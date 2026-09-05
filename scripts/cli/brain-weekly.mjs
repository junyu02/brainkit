#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  LLM_NETWORK_RETRY_DELAYS_MS, buildInputBatches, classifyBrainWriteResult,
  isTransientLlmError, parseObservationMarkdown,
} from './harvest-lib.mjs';
import { loadObserveEnv } from '../lib/plist-render.mjs';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const OBSERVATIONS = join(VAULT_ROOT, '08-观察');
const WEEKLY_DIR = join(VAULT_ROOT, '09-周报');
const CACHE = join(VAULT_ROOT, '00-系统', '.index-cache');
const HARVEST_LEDGER = join(VAULT_ROOT, '00-系统', 'logs', 'harvest-ledger.jsonl');
const BRAIN_WRITE_LEDGER = join(VAULT_ROOT, '00-系统', 'logs', 'brain-write-ledger.jsonl');
const DRY_RUN_STATE_PATHS = Object.freeze({
  candidates: join(CACHE, 'harvest-candidates.json'),
  checkpoint: join(CACHE, 'harvest-checkpoint.json'),
  ledger: HARVEST_LEDGER,
});
const BRAIN_WRITE = join(HERE, 'brain-write.mjs');
const ENV_PATH = resolve(process.env.BRAIN_OBSERVE_ENV_PATH || join(homedir(), '.config', 'second-brain', 'observe.env'));
const MAX_BATCH_ITEMS = 80;
const MAX_BATCH_CHARS = 60_000;
const MAX_LLM_TOKENS = 16_384;
const FINAL_SECTION_KEYS = Object.freeze([
  'main', 'completed', 'in_progress', 'blocked', 'evidence_boundary', 'next_comparison',
]);

class LlmSchemaError extends Error {}

function usage() {
  return 'Usage: node brain-weekly.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--dry-run]\n'
    + '       node brain-weekly.mjs --self-test\n';
}

function parseDateStamp(value, label = 'date') {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${label} requires YYYY-MM-DD`);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
    throw new Error(`${label} is not a valid calendar date`);
  }
  return date;
}

function dateStamp(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(value, days) {
  const date = parseDateStamp(value);
  date.setDate(date.getDate() + days);
  return dateStamp(date);
}

function resolveWindow({ start = null, end = null } = {}, now = new Date()) {
  const resolvedEnd = end || dateStamp(now);
  parseDateStamp(resolvedEnd, '--end');
  const resolvedStart = start || addDays(resolvedEnd, -7);
  parseDateStamp(resolvedStart, '--start');
  if (resolvedStart >= resolvedEnd) throw new Error('--start must be earlier than --end');
  return { start: resolvedStart, end: resolvedEnd, end_inclusive: addDays(resolvedEnd, -1) };
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const args = { start: null, end: null, dryRun: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--self-test') args.selfTest = true;
    else if (arg === '--start' || arg === '--end') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires YYYY-MM-DD`);
      parseDateStamp(value, arg);
      args[arg.slice(2)] = value;
    } else throw new Error(`unknown option: ${arg}\n${usage().trim()}`);
  }
  if (args.selfTest && (args.start || args.end || args.dryRun || argv.length !== 1)) {
    throw new Error('--self-test cannot be combined with other options');
  }
  return args;
}

function weeklyTitle(window) {
  return `${window.start}至${window.end_inclusive}每周工作回顾`;
}

function dateInWindow(value, window) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && value >= window.start && value < window.end;
}

function timestampInWindow(value, window, label) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${label} has invalid ts: ${value}`);
  return timestamp >= parseDateStamp(window.start) && timestamp < parseDateStamp(window.end);
}

function walkMarkdown(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

function extractSessionDate(text) {
  const frontmatter = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  const provenance = frontmatter.match(/^provenance:\s*(.+)$/m)?.[1] ?? '';
  const value = provenance.match(/\b(?:rollout-)?(\d{4}-\d{2}-\d{2})(?:T|\b)/)?.[1] ?? null;
  if (!value) return null;
  try { parseDateStamp(value, 'provenance date'); return value; } catch { return null; }
}

function parseObservationForWindow(text, path, window) {
  const item = parseObservationMarkdown(text, path);
  return dateInWindow(item.created, window) ? { ...item, session_date: extractSessionDate(text) } : null;
}

function collectObservations(window) {
  const items = [];
  const errors = [];
  for (const path of walkMarkdown(OBSERVATIONS).sort()) {
    const rel = relative(VAULT_ROOT, path).split(sep).join('/');
    try {
      const item = parseObservationForWindow(readFileSync(path, 'utf8'), rel, window);
      if (item) items.push(item);
    } catch (error) {
      errors.push({ path: rel, message: error.message });
    }
  }
  return { items, errors };
}

function promptDescription(item) {
  const suffix = ` [session_date:${item.session_date || 'unknown'}]`;
  return `${item.description.slice(0, 300 - suffix.length)}${suffix}`;
}

function buildObservationBatches(items) {
  return buildInputBatches(items.map(item => ({ ...item, description: promptDescription(item) })), MAX_BATCH_ITEMS, MAX_BATCH_CHARS);
}

function parseJsonl(text, label) {
  return String(text ?? '').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('entry must be an object');
      return [value];
    } catch (error) {
      throw new Error(`invalid ${label} line ${index + 1}: ${error.message}`);
    }
  });
}

function readJsonl(path, label) {
  return existsSync(path) ? parseJsonl(readFileSync(path, 'utf8'), label) : [];
}

function summarizeHarvestLedger(entries, window, revokedPaths = new Set()) {
  const intents = new Map(entries.filter(entry => entry.phase === 'intent' && entry.operation_id)
    .map(entry => [entry.operation_id, entry]));
  const summary = { promoted: 0, rejected: 0, skipped: 0, promoted_titles: [], promoted_without_title: 0, promoted_revoked: 0 };
  const titles = new Set();
  for (const entry of entries) {
    if (entry.phase !== 'outcome' || !timestampInWindow(entry.ts, window, 'harvest ledger outcome')) continue;
    const status = entry.resulting_status;
    if (!['promoted', 'rejected', 'skipped'].includes(status)) continue;
    summary[status] += 1;
    if (status !== 'promoted') continue;
    if (entry.receipt_path && revokedPaths.has(entry.receipt_path)) { summary.promoted_revoked += 1; continue; }
    const title = String(entry.fact_title ?? intents.get(entry.operation_id)?.fact_title ?? '').trim();
    if (!title) summary.promoted_without_title += 1;
    else if (!titles.has(title)) { titles.add(title); summary.promoted_titles.push(title); }
  }
  return summary;
}

function summarizeBrainWriteLedger(entries, window) {
  const counts = {};
  for (const entry of entries) {
    if (entry.action !== 'write' || entry.status !== 'ok' || !timestampInWindow(entry.ts, window, 'brain-write ledger entry')) continue;
    const actor = String(entry.actor || 'unknown');
    counts[actor] = (counts[actor] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function collectLedgerStats(window) {
  const writes = readJsonl(BRAIN_WRITE_LEDGER, 'brain-write ledger');
  const revokedPaths = new Set(writes.filter(entry => entry.action === 'revoke' && entry.target_path).map(entry => entry.target_path));
  return {
    harvest: summarizeHarvestLedger(readJsonl(HARVEST_LEDGER, 'harvest ledger'), window, revokedPaths),
    brain_write_by_actor: summarizeBrainWriteLedger(writes, window),
  };
}

function hashFile(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';
}

function stateHashes() {
  return Object.fromEntries(Object.entries(DRY_RUN_STATE_PATHS).map(([name, path]) => [name, hashFile(path)]));
}

function readEnv() {
  if (!existsSync(ENV_PATH)) throw new Error(`missing env file: ${ENV_PATH}`);
  return loadObserveEnv(ENV_PATH);
}

async function callLlm(env, messages) {
  const body = {
    model: env.HARVEST_JUDGE_MODEL || env.OBSERVE_MODEL,
    max_tokens: MAX_LLM_TOKENS,
    response_format: { type: 'json_object' },
    messages,
  };
  let responseJson;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = new Error(`LLM HTTP ${response.status}: ${await response.text()}`);
        error.httpStatus = response.status;
        throw error;
      }
      responseJson = await response.json();
      break;
    } catch (error) {
      const delay = LLM_NETWORK_RETRY_DELAYS_MS[attempt];
      if (!isTransientLlmError(error) || delay === undefined) throw error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, delay));
    }
  }
  const content = responseJson.choices?.[0]?.message?.content;
  if (!content) throw new LlmSchemaError(`empty LLM content (finish_reason=${responseJson.choices?.[0]?.finish_reason ?? 'unknown'})`);
  try { return JSON.parse(content); }
  catch (error) { throw new LlmSchemaError(`invalid LLM JSON: ${error.message}`); }
}

async function schemaRetry(env, messages, validate) {
  try { return validate(await callLlm(env, messages)); }
  catch (first) {
    if (!(first instanceof LlmSchemaError)) throw first;
    const feedback = { role: 'system', content: `Previous json was rejected: ${first.message}. Return corrected json only.` };
    try { return validate(await callLlm(env, [...messages, feedback])); }
    catch (second) {
      if (second instanceof LlmSchemaError) throw new LlmSchemaError(`${first.message}; schema retry failed: ${second.message}`);
      throw second;
    }
  }
}

function cleanText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new LlmSchemaError(`${label} is required`);
  const text = value.trim().replace(/\s+/g, ' ').replace(/^[-*]\s+/, '');
  if (text.length > maxLength) throw new LlmSchemaError(`${label} exceeds ${maxLength} characters`);
  return text;
}

function firstLayerMessages(batch, window) {
  const observations = batch.map((item, index) => ({
    n: index + 1,
    title: item.title,
    description: item.description.slice(0, 300),
    created: item.created,
  }));
  return [
    {
      role: 'system',
      content: '你是周报第一层归纳器。只输出 json {"themes":[{"area":"项目或领域","summary":"简体中文摘要","status":"completed|in_progress|blocked|observed","period":"current_week|historical_backfill|uncertain"}]}。description 末尾的 session_date 在窗口外时必须标为 historical_backfill；为 unknown 时不得猜测。离线测试、页面观察、后台启动、教程调研不得写成已上线或已完成。不输出公司名、账号、凭据、身份或其他隐私细节。',
    },
    { role: 'user', content: JSON.stringify({ window, observations }) },
  ];
}

function validateThemePayload(payload) {
  if (!payload || !Array.isArray(payload.themes) || payload.themes.length > 30) {
    throw new LlmSchemaError('themes must be an array with at most 30 items');
  }
  const statuses = new Set(['completed', 'in_progress', 'blocked', 'observed']);
  const periods = new Set(['current_week', 'historical_backfill', 'uncertain']);
  return {
    themes: payload.themes.map((theme, index) => {
      if (!theme || typeof theme !== 'object') throw new LlmSchemaError(`themes[${index}] must be an object`);
      if (!statuses.has(theme.status)) throw new LlmSchemaError(`themes[${index}].status is invalid`);
      if (!periods.has(theme.period)) throw new LlmSchemaError(`themes[${index}].period is invalid`);
      return {
        area: cleanText(theme.area, `themes[${index}].area`, 120),
        summary: cleanText(theme.summary, `themes[${index}].summary`, 1_000),
        status: theme.status,
        period: theme.period,
      };
    }),
  };
}

async function summarizeBatches(env, batches, window) {
  const summaries = [];
  const errors = [];
  for (let index = 0; index < batches.length; index += 1) {
    try {
      const payload = await schemaRetry(env, firstLayerMessages(batches[index], window), validateThemePayload);
      summaries.push({ batch_index: index + 1, ...payload });
    } catch (error) {
      if (!(error instanceof LlmSchemaError)) throw error;
      errors.push({ batch_index: index + 1, message: error.message });
    }
  }
  return { summaries, errors };
}

function finalLayerMessages(batchResult, ledgerStats, collection, window) {
  return [
    {
      role: 'system',
      content: '你是周报第二层综合器。只输出 json {"description":"150字内一句话概览","sections":{"main":["项目/领域：事项"],"completed":[],"in_progress":[],"blocked":[],"evidence_boundary":[],"next_comparison":[]}}。各数组元素必须是简体中文单行文本。区分已完成、推进中、阻塞与仅观察；离线测试、页面观察、后台启动、教程调研不得写成已上线或已完成。historical_backfill 仅表示本周才补记的历史活动。不生成 harvest 晋升摘要，该节由程序注入。不输出公司名、账号、凭据、身份或其他隐私细节。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        window,
        batch_summaries: batchResult.summaries,
        skipped_batch_count: batchResult.errors.length,
        observation_count: collection.items.length,
        observation_parse_error_count: collection.errors.length,
        ledger_stats: ledgerStats,
      }),
    },
  ];
}

function validateFinalPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.sections || typeof payload.sections !== 'object') {
    throw new LlmSchemaError('final payload requires sections');
  }
  const sections = {};
  for (const key of FINAL_SECTION_KEYS) {
    const values = payload.sections[key];
    if (!Array.isArray(values) || values.length > 40) throw new LlmSchemaError(`sections.${key} must be an array with at most 40 items`);
    sections[key] = values.map((value, index) => cleanText(value, `sections.${key}[${index}]`, 1_000));
  }
  return { description: cleanText(payload.description, 'description', 150), sections };
}

function actorCountLine(counts) {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([actor, count]) => `${actor} ${count} 条`).join('、') : '无成功写入';
}

function evidenceLines({ collection, batches, batchErrors, ledgerStats, window }) {
  const historical = collection.items.filter(item => item.session_date && !dateInWindow(item.session_date, window)).length;
  const unknown = collection.items.filter(item => !item.session_date).length;
  const lines = [
    `观察层按 created 命中 ${collection.items.length} 条，分 ${batches.length} 批；其中明确的历史回填 ${historical} 条，缺少 session_date ${unknown} 条。`,
    'created 是记录写入日；历史回填不等同于本周实际发生。',
    `brain-write 台账成功写入：${actorCountLine(ledgerStats.brain_write_by_actor)}。`,
  ];
  if (collection.errors.length) lines.push(`${collection.errors.length} 个观察文件因 frontmatter 无法解析而未纳入。`);
  lines.push(batchErrors.length
    ? `第一层有 ${batchErrors.length} 批在 schema 反馈重试后跳过（批次 ${batchErrors.map(error => error.batch_index).join('、')}）。`
    : '第一层无跳过批次。');
  if (ledgerStats.harvest.promoted_without_title) {
    lines.push(`${ledgerStats.harvest.promoted_without_title} 条 harvest 晋升 outcome 未找到对应标题。`);
  }
  return lines;
}

function renderSection(title, lines, fallback) {
  const values = lines.length ? lines : [fallback];
  return `## ${title}\n\n${values.map(value => `- ${value}`).join('\n')}`;
}

function renderHarvest(summary) {
  const revokedNote = summary.promoted_revoked ? `（其中 ${summary.promoted_revoked} 条后被审计撤销）` : '';
  const lines = [`窗口内 outcome：晋升 ${summary.promoted}${revokedNote}、拒绝 ${summary.rejected}、跳过 ${summary.skipped}。`];
  const shown = summary.promoted_titles.slice(0, 20);
  const rest = summary.promoted_titles.length - shown.length;
  lines.push(shown.length
    ? `晋升标题（前 ${shown.length} 条）：${shown.join('；')}${rest > 0 ? `……等共 ${summary.promoted_titles.length} 条` : ''}`
    : '晋升标题：无。');
  return renderSection('harvest 晋升摘要', lines, '无。');
}

function assembleWeeklyBody(finalPayload, context) {
  const sections = finalPayload.sections;
  return [
    renderSection('本周主线', sections.main, '本窗口未形成可归纳主线。'),
    renderSection('已完成', sections.completed, '无可确认完成项。'),
    renderSection('推进中', sections.in_progress, '无可确认推进项。'),
    renderSection('阻塞', sections.blocked, '未观察到明确阻塞。'),
    renderHarvest(context.ledgerStats.harvest),
    renderSection('证据边界', [...sections.evidence_boundary, ...evidenceLines(context)], '无额外边界。'),
    renderSection('下次对比点', sections.next_comparison, '继续按相同窗口口径对比。'),
  ].join('\n\n') + '\n';
}

function estimateTokens(batches, ledgerStats) {
  const firstLayerChars = batches.reduce((total, batch) => total + JSON.stringify(batch.map(item => ({
    title: item.title, description: item.description.slice(0, 300), created: item.created,
  }))).length, 0);
  const estimatedReduceChars = batches.length * 1_000 + JSON.stringify(ledgerStats).length;
  return Math.ceil((firstLayerChars + estimatedReduceChars) / 4);
}

function writeWeekly({ title, description, body, window, observationCount, batchCount }) {
  const provenance = `brain-weekly 窗口 ${window.start}..${window.end} 观察 ${observationCount} 条 批 ${batchCount} 个`;
  const result = spawnSync(process.execPath, [
    BRAIN_WRITE, '--type', 'weekly', '--source', 'brain-weekly', '--title', title,
    '--description', description, '--provenance', provenance,
  ], { input: body, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  const receipt = classifyBrainWriteResult(result);
  if (receipt.status !== 'promoted') throw new Error(`brain-write failed: ${receipt.message}`);
  const receiptPath = resolve(receipt.receipt_path);
  const rel = relative(resolve(WEEKLY_DIR), receiptPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || basename(receiptPath) !== `${title}.md`) {
    throw new Error(`brain-write returned unexpected weekly path: ${receipt.receipt_path}`);
  }
  return receipt.receipt_path;
}

function existingWeeklyPath(title) {
  const path = join(WEEKLY_DIR, `${title}.md`);
  return existsSync(path) ? path : null;
}

function runDryRun(window, title) {
  const before = stateHashes();
  const collection = collectObservations(window);
  const batches = buildObservationBatches(collection.items);
  const ledgerStats = collectLedgerStats(window);
  const after = stateHashes();
  assert.deepEqual(after, before, 'dry-run changed a harvest state file');
  process.stdout.write(JSON.stringify({
    mode: 'dry-run',
    window: { ...window, title },
    observations: {
      matched: collection.items.length,
      parse_errors: collection.errors.length,
      historical_backfill: collection.items.filter(item => item.session_date && !dateInWindow(item.session_date, window)).length,
      session_date_unknown: collection.items.filter(item => !item.session_date).length,
    },
    batches: { count: batches.length, max_items: MAX_BATCH_ITEMS, max_chars: MAX_BATCH_CHARS },
    ledger_stats: ledgerStats,
    estimated_tokens: estimateTokens(batches, ledgerStats),
    hashes: { before, after, unchanged: true },
  }, null, 2) + '\n');
}

async function runWeekly(window, title) {
  const collection = collectObservations(window);
  const batches = buildObservationBatches(collection.items);
  const ledgerStats = collectLedgerStats(window);
  const env = readEnv();
  const batchResult = await summarizeBatches(env, batches, window);
  const finalPayload = await schemaRetry(
    env,
    finalLayerMessages(batchResult, ledgerStats, collection, window),
    validateFinalPayload,
  );
  const context = { collection, batches, batchErrors: batchResult.errors, ledgerStats, window };
  const body = assembleWeeklyBody(finalPayload, context);
  const path = writeWeekly({
    title, description: finalPayload.description, body, window,
    observationCount: collection.items.length, batchCount: batches.length,
  });
  process.stdout.write(JSON.stringify({
    status: 'ok', path, window, observations: collection.items.length,
    batches: batches.length, skipped_batches: batchResult.errors.map(error => error.batch_index),
  }, null, 2) + '\n');
}

function writeFixtureFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function selfTestPipelineFixture() {
  const root = mkdtempSync(join(tmpdir(), 'brain-weekly-selftest-'));
  const vault = join(root, 'vault');
  const memory = join(root, 'memory');
  const routing = join(root, 'routing.json');
  mkdirSync(join(vault, '00-系统', 'logs'), { recursive: true });
  mkdirSync(join(vault, '00-系统', '.index-cache'), { recursive: true });
  mkdirSync(join(vault, '09-周报'), { recursive: true });
  mkdirSync(memory, { recursive: true });
  writeFixtureFile(join(memory, 'MEMORY.md'), '# Memory\n\n## 🔥 热记忆（容量 40，按 type 配额+FIFO）\n\n## End\n');
  writeFixtureFile(join(memory, 'MEMORY-notes.md'), '# Notes\n');
  writeFixtureFile(routing, JSON.stringify({
    routes: [{ type: 'weekly', path: '09-周报/', scope: 'global' }],
    inbox_root: '99-inbox/',
    inbox_subfolders: { '09-周报/': '99-inbox/weekly/' },
    section_policies: { '09-周报/': { policy: 'allow_root', requires_subfolder: false } },
  }));
  const title = '2026-08-01至2026-08-07每周工作回顾';
  const env = {
    ...process.env,
    BRAIN_VAULT_ROOT: vault,
    BRAIN_MEMORY_DIR: memory,
    BRAIN_ROUTING_JSON: routing,
    BRAIN_LOCK_WAIT_MS: '1000',
  };
  const result = spawnSync(process.execPath, [
    BRAIN_WRITE, '--type', 'weekly', '--source', 'brain-weekly', '--title', title,
    '--description', '隔离 fixture 周报', '--provenance', 'brain-weekly fixture',
  ], { input: '## 本周主线\n\n- fixture\n', encoding: 'utf8', env, timeout: 60_000 });
  const receipt = classifyBrainWriteResult(result);
  assert.equal(receipt.status, 'promoted', receipt.message);
  assert.equal(receipt.receipt_path, join(vault, '09-周报', `${title}.md`));
  assert.match(readFileSync(receipt.receipt_path, 'utf8'), /type: weekly/);
  assert.match(readFileSync(receipt.receipt_path, 'utf8'), /source: brain-weekly/);
  assert.match(readFileSync(join(memory, 'MEMORY.md'), 'utf8'), new RegExp(title));
  assert.match(readFileSync(join(memory, 'MEMORY-notes.md'), 'utf8'), new RegExp(title));
  const ledger = parseJsonl(readFileSync(join(vault, '00-系统', 'logs', 'brain-write-ledger.jsonl'), 'utf8'), 'fixture brain-write ledger');
  assert.ok(ledger.some(entry => entry.actor === 'brain-weekly' && entry.status === 'ok'));
  return root;
}

function selfTest() {
  const tests = [];
  const test = (name, fn) => { fn(); tests.push(name); process.stdout.write(`PASS ${name}\n`); };
  const defaultNow = new Date(2026, 7, 15, 12, 0, 0);
  const window = { start: '2026-08-08', end: '2026-08-15', end_inclusive: '2026-08-14' };
  test('default and explicit windows', () => {
    assert.deepEqual(resolveWindow({}, defaultNow), window);
    assert.deepEqual(resolveWindow({ start: '2026-08-01', end: '2026-08-08' }, defaultNow), { start: '2026-08-01', end: '2026-08-08', end_inclusive: '2026-08-07' });
    assert.throws(() => resolveWindow({ start: '2026-02-30', end: '2026-03-08' }, defaultNow));
    assert.throws(() => resolveWindow({ start: '2026-08-08', end: '2026-08-08' }, defaultNow));
  });
  test('title generation', () => assert.equal(weeklyTitle(window), '2026-08-08至2026-08-14每周工作回顾'));
  test('observation created filter and provenance date', () => {
    const inside = "---\nname: A\ndescription: d\ntype: observation\nprovenance: session rollout-2026-03-10T11-33-41-x.jsonl\ntags: []\ncreated: '2026-08-14'\n---\nBody";
    const outside = inside.replace("2026-08-14'", "2026-08-15'");
    assert.equal(parseObservationForWindow(inside, '08-观察/a.md', window).session_date, '2026-03-10');
    assert.equal(parseObservationForWindow(outside, '08-观察/b.md', window), null);
  });
  test('batch item and character budgets', () => {
    const normal = Array.from({ length: 81 }, (_, index) => ({ title: `t${index}`, description: 'd', created: '2026-08-14', session_date: null }));
    assert.deepEqual(buildObservationBatches(normal).map(batch => batch.length), [80, 1]);
    const large = [1, 2].map(index => ({ title: `${index}${'x'.repeat(35_000)}`, description: '', created: '2026-08-14', session_date: null }));
    assert.deepEqual(buildObservationBatches(large).map(batch => batch.length), [1, 1]);
  });
  test('ledger parsing and window statistics', () => {
    const harvest = parseJsonl([
      '{"ts":"2026-08-09T01:00:00Z","phase":"intent","operation_id":"p","fact_title":"晋升项"}',
      '{"ts":"2026-08-09T01:01:00Z","phase":"outcome","operation_id":"p","resulting_status":"promoted"}',
      '{"ts":"2026-08-10T01:00:00Z","phase":"outcome","operation_id":"r","resulting_status":"rejected"}',
      '{"ts":"2026-08-11T01:00:00Z","phase":"outcome","operation_id":"s","resulting_status":"skipped"}',
      '{"ts":"2026-08-12T01:00:00Z","phase":"outcome","operation_id":"rv","resulting_status":"promoted","receipt_path":"/v/x.md"}',
      '{"ts":"2026-08-15T01:00:00Z","phase":"outcome","operation_id":"late","resulting_status":"promoted"}',
    ].join('\n'), 'fixture harvest ledger');
    assert.deepEqual(summarizeHarvestLedger(harvest, window, new Set(['/v/x.md'])), {
      promoted: 2, rejected: 1, skipped: 1, promoted_titles: ['晋升项'], promoted_without_title: 0, promoted_revoked: 1,
    });
    const writes = parseJsonl([
      '{"ts":"2026-08-09T01:00:00Z","actor":"codex","action":"write","status":"ok"}',
      '{"ts":"2026-08-10T01:00:00Z","actor":"harvest","action":"write","status":"ok"}',
      '{"ts":"2026-08-11T01:00:00Z","actor":"codex","action":"write","status":"blocked-dedup"}',
    ].join('\n'), 'fixture brain-write ledger');
    assert.deepEqual(summarizeBrainWriteLedger(writes, window), { codex: 1, harvest: 1 });
    assert.throws(() => parseJsonl('{bad}', 'fixture'));
  });
  test('weekly skeleton and programmatic harvest section', () => {
    const payload = validateFinalPayload({
      description: '测试概览',
      sections: {
        main: ['项目：主线'], completed: ['完成项'], in_progress: ['推进项'], blocked: [],
        evidence_boundary: ['模型边界'], next_comparison: ['对比点'],
      },
    });
    const body = assembleWeeklyBody(payload, {
      collection: { items: [], errors: [] }, batches: [], batchErrors: [], window,
      ledgerStats: { harvest: { promoted: 1, rejected: 0, skipped: 0, promoted_titles: ['晋升项'], promoted_without_title: 0, promoted_revoked: 0 }, brain_write_by_actor: {} },
    });
    for (const heading of ['## 本周主线', '## 已完成', '## 推进中', '## 阻塞', '## harvest 晋升摘要', '## 证据边界', '## 下次对比点']) assert.match(body, new RegExp(heading));
    assert.match(body, /晋升标题（前 1 条）：晋升项/);
    const many = renderHarvest({ promoted: 30, rejected: 0, skipped: 0, promoted_titles: Array.from({ length: 30 }, (_, i) => `t${i}`), promoted_without_title: 0, promoted_revoked: 2 });
    assert.match(many, /前 20 条/); assert.match(many, /等共 30 条/); assert.match(many, /2 条后被审计撤销/);
    assert.ok(!many.includes('t25'));
  });
  let fixtureRoot;
  test('brain-write three-variable isolated weekly probe', () => { fixtureRoot = selfTestPipelineFixture(); assert.ok(fixtureRoot.startsWith(tmpdir() + sep)); });
  process.stdout.write(`SELF-TEST PASS ${tests.length}/${tests.length}\nfixture_root=${fixtureRoot}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage()); return; }
  if (args.selfTest) { selfTest(); return; }
  const window = resolveWindow(args);
  const title = weeklyTitle(window);
  const existing = existingWeeklyPath(title);
  if (existing) { process.stdout.write(`周报已存在，跳过：${existing}\n`); return; }
  if (args.dryRun) runDryRun(window, title);
  else await runWeekly(window, title);
}

main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exit(1); });

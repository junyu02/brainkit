#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  EXPERIENCE_SUBFOLDERS, LLM_NETWORK_RETRY_DELAYS_MS, aggregateDedupRoomResults,
  applyCandidateOutcome, applyMergeGroups, buildDedupCommands, buildInputBatches,
  classifyBrainWriteResult, clustersToCandidates, collectLockedEvidence,
  encodeJsonForHtml, filterDecided, isTransientLlmError, mapUiType,
  normalizeObservationPath, observationEligible, parseMempalaceOutput,
  parseObservationMarkdown, protectQueue, recomputeConsumed, recoverOperations,
  resolveNeedsCheck, sortedCandidates, validateCandidate, validateHttpRequest,
} from './harvest-lib.mjs';
import { loadObserveEnv } from '../lib/plist-render.mjs';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const OBSERVATIONS = join(VAULT_ROOT, '08-观察');
const CACHE = join(VAULT_ROOT, '00-系统', '.index-cache');
const CANDIDATES_PATH = join(CACHE, 'harvest-candidates.json');
const CHECKPOINT_PATH = join(CACHE, 'harvest-checkpoint.json');
const LOCK_PATH = join(CACHE, 'harvest.lock');
const LEDGER_PATH = join(VAULT_ROOT, '00-系统', 'logs', 'harvest-ledger.jsonl');
const PROJECT_MAP = join(VAULT_ROOT, '00-系统', '.project-map.json');
const BRAIN_WRITE = join(HERE, 'brain-write.mjs');
const ENV_PATH = resolve(process.env.BRAIN_OBSERVE_ENV_PATH || join(homedir(), '.config', 'second-brain', 'observe.env'));
const MEMPALACE = process.env.MEMPALACE_BIN || 'mempalace';
const AUTO_SENSITIVE_PATTERN = /凭证|凭据|密码|密钥|账号|账户|登录|登陆|password|passwd|credential|token|secret|api.?key|login|access.?key/i;
const AUTO_SENSITIVE_REASON = '含敏感凭证类内容，禁止自动晋升';
const AUTO_PERSONA_PROMPT_PATTERN = /JSON|schema|输出格式|仅输出|只输出|observations|提取最多|max_tokens|prompt|响应格式|reply with/i;
const AUTO_PERSONA_PROMPT_REASON = '疑似系统 prompt 误读为用户偏好，禁止进画像层';
const AUTO_TEMPORAL_STATUS_PATTERN = /完成$|已完成|进度|正在|尚未|待确认|本轮|本次会话|已修复$/;
const AUTO_TEMPORAL_STATUS_REASON = '时点状态非持久事实';
let lockHeld = false;

function usage() {
  return 'Usage: node brain-harvest.mjs cluster [--limit N] [--since YYYY-MM-DD] [--dry-run] [--force-regen]\n'
    + '       node brain-harvest.mjs review [--port 8843]\n'
    + '       node brain-harvest.mjs auto\n'
    + '       node brain-harvest.mjs --self-test\n';
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') return { command: 'self-test' };
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help' };
  const command = argv[0];
  if (!['cluster', 'review', 'auto'].includes(command)) throw new Error(usage().trim());
  const args = { command, limit: Infinity, since: null, dryRun: false, forceRegen: false, port: 8843 };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' && command === 'cluster') args.dryRun = true;
    else if (arg === '--force-regen' && command === 'cluster') args.forceRegen = true;
    else if (arg === '--limit' && command === 'cluster') {
      args.limit = Number(argv[++i]);
      if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit requires a positive integer');
    } else if (arg === '--since' && command === 'cluster') {
      args.since = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.since ?? '')) throw new Error('--since requires YYYY-MM-DD');
    } else if (arg === '--port' && command === 'review') {
      args.port = Number(argv[++i]);
      if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port requires 1..65535');
    } else throw new Error(`unknown option: ${arg}`);
  }
  return args;
}

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : structuredClone(fallback);
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, path);
}

function appendLedger(entry) {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
}

function hashFile(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';
}

function stateHashes() {
  return { candidates: hashFile(CANDIDATES_PATH), checkpoint: hashFile(CHECKPOINT_PATH), ledger: hashFile(LEDGER_PATH) };
}

function readLock() {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
      if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('pid must be a positive integer');
      return lock;
    } catch (error) {
      lastError = error;
      if (attempt === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw new Error(`harvest 锁损坏，请人工检查 ${LOCK_PATH}: ${lastError.message}`);
}

function releaseLock() {
  if (!lockHeld) return;
  try {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    if (lock.pid === process.pid) unlinkSync(LOCK_PATH);
  } catch {}
  lockHeld = false;
}

function createLock() {
  const fd = openSync(LOCK_PATH, 'wx');
  try { writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n'); }
  finally { closeSync(fd); }
  lockHeld = true;
  process.once('exit', releaseLock);
}

function acquireLock() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  try { createLock(); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const lock = readLock();
  try {
    process.kill(lock.pid, 0);
    throw new Error(`另一 harvest 实例正在运行（pid ${lock.pid}）`);
  } catch (error) {
    if (!String(error.message).startsWith('另一 harvest') && error.code !== 'ESRCH') throw error;
    if (String(error.message).startsWith('另一 harvest')) throw error;
  }
  unlinkSync(LOCK_PATH);
  try { createLock(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`另一 harvest 实例正在运行（pid ${readLock().pid}）`);
  }
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

function loadCheckpoint() {
  const value = readJson(CHECKPOINT_PATH, { consumed: {}, rejected_facts: [], decided: {} });
  value.consumed ??= {};
  value.rejected_facts ??= [];
  value.decided ??= {};
  return value;
}

function loadCandidateDocument() {
  return readJson(CANDIDATES_PATH, { generation: null, candidates: [], batch_errors: [], options: {} });
}

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`invalid harvest ledger line ${index + 1}: ${error.message}`); }
  });
}

function currentOptions() {
  const map = JSON.parse(readFileSync(PROJECT_MAP, 'utf8'));
  const projects = [...new Set((map.mappings ?? []).map(v => v.vaultDir).filter(v => v?.startsWith('01-项目/')).map(v => v.slice('01-项目/'.length)))].sort();
  const knowledgeSubfolders = readdirSync(join(VAULT_ROOT, '02-知识'), { withFileTypes: true })
    .filter(v => v.isDirectory() && !v.name.startsWith('.')).map(v => v.name).sort();
  return { experience_subfolders: [...EXPERIENCE_SUBFOLDERS], knowledge_subfolders: knowledgeSubfolders, projects };
}

function readEnv() {
  if (!existsSync(ENV_PATH)) throw new Error(`missing env file: ${ENV_PATH}`);
  return loadObserveEnv(ENV_PATH);
}

function scanObservations({ since, consumed, locked, limit }) {
  const items = [];
  const errors = [];
  for (const path of walkMarkdown(OBSERVATIONS).sort()) {
    try {
      const rel = normalizeObservationPath(relative(VAULT_ROOT, path).split(sep).join('/'));
      const item = parseObservationMarkdown(readFileSync(path, 'utf8'), rel);
      if (observationEligible(item, { since, consumed, locked })) items.push(item);
      if (items.length >= limit) break;
    } catch (error) {
      errors.push({ stage: 'collect', path: relative(VAULT_ROOT, path), message: error.message });
    }
  }
  return { items, errors };
}

class LlmSchemaError extends Error {}

function autoSensitiveDecision(candidate) {
  return AUTO_SENSITIVE_PATTERN.test(`${candidate.fact_title ?? ''}\n${candidate.fact_body ?? ''}`)
    ? { decision: 'skip', reason: AUTO_SENSITIVE_REASON }
    : null;
}

function autoPersonaPromptDecision(candidate) {
  return candidate.ui_type === 'persona'
    && AUTO_PERSONA_PROMPT_PATTERN.test(`${candidate.fact_title ?? ''}\n${candidate.fact_body ?? ''}`)
    ? { decision: 'skip', reason: AUTO_PERSONA_PROMPT_REASON }
    : null;
}

function autoTemporalStatusDecision(candidate) {
  return AUTO_TEMPORAL_STATUS_PATTERN.test(candidate.fact_title ?? '')
    ? { decision: 'skip', reason: AUTO_TEMPORAL_STATUS_REASON }
    : null;
}

function validateAutoDecision(payload) {
  if (!payload || !['promote', 'reject', 'skip'].includes(payload.decision)) {
    throw new LlmSchemaError('decision must be promote, reject, or skip');
  }
  if (typeof payload.reason !== 'string' || !payload.reason.trim()) throw new LlmSchemaError('reason is required');
  return { decision: payload.decision, reason: payload.reason.trim() };
}

function autoDecisionMessages(candidate) {
  return [
    { role: 'system', content: '你是长期记忆晋升评审器。只输出 json {"decision":"promote|reject|skip","reason":"一句话"}。promote 仅当事实具体、跨会话可复用、有证据支撑且非一次性任务状态；reject 当内容空泛、只是无复用价值的状态快照，或 dedup 高相似命中且标题语义相同、事实层已明确覆盖；拿不准一律 skip，保留观察供下轮重聚。' },
    { role: 'user', content: JSON.stringify({
      fact_title: candidate.fact_title, fact_body: candidate.fact_body,
      ui_type: candidate.ui_type, subfolder: candidate.subfolder,
      knowledge_subfolder: candidate.knowledge_subfolder, project: candidate.project,
      value_score: candidate.value_score, rationale: candidate.rationale,
      evidence: candidate.evidence.map(({ title, excerpt }) => ({ title, excerpt })),
      dedup: { top: candidate.dedup?.top ?? [] },
    }) },
  ];
}

function judgeAutoCandidate(candidate, judge) {
  return autoPersonaPromptDecision(candidate)
    ?? autoTemporalStatusDecision(candidate)
    ?? autoSensitiveDecision(candidate)
    ?? judge();
}

async function callLlm(env, messages, model = env.OBSERVE_MODEL) {
  const body = { model, max_tokens: 16384, response_format: { type: 'json_object' }, messages };
  let responseJson;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: JSON.stringify(body),
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
  try { return JSON.parse(content); } catch (error) { throw new LlmSchemaError(`invalid LLM JSON: ${error.message}`); }
}

async function schemaRetry(env, messages, validate, model = env.OBSERVE_MODEL) {
  try { return validate(await callLlm(env, messages, model)); }
  catch (first) {
    if (!(first instanceof LlmSchemaError)) throw first;
    const feedback = { role: 'system', content: `Previous JSON was rejected: ${first.message}. Return corrected JSON only.` };
    try { return validate(await callLlm(env, [...messages, feedback], model)); }
    catch (second) {
      if (second instanceof LlmSchemaError) throw new LlmSchemaError(`${first.message}; schema retry failed: ${second.message}`);
      throw second;
    }
  }
}

function firstLayerMessages(batch, options, checkpoint) {
  const facts = batch.map((item, index) => ({ n: index + 1, title: item.title, description: item.description.slice(0, 300), created: item.created }));
  const decided = Object.values(checkpoint.decided ?? {}).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const promoted = decided.filter(v => v.status === 'promoted').slice(0, 200).map(v => v.fact_title);
  const rejected = [...checkpoint.rejected_facts].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 200).map(v => v.title);
  return [
    { role: 'system', content: 'Cluster observations into durable facts. Return JSON {"clusters":[{"members":[1],"fact_title":"","fact_body":"","memory_type":"experience|project|knowledge|persona","subfolder":"","knowledge_subfolder":"","project":"","value_score":1,"rationale":""}]}. Use only supplied member numbers. title<=120, body<=4000, score integer 1..5, rationale concise. Do not emit paths. fact_title, fact_body and rationale MUST be written in Simplified Chinese (keep technical terms, code identifiers and product names in their original form), regardless of the language of the observations.' },
    { role: 'user', content: JSON.stringify({ options, already_promoted_do_not_repeat: promoted, rejected_do_not_repeat: rejected, observations: facts }) },
  ];
}

async function firstLayer(env, batches, options, checkpoint) {
  const candidates = [];
  const errors = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    try {
      const converted = await schemaRetry(env, firstLayerMessages(batches[batchIndex], options, checkpoint), payload => {
        if (!payload || !Array.isArray(payload.clusters)) throw new LlmSchemaError('clusters must be an array');
        return clustersToCandidates(payload, batches[batchIndex], { inputPaths: new Set(batches[batchIndex].map(v => v.path)), projects: options.projects, knowledgeSubfolders: options.knowledge_subfolders });
      });
      converted.candidates.forEach((candidate, index) => candidates.push({ ...candidate, cluster_id: `b${batchIndex + 1}-${index + 1}` }));
      errors.push(...converted.errors.map(v => ({ ...v, batch_index: batchIndex })));
    } catch (error) {
      if (!(error instanceof LlmSchemaError)) throw error;
      errors.push({ stage: 'first-layer', batch_index: batchIndex, message: error.message });
    }
  }
  return { candidates, errors };
}

function mergeChunks(candidates) {
  const chunks = [];
  let chunk = [];
  let chars = 0;
  for (const candidate of candidates) {
    const size = JSON.stringify({ cluster_id: candidate.cluster_id, fact_title: candidate.fact_title, fact_body: candidate.fact_body.slice(0, 300) }).length;
    if (chunk.length && (chunk.length >= 500 || chars + size > 100_000)) { chunks.push(chunk); chunk = []; chars = 0; }
    chunk.push(candidate);
    chars += size;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

async function mergeAcrossBatches(env, initial) {
  let candidates = initial;
  const errors = [];
  for (let round = 1; round <= 3; round += 1) {
    const chunks = mergeChunks(candidates);
    if (candidates.length < 2) break;
    const next = [];
    let changed = false;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (chunk.length < 2) { next.push(...chunk); continue; }
      const input = chunk.map(v => ({ cluster_id: v.cluster_id, fact_title: v.fact_title, fact_body: v.fact_body.slice(0, 300) }));
      const messages = [
        { role: 'system', content: 'Return JSON {"merges":[["cluster_id","cluster_id"]]}. Only merge genuinely duplicate facts. Groups must be disjoint and use only supplied ids.' },
        { role: 'user', content: JSON.stringify(input) },
      ];
      try {
        const merged = await schemaRetry(env, messages, payload => {
          if (!payload || !Array.isArray(payload.merges)) throw new LlmSchemaError('merges must be an array');
          return applyMergeGroups(chunk, payload.merges);
        });
        merged.candidates.forEach((v, index) => { v.cluster_id = `r${round}x${chunkIndex + 1}-${index + 1}`; });
        next.push(...merged.candidates);
        errors.push(...merged.errors.map(v => ({ ...v, round, chunk_index: chunkIndex })));
        if (merged.candidates.length < chunk.length) changed = true;
      } catch (error) {
        if (!(error instanceof LlmSchemaError)) throw error;
        errors.push({ stage: 'merge', round, chunk_index: chunkIndex, message: error.message });
        next.push(...chunk);
      }
    }
    candidates = next;
    if (!changed || chunks.length === 1) break;
  }
  return { candidates, errors };
}

function attachDedup(candidate) {
  const results = [];
  for (const command of buildDedupCommands(candidate.fact_title)) {
    const run = spawnSync(MEMPALACE, command.args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    results.push(run.status === 0
      ? { room: command.room, ok: true, output: run.stdout }
      : { room: command.room, ok: false, error: run.stderr || run.stdout || run.error?.message });
  }
  return { ...candidate, dedup: aggregateDedupRoomResults(results) };
}

async function cluster(args) {
  const before = stateHashes();
  acquireLock();
  try {
    const checkpoint = loadCheckpoint();
    const existing = loadCandidateDocument();
    const queue = protectQueue(existing.candidates, args.forceRegen);
    const locked = collectLockedEvidence(existing.candidates);
    const options = currentOptions();
    const collected = scanObservations({ since: args.since, consumed: checkpoint.consumed, locked, limit: args.limit });
    const batches = buildInputBatches(collected.items);
    const env = batches.length ? readEnv() : null;
    const first = batches.length ? await firstLayer(env, batches, options, checkpoint) : { candidates: [], errors: [] };
    const merged = batches.length > 1 ? await mergeAcrossBatches(env, first.candidates) : { candidates: first.candidates, errors: [] };
    let candidates = filterDecided(merged.candidates, checkpoint.decided).map(attachDedup);
    candidates = sortedCandidates([...queue.carried, ...candidates]).map(({ cluster_id, ...candidate }) => candidate);
    const batchErrors = [...collected.errors, ...first.errors, ...merged.errors];
    const document = { generation: new Date().toISOString(), candidates, batch_errors: batchErrors, options };
    if (!args.dryRun) {
      if (queue.invalidated.length) appendLedger({ ts: new Date().toISOString(), action: 'force-regen-invalidated', candidate_ids: queue.invalidated.map(v => v.candidate_id) });
      atomicJson(CANDIDATES_PATH, document);
    }
    const after = stateHashes();
    process.stdout.write(JSON.stringify({
      mode: args.dryRun ? 'dry-run' : 'write', observations_scanned: collected.items.length,
      batches: batches.length, candidates: candidates.length, batch_errors: batchErrors,
      preview: candidates.slice(0, 10).map(v => ({ title: v.fact_title, type: v.ui_type, evidence_count: v.evidence.length, likely_covered: v.dedup.likely_covered })),
      hashes: { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) },
    }, null, 2) + '\n');
  } finally { releaseLock(); }
}

function writeCheckpointFor(document, checkpoint, candidate) {
  const now = new Date().toISOString();
  if (['promoted', 'rejected', 'redirected'].includes(candidate.status)) {
    checkpoint.decided[candidate.candidate_id] = { status: candidate.status, ts: now, receipt_path: candidate.receipt_path || undefined, fact_title: candidate.fact_title };
  } else delete checkpoint.decided[candidate.candidate_id];
  if (candidate.status === 'rejected') checkpoint.rejected_facts.push({ title: candidate.fact_title, ts: now });
  const unsettled = new Set(document.candidates.filter(v => !['promoted', 'rejected', 'redirected'].includes(v.status)).flatMap(v => v.evidence.map(e => e.path)));
  unsettled.forEach(path => { delete checkpoint.consumed[path]; });
  checkpoint.consumed = recomputeConsumed(checkpoint.consumed, document.candidates, now);
}

function persistReview(state, candidate) {
  writeCheckpointFor(state.document, state.checkpoint, candidate);
  atomicJson(CANDIDATES_PATH, state.document);
  atomicJson(CHECKPOINT_PATH, state.checkpoint);
}

function operationIntent(candidate, action, resolves, decidedBy) {
  return { ts: new Date().toISOString(), phase: 'intent', operation_id: randomBytes(4).toString('hex'), candidate_id: candidate.candidate_id, action, fact_title: candidate.fact_title, ...(resolves ? { resolves } : {}), ...(decidedBy ? { decided_by: decidedBy } : {}) };
}

function operationOutcome(intent, candidate, outcome, extra = {}) {
  return { ts: new Date().toISOString(), phase: 'outcome', operation_id: intent.operation_id, candidate_id: candidate.candidate_id, outcome, resulting_status: candidate.status, ...extra, ...(intent.decided_by ? { decided_by: intent.decided_by } : {}) };
}

function validateEditedCandidate(candidate, body, options) {
  const validated = validateCandidate({
    ...candidate, fact_title: body.title, fact_body: body.body, ui_type: body.ui_type,
    subfolder: body.subfolder, project: body.project, knowledge_subfolder: body.knowledge_subfolder,
  }, { inputPaths: new Set(candidate.evidence.map(v => v.path)), projects: options.projects, knowledgeSubfolders: options.knowledge_subfolders });
  return { ...validated, candidate_id: candidate.candidate_id, status: candidate.status, operation_id: candidate.operation_id, evidence_locked: candidate.evidence_locked };
}

function brainWrite(candidate) {
  const config = mapUiType(candidate.ui_type);
  const args = [BRAIN_WRITE, '--type', config.writeType, '--source', 'harvest', '--title', candidate.fact_title,
    '--description', candidate.rationale, '--files', candidate.evidence.map(v => v.path).join(','),
    '--provenance', `harvest: ${candidate.evidence.length} 条观察聚合`];
  if (candidate.ui_type === 'experience') args.push('--subfolder', candidate.subfolder);
  if (candidate.ui_type === 'project') args.push('--project', candidate.project);
  if (candidate.ui_type === 'knowledge') args.push('--subfolder', candidate.knowledge_subfolder);
  return classifyBrainWriteResult(spawnSync(process.execPath, args, { input: candidate.fact_body, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }));
}

function targetRoots() {
  return [join(VAULT_ROOT, '03-经验'), join(VAULT_ROOT, '01-项目'), join(VAULT_ROOT, '02-知识'), join(VAULT_ROOT, '05-persona')];
}

function titleHits(title) {
  const hits = [];
  for (const root of targetRoots()) {
    for (const path of walkMarkdown(root)) {
      if (hits.length >= 10) return hits;
      if (basename(path, '.md').includes(title) || readFileSync(path, 'utf8').includes(`name: ${title}`) || readFileSync(path, 'utf8').includes(`name: '${title.replaceAll("'", "''")}'`)) hits.push(path);
    }
  }
  return hits;
}

function validConfirmedPath(value) {
  const requested = resolve(String(value ?? ''));
  if (!existsSync(requested) || !statSync(requested).isFile()) throw new Error('确认路径必须是已存在文件');
  const path = realpathSync(requested);
  if (!targetRoots().some(root => path.startsWith(realpathSync(root) + sep))) throw new Error('确认路径不在四个晋升目标目录');
  return path;
}

function decide(state, body, decidedBy = null) {
  const index = state.document.candidates.findIndex(v => v.candidate_id === body.candidate_id);
  if (index < 0) throw new Error('candidate not found');
  let candidate = state.document.candidates[index];
  if (!['pending', 'needs_check'].includes(candidate.status)) return { candidate, message: 'already decided' };
  if (candidate.status === 'needs_check') {
    if (!['confirm', 'retry', 'reject'].includes(body.action)) throw new Error('invalid needs_check action');
    const intent = operationIntent(candidate, `resolve-${body.action}`, candidate.operation_id, decidedBy);
    appendLedger(intent);
    const path = body.action === 'confirm' ? validConfirmedPath(body.receipt_path || titleHits(candidate.fact_title)[0]) : null;
    candidate = resolveNeedsCheck(candidate, body.action, path);
    state.document.candidates[index] = candidate;
    persistReview(state, candidate);
    appendLedger(operationOutcome(intent, candidate, body.action === 'retry' ? 'abandoned-retry' : `${body.action}ed`, path ? { receipt_path: path } : {}));
    return { candidate, message: `needs_check ${body.action}` };
  }
  if (!['promote', 'reject', 'skip'].includes(body.action)) throw new Error('invalid pending action');
  candidate = validateEditedCandidate(candidate, body, state.document.options);
  const intent = operationIntent(candidate, body.action, null, decidedBy);
  appendLedger(intent);
  let outcome;
  if (body.action === 'promote') {
    outcome = brainWrite(candidate);
    candidate = applyCandidateOutcome(candidate, outcome);
    if (candidate.status === 'needs_check') candidate.operation_id = intent.operation_id;
  } else {
    candidate.status = body.action === 'reject' ? 'rejected' : 'skipped';
    outcome = { outcome: body.action === 'reject' ? 'rejected' : 'skipped', message: candidate.status };
  }
  state.document.candidates[index] = candidate;
  persistReview(state, candidate);
  appendLedger(operationOutcome(intent, candidate, outcome.outcome, {
    ...(candidate.receipt_path ? { receipt_path: candidate.receipt_path } : {}),
    evidence: candidate.evidence.map(v => v.path),
  }));
  return { candidate, message: outcome.message };
}

function loadDecisionState() {
  const state = { document: loadCandidateDocument(), checkpoint: loadCheckpoint() };
  const recovered = recoverOperations(loadLedger(), state.document.candidates);
  if (JSON.stringify(recovered.candidates) !== JSON.stringify(state.document.candidates) || recovered.replayOutcomes.length) {
    state.document.candidates = recovered.candidates;
    for (const candidate of state.document.candidates) writeCheckpointFor(state.document, state.checkpoint, candidate);
    atomicJson(CANDIDATES_PATH, state.document);
    atomicJson(CHECKPOINT_PATH, state.checkpoint);
    recovered.replayOutcomes.forEach(appendLedger);
  }
  return state;
}

async function auto() {
  acquireLock();
  try {
    const state = loadDecisionState();
    const summary = { promoted: [], rejected: [], skipped: [], errors: [] };
    let env;
    for (const candidate of state.document.candidates.filter(v => v.status === 'pending')) {
      let judgement;
      try {
        judgement = await judgeAutoCandidate(candidate, () => {
          env ??= readEnv();
          return schemaRetry(env, autoDecisionMessages(candidate), validateAutoDecision, env.HARVEST_JUDGE_MODEL || env.OBSERVE_MODEL);
        });
      } catch (error) {
        summary.errors.push({ title: candidate.fact_title, stage: 'llm', message: error.message });
        continue;
      }
      const result = decide(state, {
        candidate_id: candidate.candidate_id, action: judgement.decision,
        title: candidate.fact_title, body: candidate.fact_body, ui_type: candidate.ui_type,
        subfolder: candidate.subfolder, knowledge_subfolder: candidate.knowledge_subfolder,
        project: candidate.project,
      }, 'auto-llm');
      if (result.candidate.status === 'promoted') summary.promoted.push({ title: result.candidate.fact_title, receipt_path: result.candidate.receipt_path });
      else if (result.candidate.status === 'rejected') summary.rejected.push({ title: result.candidate.fact_title, reason: judgement.reason });
      else if (result.candidate.status === 'skipped') summary.skipped.push({ title: result.candidate.fact_title, reason: judgement.reason });
      else summary.errors.push({ title: result.candidate.fact_title, stage: 'decide', status: result.candidate.status, message: result.message });
    }
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } finally { releaseLock(); }
}

function reviewData(state) {
  return {
    generation: state.document.generation, options: state.document.options,
    candidates: state.document.candidates.map(v => v.status === 'needs_check' ? { ...v, title_hits: titleHits(v.fact_title) } : v),
  };
}

function pageHtml(state) {
  const data = encodeJsonForHtml(reviewData(state));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><title>Harvest Review</title><style>
body{font:15px system-ui;margin:0;background:#f4f5f7;color:#17202a}main{max-width:860px;margin:auto;padding:24px}.bar,.card{background:white;border:1px solid #d8dde5;border-radius:10px;padding:16px;margin:12px 0}.card.needs{border-color:#d4a017;background:#fffbea}input,textarea,select,button{box-sizing:border-box;font:inherit}input,textarea,select{width:100%;padding:8px;margin:5px 0 10px;border:1px solid #b8c0cc;border-radius:6px}textarea{min-height:150px}button{padding:8px 14px;margin:4px;border:0;border-radius:6px;cursor:pointer}.yes{background:#137c4b;color:white}.no{background:#b42318;color:white}.skip{background:#667085;color:white}small{color:#667085}.evidence,.dedup{margin:8px 0;padding-left:20px}.error{color:#b42318;white-space:pre-wrap}.ok{color:#137c4b}progress{width:100%}
</style></head><body><main><div id="app"></div><script id="initial" type="application/json">${data}</script><script>
const state=JSON.parse(document.getElementById('initial').textContent),app=document.getElementById('app');let activeCard=null,notice=null;
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
function field(tag,value,label){const box=el('label',label),n=document.createElement(tag);n.value=value||'';box.appendChild(n);return[box,n]}
function button(text,cls,fn){const b=el('button',text,cls);b.type='button';b.addEventListener('click',fn);return b}
async function submit(candidate,action,controls,buttons){buttons.forEach(b=>b.disabled=true);const msg=el('div','执行中…');controls.card.appendChild(msg);const payload={candidate_id:candidate.candidate_id,action,title:controls.title.value,body:controls.body.value,ui_type:controls.type.value,subfolder:controls.subfolder.value,knowledge_subfolder:controls.knowledge.value,project:controls.project.value,receipt_path:controls.receipt.value};try{const response=await fetch('decide',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),result=await response.json();if(!response.ok)throw new Error(result.error||response.statusText);Object.assign(candidate,result.candidate);notice={text:result.message,error:!['promoted','rejected','skipped'].includes(result.candidate.status)};render()}catch(error){msg.textContent=error.message;msg.className='error';buttons.forEach(b=>b.disabled=false)}}
function render(){app.textContent='';const active=state.candidates.filter(c=>c.status==='pending'||c.status==='needs_check').sort((a,b)=>(a.status==='needs_check'?-1:0)-(b.status==='needs_check'?-1:0));const done=state.candidates.length-active.length,bar=el('div',undefined,'bar');bar.append(el('h1','Harvest 人审'),el('div',done+' / '+state.candidates.length+' 已处理'));const progress=document.createElement('progress');progress.max=Math.max(1,state.candidates.length);progress.value=done;bar.appendChild(progress);app.appendChild(bar);if(notice)app.appendChild(el('div',notice.text,notice.error?'bar error':'bar ok'));if(!active.length){const summary=el('div',undefined,'card');summary.append(el('h2','队列已结案'),el('div','晋升 '+state.candidates.filter(c=>c.status==='promoted').length+' · 拒绝 '+state.candidates.filter(c=>c.status==='rejected').length+' · 跳过 '+state.candidates.filter(c=>c.status==='skipped').length+' · 重定向 '+state.candidates.filter(c=>c.status==='redirected').length));const promoted=el('ul');state.candidates.filter(c=>c.status==='promoted').forEach(c=>promoted.appendChild(el('li',c.fact_title+' → '+(c.receipt_path||'已确认'))));summary.appendChild(promoted);summary.appendChild(button('完成并退出','yes',async()=>{await fetch('finish',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});document.body.textContent='Harvest review 已退出'}));app.appendChild(summary);return}active.forEach((candidate,index)=>{const card=el('section',undefined,'card'+(candidate.status==='needs_check'?' needs':''));if(index===0)activeCard=card;card.append(el('small',candidate.candidate_id+' · '+candidate.status));const [titleBox,title]=field('input',candidate.fact_title,'标题');const [bodyBox,body]=field('textarea',candidate.fact_body,'正文');card.append(titleBox,bodyBox);const type=document.createElement('select');['experience','project','knowledge','persona'].forEach(v=>{const o=el('option',v);o.value=v;o.selected=v===candidate.ui_type;type.appendChild(o)});const typeBox=el('label','类型');typeBox.appendChild(type);card.appendChild(typeBox);function select(values,current){const n=document.createElement('select');values.forEach(v=>{const o=el('option',v);o.value=v;o.selected=v===current;n.appendChild(o)});return n}const subfolder=select(state.options.experience_subfolders||[],candidate.subfolder),knowledge=select(state.options.knowledge_subfolders||[],candidate.knowledge_subfolder),project=select(state.options.projects||[],candidate.project),subBox=el('label','经验子类'),knowledgeBox=el('label','知识子类'),projectBox=el('label','项目');subBox.appendChild(subfolder);knowledgeBox.appendChild(knowledge);projectBox.appendChild(project);card.append(subBox,knowledgeBox,projectBox,el('div','价值 '+candidate.value_score+' · '+candidate.rationale,'ok'));function sync(){subBox.hidden=type.value!=='experience';knowledgeBox.hidden=type.value!=='knowledge';projectBox.hidden=type.value!=='project'}type.addEventListener('change',sync);sync();const evidence=el('details',undefined,'evidence');evidence.appendChild(el('summary','证据 '+candidate.evidence.length+' 条'));candidate.evidence.forEach(v=>evidence.appendChild(el('div',v.title+' — '+(v.excerpt||v.desc))));card.appendChild(evidence);const dedup=el('details',undefined,'dedup');dedup.appendChild(el('summary','查重 '+(candidate.dedup.available?(candidate.dedup.likely_covered?'可能已覆盖':'可用'):'不可用')));(candidate.dedup.top||[]).forEach(v=>dedup.appendChild(el('div',v.room+' / '+v.title+' · '+v.cosine)));card.appendChild(dedup);const receipt=document.createElement('input');receipt.placeholder='needs_check：确认落盘路径';if(candidate.title_hits&&candidate.title_hits[0])receipt.value=candidate.title_hits[0];card.appendChild(receipt);const controls={card,title,body,type,subfolder,knowledge,project,receipt},buttons=[];if(candidate.status==='needs_check'){card.append(el('div','可能已落盘；命中：'+((candidate.title_hits||[]).join('，')||'无'),'error'));buttons.push(button('确认已落盘','yes',()=>submit(candidate,'confirm',controls,buttons)),button('重新尝试','skip',()=>submit(candidate,'retry',controls,buttons)),button('拒绝','no',()=>submit(candidate,'reject',controls,buttons)))}else{buttons.push(button('晋升 y','yes',()=>submit(candidate,'promote',controls,buttons)),button('拒绝 n','no',()=>submit(candidate,'reject',controls,buttons)),button('跳过 s','skip',()=>submit(candidate,'skip',controls,buttons)))}buttons.forEach(b=>card.appendChild(b));app.appendChild(card)})}
document.addEventListener('keydown',event=>{if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;const b=activeCard&&activeCard.querySelector(event.key==='y'?'.yes':event.key==='n'?'.no':event.key==='s'?'.skip':'x');if(b)b.click()});render();
</script></main></body></html>`;
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    let bytes = 0;
    const chunks = [];
    request.setTimeout(30_000, () => request.destroy(new Error('request body timeout')));
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) request.destroy(new Error('body exceeds 64KB'));
      else chunks.push(chunk);
    });
    request.on('end', () => { try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); } });
    request.on('error', reject);
  });
}

async function review(args) {
  acquireLock();
  const state = loadDecisionState();
  if (!state.document.candidates.some(v => v.status === 'pending' || v.status === 'needs_check')) {
    process.stdout.write('没有 pending 或 needs_check 候选。\n');
    releaseLock();
    return;
  }
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${args.port}`);
    const boundary = validateHttpRequest({ method: request.method, path: url.pathname, host: request.headers.host, origin: request.headers.origin, contentType: request.headers['content-type'], bodyBytes: Number(request.headers['content-length'] || 0), token, port: args.port });
    if (!boundary.ok) { response.writeHead(boundary.status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: boundary.message })); return; }
    try {
      if (boundary.endpoint === 'page') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(pageHtml(state)); return; }
      const body = await readBody(request);
      if (boundary.endpoint === 'finish') {
        if (state.document.candidates.some(v => v.status === 'pending' || v.status === 'needs_check')) throw new Error('queue is not finished');
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
        server.close(() => { releaseLock(); process.exit(0); });
        return;
      }
      const result = decide(state, body);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(/64KB/.test(error.message) ? 413 : 400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.requestTimeout = 95_000;
  server.headersTimeout = 30_000;
  server.timeout = 95_000;
  server.on('error', error => { releaseLock(); throw error; });
  server.listen(args.port, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${args.port}/t/${token}/\n`));
}

function selfTestFixture() {
  const root = mkdtempSync(join(tmpdir(), 'brain-harvest-selftest-'));
  const vault = join(root, 'vault');
  const memory = join(root, 'memory');
  const routing = join(root, 'routing.json');
  ['00-系统/logs', '00-系统/.index-cache', '03-经验/AI工具', '99-inbox/experience'].forEach(path => mkdirSync(join(vault, path), { recursive: true }));
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(vault, '00-系统', '.project-map.json'), '{"mappings":[]}\n');
  writeFileSync(join(memory, 'MEMORY.md'), '# Memory\n\n## 🔥 热记忆（容量 40，按 type 配额+FIFO）\n\n## End\n');
  writeFileSync(join(memory, 'MEMORY-experience.md'), '# Experience\n');
  writeFileSync(routing, JSON.stringify({
    routes: [{ type: 'experience', path: '03-经验/', scope: 'global' }], inbox_root: '99-inbox/',
    inbox_subfolders: { '03-经验/': '99-inbox/experience/' },
    section_policies: { '03-经验/': { policy: 'deny_new_subfolder', requires_subfolder: true, allowed_subfolders: ['AI工具'], new_subfolder_policy: 'deny' } },
  }));
  const env = { ...process.env, BRAIN_VAULT_ROOT: vault, BRAIN_MEMORY_DIR: memory, BRAIN_ROUTING_JSON: routing };
  const base = [BRAIN_WRITE, '--type', 'experience', '--source', 'harvest', '--description', 'fixture', '--files', '08-观察/fixture.md', '--provenance', 'harvest fixture'];
  const success = spawnSync(process.execPath, [...base, '--subfolder', 'AI工具', '--title', 'Harvest fixture success'], { input: 'fixture body', encoding: 'utf8', env });
  const classified = classifyBrainWriteResult(success);
  assert.equal(classified.status, 'promoted');
  assert.ok(classified.receipt_path.startsWith(vault + sep));
  const note = readFileSync(classified.receipt_path, 'utf8');
  assert.match(note, /source: harvest/);
  assert.match(note, /08-观察\/fixture\.md/);
  assert.match(readFileSync(join(memory, 'MEMORY.md'), 'utf8'), /Harvest fixture success/);
  const redirected = classifyBrainWriteResult(spawnSync(process.execPath, [...base, '--subfolder', 'NotAllowed', '--title', 'Harvest fixture redirect'], { input: 'fixture body 2', encoding: 'utf8', env }));
  assert.equal(redirected.status, 'redirected');
  assert.ok(redirected.receipt_path.startsWith(join(vault, '99-inbox') + sep));
  return root;
}

function selfTest() {
  const tests = [];
  const test = (name, fn) => { fn(); tests.push(name); process.stdout.write(`PASS ${name}\n`); };
  const options = { projects: ['p'], knowledgeSubfolders: ['k'] };
  const evidence = [{ path: '08-观察/a.md', title: 'A', desc: 'd', excerpt: 'e' }];
  const base = { fact_title: 'Fact', fact_body: 'Body', memory_type: 'experience', subfolder: 'AI工具', value_score: 5, rationale: 'Why', evidence };
  test('type mapping and invalid enum', () => { assert.equal(mapUiType('knowledge').writeType, 'reference'); assert.throws(() => mapUiType('bad')); });
  test('candidate validation boundaries', () => {
    assert.equal(validateCandidate(base, { ...options, inputPaths: new Set(['08-观察/a.md']) }).ui_type, 'experience');
    for (const bad of [{ ...base, fact_title: 'x'.repeat(121) }, { ...base, value_score: 6 }, { ...base, memory_type: 'bad' }]) assert.throws(() => validateCandidate(bad, { ...options, inputPaths: new Set(['08-观察/a.md']) }));
  });
  test('LLM member index validation', () => {
    const batch = [{ path: '08-观察/a.md', title: 'A', description: 'd', excerpt: 'e', created: '2026-08-14' }];
    assert.equal(clustersToCandidates({ clusters: [{ ...base, members: [1] }] }, batch, options).candidates.length, 1);
    assert.equal(clustersToCandidates({ clusters: [{ ...base, members: [2] }] }, batch, options).errors.length, 1);
  });
  test('mempalace parser success and failure', () => {
    const fixture = '[1] second_brain / 经验\n    Source: Durable fact.md\n    Match:  cosine_sim=0.731  bm25=0.2\n';
    assert.deepEqual(parseMempalaceOutput(fixture)[0], { room: '经验', title: 'Durable fact', cosine: 0.731 });
    assert.deepEqual(parseMempalaceOutput('garbage'), []);
  });
  test('candidate id stability', () => {
    const pair = [...evidence, { path: '08-观察/b.md', title: 'B', desc: 'd', excerpt: 'e' }];
    const one = validateCandidate({ ...base, evidence: pair }, { ...options, inputPaths: new Set(['08-观察/a.md', '08-观察/b.md']) });
    const two = validateCandidate({ ...base, evidence: [...pair].reverse() }, { ...options, inputPaths: new Set(['08-观察/a.md', '08-观察/b.md']) });
    assert.equal(one.candidate_id, two.candidate_id);
  });
  test('decision state and consumed semantics', () => {
    const candidate = validateCandidate(base, { ...options, inputPaths: new Set(['08-观察/a.md']) });
    const promoted = applyCandidateOutcome(candidate, { status: 'promoted', receipt_path: '/tmp/x' });
    assert.equal(applyCandidateOutcome(promoted, { status: 'rejected' }).status, 'promoted');
    assert.deepEqual(recomputeConsumed({}, [{ ...candidate, status: 'skipped' }]), {});
    assert.ok(recomputeConsumed({}, [{ ...candidate, status: 'rejected' }])['08-观察/a.md']);
  });
  test('token Host Origin and HTTP limits', () => {
    const good = { method: 'POST', path: '/t/t/decide', host: '127.0.0.1:8843', origin: 'http://127.0.0.1:8843', contentType: 'application/json', token: 't', port: 8843 };
    assert.ok(validateHttpRequest(good).ok);
    assert.equal(validateHttpRequest({ ...good, method: 'GET' }).status, 405);
    assert.equal(validateHttpRequest({ ...good, contentType: 'text/plain' }).status, 415);
    assert.equal(validateHttpRequest({ ...good, bodyBytes: 65 * 1024 }).status, 413);
    assert.equal(validateHttpRequest({ ...good, host: 'localhost:8843' }).status, 403);
  });
  test('observation parse and filters', () => {
    const item = parseObservationMarkdown("---\nname: Test\ndescription: desc\ntags:\n  - durable-candidate\ncreated: '2026-08-14'\n---\nBody", '08-观察/a.md');
    assert.ok(observationEligible(item, { since: '2026-08-13' }));
    assert.ok(!observationEligible(item, { consumed: { '08-观察/a.md': { ts: 'x' } } }));
  });
  test('merge overlap preflight rejects every affected group', () => {
    const list = ['a', 'b', 'c'].map((id, index) => ({ ...validateCandidate({ ...base, fact_title: id, evidence: [{ ...evidence[0], path: `08-观察/${id}.md` }] }, { ...options, inputPaths: new Set([`08-观察/${id}.md`]) }), cluster_id: id, value_score: index + 1 }));
    const merged = applyMergeGroups(list, [['a', 'b'], ['b', 'c'], ['c', 'a']]);
    assert.equal(merged.errors.length, 3); assert.equal(merged.candidates.length, 3);
  });
  test('network retry classifier', () => {
    const coded = new Error('reset'); coded.code = 'ECONNRESET'; assert.ok(isTransientLlmError(coded));
    assert.ok(isTransientLlmError(new TypeError('fetch failed')));
    const http = new Error('HTTP 500'); http.httpStatus = 500; assert.ok(!isTransientLlmError(http));
  });
  test('auto persona prompt gate hit and control without LLM', () => {
    let called = false;
    const decision = judgeAutoCandidate({ ...base, ui_type: 'persona', fact_body: 'Reply with JSON observations schema' }, () => { called = true; });
    assert.deepEqual(decision, { decision: 'skip', reason: AUTO_PERSONA_PROMPT_REASON });
    assert.equal(called, false);
    assert.equal(autoPersonaPromptDecision({ ...base, ui_type: 'persona', fact_title: '用户偏好简体中文', fact_body: '使用简体中文交流' }), null);
  });
  test('auto temporal status gate hit and title-only control without LLM', () => {
    let called = false;
    const decision = judgeAutoCandidate({ ...base, ui_type: 'experience', fact_title: '画像清理已完成' }, () => { called = true; });
    assert.deepEqual(decision, { decision: 'skip', reason: AUTO_TEMPORAL_STATUS_REASON });
    assert.equal(called, false);
    assert.equal(autoTemporalStatusDecision({ ...base, fact_title: '持久协作约束', fact_body: '本轮已完成' }), null);
  });
  test('auto sensitive gate bypasses LLM', () => {
    let called = false;
    const decision = judgeAutoCandidate({ ...base, fact_title: 'API key 轮换' }, () => { called = true; });
    assert.deepEqual(decision, { decision: 'skip', reason: AUTO_SENSITIVE_REASON });
    assert.equal(called, false);
    assert.equal(autoSensitiveDecision(base), null);
  });
  test('auto judge output validation', () => {
    assert.equal(parseArgs(['auto']).command, 'auto');
    assert.deepEqual(validateAutoDecision({ decision: 'promote', reason: ' 可复用 ' }), { decision: 'promote', reason: '可复用' });
    assert.throws(() => validateAutoDecision({ decision: 'maybe', reason: 'x' }), LlmSchemaError);
    assert.throws(() => validateAutoDecision({ decision: 'skip' }), LlmSchemaError);
  });
  test('auto journal marks intent and outcome', () => {
    const candidate = validateCandidate(base, { ...options, inputPaths: new Set(['08-观察/a.md']) });
    const intent = operationIntent(candidate, 'skip', null, 'auto-llm');
    const outcome = operationOutcome(intent, { ...candidate, status: 'skipped' }, 'skipped');
    assert.equal(intent.decided_by, 'auto-llm'); assert.equal(outcome.decided_by, 'auto-llm');
    assert.ok(!Object.hasOwn(operationIntent(candidate, 'skip'), 'decided_by'));
    assert.equal(recoverOperations([intent], [candidate]).replayOutcomes[0].decided_by, 'auto-llm');
  });
  test('XSS JSON encoding', () => { const value = encodeJsonForHtml({ x: '</script><img onerror=1>\u2028' }); assert.ok(!value.includes('<')); assert.match(value, /\\u003c/); });
  test('journal crash recovery and single outcome', () => {
    const candidate = validateCandidate(base, { ...options, inputPaths: new Set(['08-观察/a.md']) });
    const rejectedCandidate = { ...candidate, candidate_id: 'reject-id' };
    const entries = [{ phase: 'intent', operation_id: 'p', candidate_id: candidate.candidate_id, action: 'promote' }, { phase: 'intent', operation_id: 'r', candidate_id: rejectedCandidate.candidate_id, action: 'reject' }];
    const recovered = recoverOperations(entries, [candidate, rejectedCandidate]);
    assert.equal(recovered.candidates[0].status, 'needs_check'); assert.equal(recovered.candidates[1].status, 'rejected'); assert.equal(recovered.replayOutcomes.length, 1);
    assert.throws(() => recoverOperations([{ phase: 'outcome', operation_id: 'x' }, { phase: 'outcome', operation_id: 'x' }], [candidate]));
    assert.equal(recoverOperations([...entries, { phase: 'intent', operation_id: 'x2', resolves: 'p', candidate_id: candidate.candidate_id, action: 'resolve-retry' }], [candidate]).candidates[0].status, 'pending');
  });
  test('queue protection decided filter and evidence lock', () => {
    const candidate = { ...validateCandidate(base, { ...options, inputPaths: new Set(['08-观察/a.md']) }), status: 'needs_check' };
    assert.throws(() => protectQueue([candidate], false));
    assert.equal(protectQueue([candidate], true).carried.length, 1);
    assert.ok(collectLockedEvidence([candidate]).has('08-观察/a.md'));
    assert.equal(filterDecided([candidate], { [candidate.candidate_id]: { status: 'promoted' } }).length, 0);
    assert.equal(resolveNeedsCheck(candidate, 'retry').evidence_locked, true); assert.equal(resolveNeedsCheck(candidate, 'confirm', '/x').status, 'promoted'); assert.equal(resolveNeedsCheck(candidate, 'reject').status, 'rejected');
  });
  test('brain-write receipt classifications', () => {
    assert.equal(classifyBrainWriteResult({ status: 0, stdout: '{"status":"ok","path":"/x","inbox_redirect":null}' }).status, 'promoted');
    assert.equal(classifyBrainWriteResult({ status: 0, stdout: '{"status":"ok","path":"/x","inbox_redirect":{"reason":"r"}}' }).status, 'redirected');
    assert.equal(classifyBrainWriteResult({ status: 5, stderr: '{"rollback":"partial"}' }).status, 'needs_check');
    assert.equal(classifyBrainWriteResult({ status: 1, stderr: '{"rollback":"rolled-back"}' }).status, 'pending');
  });
  test('per-wing dedup aggregation', () => {
    const commands = buildDedupCommands('Fact'); assert.equal(commands.length, 4);
    commands.forEach(command => { assert.equal(command.args[2], '--room'); assert.equal(command.args[3], command.room); });
    const output = '[1] second_brain / 经验\n Source: A.md\n Match: cosine_sim=0.7\n';
    const result = aggregateDedupRoomResults([{ room: '经验', ok: true, output }, { room: '项目', ok: false, error: 'readonly' }]);
    assert.ok(result.likely_covered); assert.equal(result.top[0].cosine, 0.7);
  });
  let fixtureRoot;
  test('brain-write three-variable isolated fixture', () => { fixtureRoot = selfTestFixture(); assert.ok(fixtureRoot.startsWith(tmpdir() + sep)); });
  process.stdout.write(`SELF-TEST PASS ${tests.length}/${tests.length}\nfixture_root=${fixtureRoot}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') process.stdout.write(usage());
  else if (args.command === 'self-test') selfTest();
  else if (args.command === 'cluster') await cluster(args);
  else if (args.command === 'auto') await auto();
  else await review(args);
}

main().catch(error => { releaseLock(); process.stderr.write(`${error.stack || error.message}\n`); process.exit(1); });

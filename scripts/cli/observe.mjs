#!/usr/bin/env node
import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, unlinkSync, realpathSync,
  openSync, writeSync, closeSync, lstatSync
} from 'node:fs';
import { join, dirname, basename, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadObserveEnv, loadClipEnv } from '../lib/plist-render.mjs';
import { LlmSchemaError, requestJson } from '../lib/llm-json.mjs';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';
import { isClipRejected, assertInsideVault, classifyClipText, classifyClipImage, readClipImage, clipDisposition, rejectPendingClip } from '../lib/clip-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const BRAIN_WRITE = join(__dirname, 'brain-write.mjs');
const CHECKPOINT_PATH = join(VAULT_ROOT, '00-系统', '.index-cache', 'observe-checkpoint.json');
const LOCK_PATH = join(VAULT_ROOT, '00-系统', '.index-cache', 'observe.lock');
const HOME_ROOT = resolve(process.env.BRAIN_HOME_ROOT || homedir());
const ENV_PATH = resolve(process.env.BRAIN_OBSERVE_ENV_PATH || join(HOME_ROOT, '.config', 'second-brain', 'observe.env'));
const CLAUDE_ROOT = resolve(process.env.BRAIN_CLAUDE_SESSIONS_ROOT || join(HOME_ROOT, '.claude', 'projects'));
const CODEX_ROOT = resolve(process.env.BRAIN_CODEX_SESSIONS_ROOT || join(HOME_ROOT, '.codex', 'sessions'));
const CHRONICLE_ROOT = resolve(process.env.BRAIN_CHRONICLE_ROOT || join(HOME_ROOT, '.codex', 'memories', 'extensions', 'chronicle', 'resources'));
const HOME_PATH_PATTERN = HOME_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FILE_PATH_PATTERN = new RegExp(
  '(?:' + HOME_PATH_PATTERN + '|/private/tmp|\\./|\\.\\./)[^\\s"\'`<>]+',
  'g',
);
const PENDING_ROOT = join(VAULT_ROOT, 'raw', 'pending');
const ATTACHMENTS_ROOT = join(VAULT_ROOT, '00-系统', 'attachments');
const MAX_EXTRACT_BYTES = 50 * 1024;
const MIN_AGE_MS = 30 * 60 * 1000;
const VALID_OBSERVATION_TYPES = new Set(['bugfix', 'decision', 'convention', 'exploration', 'status']);
const OBSERVATION_TYPE_ALIASES = new Map([
  ['bug', 'bugfix'], ['fix', 'bugfix'], ['fixes', 'bugfix'],
  ['preference', 'convention'], ['preferences', 'convention'],
  ['research', 'exploration'], ['investigation', 'exploration'],
  ['status-update', 'status'], ['update', 'status'],
]);

class LlmOutputError extends Error {}

function fatal(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function assertObservationStatePath(path) {
  assertInsideVault(path, VAULT_ROOT);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`observe state must be a single-link regular file: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function readObservationLock() {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertObservationStatePath(LOCK_PATH);
      const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
      if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('pid must be a positive integer');
      return lock;
    } catch (err) {
      lastError = err;
      if (attempt === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw new Error(`observe 锁损坏，请人工检查 ${LOCK_PATH}: ${lastError.message}`);
}

function releaseObservationLock() {
  try {
    assertObservationStatePath(LOCK_PATH);
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    if (lock.pid === process.pid) {
      assertObservationStatePath(LOCK_PATH);
      unlinkSync(LOCK_PATH);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      process.stderr.write(`observe lock retained: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

function createObservationLock() {
  assertObservationStatePath(LOCK_PATH);
  const fd = openSync(LOCK_PATH, 'wx');
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
  } finally {
    closeSync(fd);
  }
  process.on('exit', releaseObservationLock);
}

function acquireObservationLock() {
  assertInsideVault(dirname(LOCK_PATH), VAULT_ROOT);
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  try {
    createObservationLock();
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const lock = readObservationLock();
  try {
    process.kill(lock.pid, 0);
    fatal(`另一 observe 实例正在运行（pid ${lock.pid}）`);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }

  assertObservationStatePath(LOCK_PATH);
  unlinkSync(LOCK_PATH);
  try {
    createObservationLock();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const winner = readObservationLock();
    fatal(`另一 observe 实例正在运行（pid ${winner.pid}）`);
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, clips: false, all: false, limit: Infinity, source: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--clips') args.clips = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--source') {
      args.source = argv[++i];
      if (!['sessions', 'chronicle'].includes(args.source)) fatal('--source requires sessions or chronicle');
    }
    else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) fatal('--limit requires a positive integer');
      args.limit = value;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node observe.mjs [--dry-run] [--limit N] [--source sessions|chronicle] [--clips|--all]\n');
      process.exit(0);
    } else {
      fatal(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function walkFiles(root, predicate = () => true) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p, predicate));
    else if (entry.isFile() && predicate(p)) out.push(p);
  }
  return out;
}

function findClaudeTranscripts(root) {
  // Prevent recursive pollution: subagent transcripts contain this pipeline's own prompts.
  return walkFiles(root, p => p.endsWith('.jsonl') && !basename(p).startsWith('agent-'));
}

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function textFromContent(content, role) {
  if (typeof content === 'string') return `${role}: ${content}`;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking' || block.type === 'reasoning') continue;
    if (block.type === 'tool_result') continue;
    if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') {
      const text = block.text || block.content || '';
      if (text) parts.push(`${role}: ${text}`);
    }
  }
  return parts.join('\n');
}

function collectFilePaths(value, out = new Set()) {
  if (typeof value === 'string') {
    const matches = value.match(FILE_PATH_PATTERN) || [];
    for (const m of matches) out.add(m.replace(/[),.;:]+$/, ''));
  } else if (Array.isArray(value)) {
    for (const item of value) collectFilePaths(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/file|path|cwd|workdir/i.test(key) && typeof item === 'string') out.add(item);
      collectFilePaths(item, out);
    }
  }
  return out;
}

function trimExtract(text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_EXTRACT_BYTES) return text;
  const half = Math.floor(MAX_EXTRACT_BYTES / 2);
  return `${buf.subarray(0, half).toString('utf8')}\n[...truncated...]\n${buf.subarray(buf.length - half).toString('utf8')}`;
}

function extractClaudeSession(file) {
  const events = readJsonl(file);
  const parts = [];
  const files = new Set();
  for (const event of events) {
    if (event.isSidechain || event.attachment) continue;
    const msg = event.message || event;
    const role = msg.role || event.type;
    if (role === 'user' || role === 'assistant') {
      const text = textFromContent(msg.content, role);
      if (text) parts.push(text);
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block?.type === 'tool_use') {
        collectFilePaths(block.input, files);
        parts.push(`tool_use: ${block.name || 'unknown'} ${[...collectFilePaths(block.input)].join(' ')}`);
      }
    }
  }
  const rawBytes = statSync(file).size;
  const text = trimExtract(parts.join('\n\n'));
  return { source: 'claude', file, rawBytes, extractedBytes: Buffer.byteLength(text), estimatedTokens: Math.ceil(Buffer.byteLength(text) / 4), text, files: [...files] };
}

function extractCodexSession(file) {
  const events = readJsonl(file);
  const parts = [];
  const files = new Set();
  for (const event of events) {
    const payload = event.payload || {};
    if (event.type === 'session_meta') {
      if (payload.cwd) files.add(payload.cwd);
      parts.push(`session_meta: cwd=${payload.cwd || ''} source=${payload.thread_source || payload.source || ''}`);
      continue;
    }
    if (event.type !== 'response_item') continue;
    const role = payload.role || payload.type;
    const text = textFromContent(payload.content, role);
    if (text) parts.push(text);
    if (payload.type === 'function_call' || payload.type === 'tool_call' || payload.type === 'custom_tool_call') {
      collectFilePaths(payload.arguments || payload.input || payload, files);
      parts.push(`tool_use: ${payload.name || payload.tool_name || 'unknown'} ${[...collectFilePaths(payload.arguments || payload.input || payload)].join(' ')}`);
    }
  }
  const rawBytes = statSync(file).size;
  const text = trimExtract(parts.join('\n\n'));
  return { source: 'codex', file, rawBytes, extractedBytes: Buffer.byteLength(text), estimatedTokens: Math.ceil(Buffer.byteLength(text) / 4), text, files: [...files] };
}

function extractChronicleSummary(file) {
  const text = trimExtract(readFileSync(file, 'utf8'));
  return { source: 'chronicle', file, rawBytes: statSync(file).size, extractedBytes: Buffer.byteLength(text), estimatedTokens: Math.ceil(Buffer.byteLength(text) / 4), text, files: [] };
}

function normalizeCheckpointError(value, mtimeMs) {
  if (typeof value === 'string') return { message: value, attempts: 1, mtimeMs };
  return value;
}

function shouldProcessCandidate(checkpoint, path, mtimeMs) {
  const error = normalizeCheckpointError(checkpoint.errors[path], mtimeMs);
  if (error) checkpoint.errors[path] = error;
  return (!checkpoint.processed[path] || mtimeMs > checkpoint.processed[path])
    && !(error?.attempts >= 3 && error.mtimeMs === mtimeMs);
}

function loadCheckpoint() {
  assertObservationStatePath(CHECKPOINT_PATH);
  if (!existsSync(CHECKPOINT_PATH)) return { processed: {}, errors: {} };
  return JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
}

function saveCheckpoint(checkpoint) {
  assertInsideVault(dirname(CHECKPOINT_PATH), VAULT_ROOT);
  mkdirSync(dirname(CHECKPOINT_PATH), { recursive: true });
  assertObservationStatePath(CHECKPOINT_PATH);
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2) + '\n');
}

function readEnvFile() {
  if (!existsSync(ENV_PATH)) fatal(`Missing env file: ${ENV_PATH}`);
  try {
    return loadObserveEnv(ENV_PATH);
  } catch (error) {
    fatal(error.message);
  }
}

function validateObservations(value) {
  const list = Array.isArray(value) ? value : value?.observations;
  if (!Array.isArray(list)) throw new LlmOutputError('LLM JSON must be an array or {observations: []}');
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new LlmOutputError('observation item must be an object');
    if (!item.title || typeof item.title !== 'string') throw new LlmOutputError('title is required');
    if (typeof item.type !== 'string') throw new LlmOutputError('type must be a string');
    const normalizedType = item.type.toLowerCase();
    item.type = OBSERVATION_TYPE_ALIASES.get(normalizedType) ?? normalizedType;
    if (!VALID_OBSERVATION_TYPES.has(item.type)) throw new LlmOutputError(`invalid type: ${item.type}`);
    if (!Array.isArray(item.facts) || item.facts.length === 0 || item.facts.some(f => !f || typeof f !== 'string')) throw new LlmOutputError('facts must be a non-empty string array');
    if (!Array.isArray(item.files)) throw new LlmOutputError('files must be an array');
    for (const field of ['preference_signals', 'failures']) {
      if (field in item && (!Array.isArray(item[field]) || item[field].some(v => typeof v !== 'string'))) throw new LlmOutputError(`${field} must be a string array`);
    }
    item.title = item.title.slice(0, 80).trim();
    item.facts[0] = item.facts[0].slice(0, 140).trim();
    if (!item.title) throw new LlmOutputError('title is empty after truncation');
    if (!item.facts[0]) throw new LlmOutputError('description is empty after truncation');
    if (item.project !== null && typeof item.project !== 'string') throw new LlmOutputError('project must be string|null');
    if (!item.narrative || typeof item.narrative !== 'string') throw new LlmOutputError('narrative is required');
    if (typeof item.durable_candidate !== 'boolean') throw new LlmOutputError('durable_candidate must be boolean');
  }
  return list;
}

export async function callLlm(extract, env, schemaFeedback) {
  const systemPrompt = 'Extract at most 8 concise second-brain observations. Return JSON {observations:[{title,type,facts,files,project,narrative,durable_candidate,preference_signals?,failures?}]}. Types: bugfix, decision, convention, exploration, status. Every item MUST have non-empty title, non-empty facts (string array with at least one non-empty string), and non-empty narrative of at most 120 words. preference_signals captures user preferences or corrections; failures captures errors and how to do differently.'
    + (extract.source === 'chronicle' ? ' The input is a screen-observation summary: extract only informative work facts and skip pure entertainment or intermission segments.' : '')
    + (schemaFeedback ? ` Previous attempt was rejected: ${schemaFeedback}. Fix exactly that.` : '');
  let data;
  try {
    ({ data } = await requestJson(env, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: extract.text },
    ], { model: env.OBSERVE_MODEL, maxTokens: 8192 }));
    return validateObservations(data);
  } catch (err) {
    if (err instanceof LlmOutputError) throw err;
    if (err instanceof LlmSchemaError) throw new LlmOutputError(err.message);
    throw err;
  }
}

export async function extractWithRetry(extract, env) {
  try {
    return await callLlm(extract, env);
  } catch (first) {
    if (!(first instanceof LlmOutputError)) throw first;
    try {
      const reduced = /finish_reason=length|empty content|Unterminated|Unexpected end/i.test(first.message)
        ? `${first.message}. Return at most 4 observations, only the most important ones, narratives under 60 words`
        : first.message;
      return await callLlm(extract, env, reduced);
    } catch (second) {
      if (!(second instanceof LlmOutputError)) throw second;
      throw new LlmOutputError(`${first.message}; retry failed: ${second.message}`);
    }
  }
}

function observationSubfolder(sourceFile, source) {
  if (source === 'chronicle') {
    const match = basename(sourceFile).match(/^(\d{4})-(\d{2})-\d{2}T/);
    if (!match) throw new Error(`Invalid Chronicle filename timestamp: ${basename(sourceFile)}`);
    return `chronicle-${match[1]}-${match[2]}`;
  }
  const date = new Date(statSync(sourceFile).mtimeMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function argSafe(value, fallback) {
  const v = String(value ?? '').replace(/^[-\s]+/, '').trim();
  return v || fallback;
}

function renderObservationBody(item) {
  return [
    item.facts.map(f => `- ${f}`).join('\n'),
    item.preference_signals?.length ? `偏好信号：\n${item.preference_signals.map(v => `- ${v}`).join('\n')}` : '',
    item.failures?.length ? `失败与改法：\n${item.failures.map(v => `- ${v}`).join('\n')}` : '',
    item.narrative,
  ].filter(Boolean).join('\n\n');
}

function writeObservation(item, candidate) {
  const subfolder = observationSubfolder(candidate.p, candidate.source);
  const body = renderObservationBody(item);
  const tags = [item.type];
  if (item.durable_candidate) tags.push('durable-candidate');
  if (candidate.source === 'chronicle') tags.push('chronicle');
  const args = [
    BRAIN_WRITE,
    '--type', 'observation',
    '--subfolder', subfolder,
    '--durability', 'ephemeral',
    '--title', argSafe(item.title, '观察'),
    '--description', argSafe(item.facts[0], '观察'),
    '--tags', tags.join(','),
    '--source', 'observe',
    '--provenance', candidate.source === 'chronicle'
      ? `chronicle ${basename(candidate.p)} via observe.mjs`
      : `session ${basename(candidate.p)} via observe.mjs`,
  ];
  if (item.files.length) args.push('--files', item.files.join(','));
  const result = spawnSync(process.execPath, args, { input: body, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `brain-write exited ${result.status}`);
}

function sessionsToProcess(limit, sourceFilter = null) {
  const checkpoint = loadCheckpoint();
  const now = Date.now();
  const candidates = [
    ...findClaudeTranscripts(CLAUDE_ROOT).map(p => ({ p, source: 'sessions', parser: 'claude' })),
    ...walkFiles(CODEX_ROOT).map(p => ({ p, source: 'sessions', parser: 'codex' })),
    ...walkFiles(CHRONICLE_ROOT, p => p.endsWith('-10min-memory-summary.md')).map(p => ({ p, source: 'chronicle', parser: 'chronicle' })),
  ].filter(candidate => !sourceFilter || candidate.source === sourceFilter).filter(({ p, source }) => {
    const st = statSync(p);
    return (source === 'chronicle' || now - st.mtimeMs > MIN_AGE_MS)
      && shouldProcessCandidate(checkpoint, p, st.mtimeMs);
  }).sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs);
  return { checkpoint, candidates: candidates.slice(0, limit) };
}

function clipTimestamp(name, data) {
  const raw = data.timestamp || data.created_at || data.createdAt || data.time || name.slice(0, 23);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function parseClip(file) {
  const bytes = readFileSync(file);
  const data = JSON.parse(bytes);
  const ts = clipTimestamp(basename(file), data);
  const text = data.text || data.markdown || data.llm?.ocr_text || data.ocr_text || data.ocrText || data.content || data.summary || '';
  const summary = data.summary || data.llm?.summary || '';
  const image = data.image_path || data.imagePath || data.path || data.file || data.localPath || null;
  const isImage = !!image && /\.(png|jpe?g|webp|gif)$/i.test(image);
  const rawConfidence = Number(data.llm?.confidence ?? data.confidence ?? 0);
  const confidence = Number.isFinite(rawConfidence) ? (rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence) : 100;
  const rawTitle = data.llm?.title || data.title || summary || text.split('\n').find(Boolean) || `剪藏 ${basename(file, '.json')}`;
  const title = String(rawTitle).split('\n')[0].replace(/\s+/g, ' ').replace(/^[\s.?!,;:、。？！，；：·]+/, '').trim() || `剪藏 ${basename(file, '.json')}`;
  const subfolder = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`;
  return { file, data, sha256: createHash('sha256').update(bytes).digest('hex'), ts, text, summary, image, isImage, confidence, title: title.slice(0, 80), subfolder };
}

function writeClipObservation(clip) {
  const tags = ['clip'];
  if (clip.confidence < 60) tags.push('low-confidence');
  let attachmentRel = null;
  let imageMissing = false;
  if (clip.isImage) {
    const source = resolve(VAULT_ROOT, clip.image);
    assertInsideVault(source, VAULT_ROOT);
    assertInsideVault(ATTACHMENTS_ROOT, VAULT_ROOT);
    if (existsSync(source)) {
      const target = join(ATTACHMENTS_ROOT, `${basename(clip.file, '.json')}${extname(clip.image)}`);
      assertInsideVault(target, VAULT_ROOT);
      attachmentRel = `00-系统/attachments/${basename(target)}`;
    } else {
      imageMissing = true;
      tags.push('missing-image');
    }
  }
  const body = [
    clip.summary,
    clip.text,
    attachmentRel ? `![[${attachmentRel}]]` : '',
    imageMissing ? '（原始截图文件已缺失，仅存分类元数据）' : '',
  ].filter(Boolean).join('\n\n') || clip.title;
  const args = [
    BRAIN_WRITE,
    '--type', 'observation',
    '--subfolder', clip.subfolder,
    '--durability', 'ephemeral',
    '--title', argSafe(clip.title, '剪藏观察'),
    '--description', argSafe(clip.summary || clip.text.slice(0, 120), '剪藏观察'),
    '--tags', tags.join(','),
    '--source', 'observe',
    '--provenance', `clip ${basename(clip.file)} via observe.mjs`,
    '--clip-id', basename(clip.file, '.json'),
    '--clip-sha256', clip.sha256,
  ];
  if (attachmentRel) args.push('--files', attachmentRel);
  if (clip.imageReviewSha) args.push('--clip-image-sha256', clip.imageReviewSha);
  const result = spawnSync(process.execPath, args, { input: body, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `brain-write exited ${result.status}`);
  const receipt = JSON.parse(result.stdout);
  if (receipt.status !== 'ok' || typeof receipt.path !== 'string') throw new Error('Invalid brain-write receipt');
  assertInsideVault(receipt.path, VAULT_ROOT);
  return receipt;
}

async function runSessions(args) {
  const { checkpoint, candidates } = sessionsToProcess(args.limit, args.source);
  const env = args.dryRun ? null : readEnvFile();
  const stats = { mode: 'sessions', dryRun: args.dryRun, sessions: 0, sessionsCount: 0, chronicleCount: 0, rawBytes: 0, extractedBytes: 0, estimatedTokens: 0, observations: 0, errors: {}, parsed: [] };
  for (const candidate of candidates) {
    const extract = candidate.parser === 'claude' ? extractClaudeSession(candidate.p)
      : candidate.parser === 'codex' ? extractCodexSession(candidate.p)
        : extractChronicleSummary(candidate.p);
    stats.sessions += 1;
    stats[candidate.source === 'chronicle' ? 'chronicleCount' : 'sessionsCount'] += 1;
    stats.rawBytes += extract.rawBytes;
    stats.extractedBytes += extract.extractedBytes;
    stats.estimatedTokens += extract.estimatedTokens;
    if (args.dryRun) {
      stats.parsed.push({ file: candidate.p, source: candidate.source, subfolder: observationSubfolder(candidate.p, candidate.source), rawBytes: extract.rawBytes, extractedBytes: extract.extractedBytes });
      continue;
    }
    let writtenCount = 0;
    try {
      const observations = await extractWithRetry(extract, env);
      for (const item of observations) {
        writeObservation(item, candidate);
        writtenCount += 1;
      }
      stats.observations += observations.length;
      checkpoint.processed[candidate.p] = statSync(candidate.p).mtimeMs;
      delete checkpoint.errors[candidate.p];
      saveCheckpoint(checkpoint);
    } catch (err) {
      if (!(err instanceof LlmOutputError)) {
        if (writtenCount >= 1) {
          const mtimeMs = statSync(candidate.p).mtimeMs;
          const previous = normalizeCheckpointError(checkpoint.errors[candidate.p], mtimeMs);
          checkpoint.processed[candidate.p] = mtimeMs;
          checkpoint.errors[candidate.p] = {
            message: `partial: wrote ${writtenCount}; ${err.message}`,
            attempts: previous?.mtimeMs === mtimeMs ? previous.attempts + 1 : 1,
            mtimeMs,
          };
          saveCheckpoint(checkpoint);
        }
        throw err;
      }
      const message = err.message.split('\n')[0];
      const mtimeMs = statSync(candidate.p).mtimeMs;
      const previous = normalizeCheckpointError(checkpoint.errors[candidate.p], mtimeMs);
      checkpoint.errors[candidate.p] = { message, attempts: previous?.mtimeMs === mtimeMs ? previous.attempts + 1 : 1, mtimeMs };
      stats.errors[candidate.p] = message;
      saveCheckpoint(checkpoint);
    }
  }
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
}

async function runClips(args) {
  const checkpoint = loadCheckpoint();
  const names = existsSync(PENDING_ROOT)
    ? readdirSync(PENDING_ROOT).filter(n => n.endsWith('.json')).sort()
    : [];
  const cursor = typeof checkpoint.clipsCursor === 'string' ? checkpoint.clipsCursor : '';
  const ordered = [...names.filter(name => name > cursor), ...names.filter(name => name <= cursor)];
  const files = ordered.slice(0, args.limit).map(name => join(PENDING_ROOT, name));
  const stats = { mode: 'clips', dryRun: args.dryRun, clips: 0, observations: 0, rejected: 0, held: 0, errors: {}, parsed: [] };
  for (const file of files) {
    try {
      if (isClipRejected(basename(file, '.json'), VAULT_ROOT)) continue;
      const clip = parseClip(file);
      const source = clip.isImage ? readClipImage(resolve(VAULT_ROOT, clip.image), VAULT_ROOT) : clip.text;
      if (clip.isImage) clip.imageReviewSha = createHash('sha256').update(source).digest('hex');
      let decision = clipDisposition(clip.data.llm, source);
      stats.clips += 1;
      const parsed = { file, title: clip.title, subfolder: clip.subfolder, isImage: clip.isImage, confidence: clip.confidence, textBytes: Buffer.byteLength(clip.text || ''), decision: decision.action, reason: decision.reason };
      stats.parsed.push(parsed);
      if (args.dryRun) continue;
      if (decision.action === 'review') {
        const llm = clip.isImage ? await classifyClipImage(source, loadClipEnv()) : await classifyClipText(source, loadClipEnv());
        decision = clipDisposition(llm, source);
        clip.title = llm.title || clip.title;
        clip.summary = llm.summary || clip.summary;
        clip.confidence = llm.confidence * 100;
        if (clip.isImage) clip.text = llm.ocr_text || '';
        Object.assign(parsed, { title: clip.title, decision: decision.action, reason: decision.reason });
      }
      if (clip.isImage && !readClipImage(resolve(VAULT_ROOT, clip.image), VAULT_ROOT).equals(source)) throw new Error('图片在审阅后发生变化；保留候选重新审阅');
      if (decision.action === 'reject') {
        rejectPendingClip(BRAIN_WRITE, basename(file, '.json'), 'observe', decision.reason, clip.imageReviewSha);
        stats.rejected += 1;
        continue;
      }
      if (decision.action !== 'accept') { stats.held += 1; continue; }
      writeClipObservation(clip);
      stats.observations += 1;
    } catch (err) {
      stats.errors[file] = err.message.split('\n')[0];
    } finally {
      if (!args.dryRun) {
        checkpoint.clipsCursor = basename(file);
        saveCheckpoint(checkpoint);
      }
    }
  }
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  if (Object.keys(stats.errors).length) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun) acquireObservationLock();
  if (args.all) {
    await runSessions(args);
    await runClips(args);
  } else if (args.clips) await runClips(args);
  else await runSessions(args);
}

export { extractClaudeSession, extractCodexSession, extractChronicleSummary, findClaudeTranscripts, normalizeCheckpointError, observationSubfolder, parseClip, renderObservationBody, saveCheckpoint, shouldProcessCandidate, trimExtract, validateObservations };

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(__filename)) {
  main();
}

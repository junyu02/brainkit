#!/usr/bin/env node
// brain-write.mjs -- Write a memory entry to the Second Brain vault
// Automates: dedup (3-round) + routing + frontmatter + file write + MEMORY.md index update
//
// Mode A (CLI flags + stdin body):
//   echo "body text" | node brain-write.mjs --type experience --title "foo" --description "bar"
//   echo "body text" | node brain-write.mjs --type experience --subfolder AI工具 --title "foo" --description "bar"
//
// Mode B (JSON stdin):
//   echo '{"type":"experience","title":"foo","body":"bar","description":"baz"}' | node brain-write.mjs --json
//   echo '{"type":"experience","subfolder":"AI工具","title":"foo","body":"bar","description":"baz"}' | node brain-write.mjs --json
//
// Mode C (utility flags):
//   node brain-write.mjs --verify        # Check index health (dead links, duplicates, etc.)
//   node brain-write.mjs --dry-run ...   # Preview write without touching any files

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync,
  statSync, lstatSync, fstatSync, realpathSync, renameSync, unlinkSync,
  openSync, readSync, writeSync, closeSync, fsyncSync, linkSync, constants
} from 'node:fs';
import { resolve, join, dirname, basename, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';
import { clipStatePaths, isClipRejected } from '../lib/clip-utils.mjs';
import { listStructuredNotes, readActiveNote } from '../lib/memory-read.mjs';
import { parseRecord, parseCandidate, validateSources, assertRecordRevision, redactCredentials } from '../lib/memory-records.mjs';
import { parseEvent } from '../lib/memory-ingestion.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

function realpathOrSelf(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

// Env overrides exist so tests can run against a fixture vault without touching the real one.
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
// ~/Desktop/second-brain is a symlink into iCloud; compare escape checks against the real path.
const VAULT_REAL = realpathOrSelf(VAULT_ROOT);

const ROUTING_JSON  = BRAINKIT.routing;
const PROJECT_MAP   = join(VAULT_ROOT, '00-系统', '.project-map.json');
const MEMORY_DIR    = BRAINKIT.memory;
const MEMORY_REAL   = realpathOrSelf(MEMORY_DIR);
const MEMORY_MD     = join(MEMORY_DIR, 'MEMORY.md');

// P0: intent-map file path
const INTENT_MAP_PATH = join(VAULT_ROOT, '00-系统', '.index-cache', 'intent-map.json');
const EVICTION_LOG_CAPACITY = 50;

// Phase 4: shared write pipeline for multiple supervisors (claude / codex)
const LEDGER_PATH   = join(VAULT_ROOT, '00-系统', 'logs', 'brain-write-ledger.jsonl');
const LOCK_PATH     = join(VAULT_ROOT, '00-系统', '.index-cache', 'brain-write.lock');
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS  = Number(process.env.BRAIN_LOCK_WAIT_MS) || 15_000;
const DEFAULT_SOURCE = 'claude';
const EDITABLE_SECTIONS = new Set([
  '01-项目', '02-知识', '03-经验', '04-对话', '05-persona', '07-随笔', '09-周报',
]);
const MAX_APPEND_BYTES = 64 * 1024;
const MAX_NOTE_BYTES = 16 * 1024 * 1024;

const VALID_TYPES   = ['feedback', 'experience', 'project', 'reference', 'user-profile', 'session', 'note', 'observation', 'weekly'];
const PROJECT_SCOPED = ['project', 'session'];

// Domain index files (relative names, resolved against MEMORY_DIR)
const DOMAIN_INDEX_FILES = [
  'MEMORY.md',
  'MEMORY-knowledge.md',
  'MEMORY-experience.md',
  'MEMORY-project.md',
  'MEMORY-persona.md',
  'MEMORY-archive.md',
  'MEMORY-notes.md',
];

// Stop words for keyword extraction (common Chinese and English filler words)
const STOP_WORDS = new Set([
  '的', '是', '在', '了', '和', '与', '或', '及', '对', '从', '到', '为',
  '上', '下', '中', '内', '外', '前', '后', '方案', '问题', '总结', '分析',
  '介绍', '说明', '记录', '备注', '关于', '使用', '通过', '如何', '如果',
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'has',
  'have', 'had', 'do', 'does', 'did', 'not', 'this', 'that', 'these',
]);

// Noise-filter patterns for keyword extraction
const STOP_WORD_PATTERNS = [
  /^\d+$/,                                         // pure digits (already had this elsewhere)
  /^[\p{P}\p{S}]+$/u,                              // pure punctuation/symbols (Unicode categories)
  /^[\-=_*#`~|<>]+$/,                              // markdown symbols
  /^[!@#$%^&*()\[\]{}<>,.?/:;"'`|\\+=_\-]+$/,     // ASCII punctuation combos
];

const STOP_WORD_PREFIXES = ['"', '$', '`', '/', '\\', '#', "'", '（', '）', '「', '」', '『', '』', '【', '】', '《', '》', '的', '了', '是', '在'];
const STOP_WORD_SUFFIXES = ['）', '」', '』', '】', '》', '。', '，', '、', '；', '：'];

function isStopword(token) {
  if (!token || token.length < 2) return true;
  for (const p of STOP_WORD_PATTERNS) {
    if (p.test(token)) return true;
  }
  for (const prefix of STOP_WORD_PREFIXES) {
    if (token.startsWith(prefix)) return true;
  }
  for (const suffix of STOP_WORD_SUFFIXES) {
    if (token.endsWith(suffix)) return true;
  }
  // token contains >50% non-letter non-CJK characters → skip
  const letters = token.replace(/[^\p{L}\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff]/gu, '');
  if (letters.length < token.length / 2) return true;
  return false;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// 凭据脱敏闸（2026-08-21）：所有 source 的写入在落盘前过此闸。
// 定义在 memory-records.mjs，连接器要先脱敏再算 data_sha256，两边必须同一套规则。

function fatal(msg, code = 1) {
  process.stderr.write(JSON.stringify({ status: 'error', message: msg }) + '\n');
  process.exit(code);
}

class InputError extends Error {}

function readStdin() {
  try {
    return readFileSync('/dev/stdin', 'utf8').trim();
  } catch {
    return '';
  }
}

// --------------------------------------------------------------------------
// Path containment
// --------------------------------------------------------------------------

/**
 * realpathDeep(p) -> string
 * Resolves symlinks on the deepest existing ancestor of p, then re-appends the
 * not-yet-created tail. Needed because realpathSync throws on missing paths, and
 * a symlinked parent dir is exactly how a write escapes the vault.
 */
function realpathDeep(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  cur = realpathOrSelf(cur);
  return tail.length ? join(cur, ...tail) : cur;
}

function isInsideVault(p) {
  const real = realpathDeep(p);
  return real === VAULT_REAL || real.startsWith(VAULT_REAL + sep);
}

/** Throws on any path that resolves outside the vault (`..`, absolute, symlink escape). */
function assertInsideVault(p, label) {
  if (!isInsideVault(p)) {
    throw new Error(
      `Path escape rejected (${label}): ${p} resolves to ${realpathDeep(p)}, outside vault ${VAULT_REAL}`
    );
  }
}

// --------------------------------------------------------------------------
// Ledger (append-only JSONL audit trail, no body content)
// --------------------------------------------------------------------------

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function assertLedgerFile() {
  assertInsideVault(LEDGER_PATH, 'ledger');
  const metadata = rawPathStat(join(VAULT_REAL, relative(VAULT_ROOT, LEDGER_PATH)), VAULT_REAL);
  if (metadata && (!metadata.isFile() || metadata.nlink !== 1)) {
    throw new Error('ledger must be a single-link regular file');
  }
}

function writeLedger(entry, required = false) {
  try {
    assertLedgerFile();
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    const fd = openSync(LEDGER_PATH, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const held = fstatSync(fd), leaf = lstatSync(LEDGER_PATH);
      if (!held.isFile() || held.nlink !== 1 || held.dev !== leaf.dev || held.ino !== leaf.ino) throw new Error('ledger changed while opening');
      assertLedgerFile();
      appendFileSync(fd, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  } catch (err) {
    if (required) throw new Error(`ledger append failed: ${err.message}`);
    process.stderr.write(`[warn] ledger append failed: ${err.message}\n`);
  }
}

// --------------------------------------------------------------------------
// Single-writer lock (cross-process; claude and codex share this pipeline)
// --------------------------------------------------------------------------

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock() {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = rawBytes(join(VAULT_REAL, relative(VAULT_ROOT, LOCK_PATH)), VAULT_REAL, true, 64 * 1024).toString('utf8');
      let lock;
      try {
        lock = JSON.parse(raw);
      } catch (err) {
        err.legacyFormat = true;
        throw err;
      }
      if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
        throw new Error('lock must be a JSON object');
      }
      if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('pid must be a positive integer');
      return lock;
    } catch (err) {
      lastError = err;
      if (attempt === 0) sleepSync(100);
    }
  }
  throw lastError;
}

function createLock(path = LOCK_PATH) {
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
  } catch (err) {
    try { unlinkSync(path); } catch { /* creation did not publish a usable lock */ }
    throw err;
  } finally {
    closeSync(fd);
  }

  let released = false;
  const release = () => {
    if (released) return;
    try {
      const lock = JSON.parse(readFileSync(path, 'utf8'));
      if (lock.pid === process.pid) unlinkSync(path);
    } catch {
      // Missing or unreadable locks stay available for recovery or manual inspection.
    }
    released = true;
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}


const DARWIN_O_EXLOCK = 0x20;
const DARWIN_O_UNIQUE = 0x2000;

/**
 * Serializes stale-owner inspection and replacement.
 * Darwin releases O_EXLOCK when a process is killed, so an orphaned gate file
 * remains reusable. The gate is never written and cannot mutate linked content.
 */
function acquireTakeoverClaim() {
  const path = LOCK_PATH + '.takeover';
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK |
        constants.O_NOFOLLOW | DARWIN_O_EXLOCK | DARWIN_O_UNIQUE,
      0o600,
    );
  } catch (err) {
    if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') err.code = 'EEXIST';
    throw err;
  }

  try {
    const held = fstatSync(fd);
    if (!held.isFile() || held.nlink !== 1) {
      const err = new Error('takeover gate must be a single-link regular file');
      err.code = 'EINVAL';
      throw err;
    }
  } catch (err) {
    try { closeSync(fd); } catch { /* preserve the original validation error */ }
    throw err;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try {
      const held = fstatSync(fd);
      const current = lstatSync(path);
      if (held.dev === current.dev && held.ino === current.ino) unlinkSync(path);
    } catch {
      // The kernel lock is authoritative; a missing/replaced path is not ours to remove.
    }
    try { closeSync(fd); } catch { /* release is idempotent and best-effort on exit */ }
  };
  process.once('exit', release);
  return release;
}

function takeOverLock() {
  try {
    unlinkSync(LOCK_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    return createLock();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    fatal('Lock busy: another writer holds ' + LOCK_PATH + ' (waited ' + LOCK_WAIT_MS + 'ms)', 6);
  }
}

/** Acquires the vault write lock. Returns a release function. */
function acquireLock() {
  rawPathStat(join(VAULT_REAL, relative(VAULT_ROOT, LOCK_PATH)), VAULT_REAL);
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return createLock();
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    let releaseClaim;
    try {
      releaseClaim = acquireTakeoverClaim();
    } catch (err) {
      if (err.code !== 'EEXIST') {
        fatal('Lock corrupt: ' + LOCK_PATH + '.takeover must be a single-link regular file (' + err.message + ')', 6);
      }
      if (Date.now() >= deadline) {
        fatal('Lock busy: another writer holds ' + LOCK_PATH + ' (waited ' + LOCK_WAIT_MS + 'ms)', 6);
      }
      sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
      continue;
    }

    try {
      let lock;
      try {
        lock = readLock();
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        // O_EXCL publishes the inode before its short JSON payload is visible
        // to another process. Treat only that bounded creation interval as busy;
        // after the normal lock deadline malformed locks still fail closed.
        if ((err.legacyFormat || /raw input must be a bounded regular file/.test(err.message)) && Date.now() < deadline) {
          sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
          continue;
        }
        if (err.legacyFormat) {
          try {
            if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
              // Migration-only compatibility for pre-JSON locks; remove next writer version.
              return takeOverLock();
            }
          } catch (statErr) {
            if (statErr.code === 'ENOENT') continue;
            throw statErr;
          }
        }
        fatal('Lock corrupt: ' + LOCK_PATH + ' must contain JSON with a positive integer pid (' + err.message + ')', 6);
      }

      let dead = false;
      try {
        process.kill(lock.pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') dead = true;
        else if (err.code !== 'EPERM') fatal('Lock probe failed for pid ' + lock.pid + ': ' + err.message, 6);
      }
      if (dead) return takeOverLock();
    } finally {
      releaseClaim();
    }

    if (Date.now() >= deadline) {
      fatal('Lock busy: another writer holds ' + LOCK_PATH + ' (waited ' + LOCK_WAIT_MS + 'ms)', 6);
    }
    sleepSync(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

// --------------------------------------------------------------------------
// Journal: CAS-checked atomic writes + best-effort rollback
// --------------------------------------------------------------------------

// path -> { before: string|null, expect: string|null }
// `before` is the content at first touch (null = file did not exist) and drives rollback.
// `expect` is the sha we last observed/wrote; a mismatch means someone raced us.
const journal = new Map();
let stageClipWrites = false;

function readTracked(path) {
  if (stageClipWrites && journal.has(path)) return journal.get(path).after;
  const content = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (!journal.has(path)) {
    journal.set(path, { before: content, after: content, expect: content === null ? null : sha256(content) });
  }
  return content;
}

/** Atomic write (tmp + rename) guarded by a compare-and-swap against the last seen sha. */
function writeTracked(path, content) {
  if (stageClipWrites) {
    if (!journal.has(path)) readTracked(path);
    journal.get(path).after = content;
    return;
  }
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const curSha = cur === null ? null : sha256(cur);
  const rec = journal.get(path);
  if (rec) {
    if (curSha !== rec.expect) {
      throw new Error(`CAS abort: ${path} changed on disk since it was read (expected ${rec.expect}, found ${curSha})`);
    }
  } else {
    journal.set(path, { before: cur, expect: curSha });
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  journal.get(path).expect = sha256(content);
}

/** Restores every journalled file to its pre-run content. Returns paths that could not be restored. */
function rollbackJournal() {
  if (stageClipWrites) { journal.clear(); return []; }
  const failed = [];
  for (const [path, rec] of journal) {
    try {
      const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (rec.before === null && current === null) continue;
      const currentSha = current === null ? null : sha256(current);
      if (currentSha !== rec.expect) {
        failed.push(`${path}: CAS abort during rollback (expected ${rec.expect}, found ${currentSha})`);
        continue;
      }
      if (rec.before === null) {
        if (existsSync(path)) unlinkSync(path);
      } else {
        writeTracked(path, rec.before);
      }
    } catch (err) {
      failed.push(`${path}: ${err.message}`);
    }
  }
  return failed;
}

// Options taking a value. An unknown --flag used to fall through to readStdin() and hang
// the process waiting for EOF (the `--content` trap), so parsing is now strict.
const VALUE_OPTIONS = new Set([
  'type', 'title', 'description', 'body', 'subfolder', 'project', 'tags', 'scope', 'source',
  'append', 'undo', 'expected-sha256', 'expected-after-sha256', 'provenance',
  'durability', 'expires', 'files', 'reject-clip', 'clip-id', 'clip-sha256', 'clip-image-sha256', 'reason',
  'revise', 'deactivate', 'restore', 'resume-maintenance', 'rename', 'new-title', 'repair-index-link', 'to',
  'import-raw', 'raw-subfolder', 'import-folder', 'folder-name', 'request-id', 'request-context-sha256',
  'bind-sync-request', 'finish-sync-request',
]);
const BOOL_OPTIONS = new Set([
  'help', 'json', 'force-new', 'verify', 'dry-run', 'show-route',
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) {
      fatal(`Unexpected positional argument "${arg}". See --help.`, 1);
    }
    const key = arg.slice(2);
    if (BOOL_OPTIONS.has(key)) {
      args[key === 'force-new' ? 'forceNew' : key === 'dry-run' ? 'dryRun' : key === 'show-route' ? 'showRoute' : key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) {
      fatal(`Unknown option "${arg}". Known options: ${[...BOOL_OPTIONS, ...VALUE_OPTIONS].map(o => '--' + o).join(', ')}`, 1);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      fatal(`Option "${arg}" requires a value.`, 1);
    }
    args[key] = argv[++i];
  }
  return args;
}

function relativeRoute(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new InputError(`${label} must be a nonempty relative path`);
  value = value.trim();
  if (/^(?:[\\/]|[A-Za-z]:)/.test(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new InputError(`Path escape rejected: ${label} must stay inside its routed section`);
  }
  return value;
}

function resolveWriteDir(absDir, subfolder) {
  if (subfolder) {
    const value = relativeRoute(subfolder, 'subfolder');
    const target = join(absDir, value), rel = relative(realpathDeep(absDir), realpathDeep(target));
    if (rel === '..' || rel.startsWith(`..${sep}`) || /^(?:[\\/]|[A-Za-z]:)/.test(rel)) {
      throw new InputError('Path escape rejected: subfolder resolves outside its routed section');
    }
    return target;
  }
  return absDir;
}

function recallStateFor(writeDir) {
  const section = relative(VAULT_ROOT, writeDir).replace(/\\/g, '/').split('/')[0];
  if (section === '99-inbox') return 'pending_classification';
  if (section === '04-对话' || section === '08-观察') return 'excluded_default_recall';
  return 'eligible';
}

function sanitizeFilename(title) {
  // Replace filesystem-unsafe characters with dash, trim edges
  return title.replace(/[/\\:*?"<>|]/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

function extractKeywords(title) {
  // Split on spaces, dashes, underscores, CJK boundaries
  const tokens = title
    .replace(/[-_\s]+/g, ' ')
    .split(' ')
    .flatMap(t => {
      // Split CJK runs into individual characters for mixed titles
      const cjk = t.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || [];
      const latin = t.replace(/[\u4e00-\u9fff\u3400-\u4dbf]+/g, ' ').split(/\s+/);
      return [...cjk, ...latin];
    })
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t) && !isStopword(t));

  // Deduplicate, take up to 3
  return [...new Set(tokens)].slice(0, 3);
}

function extractKeywordsExtended(title, tags) {
  // Extended keyword extraction: title tokens + all tags (for intent-map)
  const titleTokens = title
    .replace(/[-_\s]+/g, ' ')
    .split(' ')
    .flatMap(t => {
      const cjk = t.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]+/g) || [];
      const latin = t.replace(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]+/g, ' ').split(/\s+/);
      // Also split on non-alphanumeric (catches CamelCase, separators)
      return [...cjk, ...latin];
    })
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()) && !isStopword(t));

  const tagTokens = (tags || [])
    .map(t => t.trim())
    .filter(t => t.length >= 1 && !isStopword(t));

  return [...new Set([...titleTokens, ...tagTokens])];
}

function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function normalizeFiles(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map(f => String(f).trim()).filter(Boolean);
}

function validateSha256(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new InputError(`${label} must be a 64-character SHA-256`);
  }
  return normalized;
}

function validateSource(value) {
  const source = String(value || DEFAULT_SOURCE);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(source)) {
    throw new InputError('source contains unsupported characters');
  }
  return source;
}

function resolveEditableTarget(rawTarget, sections = EDITABLE_SECTIONS) {
  if (!rawTarget) throw new InputError('append target is required');
  const requested = resolve(VAULT_ROOT, rawTarget);
  try { assertInsideVault(requested, 'append target'); }
  catch (err) { throw new InputError(err.message); }
  let metadata;
  try { metadata = lstatSync(requested); }
  catch (err) { throw new InputError(`append target is unavailable: ${err.message}`); }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new InputError('append target must be an existing regular Markdown file, not a symlink');
  }
  const targetPath = realpathSync(requested);
  assertInsideVault(targetPath, 'append target');
  const targetRelative = relative(VAULT_REAL, targetPath);
  const [section] = targetRelative.split(sep);
  if (!sections.has(section) || extname(targetPath).toLowerCase() !== '.md') {
    throw new InputError('append target must be a Markdown note inside an editable memory section');
  }
  if (metadata.size > MAX_NOTE_BYTES) {
    throw new InputError(`target note exceeds ${MAX_NOTE_BYTES} bytes`);
  }
  return { targetPath, targetRelative: targetRelative.split(sep).join('/') };
}

function buildAppendBlock(body, provenance, source, operationId) {
  const delta = String(body || '').trim();
  const origin = String(provenance || '').trim();
  if (!delta) throw new InputError('append body must not be empty');
  if (!origin) throw new InputError('provenance must not be empty');
  if (delta.includes('\0') || origin.includes('\0')) {
    throw new InputError('append body and provenance must not contain NUL');
  }
  const block =
    `\n\n## 补充（${today()}）\n\n${delta}\n\n` +
    `Provenance: ${origin}\n` +
    `<!-- brain-write operation_id=${operationId} source=${source} -->\n`;
  if (Buffer.byteLength(block, 'utf8') > MAX_APPEND_BYTES) {
    throw new InputError(`append block exceeds ${MAX_APPEND_BYTES} bytes`);
  }
  return block;
}

function readLedgerEntries() {
  if (!existsSync(LEDGER_PATH)) return [];
  assertLedgerFile();
  return readFileSync(LEDGER_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      let entry;
      try { entry = JSON.parse(line); }
      catch { throw new Error(`ledger line ${index + 1} is invalid JSON`); }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`ledger line ${index + 1} is not an object`);
      }
      return entry;
    });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function requestId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new InputError('request_id must be a UUIDv4');
  return value.toLowerCase();
}

function requestContextSha256(value, id) {
  if (value === undefined || value === null) return null;
  if (!id) throw new InputError('request_context_sha256 requires request_id');
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new InputError('request_context_sha256 must be a SHA-256 hex digest');
  return value.toLowerCase();
}

function requestFingerprint(action, value) {
  return sha256(stableJson({ action, value }));
}

function idempotentReceipt(actor, id, hash) {
  if (!id) return null;
  const matches = readLedgerEntries().filter(entry => entry.actor === actor && entry.request_id === id);
  if (!matches.length) return null;
  const entry = matches.find(candidate => candidate.status === 'ok' && candidate.request_hash === hash && candidate.idempotency_receipt);
  if (entry) return entry.idempotency_receipt;
  if (matches.some(candidate => candidate.request_hash && candidate.request_hash !== hash)) throw new InputError('idempotency_conflict: request_id was already used with different payload');
  throw new InputError(`needs_check: request_id ${id} has no replayable successful receipt`);
}

function idempotencyFields(id, hash, receipt, context) {
  return id ? { request_id: id, request_hash: hash, idempotency_receipt: receipt, ...(context ? { request_context_sha256: context } : {}) } : {};
}

function syncRequest(args) {
  const actor = validateSource(args.source), id = requestId(args['bind-sync-request'] || args['finish-sync-request']);
  const context = requestContextSha256(args['request-context-sha256'], id);
  if (!args.source || !id || !context || args['request-id'] && requestId(args['request-id']) !== id) throw new InputError('sync request requires source, UUID and request context');
  const release = acquireLock();
  try {
    const previous = readLedgerEntries().filter(row => row.actor === actor && row.request_id === id);
    if (previous.some(row => !['bind-sync-request', 'finish-sync-request'].includes(row.action) || row.request_context_sha256 !== context)) throw new InputError('idempotency_conflict: sync request context changed');
    const completed = previous.findLast(row => row.action === 'finish-sync-request');
    if (completed) return { status: 'ok', sync_receipt: completed.sync_receipt };
    if (args['bind-sync-request']) {
      if (!previous.length) writeLedger({ status: 'ok', action: 'bind-sync-request', actor, request_id: id, request_context_sha256: context }, true);
      return { status: 'ok', action: 'bind-sync-request', request_id: id };
    }
    if (!previous.length) throw new InputError('sync request has no durable binding');
    const raw = readStdin();
    if (Buffer.byteLength(raw) > 32 * 1024) throw new InputError('sync receipt exceeds limit');
    const result = JSON.parse(raw);
    if (result?.protocol !== 'brainkit/v1' || !['gmail', 'google-calendar'].includes(result.provider) || !['succeeded', 'skipped', 'failed'].every(key => Number.isInteger(result[key]) && result[key] >= 0 && result[key] <= 20) || result.failed !== 0 || result.batch_complete !== true || result.checkpoint_error || typeof result.watermark_advanced !== 'boolean' || !Array.isArray(result.results) || result.results.length > 20) throw new InputError('only a verified successful sync batch has a replayable receipt');
    const safe = JSON.parse(redactCredentials(JSON.stringify(result)).text);
    writeLedger({ status: 'ok', action: 'finish-sync-request', actor, request_id: id, request_context_sha256: context, sync_receipt: safe }, true);
    return { status: 'ok', sync_receipt: safe };
  } finally { release(); }
}

function replayableReceipt(receipt) {
  return Object.fromEntries(['status', 'action', 'path', 'target_path', 'target_relative', 'operation_id', 'backup_path', 'recall_state', 'source', 'record_id', 'record_version', 'event_id', 'candidate_id', 'inbox_redirect']
    .filter(key => receipt[key] !== undefined).map(key => [key, receipt[key]]));
}

function readRegularBytes(path, limit = MAX_NOTE_BYTES, links = 1) {
  assertInsideVault(path, 'managed file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== links || stat.size > limit) {
      throw new Error('managed file must be a bounded single-link regular file');
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function syncPath(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function saveExclusive(path, bytes, validate = p => assertInsideVault(p, 'managed backup'), temporary = `${path}.${randomUUID()}.tmp`) {
  validate(path);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { validate(path); linkSync(temporary, path); }
  catch (error) { unlinkSync(temporary); throw error; }
  finishLinkedPublication(path, temporary, sha256(bytes));
}

// ponytail: bounded in-memory reads, stream if recordings exceed 128 MiB per file.
const MAX_RAW_BYTES = 128 * 1024 * 1024;

function rawRelative(value) {
  if (!value || value.split('/').some(part => !part || part.startsWith('.') || /[\\\x00-\x1f\x7f]/.test(part))) {
    throw new InputError('raw paths must have visible relative components without traversal');
  }
  return value;
}

function rawPathStat(path, root) {
  if (path === root || !path.startsWith(root + sep)) throw new InputError('raw path escapes its root');
  let leaf;
  for (let cursor = path; cursor !== root; cursor = dirname(cursor)) {
    let stat;
    try { stat = lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink() || (cursor !== path && stat && !stat.isDirectory())) {
      throw new InputError('raw import does not follow linked or non-directory paths');
    }
    if (cursor === path) leaf = stat;
  }
  return leaf;
}

function rawBytes(path, root, source = false, limit = MAX_RAW_BYTES) {
  const before = rawPathStat(path, root);
  if (!before?.isFile() || before.size > limit || (source && before.nlink !== 1)) {
    throw new InputError('raw input must be a bounded regular file; source hardlinks are forbidden');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limit) {
      throw new Error('raw file changed while opening');
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    const bytes = buffer.subarray(0, length), after = fstatSync(fd), leaf = rawPathStat(path, root);
    if (length !== opened.size) throw new Error('raw file size changed while reading');
    if (!leaf || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some(key =>
      opened[key] !== before[key] || opened[key] !== after[key] || after[key] !== leaf[key])) {
      throw new Error('raw file changed while reading');
    }
    return bytes;
  } finally { closeSync(fd); }
}

function importRaw(args) {
  const folder = !!args['import-folder'];
  const allowed = new Set(['project', 'subfolder', 'source', 'provenance', 'dryRun',
    ...(folder ? ['import-folder', 'folder-name'] : ['import-raw', 'raw-subfolder'])]);
  if (Object.keys(args).some(key => !allowed.has(key))) throw new InputError('raw import modes and note options are mutually exclusive');
  if (!args.project || !args.source || !args.provenance?.trim()) throw new InputError('raw import requires project, source and provenance');
  const actor = validateSource(args.source);
  if (/[\x00-\x1f\x7f]/.test(args.provenance)) throw new InputError('invalid raw provenance');
  rawRelative(args.project);
  if (args.subfolder) rawRelative(args.subfolder);
  const rawSubfolder = folder ? '' : rawRelative(args['raw-subfolder'] || '原料');
  if (!folder && rawSubfolder.split('/').at(-1) !== '原料') throw new InputError('raw destination must end in 原料');
  const { absDir } = resolveTargetDir('project', args.project);
  const projectRoot = join(VAULT_REAL, relative(VAULT_ROOT, resolveWriteDir(absDir, args.subfolder)));
  const projectRelative = relative(VAULT_REAL, projectRoot).split(sep).join('/');
  if (!projectRelative.startsWith('01-项目/') ||
      !loadProjectMap().mappings.some(m => m.vaultDir === projectRelative) ||
      !validateAgainstSectionPolicy(absDir, args.subfolder, 'project', args.project).allowed ||
      !rawPathStat(projectRoot, VAULT_REAL)?.isDirectory()) {
    throw new InputError('raw import requires an existing exactly registered project route');
  }
  const desktop = realpathSync(join(homedir(), 'Desktop'));
  const sourcePath = args['import-folder'] || args['import-raw'];
  if (sourcePath !== resolve(sourcePath) || !sourcePath.startsWith(desktop + sep) || isInsideVault(sourcePath)) {
    throw new InputError('raw source must be an absolute Desktop path outside the vault');
  }
  rawRelative(relative(desktop, sourcePath).split(sep).join('/'));
  const sourceStat = rawPathStat(sourcePath, desktop);
  const isQma = !folder && sourceStat?.isDirectory() && extname(sourcePath) === '.qma';
  if (folder ? !sourceStat?.isDirectory() : !isQma && (!sourceStat?.isFile() || extname(sourcePath) !== '.m4a')) {
    throw new InputError('import requires a folder, or M4A/standard QMA for --import-raw');
  }
  // ponytail: small private archives only; stream hashes before raising the 64-entry/512-MiB caps.
  const directories = [], names = folder ? [] : isQma ? ['info.json', 'mic.m4a', 'sys.m4a'] : [''];
  if (folder) {
    function scan(path, depth = 0) {
      if (depth > 16 || directories.length + names.length >= 64) throw new InputError('folder import exceeds 64 entries or 16 levels');
      directories.push(relative(sourcePath, path).split(sep).join('/'));
      for (const name of readdirSync(path).sort()) {
        if (/[\\\x00-\x1f\x7f]/.test(name) || (name.startsWith('.') && name !== '.DS_Store')) throw new InputError('folder contains unsupported hidden or unsafe names');
        const child = join(path, name), stat = rawPathStat(child, desktop);
        if (stat?.isDirectory()) scan(child, depth + 1);
        else if (stat?.isFile() && stat.nlink === 1) names.push(relative(sourcePath, child).split(sep).join('/'));
        else throw new InputError('folder contains linked or non-regular files');
        if (directories.length + names.length > 64) throw new InputError('folder import exceeds 64 entries');
      }
    }
    scan(sourcePath);
  }
  if (isQma && JSON.stringify(readdirSync(sourcePath).sort()) !== JSON.stringify(names)) {
    throw new InputError('QMA must contain exactly info.json, mic.m4a and sys.m4a');
  }
  const folderName = folder ? rawRelative(args['folder-name'] || basename(sourcePath)) : basename(sourcePath);
  if (folder && folderName.includes('/')) throw new InputError('folder-name must be one visible name');
  const target = join(projectRoot, rawSubfolder, folderName);
  const entries = names.map(name => {
    const path = name ? join(sourcePath, name) : sourcePath;
    const bytes = rawBytes(path, desktop, true, name === 'info.json' ? 64 * 1024 : MAX_RAW_BYTES);
    if (!folder && name === 'info.json') {
      let info, text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); info = JSON.parse(text); }
      catch { throw new InputError('QMA info.json must be valid UTF-8 JSON'); }
      if (!info || typeof info !== 'object' || Array.isArray(info) || redactCredentials(text).count) {
        throw new InputError('QMA metadata must be an object without credentials');
      }
    } else if (!folder && (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp' ||
        !['M4A ', 'isom', 'mp42', 'mp41'].includes(bytes.toString('ascii', 8, 12)))) {
      throw new InputError('M4A requires a supported media header');
    }
    return { source_path: path, target_path: name ? join(target, name) : target, bytes: bytes.length, sha256: sha256(bytes) };
  });
  if (folder && entries.reduce((sum, entry) => sum + entry.bytes, 0) > 512 * 1024 * 1024) throw new InputError('folder import exceeds 512 MiB');
  const operationId = sha256(JSON.stringify(folder ? { entries, directories, sourcePath, target } : entries));
  const journalDir = join(VAULT_REAL, 'raw', 'processed', 'brain-write', 'raw-import', operationId);
  const manifest = join(journalDir, 'manifest.json');
  const plan = { operation_id: operationId, action: folder ? 'import-folder' : 'import-raw', files: entries,
    ...(folder ? { directories } : {}) };
  if (Buffer.byteLength(JSON.stringify(plan)) > 60 * 1024) throw new InputError('import manifest exceeds 60 KiB');
  const validate = path => rawPathStat(path, VAULT_REAL);
  function checkTargets() {
    const stat = validate(target);
    if (stat && (isQma || folder ? !stat.isDirectory() : !stat.isFile())) throw new Error('raw target type conflict');
    if (isQma && stat && readdirSync(target).some(name => !names.includes(name))) throw new Error('raw QMA target contains conflicting extra files');
    for (const file of entries) {
      const existing = validate(file.target_path);
      if (existing) {
        if (!existing.isFile() || existing.nlink !== 1 || sha256(rawBytes(file.target_path, VAULT_REAL)) !== file.sha256) throw new Error('raw target content conflict');
      }
    }
    validate(manifest);
    validate(LOCK_PATH.replace(VAULT_ROOT, VAULT_REAL));
    assertLedgerFile();
  }
  checkTargets();
  // Node has no descriptor-relative mkdir/rename. Use the installed stdlib runtime for this boundary.
  const result = spawnSync('python3', ['-I', '-B', join(__dirname, '../lib/raw-import.py')], {
    input: JSON.stringify({ vault: VAULT_REAL, desktop, plan, target, qma: isQma, folder, source_root: sourcePath,
      actor, provenance: args.provenance, dry_run: !!args.dryRun, wait_ms: LOCK_WAIT_MS }),
    encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || 'native raw import failed');
  return JSON.parse(result.stdout);
}

function rejectClip({ id, source, reason, imageSha }) {
  const actor = validateSource(source);
  if (!reason?.trim()) throw new InputError('reject requires --reason');
  const { pending, rejected } = clipStatePaths(id, VAULT_ROOT);
  const release = acquireLock();
  try {
    if (existsSync(clipCommitPath(id))) throw new Error('clip has a prepared or committed write; resume it before note maintenance');
    const ledger = readLedgerEntries();
    if (ledger.some(entry => entry.action === 'write' && entry.clip_id === id && entry.status === 'ok')) {
      throw new Error('clip already committed; deactivate its note through managed maintenance');
    }
    let record;
    if (isClipRejected(id, VAULT_ROOT)) {
      record = JSON.parse(readRegularBytes(rejected, MAX_NOTE_BYTES * 2));
      if (record.clip_id !== id || record.status !== 'rejected' ||
          sha256(Buffer.from(record.pending_base64, 'base64')) !== record.pending_sha256) {
        throw new Error('invalid rejection snapshot; retained for inspection');
      }
    } else {
      const bytes = readRegularBytes(pending);
      if (imageSha) reviewedClipImageBytes(JSON.parse(bytes), imageSha);
      record = { status: 'rejected', clip_id: id, actor, reason: reason.trim(),
        rejected_at: new Date().toISOString(), pending_sha256: sha256(bytes), pending_base64: bytes.toString('base64') };
      saveExclusive(rejected, JSON.stringify(record) + '\n');
    }
    // The marker is durable before queue removal. Replays also remain rejected.
    if (existsSync(pending)) {
      if (sha256(readRegularBytes(pending)) !== record.pending_sha256) throw new Error('pending changed; rejection retained, queue left untouched');
      unlinkSync(pending);
      syncPath(dirname(pending));
    }
    const receipt = { status: 'ok', action: 'reject-clip', actor, clip_id: id, backup_path: rejected,
      content_sha256: record.pending_sha256 };
    writeLedger(receipt, true);
    return receipt;
  } finally { release(); }
}

function clipCommitPath(id) {
  clipStatePaths(id, VAULT_ROOT);
  const path = join(VAULT_ROOT, 'raw', 'processed', 'brain-write', 'clip-commits', `${id}.json`);
  assertInsideVault(path, 'clip commit');
  return path;
}

function reviewedClipImageBytes(data, expectedSha) {
  const image = data.image_path || data.imagePath || data.path || data.file || data.localPath;
  if (!image || !/\.(png|jpe?g|webp|gif)$/i.test(image)) {
    if (expectedSha) throw new Error('image SHA requires an image clip');
    return null;
  }
  const bytes = readRegularBytes(resolve(VAULT_ROOT, image));
  const reviewedSha = expectedSha || (data.llm?.curator_version === 1 ? data.llm.curator_sha256 : null);
  if ((expectedSha !== undefined || data.llm?.curator_version === 1) && sha256(bytes) !== validateSha256(reviewedSha, 'clip image SHA-256')) throw new Error('clip image changed since review; pending retained');
  return bytes;
}

function stageClipAttachment(id, data, files, imageSha) {
  const image = data.image_path || data.imagePath || data.path || data.file || data.localPath;
  if (!image || !/\.(png|jpe?g|webp|gif)$/i.test(image) || files.length === 0) return null;
  if (files.length !== 1 || !new RegExp(`^00-系统/attachments/${id}\\.(png|jpe?g|webp|gif)$`, 'i').test(files[0])) {
    throw new Error('clip attachment must use its managed timestamp filename');
  }
  const bytes = reviewedClipImageBytes(data, imageSha);
  const target = join(VAULT_ROOT, files[0]);
  assertInsideVault(target, 'clip attachment');
  if (!existsSync(target)) saveExclusive(target, bytes);
  if (!readRegularBytes(target).equals(bytes)) throw new Error('attachment collision; both originals retained');
  return { path: target, sha256: sha256(bytes) };
}

function validateCreatePlan(plan) {
  if (plan.version !== 1 || !Array.isArray(plan.writes) || !plan.writes.length || plan.writes.length > 32 || typeof plan.receipt?.path !== 'string') {
    throw new Error('invalid creation commit plan');
  }
  const target = resolve(plan.receipt.path);
  assertInsideVault(target, 'clip note');
  const section = relative(VAULT_REAL, realpathDeep(target)).split(sep)[0];
  if (![...EDITABLE_SECTIONS, '08-观察', '99-inbox'].includes(section) || extname(target) !== '.md') throw new Error('invalid clip note target');
  const allowed = new Set([target, INTENT_MAP_PATH, ...DOMAIN_INDEX_FILES.map(name => join(MEMORY_DIR, name))]);
  const seen = new Set();
  for (const write of plan.writes) {
    if (!allowed.has(write.path) || seen.has(write.path) || typeof write.after !== 'string' ||
        (write.before !== null && typeof write.before !== 'string')) throw new Error('invalid clip write target or content');
    seen.add(write.path);
    if (write.path === target || write.path === INTENT_MAP_PATH) assertInsideVault(write.path, 'clip commit');
    else if (realpathDeep(dirname(write.path)) !== realpathDeep(MEMORY_DIR) ||
        (existsSync(write.path) && lstatSync(write.path).isSymbolicLink())) throw new Error('clip index path changed');
  }
  if (!seen.has(target)) throw new Error('clip plan lacks note');
  if (plan.ledger?.target_path !== target || plan.ledger.action !== 'write' || plan.ledger.status !== 'ok') throw new Error('invalid creation ledger');
  return target;
}

function applyCreateWrites(plan, label = 'creation') {
  for (const write of plan.writes) {
    const current = existsSync(write.path) ? readFileSync(write.path, 'utf8') : null;
    if (current !== write.before && current !== write.after) throw new Error(`${label} commit conflict: ${write.path}`);
  }
  for (const write of plan.writes) {
    const current = existsSync(write.path) ? readFileSync(write.path, 'utf8') : null;
    if (current === write.after) continue;
    if (current !== write.before) throw new Error(`${label} commit conflict: ${write.path}`);
    journal.delete(write.path);
    readTracked(write.path);
    writeTracked(write.path, write.after);
    syncPath(write.path);
    syncPath(dirname(write.path));
  }
  writeLedger(plan.ledger, true);
  syncPath(LEDGER_PATH);
}

function requestCommitPath(actor, id) {
  const path = join(VAULT_ROOT, 'raw', 'processed', 'brain-write', 'request-commits', `${sha256(actor).slice(0, 24)}-${requestId(id)}.json`);
  assertInsideVault(path, 'request commit');
  return path;
}

function completeRequestCommit(actor, id, fingerprint) {
  const path = requestCommitPath(actor, id), temporary = renameTemp(path, id);
  const linked = linkedPublication(path, id), source = existsSync(path) ? path : temporary;
  const bytes = readRegularBytes(source, MAX_NOTE_BYTES * 4, linked ? 2 : 1);
  const plan = JSON.parse(bytes);
  validateCreatePlan(plan);
  if (plan.ledger.actor !== actor || plan.ledger.request_id !== id || plan.ledger.request_hash !== fingerprint || plan.receipt.source !== actor) throw new InputError('idempotency_conflict: retained request plan does not match this request');
  if (!existsSync(path)) linkSync(temporary, path);
  finishPublication(path, id, sha256(bytes));
  applyCreateWrites(plan);
  return plan.receipt;
}

function completeClipCommit(id) {
  const plan = JSON.parse(readRegularBytes(clipCommitPath(id), MAX_NOTE_BYTES * 4));
  const { pending } = clipStatePaths(id, VAULT_ROOT);
  const target = validateCreatePlan(plan);
  if (plan.clip_id !== id) throw new Error('invalid clip commit plan');
  if (sha256(Buffer.from(plan.pending_base64, 'base64')) !== plan.pending_sha256 ||
      plan.ledger.clip_id !== id || plan.ledger.target_path !== target ||
      plan.ledger.action !== 'write' || plan.ledger.status !== 'ok') throw new Error('invalid clip commit identity');
  if (existsSync(pending) && sha256(readRegularBytes(pending)) !== plan.pending_sha256) throw new Error('clip pending changed; commit retained');
  if (plan.attachment) {
    if (dirname(plan.attachment.path) !== join(VAULT_ROOT, '00-系统/attachments') ||
        sha256(readRegularBytes(plan.attachment.path)) !== plan.attachment.sha256) throw new Error('clip attachment changed; pending retained');
  }
  const committed = readLedgerEntries().some(entry => entry.status === 'ok' && entry.action === 'write' && entry.clip_id === id);
  if (committed) {
    if (readRegularBytes(target).toString('utf8') !== plan.writes.find(write => write.path === target).after) {
      throw new Error('committed clip note changed; refusing to replay');
    }
    if (existsSync(pending)) { unlinkSync(pending); syncPath(dirname(pending)); }
    return plan.receipt;
  }
  // A prepared plan closes the response-loss window: retries finish the same
  // note and index bytes, and refuse any unrelated intervening value.
  applyCreateWrites(plan, 'clip');
  if (existsSync(pending)) {
    if (sha256(readRegularBytes(pending)) !== plan.pending_sha256) throw new Error('clip pending changed after commit');
    unlinkSync(pending);
    syncPath(dirname(pending));
  }
  return plan.receipt;
}

const MAINTENANCE_SECTIONS = new Set([...EDITABLE_SECTIONS, '08-观察', '99-inbox']);

function renameNotePath(path) {
  return typeof path === 'string' && path === resolve(path) &&
    MAINTENANCE_SECTIONS.has(relative(VAULT_REAL, path).split(sep)[0]) && extname(path) === '.md';
}

function assertRenamePath(path, links = 1) {
  if (!renameNotePath(path) && path !== join(VAULT_REAL, '_index.md')) throw new Error('invalid rename reference path');
  assertInsideVault(path, 'rename');
  let cursor = path;
  while (cursor !== VAULT_REAL) {
    let stat;
    try { stat = lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error('rename does not follow linked paths');
    if (cursor === path && stat && (!stat.isFile() || stat.nlink !== links || stat.size > MAX_NOTE_BYTES)) throw new Error('rename requires bounded single-link files');
    cursor = dirname(cursor);
  }
}

function renameInventory() {
  const notes = [];
  function walk(dir) {
    assertInsideVault(dir, 'rename scan');
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error(`rename cannot scan linked directory: ${dir}`);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`rename cannot scan linked entry: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) { assertRenamePath(path); notes.push(path); }
    }
  }
  for (const section of MAINTENANCE_SECTIONS) {
    const root = join(VAULT_REAL, section);
    if (existsSync(root)) walk(root);
  }
  const rootIndex = join(VAULT_REAL, '_index.md');
  if (existsSync(rootIndex)) { assertRenamePath(rootIndex); notes.push(rootIndex); }
  return notes.sort();
}

function markdownLinkMask(text) {
  const blank = s => s.replace(/[^\r\n]/g, ' ');
  let masked = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, blank);
  let fence;
  masked = masked.split(/(?<=\n)/).map(line => {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !line.slice(mark[0].length).trim()) fence = null;
      return blank(line);
    }
    if (mark) { fence = mark[1]; return blank(line); }
    return /^(?: {4}|\t)/.test(line) ? blank(line) : line;
  }).join('');
  masked = masked.replace(/<!--[\s\S]*?(?:-->|$)/g, blank);
  return masked.replace(/(`+)([\s\S]*?)\1(?!`)/g, blank);
}

function readRenameText(path) {
  // Never turn undecodable reference bytes into replacement characters on save.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
}

function rewriteRenameLinks(text, referrer, rename) {
  const { from, to, notes } = rename;
  const oldName = basename(from, '.md'), newName = basename(to, '.md');
  const masked = markdownLinkMask(text);
  const edits = [];
  const escaped = index => {
    let slashes = 0;
    while (index > 0 && text[--index] === '\\') slashes++;
    return slashes % 2 === 1;
  };
  const isIndex = DOMAIN_INDEX_FILES.some(name => referrer === join(MEMORY_DIR, name)) || basename(referrer) === '_index.md';
  function destination(raw, wiki) {
    const suffixAt = raw.search(wiki ? /\\?\||[#^]/ : /[#?]/);
    const name = suffixAt < 0 ? raw : raw.slice(0, suffixAt);
    const suffix = suffixAt < 0 ? '' : raw.slice(suffixAt);
    if (!name || /^[a-z][\w+.-]*:/i.test(name) || name.startsWith('//')) return raw;
    let decoded;
    if (wiki) decoded = name;
    else {
      const unescaped = name.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
      try { decoded = decodeURIComponent(unescaped); } catch { decoded = unescaped; }
    }
    let matches;
    if (wiki) {
      const wanted = decoded.replace(/\.md$/, '');
      if (wanted.startsWith('./') || wanted.startsWith('../')) {
        if (resolve(dirname(referrer), wanted + '.md') !== from) return raw;
        matches = notes.filter(path => path === from);
      } else {
        const source = relative(VAULT_REAL, from).replace(/\.md$/, '');
        if (source !== wanted && !source.endsWith('/' + wanted)) return raw;
        matches = notes.filter(path => relative(VAULT_REAL, path).replace(/\.md$/, '') === wanted || relative(VAULT_REAL, path).replace(/\.md$/, '').endsWith('/' + wanted));
      }
    } else {
      const candidate = resolve(dirname(referrer), decoded);
      matches = realpathDeep(candidate) === from ? [from] : [];
    }
    if (!matches.includes(from)) return raw;
    if (matches.length !== 1) throw new Error(`ambiguous rename reference in ${referrer}: ${raw}`);
    let replacement;
    if (wiki) {
      replacement = decoded.includes('/') ? relative(VAULT_REAL, to).replace(/\.md$/, '') : newName;
      if (decoded.endsWith('.md')) replacement += '.md';
    } else {
      replacement = decoded.startsWith('/') ?
        (decoded.startsWith(VAULT_ROOT + sep) ? resolve(VAULT_ROOT, relative(VAULT_REAL, to)) : to) : relative(dirname(referrer), to);
      if (!isIndex && (name.includes('%') || /\s/.test(replacement))) replacement = encodeURI(replacement).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16));
    }
    return replacement + suffix;
  }
  const header = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] || '';
  if ((header.includes('[[') || header.includes('](')) && (header.includes(oldName) || header.includes(encodeURI(oldName)))) throw new Error(`unsupported frontmatter reference in ${referrer}`);
  for (const match of masked.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
    if (escaped(match.index)) continue;
    const next = destination(match[1], true);
    if (next !== match[1]) edits.push({ start: match.index + 2, end: match.index + 2 + match[1].length, next });
  }
  for (const match of masked.matchAll(/\]\(/g)) {
    const labelStart = masked.lastIndexOf('[', match.index);
    if (labelStart < 0 || escaped(labelStart) || escaped(match.index)) continue;
    const start = match.index + 2;
    let end = start, depth = 1, angle = false, quote;
    for (; end < masked.length; end++) {
      const char = masked[end];
      if (char === '\\') { end++; continue; }
      if (quote) { if (char === quote) quote = null; continue; }
      if (!angle && depth === 1 && /["']/.test(char) && /\s/.test(masked[end - 1])) { quote = char; continue; }
      if (char === '<') angle = true;
      else if (char === '>') angle = false;
      else if (!angle && char === '(') depth++;
      else if (!angle && char === ')' && --depth === 0) break;
      if (char === '\n') break;
    }
    const raw = text.slice(start, end);
    if (depth !== 0) { if (raw.includes(oldName)) throw new Error(`unsupported multiline reference in ${referrer}`); continue; }
    const part = raw.match(/^(\s*)(<[^>]*>|[\s\S]*?)(\s+["'][\s\S]*["']\s*|\s*)$/);
    const enclosed = part[2].startsWith('<') && part[2].endsWith('>');
    const value = enclosed ? part[2].slice(1, -1) : part[2];
    const next = destination(value, false);
    if (next !== value) {
      edits.push({ start, end, next: part[1] + (enclosed ? '<' + next + '>' : next) + part[3] });
      if (isIndex) {
        if (labelStart >= 0 && text.slice(labelStart + 1, match.index) === oldName) edits.push({ start: labelStart + 1, end: match.index, next: newName });
      }
    }
  }
  for (const line of masked.split('\n')) {
    if ((/^\s*\[[^\]]+\]:/.test(line) || /\b(?:href|src)\s*=/.test(line)) && (line.includes(oldName) || line.includes(encodeURI(oldName)))) throw new Error(`unsupported reference form in ${referrer}`);
  }
  let after = text, edge = text.length;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > edge) throw new Error(`overlapping references in ${referrer}`);
    after = after.slice(0, edit.start) + edit.next + after.slice(edit.end);
    edge = edit.start;
  }
  return after;
}

function renamedBody(before, rename) {
  let after = rewriteRenameLinks(before, rename.from, rename);
  const header = after.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
  if (!header || !/^name:|^title:/m.test(header)) throw new InputError('rename requires a frontmatter name or title');
  if (header.match(/^name:/gm)?.length > 1 || header.match(/^title:/gm)?.length > 1) throw new InputError('duplicate name/title fields');
  const next = header.replace(/^(name|title):[^\r\n]*/gm, (_, key) => `${key}: ${yamlScalar(rename.title)}`);
  return next + after.slice(header.length);
}

function renameIntent(before, rename) {
  const map = JSON.parse(before);
  if (!Array.isArray(map.eviction_log)) throw new Error('invalid intent-map eviction log');
  const entries = map.eviction_log.filter(entry => entry.source_path === rename.from);
  if (!entries.length) return before;
  for (const entry of entries) { entry.source_path = rename.to; if (entry.title === basename(rename.from, '.md')) entry.title = rename.title; }
  return JSON.stringify(map, null, 2) + '\n';
}

function planRename(args) {
  const from = resolveEditableTarget(args.rename, MAINTENANCE_SECTIONS).targetPath;
  const requested = resolve(VAULT_ROOT, args.rename);
  const suffix = relative(VAULT_REAL, from);
  const root = requested.slice(0, -suffix.length - 1);
  if (!requested.endsWith(sep + suffix) ||
      isInsideVault(dirname(root)) ||
      realpathSync(root) !== VAULT_REAL) throw new Error('rename does not follow linked note paths');
  assertRenamePath(from);
  const title = String(args['new-title'] || '');
  if (!title || title !== title.trim() || title !== sanitizeFilename(title) || /[\x00-\x1f\x7f\[\]#^`()]/.test(title) || title.startsWith('.') || title.endsWith('.') || /\.md$/i.test(title) || title.normalize('NFC').toLowerCase() === basename(from, '.md').normalize('NFC').toLowerCase()) throw new InputError('rename needs a distinct safe title without path, extension or link delimiters');
  const to = join(dirname(from), title + '.md');
  assertRenamePath(to);
  const notes = renameInventory();
  if (notes.some(path => path !== from && basename(path).normalize('NFC').toLowerCase() === basename(to).normalize('NFC').toLowerCase())) throw new Error('rename target name already exists');
  const before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readRegularBytes(from));
  if (sha256(before) !== validateSha256(args['expected-sha256'], 'expected SHA-256')) throw new Error('maintenance CAS mismatch');
  const rename = { from, to, title, notes };
  const writes = [{ path: to, before: null, after: renamedBody(before, rename) }];
  for (const path of new Set([...notes, ...DOMAIN_INDEX_FILES.map(name => join(MEMORY_DIR, name)), INTENT_MAP_PATH])) {
    if (path === from || !existsSync(path)) continue;
    if (notes.includes(path)) assertRenamePath(path); else assertMaintenancePath(path, from);
    const old = readRenameText(path);
    const after = path === INTENT_MAP_PATH ? renameIntent(old, rename) : rewriteRenameLinks(old, path, rename);
    if (old !== after) writes.push({ path, before: old, after });
  }
  writes.push({ path: from, before, after: null });
  // ponytail: one note and at most 256 affected files per operation; split a
  // heavily linked migration into a separately reviewed plan if this is exceeded.
  if (writes.length > 256) throw new Error('rename affects more than 256 files');
  return { target: from, writes, rename };
}

function maintenancePath(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id))) throw new InputError('maintenance requires an operation UUID');
  return join(VAULT_ROOT, 'raw', 'processed', 'brain-write', 'note-maintenance', `${id}.json`);
}

function assertMaintenancePath(path, target, links = 1) {
  if (path === target || path === INTENT_MAP_PATH) assertInsideVault(path, 'maintenance');
  else if (!DOMAIN_INDEX_FILES.some(name => path === join(MEMORY_DIR, name)) ||
      realpathDeep(dirname(path)) !== MEMORY_REAL) throw new Error('invalid maintenance index');
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== links || stat.size > MAX_NOTE_BYTES)) throw new Error('maintenance target must be a bounded single-link regular file');
}

const renameTemp = (path, id) => `${path}.${id}.tmp`;

function linkedPublication(path, id) {
  const temporary = renameTemp(path, id);
  if (!existsSync(path) || !existsSync(temporary)) return false;
  const file = lstatSync(path), temp = lstatSync(temporary);
  return file.isFile() && temp.isFile() && file.nlink === 2 && temp.nlink === 2 && file.dev === temp.dev && file.ino === temp.ino;
}

function finishLinkedPublication(path, temporary, hash) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = fstatSync(fd), temp = lstatSync(temporary);
    if (!file.isFile() || !temp.isFile() || file.nlink !== 2 || temp.nlink !== 2 ||
        file.dev !== temp.dev || file.ino !== temp.ino || sha256(readFileSync(fd)) !== hash) throw new Error(`publication changed: ${path}`);
    unlinkSync(temporary);
    const final = fstatSync(fd), leaf = lstatSync(path);
    if (final.nlink !== 1 || leaf.dev !== final.dev || leaf.ino !== final.ino ||
        !leaf.isFile() || sha256(readFileSync(path)) !== hash) throw new Error(`publication changed during cleanup: ${path}`);
  } finally { closeSync(fd); }
  syncPath(dirname(path));
}

function finishPublication(path, id, hash) {
  if (linkedPublication(path, id)) finishLinkedPublication(path, renameTemp(path, id), hash);
}

function assertMaintenanceWrite(path, plan) {
  const write = plan.writes.find(w => w.path === path);
  if (plan.version === 3) {
    if (!DOMAIN_INDEX_FILES.some(name => path === join(MEMORY_DIR, name)) || realpathDeep(dirname(path)) !== MEMORY_REAL) throw new Error('invalid repair index');
    assertMaintenancePath(path, plan.receipt.target_path);
    return;
  }
  const linked = plan.version === 2 && linkedPublication(path, plan.receipt.operation_id);
  if (linked && sha256(readFileSync(path)) !== write.after_sha256) throw new Error('publication content changed');
  if (plan.version === 2 && (path === plan.rename.from || path === plan.rename.to || plan.rename.notes.includes(path))) assertRenamePath(path, linked ? 2 : 1);
  else assertMaintenancePath(path, plan.receipt.target_path, linked ? 2 : 1);
}

function validateRepairTarget(plan) {
  const target = plan.receipt.target_path;
  if (typeof plan.repair?.from !== 'string' || typeof plan.inverse !== 'boolean') throw new Error('invalid repair record');
  const expected = validateSha256(plan.receipt.target_sha256, 'repair target SHA-256');
  const resolved = resolveEditableTarget(target, MAINTENANCE_SECTIONS).targetPath;
  if (resolved !== target || sha256(readRegularBytes(resolved)) !== expected) throw new Error('repair target changed since review');
}

function validateRenameRecord(plan) {
  const r = plan.rename;
  if (!r || typeof r.title !== 'string' || !renameNotePath(r.from) || !renameNotePath(r.to) ||
      dirname(r.from) !== dirname(r.to) || r.from === r.to || basename(r.to) !== r.title + '.md' ||
      !Array.isArray(r.notes) || new Set(r.notes).size !== r.notes.length ||
      !r.notes.includes(r.from) || r.notes.includes(r.to) ||
      r.notes.some(path => !renameNotePath(path) && path !== join(VAULT_REAL, '_index.md')) ||
      plan.receipt.target_path !== r.from || typeof plan.inverse !== 'boolean' || !['rename', 'restore'].includes(plan.receipt.action)) throw new Error('invalid rename record');
  const forward = plan.inverse ? [...plan.writes].reverse().map(w => ({ path: w.path, before: w.after, after: w.before })) : plan.writes;
  const first = forward[0], last = forward.at(-1);
  if (first?.path !== r.to || first.before !== null || last?.path !== r.from || last.after !== null ||
      typeof last.before !== 'string' || first.after !== renamedBody(last.before, r)) throw new Error('invalid rename endpoints');
  for (const w of forward.slice(1, -1)) {
    if (w.path === r.from || w.path === r.to || typeof w.before !== 'string' || typeof w.after !== 'string') throw new Error('invalid rename reference');
    const after = w.path === INTENT_MAP_PATH ? renameIntent(w.before, r) : rewriteRenameLinks(w.before, w.path, r);
    if (after !== w.after || after === w.before) throw new Error('rename reference content was changed');
  }
}

function loadMaintenance(id) {
  const path = maintenancePath(id);
  const linked = linkedPublication(path, id);
  const bytes = readRegularBytes(existsSync(path) ? path : renameTemp(path, id), MAX_NOTE_BYTES * 4, linked ? 2 : 1);
  const plan = JSON.parse(bytes);
  plan.recordHash = sha256(bytes);
  const target = plan.receipt?.target_path;
  if (![1, 2, 3].includes(plan.version) || plan.receipt.operation_id !== id || typeof target !== 'string' ||
      !(plan.version === 2 ? ['rename', 'restore'] : plan.version === 3 ? ['repair-index-link', 'restore'] : ['revise', 'deactivate', 'restore']).includes(plan.receipt.action) || plan.receipt.status !== 'ok' ||
      !Array.isArray(plan.writes) || !plan.writes.length || plan.writes.length > (plan.version === 2 ? 256 : DOMAIN_INDEX_FILES.length + 2)) throw new Error('invalid maintenance record');
  if (plan.version === 2) validateRenameRecord(plan);
  else {
    const preparedIdempotent = plan.receipt.request_id === id && existsSync(renameTemp(path, id));
    if ((linked || !existsSync(path)) && !preparedIdempotent) throw new Error('legacy maintenance record must be fully published');
  }
  assertInsideVault(target, 'maintenance note');
  if (!MAINTENANCE_SECTIONS.has(relative(VAULT_REAL, realpathDeep(target)).split(sep)[0]) || extname(target) !== '.md') throw new Error('invalid maintenance note');
  if (plan.version === 3) validateRepairTarget(plan);
  const seen = new Set();
  for (const write of plan.writes) {
    assertMaintenanceWrite(write.path, plan);
    if (seen.has(write.path)) throw new Error('duplicate maintenance target');
    seen.add(write.path);
    for (const value of ['before', 'after']) {
      if ((write[value] !== null && typeof write[value] !== 'string') ||
          (write[value] === null ? null : sha256(write[value])) !== write[`${value}_sha256`]) throw new Error('maintenance content does not match its digest');
      if (plan.version === 2 && write[value] !== null && Buffer.byteLength(write[value]) > MAX_NOTE_BYTES) throw new Error('rename note or reference exceeds size limit');
    }
    if (plan.version === 3 && (typeof write.before !== 'string' || typeof write.after !== 'string' || write.before === write.after)) throw new Error('invalid repair index write');
  }
  if (plan.version === 3) {
    const forward = plan.writes.map(w => ({ path: w.path, before: plan.inverse ? w.after : w.before, after: plan.inverse ? w.before : w.after }));
    const rebuilt = repairIndexLinkPlan({ 'repair-index-link': plan.repair.from, to: target, 'expected-sha256': plan.receipt.target_sha256 }, new Map(forward.map(w => [w.path, w.before])));
    if (JSON.stringify(rebuilt.writes) !== JSON.stringify(forward)) throw new Error('repair index transformation was changed');
  }
  if (plan.version !== 3 && !seen.has(target)) throw new Error('maintenance record lacks note');
  return plan;
}

function completeMaintenance(id) {
  const plan = loadMaintenance(id);
  if (plan.version === 3) validateRepairTarget(plan);
  const committed = readLedgerEntries().some(entry => entry.status === 'ok' && entry.operation_id === id);
  const publication = maintenancePath(id), publicationTemp = renameTemp(publication, id);
  if (!existsSync(publication) && existsSync(publicationTemp)) {
    if (sha256(readRegularBytes(publicationTemp, MAX_NOTE_BYTES * 4)) !== plan.recordHash) throw new Error('maintenance snapshot changed');
    linkSync(publicationTemp, publication);
  }
  finishPublication(publication, id, plan.recordHash);
  const retirement = write => maintenancePath(id).replace(/\.json$/, `-${sha256(write.path)}.retired`);
  function retainedBefore(write) {
    if (plan.version !== 2 || write.before === null) return false;
    const retired = retirement(write);
    assertInsideVault(retired, 'rename retired file');
    if (!existsSync(retired)) return false;
    if (sha256(readRegularBytes(retired)) !== write.before_sha256) throw new Error(`rename source changed; actual file retained at ${retired}`);
    return true;
  }
  for (const write of plan.writes) {
    const current = existsSync(write.path) ? (plan.version === 2 ? readRenameText(write.path) : readFileSync(write.path, 'utf8')) : null;
    const retained = retainedBefore(write);
    const interrupted = plan.version === 2 && !committed && retained && current === null;
    if ((!interrupted && current !== write.after && (committed || current !== write.before)) ||
        (plan.version === 2 && write.before !== null && current === write.after && !retained)) throw new Error(`maintenance conflict: ${write.path}; recovery retained at ${maintenancePath(id)}`);
  }
  for (const write of plan.writes) {
    assertMaintenanceWrite(write.path, plan);
    if (plan.version === 2) finishPublication(write.path, id, write.after_sha256);
    const current = existsSync(write.path) ? (plan.version === 2 ? readRenameText(write.path) : readFileSync(write.path, 'utf8')) : null;
    const retained = retainedBefore(write);
    const temporary = renameTemp(write.path, id);
    if (plan.version === 2 && existsSync(temporary)) {
      const stat = lstatSync(temporary);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_NOTE_BYTES) throw new Error(`unexpected publication temporary: ${temporary}`);
      // Preserve even a partial or redundant temporary before accepting after.
      const saved = maintenancePath(id) + '.' + randomUUID() + '.incomplete';
      assertInsideVault(saved, 'incomplete publication');
      renameSync(temporary, saved);
      syncPath(dirname(saved));
    }
    if (current === write.after) continue;
    if (current !== write.before && !(plan.version === 2 && retained && current === null)) throw new Error(`maintenance conflict: ${write.path}`);
    if (plan.version === 2) {
      // Keep the actual retired inode as well as the preflight bytes: a path
      // replacement must survive both source retirement and reference rewrites.
      if (write.before !== null && !retained) {
        const retired = retirement(write);
        assertInsideVault(retired, 'rename retired file');
        renameSync(write.path, retired);
        syncPath(dirname(retired));
        retainedBefore(write);
      } else if (retained && current !== null) throw new Error(`rename conflict after retirement: ${write.path}`);
      if (write.after !== null) {
        saveExclusive(write.path, write.after, p => assertMaintenanceWrite(p, plan), temporary);
      }
    } else if (write.after === null) unlinkSync(write.path);
    else {
      journal.delete(write.path);
      readTracked(write.path);
      writeTracked(write.path, write.after);
      syncPath(write.path);
    }
    syncPath(dirname(write.path));
  }
  if (plan.version === 2) {
    if (existsSync(renameTemp(maintenancePath(id), id)) || sha256(readRegularBytes(maintenancePath(id), MAX_NOTE_BYTES * 4)) !== plan.recordHash) throw new Error('maintenance snapshot changed before commit');
    for (const write of plan.writes) {
      if (existsSync(renameTemp(write.path, id))) throw new Error('publication cleanup unfinished');
      assertMaintenanceWrite(write.path, plan);
      const current = existsSync(write.path) ? readRenameText(write.path) : null;
      if (current !== write.after || (write.before !== null && !retainedBefore(write))) throw new Error(`maintenance final conflict: ${write.path}`);
    }
  }
  if (!committed) { writeLedger(plan.receipt, true); syncPath(LEDGER_PATH); }
  return plan.receipt;
}

function hasMaintenancePlan(id) {
  const path = maintenancePath(id);
  return existsSync(path) || existsSync(renameTemp(path, id));
}

function resumeIdempotentMaintenance({ actor, id, requestHash, requestContext, bridge = false }) {
  if (!hasMaintenancePlan(id)) return bridge ? { status: 'not_prepared' } : null;
  const receipt = loadMaintenance(id).receipt;
  if (receipt.actor !== actor || receipt.request_id !== id || receipt.request_context_sha256 !== requestContext || (!bridge && receipt.request_hash !== requestHash)) {
    throw new InputError('idempotency_conflict: retained maintenance plan does not match this request');
  }
  return completeMaintenance(id);
}

function structuredNote(body) {
  const record = parseRecord(body), event = parseEvent(body), candidate = parseCandidate(body);
  if ([record, event, candidate].filter(Boolean).length > 1) throw new InputError('a note can contain only one structured record, candidate, or event');
  return record ? { id: record.id, record } : event ? { id: event.event_id, event } : candidate ? { id: candidate.candidate_id, candidate } : null;
}

// Called under the writer lock, so every writer entry shares the same stable-ID boundary.
function checkStructuredWrite(after, { before = null, target = null, restore = false, noteType } = {}) {
  const next = structuredNote(after), previous = before === null ? null : structuredNote(before);
  if (!next && !previous) return null;
  if (!restore && next?.record?.confirmation !== undefined && next.record.confirmation !== 'confirmed') throw new InputError('unconfirmed records must use a candidate block in the observation layer');
  if (next?.record && noteType === 'observation') throw new InputError('confirmed records need an authoritative note route');
  if (next?.candidate && noteType !== undefined && noteType !== 'observation') throw new InputError('candidates must be written as observations');
  if (before !== null && !restore) {
    if (previous?.candidate && (!next?.candidate || previous.id !== next.id)) throw new InputError('candidate content is immutable; retain it and create a new candidate or confirmed record');
    if (previous?.record || next?.record) assertRecordRevision(before, after);
    if (previous?.event && (!next?.event || previous.id !== next.id || previous.event.provider !== next.event.provider)) throw new InputError('connector event identity must not change');
    if (previous?.event && Date.parse(next.event.source_updated_at) < Date.parse(previous.event.source_updated_at)) throw new InputError('connector revision cannot move backwards');
    if (previous?.event && previous.event.source_updated_at === next.event.source_updated_at && previous.event.data_sha256 !== next.event.data_sha256) throw new InputError('connector data cannot change at the same source revision');
    if (previous?.event?.source_ref && next.event.source_ref !== previous.event.source_ref) throw new InputError('connector source reference must not change');
    if (!previous && next) throw new InputError('create structured records as new notes rather than replacing an ordinary note');
  }
  const record = next?.record || next?.candidate?.record;
  if (record && !restore) {
    const evidence = [...record.sources, ...(record.completion_sources || [])];
    const sources = [...new Set(evidence.map(entry => entry.note_id))].map(id => readActiveNote(VAULT_ROOT, resolve(VAULT_ROOT, id), { includeUnconfirmed: true })).filter(Boolean);
    validateSources(record, sources);
    if (before === null && record.version !== 1) throw new InputError('new structured record version must be 1');
  }
  if (next && (before === null || restore)) {
    const diagnostics = [];
    for (const note of listStructuredNotes(VAULT_ROOT, { includeUnconfirmed: true, diagnostics })) {
      if (target && realpathOrSelf(note.path) === realpathOrSelf(target)) continue;
      if (structuredNote(note.body)?.id === next.id) throw new InputError(`structured identity already exists: ${next.id}`);
    }
    if (diagnostics.length) throw new InputError(`cannot verify structured identity while source notes are invalid: ${diagnostics.slice(0, 3).map(row => row.path).join(', ')}`);
  }
  return next;
}

function maintainNote(args) {
  const actor = validateSource(args.source);
  const reason = redactCredentials(String(args.reason || (args['repair-index-link'] ? '修复受管索引路径' : '')).trim()).text;
  if (args.revise && args.body === undefined) args.body = readStdin();
  const action = args.rename ? 'rename' : args.revise ? 'revise' : args.deactivate ? 'deactivate' : args['repair-index-link'] ? 'repair-index-link' : 'restore';
  const rid = requestId(args.request_id ?? args['request-id']);
  const requestContext = requestContextSha256(args.request_context_sha256 ?? args['request-context-sha256'], rid);
  const bridgeResume = Boolean(args['resume-maintenance'] && rid && requestContext);
  if (!args.source || (!bridgeResume && (!reason || reason.length > 2000))) throw new InputError('maintenance requires --source and a reason of 1–2000 characters');
  const rhash = rid ? requestFingerprint(action, { source: actor, reason, revise: args.revise, deactivate: args.deactivate, restore: args.restore, rename: args.rename, repair: args['repair-index-link'], expected_sha256: args['expected-sha256'], body: args.body, description: args.description, to: args.to, new_title: args['new-title'] }) : null;
  const release = args.dryRun ? () => {} : acquireLock();
  journal.clear();
  let id;
  try {
    if (args['resume-maintenance']) {
      if (bridgeResume) {
        if (String(args['resume-maintenance']).toLowerCase() !== rid) throw new InputError('idempotency_conflict: --resume-maintenance must match --request-id');
        return resumeIdempotentMaintenance({ actor, id: rid, requestHash: rhash, requestContext, bridge: true });
      }
      const planned = loadMaintenance(args['resume-maintenance']).receipt;
      if (planned.actor && planned.actor !== actor) throw new InputError('idempotency_conflict: retained maintenance plan belongs to another actor');
      return completeMaintenance(args['resume-maintenance']);
    }
    const replay = idempotentReceipt(actor, rid, rhash);
    if (replay) return replay;
    id = rid || randomUUID();
    if (rid) {
      const resumed = resumeIdempotentMaintenance({ actor, id, requestHash: rhash, requestContext });
      if (resumed) return resumed;
    }
    let target, writes, rename, target_sha256, repair = null, inverse = false;
    if (args.restore) {
      const previous = loadMaintenance(args.restore);
      if (!readLedgerEntries().some(entry => entry.status === 'ok' && entry.operation_id === args.restore)) throw new Error('finish the original operation before restoring it');
      target = previous.receipt.target_path;
      rename = previous.rename;
      repair = previous.version === 3 ? previous.repair : null;
      target_sha256 = repair ? previous.receipt.target_sha256 : undefined;
      inverse = rename || repair ? !previous.inverse : false;
      writes = (rename ? [...previous.writes].reverse() : previous.writes).map(write => ({ path: write.path, before: write.after, after: write.before }));
    } else if (args.rename) {
      ({ target, writes, rename } = planRename(args));
    } else if (args['repair-index-link']) {
      ({ target, writes, target_sha256, repair } = repairIndexLinkPlan(args));
    } else {
      target = resolveEditableTarget(args.revise || args.deactivate, MAINTENANCE_SECTIONS).targetPath;
      const before = readRegularBytes(target).toString('utf8');
      if (sha256(before) !== validateSha256(args['expected-sha256'], 'expected SHA-256')) throw new Error('maintenance CAS mismatch');
      let after = null;
      if (args.revise) {
        const body = redactCredentials(args.body || readStdin()).text.trim();
        const frontmatter = before.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
        if (!body || body.includes('\0') || !frontmatter) throw new InputError('revision requires a body and existing frontmatter');
        let header = frontmatter;
        if (args.description !== undefined) {
          const description = redactCredentials(args.description.trim()).text;
          if (!description || description.length > 150 || /[\r\n\0]/.test(description)) throw new InputError('description must be one line of 1–150 characters');
          header = header.replace(/^description:.*$/m, `description: ${yamlScalar(description)}`);
        }
        after = `${header.trimEnd()}\n\n${body}\n`;
        if (Buffer.byteLength(after) > MAX_NOTE_BYTES) throw new InputError('revised note too large');
        checkStructuredWrite(after, { before, target });
      }
      writes = [{ path: target, before, after }];
      const hrefs = new Set([target, resolve(VAULT_ROOT, relative(VAULT_REAL, target)), relative(MEMORY_DIR, target), relative(MEMORY_REAL, target), relative(VAULT_REAL, target)]);
      for (const name of DOMAIN_INDEX_FILES) {
        const path = join(MEMORY_DIR, name);
        assertMaintenancePath(path, target);
        if (!existsSync(path)) continue;
        const old = readFileSync(path, 'utf8');
        const next = old.split('\n').flatMap(line => {
          const link = [...hrefs].map(href => `](${href})`).find(link => line.includes(link));
          if (!link || !/^\s*- \[/.test(line)) return [line];
          if (action === 'deactivate') return [];
          return [args.description === undefined ? line : `${line.slice(0, line.indexOf(link) + link.length)} — ${redactCredentials(args.description.trim()).text}`];
        }).join('\n');
        if (old !== next) writes.push({ path, before: old, after: next });
      }
      if (action === 'deactivate' && existsSync(INTENT_MAP_PATH)) {
        assertMaintenancePath(INTENT_MAP_PATH, target);
        const old = readFileSync(INTENT_MAP_PATH, 'utf8');
        const map = JSON.parse(old);
        if (!Array.isArray(map.eviction_log)) throw new Error('invalid intent-map eviction log');
        // Legacy eviction records have no note identity; same-title history
        // can belong to another note and must remain untouched.
        const kept = map.eviction_log.filter(entry => entry.source_path !== target);
        if (kept.length !== map.eviction_log.length) {
          map.eviction_log = kept;
          writes.push({ path: INTENT_MAP_PATH, before: old, after: JSON.stringify(map, null, 2) + '\n' });
        }
      }
    }
    const noteWrite = writes.find(write => write.path === target);
    if (args.restore && noteWrite?.after) checkStructuredWrite(noteWrite.after, { before: noteWrite.before, target, restore: true });
    const structured = noteWrite && structuredNote(noteWrite.after || noteWrite.before || '');
    const receipt = { status: 'ok', action, actor, reason, operation_id: id, target_path: target,
      ...(structured?.record ? { record_id: structured.id, record_version: structured.record.version } : {}),
      ...(structured?.event ? { event_id: structured.id } : {}),
      ...(structured?.candidate ? { candidate_id: structured.id } : {}),
      backup_path: maintenancePath(id), ...(args.restore ? { reverts_operation_id: args.restore } : {}),
      ...(rename ? { new_path: inverse ? rename.from : rename.to } : {}),
      ...(target_sha256 ? { target_sha256 } : {}) };
    Object.assign(receipt, idempotencyFields(rid, rhash, replayableReceipt(receipt), requestContext));
    const plan = { version: rename ? 2 : repair ? 3 : 1, receipt, writes, ...(rename ? { rename, inverse } : {}), ...(repair ? { repair, inverse } : {}) };
    for (const write of writes) {
      if (rename && write.after !== null && Buffer.byteLength(write.after) > MAX_NOTE_BYTES) throw new Error('rename note or reference exceeds size limit');
      assertMaintenanceWrite(write.path, plan);
      const current = existsSync(write.path) ? readFileSync(write.path, 'utf8') : null;
      if (current !== write.before) throw new Error(`maintenance CAS mismatch: ${write.path}`);
      write.before_sha256 = write.before === null ? null : sha256(write.before);
      write.after_sha256 = write.after === null ? null : sha256(write.after);
    }
    if (args.dryRun) return { status: 'preview', action, target_path: target, ...(rename ? { new_path: rename.to } : {}),
      ...(target_sha256 ? { target_sha256 } : {}),
      affected: writes.map(w => ({ path: w.path, before_sha256: w.before_sha256, after_sha256: w.after_sha256 })) };
    const record = JSON.stringify(plan) + '\n';
    if (Buffer.byteLength(record) > MAX_NOTE_BYTES * 4) throw new Error('maintenance recovery record exceeds size limit');
    saveExclusive(maintenancePath(id), record, undefined, renameTemp(maintenancePath(id), id));
    return completeMaintenance(id);
  } catch (error) {
    if (id && existsSync(maintenancePath(id))) throw new Error(`${error.message}; resume with --resume-maintenance ${id}`);
    throw error;
  } finally { release(); }
}

function nonnegativeLedgerInt(entry, key) {
  const value = entry[key];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ledger field ${key} must be a non-negative integer`);
  }
  return value;
}

function appendExistingNote({ rawTarget, expectedSha256, source, body, provenance }) {
  const actor = validateSource(source);
  const expected = validateSha256(expectedSha256, 'expected SHA-256');
  const operationId = randomUUID();
  const bodyRedaction = redactCredentials(body);
  const block = buildAppendBlock(bodyRedaction.text, provenance, actor, operationId);
  const release = acquireLock();
  journal.clear();
  let wrote = false;
  let target = null;
  try {
    readLedgerEntries();
    target = resolveEditableTarget(rawTarget);
    const before = readTracked(target.targetPath);
    const beforeSha256 = sha256(before);
    if (beforeSha256 !== expected) {
      throw new Error(`CAS mismatch: expected ${expected}, found ${beforeSha256}`);
    }
    const after = before + block;
    // Append is provenance-only for ordinary notes. Structured records/events
    // have stable identities and must use the governed revision path instead.
    if (structuredNote(before) || structuredNote(after)) throw new InputError('append cannot add to or create a structured record/event note');
    const afterBytes = Buffer.byteLength(after, 'utf8');
    if (afterBytes > MAX_NOTE_BYTES) {
      throw new Error(`merged note exceeds ${MAX_NOTE_BYTES} bytes`);
    }
    writeTracked(target.targetPath, after);
    wrote = true;
    const receipt = {
      actor,
      action: 'append',
      status: 'ok',
      operation_id: operationId,
      target_path: target.targetPath,
      target_relative: target.targetRelative,
      before_sha256: beforeSha256,
      after_sha256: sha256(after),
      before_bytes: Buffer.byteLength(before, 'utf8'),
      after_bytes: afterBytes,
      append_bytes: Buffer.byteLength(block, 'utf8'),
      delta_sha256: sha256(block),
      ...(bodyRedaction.count ? { redactions: bodyRedaction.count } : {}),
    };
    writeLedger(receipt, true);
    return receipt;
  } catch (err) {
    if (wrote) {
      const restoreFailures = rollbackJournal();
      writeLedger({
        actor, action: 'append', operation_id: operationId,
        target_path: target?.targetPath || rawTarget,
        status: restoreFailures.length ? 'partial' : 'rolled-back',
      });
      if (restoreFailures.length) {
        throw new Error(`${err.message}; rollback partial: ${restoreFailures.join('; ')}`);
      }
    }
    throw err;
  } finally {
    release();
  }
}

function undoAppend({ operationId, expectedAfterSha256, source }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(operationId || ''))) {
    throw new InputError('undo requires a valid append operation UUID');
  }
  const actor = validateSource(source);
  const expectedAfter = validateSha256(expectedAfterSha256, 'expected after SHA-256');
  const release = acquireLock();
  journal.clear();
  let wrote = false;
  let target = null;
  const undoOperationId = randomUUID();
  try {
    const matches = readLedgerEntries().filter(entry =>
      entry.action === 'append' && entry.status === 'ok' && entry.operation_id === operationId
    );
    if (matches.length !== 1) {
      throw new Error(`expected one successful append for operation ${operationId}, found ${matches.length}`);
    }
    const appendReceipt = matches[0];
    target = resolveEditableTarget(appendReceipt.target_path);
    if (appendReceipt.target_relative !== target.targetRelative) {
      throw new Error('ledger target path does not match its relative path');
    }
    const current = readTracked(target.targetPath);
    const currentSha256 = sha256(current);
    const ledgerAfter = validateSha256(appendReceipt.after_sha256, 'ledger after SHA-256');
    if (currentSha256 !== expectedAfter || currentSha256 !== ledgerAfter) {
      throw new Error('CAS mismatch: current note no longer equals the recorded append result');
    }
    const currentBytes = Buffer.from(current, 'utf8');
    const beforeBytes = nonnegativeLedgerInt(appendReceipt, 'before_bytes');
    const appendBytes = nonnegativeLedgerInt(appendReceipt, 'append_bytes');
    if (currentBytes.length !== beforeBytes + appendBytes) {
      throw new Error('recorded append byte lengths do not match the note');
    }
    const restoredBytes = currentBytes.subarray(0, beforeBytes);
    const appendedBytes = currentBytes.subarray(beforeBytes);
    if (sha256(restoredBytes) !== validateSha256(appendReceipt.before_sha256, 'ledger before SHA-256')) {
      throw new Error('recorded pre-append SHA does not match the note prefix');
    }
    if (sha256(appendedBytes) !== validateSha256(appendReceipt.delta_sha256, 'ledger delta SHA-256')) {
      throw new Error('recorded delta SHA does not match the note suffix');
    }
    const restored = restoredBytes.toString('utf8');
    if (!Buffer.from(restored, 'utf8').equals(restoredBytes)) {
      throw new Error('recorded append boundary splits invalid UTF-8');
    }
    writeTracked(target.targetPath, restored);
    wrote = true;
    const receipt = {
      actor,
      action: 'undo',
      status: 'ok',
      operation_id: undoOperationId,
      reverts_operation_id: operationId,
      target_path: target.targetPath,
      target_relative: target.targetRelative,
      before_sha256: currentSha256,
      after_sha256: sha256(restored),
      before_bytes: currentBytes.length,
      after_bytes: restoredBytes.length,
    };
    writeLedger(receipt, true);
    return receipt;
  } catch (err) {
    if (wrote) {
      const restoreFailures = rollbackJournal();
      writeLedger({
        actor, action: 'undo', operation_id: undoOperationId,
        reverts_operation_id: operationId,
        target_path: target?.targetPath || null,
        status: restoreFailures.length ? 'partial' : 'rolled-back',
      });
      if (restoreFailures.length) {
        throw new Error(`${err.message}; rollback partial: ${restoreFailures.join('; ')}`);
      }
    }
    throw err;
  } finally {
    release();
  }
}

/**
 * yamlScalar(v) -> string
 * Emits a YAML-safe scalar. Titles and descriptions routinely contain ':', '#', quotes
 * and brackets, any of which breaks a bare scalar and corrupts the whole frontmatter block.
 */
function yamlScalar(v) {
  const s = String(v ?? '');
  const needsQuote = s === '' ||
    /^[\s>|*&!%@`#?,\[\]{}-]/.test(s) ||   // leading indicator character
    /[:#]/.test(s) ||                       // key separator / comment marker
    /[\n\r\t]/.test(s) ||
    /\s$/.test(s) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^[+-]?(\d|\.\d)/.test(s);              // would otherwise parse as a number/date
  if (!needsQuote) return s;
  return `'${s.replace(/\n/g, ' ').replace(/'/g, "''")}'`;
}

function buildFrontmatter(fields) {
  const { name, description, type, scope, project, tags, created, source, durability, expires, files, provenance } = fields;
  const lines = ['---'];
  lines.push(`name: ${yamlScalar(name)}`);
  lines.push(`description: ${yamlScalar(description)}`);
  lines.push(`type: ${yamlScalar(type)}`);
  lines.push(`scope: ${yamlScalar(scope)}`);
  lines.push(`durability: ${yamlScalar(durability || 'durable')}`);
  if (expires) lines.push(`expires: ${yamlScalar(expires)}`);
  if (files && files.length > 0) {
    lines.push('files:');
    for (const f of files) lines.push(`  - ${yamlScalar(f)}`);
  }
  if (project) lines.push(`projects:\n  - ${yamlScalar(project)}`);
  else          lines.push('projects: []');
  lines.push(`source: ${yamlScalar(source || DEFAULT_SOURCE)}`);
  if (provenance) lines.push(`provenance: ${yamlScalar(provenance)}`);
  if (tags && tags.length > 0) {
    lines.push('tags:');
    for (const t of tags) lines.push(`  - ${yamlScalar(t)}`);
  } else {
    lines.push('tags: []');
  }
  lines.push(`created: '${created}'`);
  lines.push('---');
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Routing
// --------------------------------------------------------------------------

function loadRouting() {
  try {
    return JSON.parse(readFileSync(ROUTING_JSON, 'utf8'));
  } catch (err) {
    fatal(`Cannot read routing config ${ROUTING_JSON}: ${err.message}`, 3);
  }
}

function loadProjectMap() {
  try {
    return JSON.parse(readFileSync(PROJECT_MAP, 'utf8'));
  } catch (err) {
    fatal(`Cannot read project map ${PROJECT_MAP}: ${err.message}`, 3);
  }
}

function resolveTargetDir(type, projectArg) {
  const routing = loadRouting();
  const route = routing.routes.find(r => r.type === type);
  if (!route) fatal(`No routing entry for type "${type}"`, 3);

  let relPath = route.path;

  if (relPath.includes('{project-name}')) {
    if (!projectArg) {
      fatal(`type "${type}" requires --project`, 1);
    }
    projectArg = relativeRoute(projectArg, 'project');
    // Look up vaultDir from project map
    const pm = loadProjectMap();
    const mapping = pm.mappings.find(
      m => m.vaultDir === `01-项目/${projectArg}` ||
           m.localPath.endsWith(`/${projectArg}`) ||
           m.vaultDir.endsWith(`/${projectArg}`)
    );
    const vaultDir = mapping ? mapping.vaultDir : `01-项目/${projectArg}`;
    if (typeof vaultDir !== 'string' || !vaultDir.startsWith('01-项目/')) throw new InputError('Path escape rejected: project mapping must stay in 01-项目');
    resolveWriteDir(join(VAULT_ROOT, '01-项目'), vaultDir.slice('01-项目/'.length));
    relPath = vaultDir + '/';
  }

  const absDir = join(VAULT_ROOT, relPath);
  return { absDir, relPath, scope: route.scope };
}

// --------------------------------------------------------------------------
// v2: Section policy validation (2026-05-03 4-AI debate convergence)
// Enforces: 禁落顶层根 + per-section policy + 99-inbox/ fallback
// --------------------------------------------------------------------------

function listExistingSubfolders(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map(e => e.name);
  } catch { return []; }
}

/**
 * validateAgainstSectionPolicy(absDir, subfolder, type, project)
 *
 * Checks whether the resolved write target is allowed by the section_policies
 * defined in vault-routing.json (v2). Returns:
 *   { allowed: true }  → proceed
 *   { allowed: false, reason, fallback, existing_subfolders[, hint] }
 *     → caller should redirect to fallback (under 99-inbox/) and warn user
 *
 * Top-level sections without a policy entry are allowed by default.
 * 'allow_root' policy permits writing directly to the section root (no subfolder).
 */
function validateAgainstSectionPolicy(absDir, subfolder, type, projectArg) {
  const routing = loadRouting();
  const policies  = routing.section_policies || {};
  const inboxSubs = routing.inbox_subfolders || {};
  const inboxRoot = routing.inbox_root || '99-inbox/';

  // Compute path relative to vault root → "03-经验" or "01-项目/找工作"
  const relFromVault = relative(VAULT_ROOT, absDir).replace(/\\/g, '/');
  const parts = relFromVault.split('/').filter(Boolean);
  if (parts.length === 0) return { allowed: true };

  const topSection = parts[0] + '/';
  const policy = policies[topSection];
  if (!policy) return { allowed: true };  // unmanaged section → allow

  // The "subfolder" used for validation: explicit --subfolder flag wins;
  // otherwise infer from the resolved path (parts[1] when type routes to "01-项目/{project-name}/")
  const actualSubfolder = (subfolder && subfolder.trim())
    ? subfolder.trim()
    : (parts.length > 1 ? parts[1] : null);

  // Policy: allow_root → no subfolder requirement
  if (policy.policy === 'allow_root' || policy.requires_subfolder === false) {
    return { allowed: true };
  }

  // requires_subfolder = true
  if (!actualSubfolder) {
    return {
      allowed: false,
      reason: `${topSection} 要求 subfolder（policy=${policy.policy}）。请用 --subfolder <name> 指定；否则文件将落 ${inboxSubs[topSection] || inboxRoot}，等待经受管入口重新指定合法分类`,
      fallback: inboxSubs[topSection] || inboxRoot,
      existing_subfolders: policy.allowed_subfolders || listExistingSubfolders(join(VAULT_ROOT, topSection))
    };
  }

  if (policy.subfolder_pattern && !new RegExp(policy.subfolder_pattern).test(actualSubfolder)) {
    return {
      allowed: false,
      reason: `${topSection} 子文件夹 "${actualSubfolder}" 不匹配 subfolder_pattern=${policy.subfolder_pattern}`,
      fallback: inboxSubs[topSection] || inboxRoot,
      existing_subfolders: policy.allowed_subfolders || listExistingSubfolders(join(VAULT_ROOT, topSection))
    };
  }

  // allowed_subfolders whitelist (e.g. 03-经验/ closed set)
  if (Array.isArray(policy.allowed_subfolders) && !policy.allowed_subfolders.includes(actualSubfolder)) {
    return {
      allowed: false,
      reason: `${topSection} 子文件夹白名单不含 "${actualSubfolder}"（policy=${policy.policy}）。新增子类需手改 ~/.claude/vault-routing.json`,
      fallback: inboxSubs[topSection] || inboxRoot,
      existing_subfolders: policy.allowed_subfolders
    };
  }

  // propose / deny: subfolder must already exist on disk (no agent-created folders)
  const newSubfolderPolicy = policy.new_subfolder_policy;
  if (newSubfolderPolicy === 'propose' || newSubfolderPolicy === 'deny') {
    const subfolderPath = join(VAULT_ROOT, topSection, actualSubfolder);
    if (!existsSync(subfolderPath)) {
      const existing = listExistingSubfolders(join(VAULT_ROOT, topSection));
      return {
        allowed: false,
        reason: `子文件夹 "${actualSubfolder}" 不存在于 ${topSection}（policy=${newSubfolderPolicy}）。请经受管入口重新指定已有合法分类`,
        fallback: inboxSubs[topSection] || inboxRoot,
        existing_subfolders: existing
      };
    }
  }

  // bind_to_project: subfolder must be a registered project in .project-map.json
  if (policy.policy === 'bind_to_project') {
    let pm;
    try { pm = loadProjectMap(); } catch { pm = { mappings: [] }; }
    const sectionPrefix = topSection.replace(/\/$/, '');
    const matched = pm.mappings && pm.mappings.find(m =>
      m.vaultDir === `${sectionPrefix}/${actualSubfolder}` ||
      m.vaultDir.endsWith(`/${actualSubfolder}`)
    );
    if (!matched) {
      const registered = (pm.mappings || [])
        .filter(m => m.vaultDir && m.vaultDir.startsWith(sectionPrefix))
        .map(m => m.vaultDir.split('/').pop());
      return {
        allowed: false,
        reason: `项目 "${actualSubfolder}" 未注册到 .project-map.json（policy=bind_to_project）`,
        fallback: inboxSubs[topSection] || inboxRoot,
        existing_subfolders: registered,
        hint: `运行: node ${join(VAULT_ROOT, '00-系统', 'scripts', 'cli', 'brain-init.mjs')} ${actualSubfolder} --path <project_path>`
      };
    }
  }

  return { allowed: true };
}

// --------------------------------------------------------------------------
// Dedup (3 rounds)
// --------------------------------------------------------------------------

function collectAllMdFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  try {
    const entries = readdirSync(dir, { recursive: true });
    for (const e of entries) {
      if (e.endsWith('.md')) results.push(join(dir, e));
    }
  } catch {
    // fallback for older Node without recursive option
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      try {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name.endsWith('.md')) results.push(full);
        }
      } catch { /* skip unreadable dirs */ }
    }
  }
  return results;
}

function similarityScore(a, b) {
  // Simple character-level Jaccard on bigrams
  const bigrams = s => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const setA = bigrams(a.toLowerCase());
  const setB = bigrams(b.toLowerCase());
  let intersection = 0;
  for (const g of setA) if (setB.has(g)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function runDedup(title, targetDir, keywords, subfolderDir) {
  const exactMatches  = [];
  const fuzzyMatches  = [];

  // Collect scan dirs: always scan baseTarget; also scan subfolderDir if provided and different
  const scanDirs = [targetDir];
  if (subfolderDir && subfolderDir !== targetDir) {
    scanDirs.push(subfolderDir);
  }

  // --- Round 1: filename scan in target dirs ---
  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue;
    const files = collectAllMdFiles(dir);
    for (const fp of files) {
      const base = fp.split('/').pop().replace('.md', '');
      const hasKeyword = keywords.some(k => base.toLowerCase().includes(k));
      const score = similarityScore(base, title);
      if (score > 0.8) {
        exactMatches.push({ path: fp, round: 1, score });
      } else if (hasKeyword || score > 0.4) {
        fuzzyMatches.push({ path: fp, round: 1, score });
      }
    }
  }

  // --- Round 2: grep frontmatter name/description fields in target dirs ---
  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue;
    const files = collectAllMdFiles(dir);
    for (const fp of files) {
      if (exactMatches.some(m => m.path === fp) || fuzzyMatches.some(m => m.path === fp)) continue;
      try {
        const content = readFileSync(fp, 'utf8').slice(0, 2000); // only frontmatter region
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        const fm = fmMatch[1].toLowerCase();
        const hasKeyword = keywords.some(k => fm.includes(k));
        if (hasKeyword) {
          const score = similarityScore(fm, title.toLowerCase());
          if (score > 0.5) {
            exactMatches.push({ path: fp, round: 2, score });
          } else {
            fuzzyMatches.push({ path: fp, round: 2, score });
          }
        }
      } catch { /* skip unreadable files */ }
    }
  }

  // --- Round 3: MEMORY.md index scan ---
  if (existsSync(MEMORY_MD)) {
    try {
      const memContent = readFileSync(MEMORY_MD, 'utf8');
      for (const line of memContent.split('\n')) {
        if (!line.startsWith('- [')) continue;
        const linkMatch = line.match(/\[([^\]]+)\]/);
        if (!linkMatch) continue;
        const memTitle = linkMatch[1];
        const hasKeyword = keywords.some(k => memTitle.toLowerCase().includes(k));
        const score = similarityScore(memTitle, title);
        if (score > 0.8) {
          // Try to extract vault path from markdown link
          const path = markdownLinkDestination(line);
          exactMatches.push({ path: path || memTitle, round: 3, score });
        } else if (hasKeyword || score > 0.4) {
          const path = markdownLinkDestination(line);
          fuzzyMatches.push({ path: path || memTitle, round: 3, score });
        }
      }
    } catch { /* skip if MEMORY.md unreadable */ }
  }

  return { exactMatches, fuzzyMatches };
}

// --------------------------------------------------------------------------
// MEMORY.md index update (split-index aware)
// --------------------------------------------------------------------------

function buildIndexLine(title, absFilePath, description) {
  // Compute relative path from MEMORY.md's directory to vault file
  const memDir  = dirname(MEMORY_MD);
  const relPath = relative(memDir, absFilePath);
  // Use title as link text, path as relative href, description as hook
  return `- [${title}](${relPath}) — ${description}`;
}

/**
 * inferIndexTarget(relPath) -> { file: 'MEMORY-*.md', subfolder: string }
 *
 * Shared classification logic — mirrors brain-memory-split.mjs.
 * relPath is relative from MEMORY.md directory to the vault file.
 */
function inferIndexTarget(relPath) {
  const basename = relPath.split('/').pop() || relPath;

  // Vault path patterns (higher priority)
  if (relPath.includes('/02-知识/')) {
    return { file: 'MEMORY-knowledge.md', subfolder: extractSubfolderFromPath(relPath, '02-知识') };
  }
  if (relPath.includes('/03-经验/')) {
    return { file: 'MEMORY-experience.md', subfolder: extractSubfolderFromPath(relPath, '03-经验') };
  }
  if (relPath.includes('/01-项目/')) {
    return { file: 'MEMORY-project.md', subfolder: extractSubfolderFromPath(relPath, '01-项目') };
  }
  if (relPath.includes('/05-persona/')) {
    return { file: 'MEMORY-persona.md', subfolder: extractSubfolderFromPath(relPath, '05-persona') };
  }
  if (relPath.includes('/06-归档/')) {
    return { file: 'MEMORY-archive.md', subfolder: extractSubfolderFromPath(relPath, '06-归档') };
  }
  if (relPath.includes('/07-随笔/')) {
    return { file: 'MEMORY-notes.md', subfolder: extractSubfolderFromPath(relPath, '07-随笔') };
  }
  if (relPath.includes('/09-周报/')) {
    return { file: 'MEMORY-notes.md', subfolder: extractSubfolderFromPath(relPath, '09-周报') };
  }

  // Filename prefix patterns (local memory/ files)
  if (basename.startsWith('reference_')) return { file: 'MEMORY-knowledge.md',  subfolder: '（无子文件夹/顶层）' };
  if (basename.startsWith('feedback_'))  return { file: 'MEMORY-experience.md', subfolder: '（无子文件夹/顶层）' };
  if (basename.startsWith('project_'))   return { file: 'MEMORY-project.md',    subfolder: '（无子文件夹/顶层）' };
  if (basename.startsWith('user_'))      return { file: 'MEMORY-persona.md',    subfolder: '（无子文件夹/顶层）' };
  if (basename === 'VAULT-MEMORY-PROTOCOL.md') return { file: 'MEMORY-knowledge.md', subfolder: '（无子文件夹/顶层）' };

  return { file: null, subfolder: null };
}

function extractSubfolderFromPath(relPath, layer) {
  const normalised = relPath.replace(/\\/g, '/');
  const marker = `/${layer}/`;
  const idx = normalised.indexOf(marker);
  if (idx === -1) return '（无子文件夹/顶层）';
  const afterLayer = normalised.slice(idx + marker.length);
  const parts = afterLayer.split('/');
  return parts.length <= 1 ? '（无子文件夹/顶层）' : parts[0];
}

const HOT_SECTION_HEADER  = '## 🔥 热记忆（容量 40，按 type 配额+FIFO）';
const HOT_CAPACITY        = 40;
const HOT_DESCRIPTION_MAX_LEN = 100;

/**
 * truncateHotDescription(indexLine)
 *
 * MEMORY.md is auto-loaded by Claude Code with a hard size limit; long descriptions
 * are the main contributor to index bloat. Truncate only the description portion
 * (never the [title](path) link) to HOT_DESCRIPTION_MAX_LEN chars for hot-section
 * entries. Domain index files (MEMORY-*.md) keep the untruncated indexLine.
 */
function hotLineExpired(line) {
  const path = markdownLinkDestination(line);
  if (!path) return false;
  const target = resolve(MEMORY_DIR, path);
  if (!existsSync(target)) return false;
  const frontmatter = readFileSync(target, 'utf8').slice(0, 2000);
  const expiresM = frontmatter.match(/^expires:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m);
  return expiresM ? expiresM[1] < today() : false;
}

function truncateHotDescription(indexLine) {
  const link = parseMarkdownLink(indexLine);
  if (!link || !indexLine.startsWith('- [') || !indexLine.slice(link.end + 1).startsWith(' — ')) return indexLine;
  const head = indexLine.slice(0, link.end + 1);
  const desc = indexLine.slice(link.end + 4);
  if (desc.length <= HOT_DESCRIPTION_MAX_LEN) return indexLine;
  return `${head} — ${desc.slice(0, HOT_DESCRIPTION_MAX_LEN)}`;
}

// Q3: type-quota for hot section (type -> max count before pushing to flex)
const TYPE_QUOTAS = {
  experience: 10,
  project:    8,
  knowledge:  6,
  persona:    2,
  flex:       14,
};

/**
 * inferHotEntryType(relPath) -> 'experience' | 'project' | 'knowledge' | 'persona' | 'flex'
 * Used by Q3 eviction logic to determine which quota bucket an entry belongs to.
 */
function inferHotEntryType(relPath) {
  if (!relPath) return 'flex';
  const r = relPath.replace(/\\/g, '/');
  if (r.includes('/03-经验/') || r.includes('feedback_')) return 'experience';
  if (r.includes('/01-项目/') || r.includes('project_'))  return 'project';
  if (r.includes('/02-知识/') || r.includes('reference_')) return 'knowledge';
  if (r.includes('/05-persona/') || r.includes('user_'))  return 'persona';
  return 'flex';
}

/**
 * updateMemoryMdHot(indexLine, dryRun)
 *
 * Inserts indexLine at the top of the 🔥 hot section.
 * If hot count exceeds HOT_CAPACITY, removes the oldest (last) hot entry and returns it.
 * Falls back to legacy append if MEMORY.md doesn't have the split structure.
 * Returns { evicted: { title, relPath } | null }
 */
function updateMemoryMdHot(indexLine, dryRun = false, insertHot = true) {
  if (insertHot) indexLine = truncateHotDescription(indexLine);
  let evicted = null;
  const existing = readTracked(MEMORY_MD) ?? '';

  // Detect split-index structure
  const hotHeaderIdx = existing.indexOf(HOT_SECTION_HEADER);
  if (hotHeaderIdx === -1) {
    // Legacy flat format — just append
    if (!dryRun && insertHot) {
      const newContent = existing.endsWith('\n')
        ? existing + indexLine + '\n'
        : existing + '\n' + indexLine + '\n';
      writeTracked(MEMORY_MD, newContent);
    }
    return { evicted: null };
  }

  const lines = existing.split('\n');
  // Find the line index of the hot section header
  const headerLineIdx = lines.findIndex(l => l === HOT_SECTION_HEADER);
  if (headerLineIdx === -1) {
    // Fallback
    if (!dryRun && insertHot) {
      const newContent = existing.endsWith('\n')
        ? existing + indexLine + '\n'
        : existing + '\n' + indexLine + '\n';
      writeTracked(MEMORY_MD, newContent);
    }
    return { evicted: null };
  }

  // Find insertion point: first entry line after header (skip blank lines and the
  // <auto-maintained...> comment line)
  let insertAt = headerLineIdx + 1;
  while (insertAt < lines.length &&
         (lines[insertAt].trim() === '' || lines[insertAt].trim().startsWith('<'))) {
    insertAt++;
  }

  // Count hot entries (lines starting with '- [' between header and next '##')
  const nextSectionIdx = lines.findIndex(
    (l, i) => i > headerLineIdx + 1 && l.startsWith('## ')
  );
  const endOfHot = nextSectionIdx === -1 ? lines.length : nextSectionIdx;

  const expiredIndices = [];
  for (let i = headerLineIdx + 1; i < endOfHot; i++) {
    if (lines[i].startsWith('- [') && hotLineExpired(lines[i])) expiredIndices.push(i);
  }
  for (const idx of expiredIndices.reverse()) {
    lines.splice(idx, 1);
    if (idx < insertAt) insertAt--;
  }

  if (insertHot) {
    lines.splice(insertAt, 0, indexLine);
  }

  const nextSectionAfterCleanup = lines.findIndex(
    (l, i) => i > headerLineIdx + 1 && l.startsWith('## ')
  );
  const hotEndAfterCleanup = nextSectionAfterCleanup === -1 ? lines.length : nextSectionAfterCleanup;
  const hotEntryIndices = [];
  for (let i = headerLineIdx + 1; i < hotEndAfterCleanup; i++) {
    if (lines[i].startsWith('- [')) hotEntryIndices.push(i);
  }

  // Q3: If over capacity, evict from the most over-quota type (or oldest flex)
  if (insertHot && hotEntryIndices.length > HOT_CAPACITY) {
      // Build per-type lists of [lineIdx, relPath] (oldest = last in list since newest is at top)
      const typeEntries = { experience: [], project: [], knowledge: [], persona: [], flex: [] };
      for (const idx of hotEntryIndices) {
        const l = lines[idx];
        const rp = markdownLinkDestination(l) || '';
        const t = inferHotEntryType(rp);
        typeEntries[t].push({ idx, relPath: rp, line: l });
      }

      // Find type with most excess over quota (oldest entry = last in array)
      let evictType = null;
      let maxExcess = 0;
      for (const [t, quota] of Object.entries(TYPE_QUOTAS)) {
        const excess = (typeEntries[t] || []).length - quota;
        if (excess > maxExcess) { maxExcess = excess; evictType = t; }
      }
      // fallback: evict oldest overall
      if (!evictType) evictType = 'flex';
      const candidates = typeEntries[evictType];
      const victim = candidates.length > 0
        ? candidates[candidates.length - 1]   // oldest of that type
        : { idx: hotEntryIndices[hotEntryIndices.length - 1], relPath: '', line: lines[hotEntryIndices[hotEntryIndices.length - 1]] };

      const removedLine = victim.line;
      const titleMatch = removedLine.match(/\[([^\]]+)\]/);
      evicted = {
        title: titleMatch ? titleMatch[1] : removedLine,
        relPath: markdownLinkDestination(removedLine) || '',
      };
      if (!dryRun) {
        lines.splice(victim.idx, 1);
      }
    }

  if (!dryRun) {
    writeTracked(MEMORY_MD, lines.join('\n'));
  }
  return { evicted };
}

/**
 * updateDomainIndex(indexLine, relPath, subfolder, dryRun, forceIndexFile)
 *
 * Appends indexLine to the correct MEMORY-*.md domain index file.
 * Finds or creates the matching subfolder group within that file.
 * subfolder param overrides path inference when provided.
 * forceIndexFile (Q1): when set, writes to this index file instead of the inferred one.
 */
function updateDomainIndex(indexLine, relPath, explicitSubfolder, dryRun = false, forceIndexFile = null) {
  try {
    const { file: inferredFile, subfolder: inferredSubfolder } = inferIndexTarget(relPath);
    const file = forceIndexFile || inferredFile;
    if (!file) {
      // Unknown domain — skip silently (entry is still in MEMORY.md hot)
      process.stderr.write(`[warn] Could not infer domain index for path: ${relPath}\n`);
      return { file: null, subfolder: null };
    }

    // Use explicit subfolder if provided (matches vault write location), else inferred
    const targetSubfolder = explicitSubfolder || inferredSubfolder || '（无子文件夹/顶层）';
    void inferredFile; // used above

    const domainPath = join(dirname(MEMORY_MD), file);
    const existing   = readTracked(domainPath) ?? '';
    const lines      = existing.split('\n');

    // Look for the subfolder group header: '## <targetSubfolder>'
    const groupHeader = `## ${targetSubfolder}`;
    const groupIdx = lines.findIndex(l => l === groupHeader);

    if (groupIdx !== -1) {
      // Group exists — find last entry line in this group, append after it
      let lastEntryIdx = groupIdx;
      for (let i = groupIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) break; // next group
        if (lines[i].startsWith('- [')) lastEntryIdx = i;
      }
      lines.splice(lastEntryIdx + 1, 0, indexLine);
    } else {
      // Group doesn't exist — append new group at end of file
      // Ensure file ends with a newline before adding
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('');
      lines.push(groupHeader);
      lines.push(indexLine);
      lines.push('');
    }

    if (!dryRun) {
      writeTracked(domainPath, lines.join('\n'));
    }
    return { file, subfolder: targetSubfolder };
  } catch (err) {
    if (!dryRun) throw new Error(`Failed to update domain index: ${err.message}`);
    return { file: null, subfolder: null };
  }
}

// --------------------------------------------------------------------------
// Q1: Cross-type detection
// --------------------------------------------------------------------------

// Priority order for primary type selection (highest index = highest priority)
const TYPE_PRIORITY = ['archive', 'persona', 'note', 'reference', 'experience', 'project'];

// Map tag keywords to index targets
const TAG_TO_TYPE = {
  experience: 'experience',
  feedback:   'experience',
  project:    'project',
  reference:  'reference',
  knowledge:  'reference',
  note:       'note',
  persona:    'persona',
  'user-profile': 'persona',
  archive:    'archive',
};

/**
 * detectCrossTypeTags(tags) -> string[]
 *
 * Returns all type strings matched by the given tags array.
 * e.g. ['experience','project','ai'] -> ['experience','project']
 */
function detectCrossTypeTags(tags) {
  if (!tags || tags.length === 0) return [];
  const matched = new Set();
  for (const tag of tags) {
    const t = (tag || '').toLowerCase().trim();
    if (TAG_TO_TYPE[t]) matched.add(TAG_TO_TYPE[t]);
  }
  return [...matched];
}

/**
 * pickPrimaryType(crossTypes, writeType) -> string
 *
 * Given a list of matched types and the explicitly-declared write type,
 * returns the highest-priority type.
 * project > experience > reference > note > persona > archive
 */
function pickPrimaryType(crossTypes, writeType) {
  const candidates = new Set(crossTypes);
  // Map writeType to canonical cross type
  const writeCanonical = TAG_TO_TYPE[writeType] || writeType;
  candidates.add(writeCanonical);

  let best = null;
  let bestPriority = -1;
  for (const t of candidates) {
    const p = TYPE_PRIORITY.indexOf(t);
    if (p > bestPriority) { bestPriority = p; best = t; }
  }
  return best || writeCanonical;
}

/**
 * indexFileForCrossType(crossType) -> string | null
 */
function indexFileForCrossType(crossType) {
  const map = {
    experience: 'MEMORY-experience.md',
    project:    'MEMORY-project.md',
    reference:  'MEMORY-knowledge.md',
    knowledge:  'MEMORY-knowledge.md',
    note:       'MEMORY-notes.md',
    persona:    'MEMORY-persona.md',
    archive:    'MEMORY-archive.md',
  };
  return map[crossType] || null;
}

/**
 * buildPointerLine(title, relPath, primaryIndexFile, primarySubfolder) -> string
 *
 * Formats a lightweight pointer line for secondary cross-type indexes.
 * Format: - [title] → 见 MEMORY-xxx.md#subfolder
 */
function buildPointerLine(title, relPath, primaryIndexFile, primarySubfolder) {
  const memDir = dirname(MEMORY_MD);
  const rel = relPath.startsWith('/') ? relative(memDir, relPath) : relPath;
  const target = primarySubfolder
    ? `${primaryIndexFile}#${primarySubfolder}`
    : primaryIndexFile;
  return `- [${title}](${rel}) → 见 ${target}`;
}

/**
 * appendToMemory(indexLine, relPath, subfolder, dryRun, crossTypes, title, primaryIndexFile, primarySubfolder)
 *
 * Main entry point for index updates.
 * Writes to two locations:
 *   1. MEMORY.md 🔥 hot section (top-insert, FIFO capacity 40)
 *   2. MEMORY-*.md domain index (subfolder group, append)
 *
 * Q1: If crossTypes has more than one type, also writes pointer lines to secondary indexes.
 * relPath: relative path from MEMORY.md dir to the vault file (same as in indexLine)
 * subfolder: explicit subfolder used when writing the vault file (optional)
 * Returns { evicted } for P0 eviction log
 */
function appendToMemory(indexLine, relPath, subfolder, dryRun = false, crossTypes, title, primaryIndexFile, primarySubfolder, durability = 'durable') {
  const { evicted } = updateMemoryMdHot(indexLine, dryRun, durability !== 'ephemeral');
  const { file: domainFile, subfolder: domainSubfolder } = updateDomainIndex(indexLine, relPath, subfolder || null, dryRun);

  // Q1: write pointer lines to secondary cross-type indexes
  // domainFile = index that got the full entry (inferred from vault path)
  // For all OTHER matched cross types, write a pointer → pointing to domainFile
  if (crossTypes && crossTypes.length > 1 && title && domainFile) {
    for (const ct of crossTypes) {
      const secFile = indexFileForCrossType(ct);
      if (!secFile) continue;
      // Skip the index that already got the full entry
      if (secFile === domainFile) continue;
      const pointerLine = buildPointerLine(title, relPath, domainFile, domainSubfolder);
      updateDomainIndex(pointerLine, relPath, subfolder || null, dryRun, secFile);
    }
  }

  return { evicted, domainFile, domainSubfolder };
}

// --------------------------------------------------------------------------
// P0: Intent Map (intent-map.json)
// --------------------------------------------------------------------------

/**
 * loadIntentMap() -> { version, updated_at, keyword_routes, eviction_log }
 *
 * Loads or initialises the intent map. Never throws — returns default structure on error.
 */
function loadIntentMap() {
  if (!existsSync(INTENT_MAP_PATH)) {
    return {
      version: 1,
      updated_at: new Date().toISOString(),
      keyword_routes: {},
      eviction_log: [],
    };
  }
  try {
    return JSON.parse(readTracked(INTENT_MAP_PATH));
  } catch {
    return {
      version: 1,
      updated_at: new Date().toISOString(),
      keyword_routes: {},
      eviction_log: [],
    };
  }
}

function saveIntentMap(map) {
  const dir = dirname(INTENT_MAP_PATH);
  mkdirSync(dir, { recursive: true });
  map.updated_at = new Date().toISOString();
  writeTracked(INTENT_MAP_PATH, JSON.stringify(map, null, 2) + '\n');
}

/**
 * updateIntentMap(title, tags, indexFile, subfolder, dryRun)
 *
 * Adds keyword_routes entries for all keywords derived from title + tags.
 * Each route points to "<indexFile>#<subfolder>".
 * Returns preview object (used by --dry-run).
 */
function updateIntentMap(title, tags, indexFile, subfolder, dryRun = false) {
  const map = loadIntentMap();
  const routeTarget = indexFile
    ? `${indexFile}${subfolder ? '#' + subfolder : ''}`
    : null;

  const keywords = extractKeywordsExtended(title, tags);
  const newRoutes = {};

  for (const kw of keywords) {
    if (!kw || kw.length < 1) continue;
    const existing = map.keyword_routes[kw] || [];
    if (routeTarget && !existing.includes(routeTarget)) {
      newRoutes[kw] = routeTarget;
      if (!dryRun) {
        map.keyword_routes[kw] = [...existing, routeTarget];
      }
    }
  }

  if (!dryRun) {
    saveIntentMap(map);
  }

  return { keywords, new_routes: newRoutes };
}

/**
 * recordEvictionToIntentMap(evicted, domainFile, subfolder, tags)
 *
 * When FIFO evicts a hot entry, log it to intent-map.json eviction_log.
 * Also ensures keyword_routes for the evicted entry still exist (don't remove them).
 */
function recordEvictionToIntentMap(evicted, domainFile, subfolder, tags) {
  if (!evicted || !evicted.title) return;

  const map = loadIntentMap();

  // Build eviction log entry
  const keywords = extractKeywordsExtended(evicted.title, tags || []);
  const logEntry = {
    title: evicted.title,
    ...(evicted.relPath ? { source_path: realpathDeep(resolve(MEMORY_DIR, evicted.relPath)) } : {}),
    evicted_at: new Date().toISOString(),
    destination_index: domainFile || 'unknown',
    subfolder: subfolder || '（无子文件夹/顶层）',
    keywords,
  };

  map.eviction_log = [logEntry, ...(map.eviction_log || [])];

  // FIFO cap: keep most recent EVICTION_LOG_CAPACITY entries
  if (map.eviction_log.length > EVICTION_LOG_CAPACITY) {
    map.eviction_log = map.eviction_log.slice(0, EVICTION_LOG_CAPACITY);
  }

  saveIntentMap(map);
}

// --------------------------------------------------------------------------
// P1: --verify
// --------------------------------------------------------------------------

function parseMarkdownLink(line) {
  const marker = line.indexOf('](');
  if (marker < 0) return null;
  const start = marker + 2;
  let depth = 1, angle = false, quote = null, end = start;
  for (; end < line.length; end++) {
    const char = line[end];
    if (char === '\\') { end++; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (!angle && depth === 1 && /["']/.test(char) && /\s/.test(line[end - 1]) && /(?:\.md|>)$/.test(line.slice(start, end).trim()) && /^(?:"[^"]*"|'[^']*')\s*\)/.test(line.slice(end))) { quote = char; continue; }
    if (char === '<') angle = true;
    else if (char === '>') angle = false;
    else if (!angle && char === '(') depth++;
    else if (!angle && char === ')' && --depth === 0) break;
    if (char === '\n') return null;
  }
  if (depth !== 0) return null;
  let destination = line.slice(start, end).trim();
  if (destination.startsWith('<')) {
    const close = destination.indexOf('>');
    if (close < 1 || !/^\s*(?:["'][\s\S]*["'])?\s*$/.test(destination.slice(close + 1))) return null;
    destination = destination.slice(1, close);
  } else {
    const titleAt = destination.search(/(?<=\.md)\s+(?:"[^"]*"|'[^']*')$/);
    if (titleAt >= 0) destination = destination.slice(0, titleAt);
  }
  const destinationStart = start + line.slice(start, end).indexOf(destination);
  return destination ? { destination, destinationStart, destinationEnd: destinationStart + destination.length, end } : null;
}

function markdownLinkDestination(line) {
  return parseMarkdownLink(line)?.destination || null;
}

function repairIndexLinkPlan(args, indexContents = null) {
  const rawFrom = String(args['repair-index-link'] || '');
  if (!rawFrom || resolve(rawFrom) !== rawFrom) throw new InputError('repair index link requires an absolute old note path');
  const from = resolve(rawFrom);
  assertInsideVault(from, 'repair index source');
  const target = resolveEditableTarget(args.to, MAINTENANCE_SECTIONS).targetPath;
  const sameTarget = existsSync(from) && realpathSync(from) === target;
  if (existsSync(from) && !sameTarget) throw new InputError('repair index source must no longer exist');
  const targetBytes = readRegularBytes(target);
  if (sha256(targetBytes) !== validateSha256(args['expected-sha256'], 'expected SHA-256')) throw new Error('repair target changed since review');
  const targetIndexPath = resolve(VAULT_ROOT, relative(VAULT_REAL, target));
  const targetRel = relative(MEMORY_DIR, targetIndexPath);
  const inferred = inferIndexTarget(targetRel);
  const writes = [];
  for (const name of DOMAIN_INDEX_FILES) {
    const path = join(MEMORY_DIR, name);
    assertMaintenancePath(path, target);
    if (indexContents && !indexContents.has(path)) continue;
    if (!existsSync(path)) continue;
    const before = indexContents ? indexContents.get(path) : readFileSync(path, 'utf8');
    const lines = before.split('\n');
    const matches = [];
    let group = '（无子文件夹/顶层）';
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.startsWith('## ')) { group = line.slice(3).trim(); continue; }
      const link = parseMarkdownLink(line);
      if (link && resolve(MEMORY_DIR, link.destination) === from) matches.push({ line, link, index, group });
    }
    if (matches.length > 1) throw new Error(`ambiguous repair index reference in ${path}`);
    if (!matches.length) continue;
    if (name !== 'MEMORY.md' && inferred.file !== name) throw new Error(`repair target belongs in ${inferred.file || 'no domain index'}, not ${name}`);
    const match = matches[0];
    const replacement = match.link.destination.startsWith('/') ? target : targetRel;
    const repairedLine = match.line.slice(0, match.link.destinationStart) + replacement + match.line.slice(match.link.destinationEnd);
    let after;
    if (name !== 'MEMORY.md' && inferred.subfolder !== match.group) {
      lines.splice(match.index, 1);
      const header = `## ${inferred.subfolder}`;
      const groupIndex = lines.findIndex(line => line === header);
      if (groupIndex >= 0) {
        let insertAt = groupIndex + 1;
        while (insertAt < lines.length && !lines[insertAt].startsWith('## ')) insertAt++;
        lines.splice(insertAt, 0, repairedLine);
      } else {
        while (lines.length && lines.at(-1) === '') lines.pop();
        lines.push('', header, repairedLine, '');
      }
      after = lines.join('\n');
    } else {
      after = before.slice(0, before.indexOf(match.line)) + repairedLine + before.slice(before.indexOf(match.line) + match.line.length);
    }
    if (before !== after) writes.push({ path, before, after });
  }
  if (!writes.length) throw new Error('repair source is not referenced by a managed index');
  return { target, writes, target_sha256: sha256(targetBytes), repair: { from } };
}

/**
 * runVerify()
 *
 * Scans all domain index files for:
 * - Dead links (file path doesn't exist on disk)
 * - Duplicate entries (same path in hot section twice)
 * - Inconsistent group (path's inferred subfolder != group header it's under)
 * - intent-map.json pointing to non-existent index files
 *
 * Outputs JSON report.
 */
function runVerify() {
  const report = {
    dead_links: [],
    duplicates: [],
    inconsistent_group: [],
    intent_map_issues: [],
    overall: 'PASS',
  };

  // --- Check each domain index file ---
  for (const indexFileName of DOMAIN_INDEX_FILES) {
    const indexPath = join(MEMORY_DIR, indexFileName);
    if (!existsSync(indexPath)) {
      report.intent_map_issues.push({
        file: indexFileName,
        issue: 'Index file does not exist',
      });
      continue;
    }

    const content = readFileSync(indexPath, 'utf8');
    const lines = content.split('\n');

    // Track seen paths for duplicate detection (hot section only for MEMORY.md)
    const seenPaths = {};
    let currentGroup = '（无子文件夹/顶层）';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track group header
      if (line.startsWith('## ')) {
        // Ignore well-known non-subfolder headers
        const headerText = line.slice(3).trim();
        const knownMeta = ['📚 领域索引（按需读取）', '索引维护规则'];
        if (!knownMeta.some(h => headerText.includes(h)) &&
            !headerText.startsWith('🔥')) {
          currentGroup = headerText;
        }
        continue;
      }

      if (!line.startsWith('- [')) continue;

      // Extract link path
      const rawPath = markdownLinkDestination(line);
      if (!rawPath) continue;

      // Resolve absolute path
      let absPath;
      if (rawPath.startsWith('/')) {
        absPath = rawPath;
      } else {
        absPath = resolve(MEMORY_DIR, rawPath);
      }

      // Dead link check
      if (!existsSync(absPath)) {
        report.dead_links.push({
          index_file: indexFileName,
          line: i + 1,
          path: rawPath,
          abs_path: absPath,
        });
        report.overall = 'FAIL';
      }

      // Duplicate check (within same index file)
      const key = `${indexFileName}:${rawPath}`;
      if (seenPaths[key]) {
        report.duplicates.push({
          index_file: indexFileName,
          path: rawPath,
          first_line: seenPaths[key],
          second_line: i + 1,
        });
        report.overall = 'FAIL';
      } else {
        seenPaths[key] = i + 1;
      }

      // Inconsistent group check (only for domain index files, not MEMORY.md)
      if (indexFileName !== 'MEMORY.md') {
        const inferred = inferIndexTarget(rawPath);
        if (inferred.subfolder && inferred.subfolder !== currentGroup) {
          report.inconsistent_group.push({
            index_file: indexFileName,
            line: i + 1,
            path: rawPath,
            declared_group: currentGroup,
            inferred_group: inferred.subfolder,
          });
          // Inconsistent group is a warning, not necessarily FAIL
        }
      }
    }
  }

  // --- Check intent-map.json ---
  if (existsSync(INTENT_MAP_PATH)) {
    try {
      const map = JSON.parse(readFileSync(INTENT_MAP_PATH, 'utf8'));
      for (const [kw, targets] of Object.entries(map.keyword_routes || {})) {
        for (const target of (Array.isArray(targets) ? targets : [targets])) {
          const indexFileName = target.split('#')[0];
          const indexPath = join(MEMORY_DIR, indexFileName);
          if (!existsSync(indexPath)) {
            report.intent_map_issues.push({
              keyword: kw,
              target,
              issue: `Referenced index file does not exist: ${indexFileName}`,
            });
            report.overall = 'FAIL';
          }
        }
      }
    } catch (e) {
      report.intent_map_issues.push({ issue: `Cannot parse intent-map.json: ${e.message}` });
      report.overall = 'FAIL';
    }
  }

  return report;
}

// --------------------------------------------------------------------------
// P1: --dry-run preview builder
// --------------------------------------------------------------------------

/**
 * buildDryRunPreview(params)
 *
 * Simulates a write and returns what would happen, without touching any files.
 */
function buildDryRunPreview({ type, title, description, subfolder, tags, body, project }) {
  // Route
  let routing;
  try {
    routing = resolveTargetDir(type, project);
  } catch {
    return { error: `Cannot resolve route for type "${type}"` };
  }
  const { absDir } = routing;
  let writeDir = resolveWriteDir(absDir, subfolder);
  const validation = validateAgainstSectionPolicy(writeDir, subfolder, type, project);
  const inboxRedirect = validation.allowed ? null : {
    from: writeDir,
    to: join(VAULT_ROOT, validation.fallback),
    reason: validation.reason,
  };
  if (inboxRedirect) writeDir = inboxRedirect.to;
  const recallState = recallStateFor(writeDir);
  const recallEligible = recallState === 'eligible';
  const safeFilename = sanitizeFilename(title) + '.md';
  const finalPath = join(writeDir, safeFilename);
  const relPathForIndex = relative(MEMORY_DIR, finalPath);

  const isObservation = type === 'observation';
  let exactMatches = [];
  let fuzzyMatches = [];
  if (!isObservation) {
    const keywords = extractKeywords(title);
    ({ exactMatches, fuzzyMatches } = runDedup(title, absDir, keywords, subfolder ? writeDir : undefined));
  }

  // Domain index inference
  const { file: domainFile, subfolder: domainSub } = !recallEligible || isObservation
    ? { file: null, subfolder: null }
    : inferIndexTarget(relPathForIndex);

  // intent-map keywords
  const allKeywords = !recallEligible || isObservation ? [] : extractKeywordsExtended(title, tags || []);
  const intentMap = !recallEligible || isObservation ? { keyword_routes: {} } : loadIntentMap();
  const routeTarget = domainFile ? `${domainFile}${domainSub ? '#' + domainSub : ''}` : null;
  const newRoutes = {};
  for (const kw of allKeywords) {
    const existing = intentMap.keyword_routes[kw] || [];
    if (routeTarget && !existing.includes(routeTarget)) {
      newRoutes[kw] = routeTarget;
    }
  }

  // FIFO eviction preview
  const memContent = !recallEligible || isObservation ? '' : (existsSync(MEMORY_MD) ? readFileSync(MEMORY_MD, 'utf8') : '');
  const lines = memContent.split('\n');
  const headerLineIdx = lines.findIndex(l => l === HOT_SECTION_HEADER);
  let hotCount = 0;
  let wouldEvict = null;
  if (headerLineIdx !== -1) {
    const nextSec = lines.findIndex((l, i) => i > headerLineIdx + 1 && l.startsWith('## '));
    const end = nextSec === -1 ? lines.length : nextSec;
    const hotLines = lines.slice(headerLineIdx + 1, end).filter(l => l.startsWith('- ['));
    hotCount = hotLines.length;
    if (hotCount >= HOT_CAPACITY && hotLines.length > 0) {
      const oldest = hotLines[hotLines.length - 1];
      const tm = oldest.match(/\[([^\]]+)\]/);
      wouldEvict = tm ? tm[1] : oldest;
    }
  }

  return {
    would_create_file: finalPath,
    recall_state: recallState,
    inbox_redirect: inboxRedirect,
    would_update_hot_section: recallEligible && !isObservation ? MEMORY_MD : null,
    would_update_domain_index: domainFile ? join(MEMORY_DIR, domainFile) : null,
    domain_subfolder: domainSub,
    dedup_exact_matches: exactMatches.map(m => m.path),
    dedup_fuzzy_matches: fuzzyMatches.map(m => m.path),
    intent_map_new_routes: newRoutes,
    hot_section_count_before: hotCount,
    would_evict: wouldEvict,
    index_line_preview: `- [${title}](${relPathForIndex}) — ${description}`,
  };
}

// --------------------------------------------------------------------------
// Q2A: --show-route
// --------------------------------------------------------------------------

/**
 * buildShowRoute(params) -> object
 *
 * Returns routing decision JSON without touching any files.
 * Faster than --dry-run: no dedup, no frontmatter generation.
 */
function buildShowRoute({ type, title, subfolder, tags, project }) {
  let routing;
  try {
    routing = resolveTargetDir(type, project);
  } catch (e) {
    return { error: `Cannot resolve route for type "${type}": ${e.message}` };
  }
  const { absDir } = routing;
  let writeDir = resolveWriteDir(absDir, subfolder);
  const validation = validateAgainstSectionPolicy(writeDir, subfolder, type, project);
  const inboxRedirect = validation.allowed ? null : {
    from: writeDir,
    to: join(VAULT_ROOT, validation.fallback),
    reason: validation.reason,
  };
  if (inboxRedirect) writeDir = inboxRedirect.to;
  const recallState = recallStateFor(writeDir);
  const recallEligible = recallState === 'eligible';
  const safeFilename = sanitizeFilename(title || 'untitled') + '.md';
  const absolutePath = join(writeDir, safeFilename);
  const relPathForIndex = relative(dirname(MEMORY_MD), absolutePath);
  const { file: indexFile, subfolder: indexGroup } = recallEligible
    ? inferIndexTarget(relPathForIndex)
    : { file: null, subfolder: null };

  // Q1: detect cross-type tags
  // domainFile = the index that will get the full entry (inferred from vault path)
  const crossTypes = detectCrossTypeTags(tags || []);
  const crossRefs = recallEligible && crossTypes.length > 1
    ? crossTypes
        .filter(ct => {
          const f = indexFileForCrossType(ct);
          return f && f !== indexFile;
        })
        .map(ct => ({
          type: ct,
          index_file: indexFileForCrossType(ct),
          entry: 'pointer',
        }))
    : [];

  return {
    title: title || '',
    type,
    subfolder: subfolder || null,
    absolute_path: absolutePath,
    recall_state: recallState,
    inbox_redirect: inboxRedirect,
    index_file: indexFile,
    index_group: indexGroup,
    cross_refs: crossRefs,
  };
}

// --------------------------------------------------------------------------
// Help
// --------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node brain-write.mjs [options]

Write a memory entry to the Second Brain vault.
Automates: dedup + routing + frontmatter + file write + MEMORY.md index.

Mode A — CLI flags + stdin body:
  echo "body" | node brain-write.mjs \\
    --type experience \\
    --title "标题" \\
    --description "One-line summary (≤150 chars)" \\
    [--subfolder AI工具] \\
    [--project sec-brain] \\
    [--tags tag1,tag2] \\
    [--scope global|project] \\
    [--force-new]

Mode B — JSON stdin:
  echo '{"type":"experience","subfolder":"方法论","title":"xxx","body":"yyy","description":"zzz"}' \\
    | node brain-write.mjs --json

For guarded Codex callers, pass a UTF-8 body file through stdin:
  node brain-write.mjs --type experience --subfolder AI工具 --title "标题" --description "摘要" --source codex < /tmp/body.md
  This supports multiline bodies without embedding shell syntax or changing the guard.

Mode C — Utility:
  node brain-write.mjs --import-folder <absolute Desktop folder> --folder-name "Archive name" \\
    --project <registered project> [--subfolder <registered subproject>] \\
    --source codex --provenance "user-request; session=<id>" [--dry-run]
    Archive original bytes and nested/empty directories directly under the registered project.
    Copy only; verify before removing Desktop sources. Refuse links, special files and conflicts.
    Limits: 64 entries, 16 levels, 128 MiB per file, 512 MiB total; only .DS_Store may be hidden.

  node brain-write.mjs --import-raw <absolute Desktop .m4a or .qma> --project <registered project> \\
    [--subfolder <registered subproject>] [--raw-subfolder "面经/公司/原料"] \\
    --source codex --provenance "user-request; session=<id>" [--dry-run]
    Preserve source bytes and names. Reject conflicts; rerun to finish an interrupted import.
    QMA accepts exactly mic.m4a, sys.m4a and info.json. Files are bounded at 128 MiB.
    Raw imports currently require macOS and the installed Python 3 stdlib runtime.

  node brain-write.mjs --rename <note> --new-title "新标题" --expected-sha256 <sha> \\
    --reason "标题更准确" --source codex [--dry-run]
    Rename one note within its directory, updating supported links and indexes.
    --dry-run previews the affected files without writing. Recovery bytes are permanent.

  node brain-write.mjs --reject-clip <timestamp> --source codex --reason "误采"
    Reject a pending clip. Keep its original bytes and image; observe skips it.

  node brain-write.mjs --revise <note> --expected-sha256 <sha> --body "正文" \\
    --description "更新摘要" --reason "核验依据" --source codex
    Replace the body in place, retaining frontmatter and a recoverable snapshot.

  node brain-write.mjs --deactivate <note> --expected-sha256 <sha> --reason "重复" --source codex
    Remove the active note and its index entries after saving recovery bytes.

  node brain-write.mjs --repair-index-link <old absolute note path> --to <existing note path> \
    --expected-sha256 <new note SHA-256> --source codex [--dry-run]
    Repair exact managed-index hrefs after a move. The old path must be absent, unless it
    equals --to for a group-only repair. The target note body is never changed.

  node brain-write.mjs --restore <operation UUID> --reason "撤销修订或停用" --source codex
  node brain-write.mjs --resume-maintenance <operation UUID> --reason "中断后重试" --source codex
    Restore or finish the recorded operation only while affected bytes still match.
    Snapshots stay in raw/processed/brain-write; no automatic permanent cleanup.

  node brain-write.mjs --verify
    Check all domain index files for dead links, duplicates, inconsistent groups.
    Outputs JSON: { dead_links, duplicates, inconsistent_group, overall: "PASS"|"FAIL" }

  echo "body" | node brain-write.mjs --dry-run --type experience --title "xxx" --description "yyy"
    Simulate a write without touching any files. Shows what would happen.

  node brain-write.mjs --show-route --type experience --subfolder AI工具 --title "xxx"
    Show routing decision only (no dedup, no file write). Outputs JSON with
    absolute_path, index_file, index_group, cross_refs.
    Useful to understand where a future write would land.

  echo "补充内容" | node brain-write.mjs \
    --append 03-经验/AI工具/已有记忆.md \
    --expected-sha256 <当前文件SHA-256> \
    --provenance "查重与合并依据" \
    --source codex
    Append a provenance-marked block to one existing memory note. The expected
    SHA prevents overwriting a note that changed after review.

  node brain-write.mjs \
    --undo <append operation UUID> \
    --expected-after-sha256 <append 输出的 after_sha256> \
    --source codex
    Undo exactly one append while the note still matches its recorded result.

Required fields (write modes):
  type         feedback | experience | project | reference | user-profile | session
  title        Entry title (used as filename base)
  body         Main content (no frontmatter)
  description  One-line hook (≤150 chars), written to frontmatter
  durability   durable | ephemeral (default: durable)
  expires      Optional YYYY-MM-DD expiry for hot-index cleanup
  files        Optional comma-separated file list written to frontmatter

Optional fields:
  subfolder    Sub-directory within the routed base dir (e.g. AI工具, 方法论, 前端开发)
  project      Required when type=project or type=session
  tags         Comma-separated tags (or JSON array in --json mode)
  scope        global | project (inferred from routing table if omitted)
  source       Writing supervisor: claude | codex | dsh | ... (default: claude) → frontmatter source:
  force-new    Skip dedup check and always create new file
  append       Existing memory-note path to extend (relative to vault or absolute)
  undo         Append operation UUID to revert
  expected-sha256        Required compare-and-swap hash for --append
  expected-after-sha256  Required compare-and-swap hash for --undo
  provenance   Required source/context line for --append

Unknown options are rejected (exit 1) rather than silently falling through to stdin.

Successful mutations, dedup blocks and rollback outcomes append one JSONL line
to 00-系统/logs/brain-write-ledger.jsonl. Rejected input and pre-write CAS
mismatches do not. Bodies are never copied into the ledger.

Exit codes:
  0  Success
  1  Invalid input (missing fields, bad type enum, unknown option, path escape)
  2  Dedup: exact match found (use --force-new to override)
  3  Routing config missing or unresolvable
  4  File write failure
  5  Write sequence failed — files rolled back (or 'partial' if restore also failed)
  6  Write lock busy (another supervisor is mid-write)

Examples:
  # Write to 03-经验/AI工具/
  echo "body" | node brain-write.mjs --type experience --subfolder AI工具 --title "foo" --description "bar"

  # JSON mode with subfolder
  echo '{"type":"experience","subfolder":"方法论","title":"foo","body":"bar","description":"baz"}' \\
    | node brain-write.mjs --json

  # Verify index health
  node brain-write.mjs --verify

  # Preview without writing
  echo "body" | node brain-write.mjs --dry-run --type experience --title "test" --description "test desc"

  # Extend an existing note after dedup review
  echo "new evidence" | node brain-write.mjs --append 03-经验/AI工具/existing.md \
    --expected-sha256 <sha256> --provenance "source context" --source codex
`);
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args['import-raw'] || args['import-folder']) {
    process.stdout.write(JSON.stringify(importRaw(args), null, 2) + '\n');
    return;
  }
  if (args['raw-subfolder']) fatal('--raw-subfolder requires --import-raw', 1);
  if (args['folder-name']) fatal('--folder-name requires --import-folder', 1);

  const syncMode = args['bind-sync-request'] || args['finish-sync-request'];
  const maintenance = args.rename || args.revise || args.deactivate || args.restore || args['resume-maintenance'] || args['repair-index-link'];
  const exclusiveModes = [args.verify, args.showRoute, args.append, args.undo, args['reject-clip'], args.rename, args.revise, args.deactivate, args.restore, args['resume-maintenance'], args['repair-index-link'], args['bind-sync-request'], args['finish-sync-request']].filter(Boolean);
  if (exclusiveModes.length > 1 || (args['new-title'] && !args.rename) || ((args.append || args.undo || args['reject-clip'] || maintenance) && ((args.dryRun && !args.rename && !args['repair-index-link']) || args.json || args['clip-id']))) {
    fatal('utility and mutation modes are mutually exclusive', 1);
  }

  if (maintenance) {
    process.stdout.write(JSON.stringify(maintainNote(args), null, 2) + '\n');
    return;
  }
  if (syncMode) {
    if (args.json || args.dryRun || args['clip-id']) throw new InputError('sync request mode is exclusive');
    process.stdout.write(JSON.stringify(syncRequest(args)) + '\n');
    return;
  }

  if (args['reject-clip']) {
    const receipt = rejectClip({ id: args['reject-clip'], source: args.source, reason: args.reason, imageSha: args['clip-image-sha256'] });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    return;
  }
  if (args['clip-id'] && existsSync(clipCommitPath(args['clip-id']))) {
    const release = acquireLock();
    try { process.stdout.write(JSON.stringify(completeClipCommit(args['clip-id'])) + '\n'); }
    finally { release(); }
    return;
  }

  // --- P1: --verify mode ---
  if (args.verify) {
    const report = runVerify();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(report.overall === 'PASS' ? 0 : 1);
  }

  // --- Q2A: --show-route mode ---
  if (args.showRoute) {
    const type       = args.type;
    const title      = args.title;
    const subfolder  = args.subfolder || null;
    const project    = args.project   || null;
    const tags       = args.tags ? args.tags.split(',').map(t => t.trim()) : [];
    if (!type) fatal('--show-route requires --type', 1);
    const routeInfo = buildShowRoute({ type, title, subfolder, tags, project });
    process.stdout.write(JSON.stringify(routeInfo, null, 2) + '\n');
    process.exit(0);
  }

  // Existing-note updates reuse this writer's lock, CAS journal and ledger.
  if (args.append || args.undo) {
    try {
      const result = args.append
        ? appendExistingNote({
            rawTarget: args.append,
            expectedSha256: args['expected-sha256'],
            source: args.source || DEFAULT_SOURCE,
            body: args.body || readStdin(),
            provenance: args.provenance,
          })
        : undoAppend({
            operationId: args.undo,
            expectedAfterSha256: args['expected-after-sha256'],
            source: args.source || DEFAULT_SOURCE,
          });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(0);
    } catch (err) {
      fatal(err.message, err instanceof InputError ? 1 : 5);
    }
  }

  const dryRun = args.dryRun || false;

  // --- Parse input ---
  let type, title, body, description, project, tags, scope, forceNew, subfolder, source, durability, expires, files, provenance, requestIdValue, requestContextValue;

  if (args.json) {
    const raw = readStdin();
    if (!raw) fatal('--json mode requires JSON on stdin', 1);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { fatal(`Invalid JSON: ${e.message}`, 1); }
    ({ type, title, body, description, project, scope, subfolder, source, durability, expires, provenance, request_id: requestIdValue, request_context_sha256: requestContextValue } = parsed);
    source = args.source || source || DEFAULT_SOURCE;
    for (const [field, flag] of [['request_id', 'request-id'], ['request_context_sha256', 'request-context-sha256']]) {
      if (parsed[field] !== undefined && args[flag] !== undefined && parsed[field] !== args[flag]) fatal(`${field} conflicts with CLI argument`, 1);
    }
    requestIdValue ??= args['request-id'];
    requestContextValue ??= args['request-context-sha256'];
    forceNew = parsed['force-new'] || false;
    tags = Array.isArray(parsed.tags)
      ? parsed.tags
      : (parsed.tags ? String(parsed.tags).split(',').map(t => t.trim()) : []);
    files = normalizeFiles(parsed.files);
  } else {
    type        = args.type;
    title       = args.title;
    description = args.description;
    project     = args.project;
    scope       = args.scope;
    subfolder   = args.subfolder || null;
    source      = args.source || DEFAULT_SOURCE;
    durability  = args.durability || null;
    expires     = args.expires || null;
    files       = normalizeFiles(args.files);
    provenance  = args.provenance || null;
    forceNew    = args.forceNew || false;
    requestIdValue = args['request-id'];
    requestContextValue = args['request-context-sha256'];
    tags        = args.tags ? args.tags.split(',').map(t => t.trim()) : [];
    // body from stdin if not provided via flag
    body = args.body || readStdin();
  }

  // --- Validate ---
  if (!type)        fatal('Missing required field: type', 1);
  if (!title)       fatal('Missing required field: title', 1);
  if (!description) fatal('Missing required field: description', 1);
  if (!dryRun && !body) fatal('Missing required field: body (pass via stdin or --body)', 1);
  if (!VALID_TYPES.includes(type)) {
    fatal(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`, 1);
  }
  if (PROJECT_SCOPED.includes(type) && !project) {
    fatal(`type "${type}" requires --project`, 1);
  }
  if (!durability) durability = type === 'observation' ? 'ephemeral' : 'durable';
  if (!['durable', 'ephemeral'].includes(durability)) {
    fatal('--durability must be durable or ephemeral', 1);
  }
  if (expires && !isValidIsoDate(expires)) {
    fatal('--expires must be YYYY-MM-DD', 1);
  }

  // 凭据脱敏闸：对全部 source 生效
  if (provenance != null && (typeof provenance !== 'string' || provenance.length > 2000 || /[\r\n\0]/.test(provenance))) fatal('provenance must be a single-line string of at most 2000 characters', 1);
  let idempotencyId, requestContext;
  try {
    idempotencyId = requestId(requestIdValue);
    requestContext = requestContextSha256(requestContextValue, idempotencyId);
  } catch (error) { fatal(error.message, 1); }
  let redactionCount = 0;
  let redactionResult = redactCredentials(title); title = redactionResult.text; redactionCount += redactionResult.count;
  redactionResult = redactCredentials(description); description = redactionResult.text; redactionCount += redactionResult.count;
  redactionResult = redactCredentials(body); body = redactionResult.text; redactionCount += redactionResult.count;
  if (provenance) { redactionResult = redactCredentials(provenance); provenance = redactionResult.text; redactionCount += redactionResult.count; }

  // --- P1: --dry-run mode ---
  if (dryRun) {
    const preview = buildDryRunPreview({ type, title, description, subfolder, tags, body, project });
    process.stdout.write(JSON.stringify(preview, null, 2) + '\n');
    process.exit(0);
  }

  // --- Route ---
  const { absDir, relPath, scope: defaultScope } = resolveTargetDir(type, project);
  const finalScope = scope || defaultScope;

  // Resolve the concrete write directory (baseDir or baseDir/subfolder)
  let writeDir = resolveWriteDir(absDir, subfolder);

  // --- Path containment: reject before anything is created on disk ---
  try {
    assertInsideVault(writeDir, '--subfolder');
  } catch (err) {
    writeLedger({
      actor: source, action: 'write', target_path: writeDir,
      content_sha256: sha256(body || ''), dedup_result: 'not-run',
      force_new: !!forceNew, status: 'rejected-path-escape',
    });
    fatal(err.message, 1);
  }

  // --- v2: Section policy validation (禁落顶层根 + per-section policy) ---
  const validation = validateAgainstSectionPolicy(writeDir, subfolder, type, project);
  let inboxRedirect = null;
  if (!validation.allowed) {
    const inboxAbs = join(VAULT_ROOT, validation.fallback);
    process.stderr.write(JSON.stringify({
      status: 'warn',
      kind: 'section_policy_redirect',
      reason: validation.reason,
      original_intended_dir: writeDir,
      redirected_to: inboxAbs,
      existing_subfolders: validation.existing_subfolders || [],
      hint: validation.hint || '重新调用时指定合法分类；该条目将保留为待定，待后续经受管入口重定向。'
    }) + '\n');
    inboxRedirect = { from: writeDir, to: inboxAbs, reason: validation.reason };
    writeDir = inboxAbs;
  }

  const bodySha = sha256(body || '');
  const requestHash = idempotencyId ? requestFingerprint('write', { source, type, title, description, body, project, tags: [...tags].sort(), scope, force_new: forceNew, subfolder, durability, expires, files, provenance }) : null;
  const ledgerBase = { actor: source, action: 'write', force_new: !!forceNew, content_sha256: bodySha,
    trigger: /^agent-checkpoint(?:;|$)/.test(provenance || '') ? 'agent-checkpoint' : /^user-request(?:;|$)/.test(provenance || '') ? 'user-request' : ['observe', 'harvest'].includes(source) ? 'background' : 'unknown',
    ...(provenance ? { provenance } : {}),
    ...(args['clip-id'] ? { clip_id: args['clip-id'] } : {}) };

  // Everything below mutates the vault + the four index files. One writer at a time,
  // and any failure mid-sequence unwinds the files already touched.
  const release = acquireLock();
  let finalPath = null;
  let clipBytes = null;
  let clipAttachment = null;
  try {
    const replay = idempotentReceipt(source, idempotencyId, requestHash);
    if (replay) {
      process.stdout.write(JSON.stringify(replay, null, 2) + '\n');
      return;
    }
    if (idempotencyId) {
      const prepared = requestCommitPath(source, idempotencyId);
      if (existsSync(prepared) || existsSync(renameTemp(prepared, idempotencyId))) {
        process.stdout.write(JSON.stringify(completeRequestCommit(source, idempotencyId, requestHash), null, 2) + '\n');
        return;
      }
    }
    const structured = checkStructuredWrite(body, { noteType: type });
    if (args['clip-id']) {
      if (existsSync(clipCommitPath(args['clip-id']))) {
        process.stdout.write(JSON.stringify(completeClipCommit(args['clip-id'])) + '\n');
        return;
      }
      const { pending } = clipStatePaths(args['clip-id'], VAULT_ROOT);
      if (isClipRejected(args['clip-id'], VAULT_ROOT)) throw new Error('clip rejected; consumption refused');
      clipBytes = readRegularBytes(pending);
      if (sha256(clipBytes) !== validateSha256(args['clip-sha256'], 'clip SHA-256')) throw new Error('clip pending changed since classification');
      clipAttachment = stageClipAttachment(args['clip-id'], JSON.parse(clipBytes), files, args['clip-image-sha256']);
      stageClipWrites = true;
    }
    if (idempotencyId) stageClipWrites = true;
    // --- Dedup ---
    const isObservation = type === 'observation';
    const recallState = recallStateFor(writeDir);
    const recallEligible = recallState === 'eligible';
    const keywords = isObservation ? [] : extractKeywords(title);
    // When subfolder is given, scan both baseDir and subfolderDir to catch duplicates across locations
    const { exactMatches, fuzzyMatches } = isObservation
      ? { exactMatches: [], fuzzyMatches: [] }
      : runDedup(title, absDir, keywords, subfolder ? writeDir : undefined);

    const dedupWarnings = fuzzyMatches.map(m => `fuzzy match (round ${m.round}): ${m.path}`);
    const dedupResult = exactMatches.length > 0
      ? (forceNew ? 'exact-bypassed' : 'exact-blocked')
      : (isObservation ? 'not-run' : (fuzzyMatches.length > 0 ? 'fuzzy' : 'clean'));

    if (exactMatches.length > 0 && !forceNew) {
      const matchList = exactMatches.map(m => m.path).join(', ');
      writeLedger({
        ...ledgerBase, target_path: join(writeDir, sanitizeFilename(title) + '.md'),
        dedup_result: dedupResult, status: 'blocked-dedup',
      });
      process.stderr.write(JSON.stringify({
        status: 'error',
        message: `Dedup: exact match found — ${matchList}. Use --force-new to bypass.`,
        exact_matches: exactMatches.map(m => m.path),
        dedup_warnings: dedupWarnings,
      }) + '\n');
      release();
      process.exit(2);
    }

    // Emit fuzzy warnings to stderr but continue
    if (fuzzyMatches.length > 0) {
      process.stderr.write(
        `[warn] Fuzzy matches found:\n${dedupWarnings.map(w => '  ' + w).join('\n')}\n`
      );
    }

    // --- Build file ---
    const safeFilename = sanitizeFilename(title) + '.md';
    // writeDir may be baseDir or baseDir/subfolder — create it if needed
    mkdirSync(writeDir, { recursive: true });

    // Avoid overwriting; append suffix if needed
    finalPath = join(writeDir, safeFilename);
    let suffix = 1;
    while (existsSync(finalPath)) {
      finalPath = join(writeDir, sanitizeFilename(title) + `-${suffix++}.md`);
    }
    // sanitizeFilename strips path separators, but re-check: this is the actual write target.
    assertInsideVault(finalPath, 'target file');

    const frontmatter = buildFrontmatter({
      name: title,
      description,
      type,
      scope: finalScope,
      project: project || null,
      tags,
      created: today(),
      source,
      durability,
      expires,
      files,
      provenance,
    });

    const fileContent = frontmatter + '\n\n' + body.trimEnd() + '\n';
    writeTracked(finalPath, fileContent);

    // --- Update index ---
    const indexLine = buildIndexLine(title, finalPath, description);
    // relPath is what appears inside the markdown link (relative from MEMORY.md dir)
    const relPathForIndex = relative(MEMORY_DIR, finalPath);

    // Q1: detect cross-type from tags
    const crossTypes = detectCrossTypeTags(tags);

    const { evicted, domainFile, domainSubfolder } = !recallEligible || isObservation
      ? { evicted: null, domainFile: null, domainSubfolder: null }
      : appendToMemory(
          indexLine, relPathForIndex, subfolder || null, false,
          crossTypes.length > 1 ? crossTypes : null,
          title, null, subfolder || null, durability
        );

    // --- P0: Update intent-map keyword_routes ---
    const { keywords: allKw, new_routes: newRoutes } = !recallEligible || isObservation
      ? { keywords: [], new_routes: {} }
      : updateIntentMap(title, tags, domainFile, domainSubfolder);

    // --- P0: Record eviction to intent-map if FIFO evicted ---
    if (evicted) {
      // Try to infer domainFile/subfolder for the evicted entry
      const evictedInfer = inferIndexTarget(evicted.relPath);
      recordEvictionToIntentMap(
        evicted,
        evictedInfer.file || domainFile,
        evictedInfer.subfolder || domainSubfolder,
        [] // no tags available for evicted entries
      );
    }

    const structuredFields = structured?.record ? { record_id: structured.id, record_version: structured.record.version } : structured?.event ? { event_id: structured.id } : structured?.candidate ? { candidate_id: structured.id } : {};
    // --- Output ---
    const result = {
      status: 'ok',
      ...structuredFields,
      path: finalPath,
      index_line: indexLine,
      dedup_warnings: dedupWarnings,
      intent_map: {
        keywords: allKw,
        new_routes: newRoutes,
      },
      evicted: evicted || null,
      inbox_redirect: inboxRedirect,
      recall_state: recallState,
      source,
      ...(redactionCount ? { redactions: redactionCount } : {}),
    };
    const ledgerEntry = { ...ledgerBase, ...structuredFields, target_path: finalPath, dedup_result: dedupResult, status: 'ok', ...(redactionCount ? { redactions: redactionCount } : {}), ...idempotencyFields(idempotencyId, requestHash, replayableReceipt({ ...result, action: 'write', target_path: finalPath }), requestContext) };
    if (!args['clip-id'] && !idempotencyId) writeLedger(ledgerEntry, true);
    if (args['clip-id']) {
      const plan = { version: 1, clip_id: args['clip-id'], pending_sha256: sha256(clipBytes),
        pending_base64: clipBytes.toString('base64'), attachment: clipAttachment, receipt: result, ledger: ledgerEntry,
        writes: [...journal].filter(([, record]) => record.after !== record.before)
          .map(([path, record]) => ({ path, before: record.before, after: record.after })) };
      saveExclusive(clipCommitPath(args['clip-id']), JSON.stringify(plan) + '\n');
      stageClipWrites = false;
      completeClipCommit(args['clip-id']);
    } else if (idempotencyId) {
      const path = requestCommitPath(source, idempotencyId);
      const plan = { version: 1, receipt: result, ledger: ledgerEntry, writes: [...journal].filter(([, record]) => record.after !== record.before).map(([path, record]) => ({ path, before: record.before, after: record.after })) };
      saveExclusive(path, JSON.stringify(plan) + '\n', undefined, renameTemp(path, idempotencyId));
      stageClipWrites = false;
      completeRequestCommit(source, idempotencyId, requestHash);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    if (err instanceof InputError && finalPath === null) {
      process.stderr.write(JSON.stringify({ status: 'error', message: err.message }) + '\n');
      process.exit(1);
    }
    const prepared = args['clip-id'] && existsSync(clipCommitPath(args['clip-id'])) || idempotencyId && existsSync(requestCommitPath(source, idempotencyId));
    const restoreFailures = prepared ? ['creation commit retained; retry resumes the same write'] : rollbackJournal();
    writeLedger({
      ...ledgerBase,
      target_path: finalPath || writeDir,
      dedup_result: 'aborted',
      status: restoreFailures.length === 0 ? 'rolled-back' : 'partial',
    });
    process.stderr.write(JSON.stringify({
      status: 'error',
      message: err.message,
      rollback: restoreFailures.length === 0 ? 'rolled-back' : 'partial',
      restore_failures: restoreFailures,
    }) + '\n');
    release();
    process.exit(5);
  } finally {
    stageClipWrites = false;
    release();
  }
}

// Guard: only run when executed directly.
// Use realpathSync to handle symlinks (vault is symlinked from ~/Desktop/second-brain → iCloud).
// Exported for 00-系统/tests/test-brain-write.mjs (importing does not run main()).
export {
  yamlScalar, realpathDeep, isInsideVault, assertInsideVault,
  acquireLock, acquireTakeoverClaim, readTracked, writeTracked, rollbackJournal, journal,
  VAULT_REAL, LOCK_PATH, LEDGER_PATH,
};

if (process.argv[1] && realpathOrSelf(process.argv[1]) === realpathOrSelf(__filename)) {
  main().catch(err => {
    process.stderr.write(JSON.stringify({ status: 'error', message: err.message }) + '\n');
    process.exit(1);
  });
}

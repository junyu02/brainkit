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
  openSync, writeSync, closeSync, constants
} from 'node:fs';
import { resolve, join, dirname, basename, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

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
// per-line 豁免示例/引用形态（process.env.X、占位符）；password 值限 ASCII 凭据形态，中文叙述不受影响。
const CREDENTIAL_RULES = [
  [/(passwor?d"?\s*[:=]\s*["']?)[A-Za-z0-9!@#%^&*_.+-]{6,}(["']?)/gi, '$1[REDACTED]$2'],
  [/\bsk-[A-Za-z0-9]{20,}/g, '[REDACTED-OPENAI-KEY]'],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, '[REDACTED-GOOGLE-KEY]'],
  [/\bghp_[A-Za-z0-9]{30,}/g, '[REDACTED-GITHUB-PAT]'],
  [/\bxoxb-[0-9A-Za-z-]{20,}/g, '[REDACTED-SLACK-TOKEN]'],
  [/(Bearer\s+)[A-Za-z0-9._-]{30,}/g, '$1[REDACTED]'],
];
const CREDENTIAL_EXEMPT = /your[_-]|xxx|placeholder|<[a-z_]+>|\*\*\*|example|redacted|\$\{|process\.env/i;
function redactCredentials(text) {
  if (!text) return { text, count: 0 };
  let count = 0;
  const out = text.split('\n').map(line => {
    if (CREDENTIAL_EXEMPT.test(line)) return line;
    let current = line;
    for (const [re, sub] of CREDENTIAL_RULES) {
      const n = (current.match(re) || []).length;
      if (n) { count += n; current = current.replace(re, sub); }
    }
    return current;
  }).join('\n');
  return { text: out, count };
}

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
  if (!existsSync(LEDGER_PATH)) return;
  const metadata = lstatSync(LEDGER_PATH);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('ledger must be a regular file, not a symlink or directory');
  }
}

function writeLedger(entry, required = false) {
  try {
    assertLedgerFile();
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
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
      const raw = readFileSync(LOCK_PATH, 'utf8');
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

function readTracked(path) {
  const content = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (!journal.has(path)) {
    journal.set(path, { before: content, expect: content === null ? null : sha256(content) });
  }
  return content;
}

/** Atomic write (tmp + rename) guarded by a compare-and-swap against the last seen sha. */
function writeTracked(path, content) {
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
  'durability', 'expires', 'files',
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

function resolveWriteDir(absDir, subfolder) {
  // Returns the concrete directory to write into.
  // If subfolder is provided, appends it to absDir; otherwise returns absDir unchanged.
  if (subfolder && subfolder.trim()) {
    return join(absDir, subfolder.trim());
  }
  return absDir;
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

function resolveEditableTarget(rawTarget) {
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
  if (!EDITABLE_SECTIONS.has(section) || extname(targetPath).toLowerCase() !== '.md') {
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
    // Look up vaultDir from project map
    const pm = loadProjectMap();
    const mapping = pm.mappings.find(
      m => m.vaultDir === `01-项目/${projectArg}` ||
           m.localPath.endsWith(`/${projectArg}`) ||
           m.vaultDir.endsWith(`/${projectArg}`)
    );
    const vaultDir = mapping ? mapping.vaultDir : `01-项目/${projectArg}`;
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
      reason: `${topSection} 要求 subfolder（policy=${policy.policy}）。请用 --subfolder <name> 指定，或文件将落 ${inboxSubs[topSection] || inboxRoot} 等待人工分类`,
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
        reason: `子文件夹 "${actualSubfolder}" 不存在于 ${topSection}（policy=${newSubfolderPolicy}）。agent 不能自创新主题；用户需手动 mkdir 后重写`,
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
          const pathMatch = line.match(/\(([^)]+)\)/);
          exactMatches.push({ path: pathMatch ? pathMatch[1] : memTitle, round: 3, score });
        } else if (hasKeyword || score > 0.4) {
          const pathMatch = line.match(/\(([^)]+)\)/);
          fuzzyMatches.push({ path: pathMatch ? pathMatch[1] : memTitle, round: 3, score });
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
  const pathM = line.match(/\(([^)]+)\)/);
  if (!pathM) return false;
  const target = resolve(MEMORY_DIR, pathM[1]);
  if (!existsSync(target)) return false;
  const frontmatter = readFileSync(target, 'utf8').slice(0, 2000);
  const expiresM = frontmatter.match(/^expires:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m);
  return expiresM ? expiresM[1] < today() : false;
}

function truncateHotDescription(indexLine) {
  const m = indexLine.match(/^(- \[[^\]]*\]\([^)]*\)) — (.*)$/);
  if (!m) return indexLine;
  const [, head, desc] = m;
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
        const pathM = l.match(/\(([^)]+)\)/);
        const rp = pathM ? pathM[1] : '';
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
      const pathMatch  = removedLine.match(/\(([^)]+)\)/);
      evicted = {
        title: titleMatch ? titleMatch[1] : removedLine,
        relPath: pathMatch ? pathMatch[1] : '',
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
      const pathMatch = line.match(/\(([^)]+)\)/);
      if (!pathMatch) continue;
      const rawPath = pathMatch[1];

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
  const writeDir = resolveWriteDir(absDir, subfolder);
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
  const { file: domainFile, subfolder: domainSub } = isObservation
    ? { file: null, subfolder: null }
    : inferIndexTarget(relPathForIndex);

  // intent-map keywords
  const allKeywords = isObservation ? [] : extractKeywordsExtended(title, tags || []);
  const intentMap = isObservation ? { keyword_routes: {} } : loadIntentMap();
  const routeTarget = domainFile ? `${domainFile}${domainSub ? '#' + domainSub : ''}` : null;
  const newRoutes = {};
  for (const kw of allKeywords) {
    const existing = intentMap.keyword_routes[kw] || [];
    if (routeTarget && !existing.includes(routeTarget)) {
      newRoutes[kw] = routeTarget;
    }
  }

  // FIFO eviction preview
  const memContent = isObservation ? '' : (existsSync(MEMORY_MD) ? readFileSync(MEMORY_MD, 'utf8') : '');
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
    would_update_hot_section: isObservation ? null : MEMORY_MD,
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
  const writeDir = resolveWriteDir(absDir, subfolder);
  const safeFilename = sanitizeFilename(title || 'untitled') + '.md';
  const absolutePath = join(writeDir, safeFilename);
  const relPathForIndex = relative(dirname(MEMORY_MD), absolutePath);
  const { file: indexFile, subfolder: indexGroup } = inferIndexTarget(relPathForIndex);

  // Q1: detect cross-type tags
  // domainFile = the index that will get the full entry (inferred from vault path)
  const crossTypes = detectCrossTypeTags(tags || []);
  const crossRefs = crossTypes.length > 1
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

Mode C — Utility:
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

  const exclusiveModes = [args.verify, args.showRoute, args.append, args.undo].filter(Boolean);
  if (exclusiveModes.length > 1 || ((args.append || args.undo) && (args.dryRun || args.json))) {
    fatal('--verify, --show-route, --append, --undo and append/undo input modes are mutually exclusive', 1);
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
  let type, title, body, description, project, tags, scope, forceNew, subfolder, source, durability, expires, files, provenance;

  if (args.json) {
    const raw = readStdin();
    if (!raw) fatal('--json mode requires JSON on stdin', 1);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { fatal(`Invalid JSON: ${e.message}`, 1); }
    ({ type, title, body, description, project, scope, subfolder, source, durability, expires, provenance } = parsed);
    source = source || DEFAULT_SOURCE;
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
  let redactionCount = 0;
  let redactionResult = redactCredentials(title); title = redactionResult.text; redactionCount += redactionResult.count;
  redactionResult = redactCredentials(description); description = redactionResult.text; redactionCount += redactionResult.count;
  redactionResult = redactCredentials(body); body = redactionResult.text; redactionCount += redactionResult.count;

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
      hint: validation.hint || '重新调用时指定合法 subfolder（已列于 existing_subfolders）；或在 inbox 处人工分类'
    }) + '\n');
    inboxRedirect = { from: writeDir, to: inboxAbs, reason: validation.reason };
    writeDir = inboxAbs;
  }

  const bodySha = sha256(body || '');
  const ledgerBase = { actor: source, action: 'write', force_new: !!forceNew, content_sha256: bodySha };

  // Everything below mutates the vault + the four index files. One writer at a time,
  // and any failure mid-sequence unwinds the files already touched.
  const release = acquireLock();
  let finalPath = null;
  try {
    // --- Dedup ---
    const isObservation = type === 'observation';
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

    const { evicted, domainFile, domainSubfolder } = isObservation
      ? { evicted: null, domainFile: null, domainSubfolder: null }
      : appendToMemory(
          indexLine, relPathForIndex, subfolder || null, false,
          crossTypes.length > 1 ? crossTypes : null,
          title, null, subfolder || null, durability
        );

    // --- P0: Update intent-map keyword_routes ---
    const { keywords: allKw, new_routes: newRoutes } = isObservation
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

    writeLedger({ ...ledgerBase, target_path: finalPath, dedup_result: dedupResult, status: 'ok', ...(redactionCount ? { redactions: redactionCount } : {}) }, true);

    // --- Output ---
    const result = {
      status: 'ok',
      path: finalPath,
      index_line: indexLine,
      dedup_warnings: dedupWarnings,
      intent_map: {
        keywords: allKw,
        new_routes: newRoutes,
      },
      evicted: evicted || null,
      inbox_redirect: inboxRedirect,
      source,
      ...(redactionCount ? { redactions: redactionCount } : {}),
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const restoreFailures = rollbackJournal();
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

import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

const MAX_BYTES = 64 * 1024;
const PROVIDERS = new Set(['gmail', 'google-calendar']);
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.nlink}`;
const empty = () => ({ version: 1, providers: {} });

function owner(info) {
  return typeof process.getuid !== 'function' || info.uid === process.getuid();
}

function realDirectory(path, create) {
  const target = resolve(path), root = parse(target).root;
  let current = root;
  for (const part of target.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return null;
      mkdirSync(current, { mode: 0o700 });
      info = lstatSync(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('sync state directory contains a non-directory or symlink');
    const final = current === target;
    const trustedAncestor = owner(info) || info.uid === 0;
    if ((!final && !trustedAncestor) || (final && !owner(info)) || (info.mode & 0o022) !== 0) {
      throw new Error(final ? 'sync state root must be current-user owned and not group or other writable' : 'sync state parent must be current-user or root owned and not group or other writable');
    }
  }
  return target;
}

function stateDirectory({ vault, stateRoot, create = false }) {
  const realVault = realpathSync(vault);
  const root = stateRoot ? resolve(stateRoot) : join(homedir(), '.cache', 'brainkit', createHash('sha256').update(realVault).digest('hex'));
  return realDirectory(root, create);
}

function safeFile(path, { missing = false } = {}) {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT' && missing) return null;
    if (error.code === 'ENOENT') throw new Error('sync state file is missing');
    throw error;
  }
  if (info.isSymbolicLink() || unsafeFile(info)) throw new Error('sync state file is unsafe');
  return info;
}

function unsafeFile(info) {
  return !info.isFile() || info.nlink !== 1 || !owner(info) || (info.mode & 0o777) !== 0o600 || info.size > MAX_BYTES;
}

function validTime(value, name) {
  const match = typeof value === 'string' && ISO.exec(value);
  const calendar = match && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[3]) >= 1 && Number(match[3]) <= new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate() && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59;
  if (!calendar || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function validCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function validateProvider(value, provider) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error(`invalid sync provider state: ${provider}`);
  for (const key of ['initial_from', 'completed_through']) if (value[key] !== null && value[key] !== undefined) validTime(value[key], key);
  if (value.completed_through && (!value.initial_from || Date.parse(value.initial_from) > Date.parse(value.completed_through))) throw new Error(`invalid sync checkpoint range: ${provider}`);
  if (!value.last_attempt || typeof value.last_attempt !== 'object') throw new Error(`invalid sync attempt: ${provider}`);
  const attempt = value.last_attempt;
  if (!['complete', 'failed', 'partial', 'window_gap'].includes(attempt.status)) throw new Error(`invalid sync attempt status: ${provider}`);
  validTime(attempt.at, 'attempt.at'); validTime(attempt.window_start, 'attempt.window_start'); validTime(attempt.window_end, 'attempt.window_end');
  validCount(attempt.processed, 'attempt.processed'); validCount(attempt.failed, 'attempt.failed');
  return value;
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) throw new Error('invalid sync state');
  for (const [provider, checkpoint] of Object.entries(value.providers)) {
    if (!PROVIDERS.has(provider)) throw new Error('invalid sync provider name');
    validateProvider(checkpoint, provider);
  }
  return value;
}

function readState(root) {
  if (!root) return empty();
  const path = join(root, 'sync.json'), info = safeFile(path, { missing: true });
  if (!info) return empty();
  let value;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (unsafeFile(before)) throw new Error('sync state file is unsafe');
    try { value = JSON.parse(readFileSync(fd, 'utf8')); }
    catch { throw new Error('sync state JSON is corrupt'); }
    if (identity(before) !== identity(fstatSync(fd))) throw new Error('sync state changed while reading');
  } finally { closeSync(fd); }
  if (identity(info) !== identity(safeFile(path))) throw new Error('sync state changed while reading');
  return validateState(value);
}

function lock(root, attempts = 0) {
  const path = join(root, 'sync.lock');
  try {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    return { path, identity: identity(safeFile(path)) };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const before = safeFile(path);
  let owner;
  try { owner = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('sync lock is corrupt; refusing automatic recovery'); }
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw new Error('sync lock has invalid pid; refusing automatic recovery');
  try { process.kill(owner.pid, 0); throw new Error(`sync state is busy (pid ${owner.pid})`); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const after = safeFile(path);
  if (identity(before) !== identity(after)) throw new Error('sync lock changed during stale-lock recovery');
  if (attempts >= 2) throw new Error('sync stale-lock recovery limit reached; retry later');
  unlinkSync(path);
  return lock(root, attempts + 1);
}

function release(lockInfo) {
  try {
    if (identity(safeFile(lockInfo.path)) === lockInfo.identity) unlinkSync(lockInfo.path);
  } catch { /* A changed lock is never ours to remove. */ }
}

function writeState(root, value) {
  const target = join(root, 'sync.json');
  safeFile(target, { missing: true });
  const temporary = join(root, `sync.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  safeFile(temporary);
  renameSync(temporary, target);
  const directory = openSync(root, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function loadSyncState({ vault, stateRoot } = {}) {
  return readState(stateDirectory({ vault, stateRoot, create: false }));
}

// Mail cannot arrive from the future; calendar legitimately looks ahead. Without
// a bound, one window ending in 2999 marks every real window already covered.
const FUTURE_BOUND_MS = { gmail: 86400_000, 'google-calendar': 366 * 86400_000 };

export function validateSyncWindow(window_start, window_end, { provider, now = Date.now } = {}) {
  const start = validTime(window_start, 'window_start'), end = validTime(window_end, 'window_end');
  if (Date.parse(start) >= Date.parse(end)) throw new Error('window_start must precede window_end');
  const bound = FUTURE_BOUND_MS[provider];
  if (bound !== undefined && Date.parse(end) > (typeof now === 'function' ? now() : now) + bound) {
    throw new Error(`window_end is too far in the future for ${provider}`);
  }
  return { start, end };
}

export function recordSyncAttempt({ vault, stateRoot, provider, window_start, window_end, expected_revision, complete, failed, processed, now = Date.now } = {}) {
  if (!PROVIDERS.has(provider)) throw new Error('provider must be gmail or google-calendar');
  const { start, end } = validateSyncWindow(window_start, window_end, { provider, now });
  if (!Number.isSafeInteger(expected_revision) || expected_revision < 0) throw new Error('expected_revision must be a non-negative integer');
  if (typeof complete !== 'boolean') throw new Error('complete must be boolean');
  failed = validCount(failed, 'failed'); processed = validCount(processed, 'processed');
  const at = validTime(typeof now === 'function' ? new Date(now()).toISOString() : new Date(now).toISOString(), 'now');
  const root = stateDirectory({ vault, stateRoot, create: true }), held = lock(root);
  try {
    const state = readState(root), prior = state.providers[provider] || { revision: 0, initial_from: null, completed_through: null, last_attempt: null };
    if (prior.revision !== expected_revision) throw new Error(`sync state revision conflict: expected ${expected_revision}, found ${prior.revision}`);
    const success = complete && failed === 0;
    const continuous = !prior.completed_through || Date.parse(start) <= Date.parse(prior.completed_through) && Date.parse(end) >= Date.parse(prior.initial_from);
    const extendsEnd = !prior.completed_through || Date.parse(end) > Date.parse(prior.completed_through);
    const extendsStart = !prior.initial_from || Date.parse(start) < Date.parse(prior.initial_from);
    const advances = success && continuous && (extendsEnd || extendsStart);
    const attemptStatus = failed ? 'failed' : !complete ? 'partial' : !continuous ? 'window_gap' : 'complete';
    state.providers[provider] = {
      revision: prior.revision + 1,
      initial_from: success && continuous && extendsStart ? start : prior.initial_from,
      completed_through: success && continuous && extendsEnd ? end : prior.completed_through,
      last_attempt: { status: attemptStatus, at, window_start: start, window_end: end, processed, failed },
    };
    writeState(root, state);
    return { checkpoint: state.providers[provider], advanced: advances };
  } finally { release(held); }
}

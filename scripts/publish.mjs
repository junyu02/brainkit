#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMain, parseEnvFile } from './lib/plist-render.mjs';
import { runLaunchctl, runLaunchctlRetrying } from './lib/launchctl.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..');
const MANIFEST_RELATIVE_PATH = '00-系统/.index-cache/publish-manifest.json';
const LOCK_RELATIVE_PATH = '00-系统/.index-cache/publish.lock';
const RECOVERY_AUTHORIZATIONS_RELATIVE_PATH = '00-系统/.index-cache/publish-recovery-authorizations.json';
const TEST_CAPABILITY_FD = 3;
const HASH_RE = /^[a-f0-9]{64}$/;
const CHANGE_STATES = new Set(['repo-ahead', 'repo-new', 'same-change']);
const REJECT_STATES = new Set([
  'manifest-corrupt',
  'entry-corrupt',
  'conflict',
  'vault-ahead',
  'vault-missing',
  'repo-removed',
  'retirement-pending',
  'untracked-vault',
  'uninitialized',
]);
const STATE_PRIORITY = [
  'manifest-corrupt',
  'entry-corrupt',
  'conflict',
  'vault-ahead',
  'vault-missing',
  'repo-removed',
  'retirement-pending',
  'untracked-vault',
  'uninitialized',
  'repo-ahead',
  'repo-new',
  'same-change',
  'clean',
];
const LAUNCH_AGENTS = [
  'com.second-brain.clip',
  'com.second-brain.observe',
  'com.second-brain.sunday',
  'com.second-brain.watch',
];
// Runs from the repo clone only: never published, so never whitelisted, and
// therefore exempt from the undeclared-script assertion below.
const REPO_ONLY_SCRIPTS = new Set(['scripts/publish.mjs', 'scripts/lib/launchctl.mjs']);
let testControlsAuthorized = false;

class PublishError extends Error {
  constructor(message, { code = 'publish-error', backupDir = null } = {}) {
    super(message);
    this.code = code;
    this.backupDir = backupDir;
  }
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function hashFileOrNull(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PublishError(`not a regular file: ${path}`, { code: 'unsafe-file' });
    }
    return sha256File(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeRelativePath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    throw new PublishError(`${field} must be a non-empty POSIX relative path`, { code: 'invalid-path' });
  }
  if (isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new PublishError(`${field} escapes its root: ${value}`, { code: 'invalid-path' });
  }
  return value;
}

function isInside(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertInside(path, root, label) {
  if (!isInside(path, root)) {
    throw new PublishError(`${label} escapes root: ${path}`, { code: 'path-escape' });
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PublishError(`${label} is not valid JSON: ${error.message}`, { code: 'invalid-json' });
  }
}

function loadWhitelist(repoRoot) {
  const path = join(repoRoot, 'publish-whitelist.json');
  const value = readJson(path, 'publish whitelist');
  if (value?.version !== 1 || !Array.isArray(value.entries)) {
    throw new PublishError('publish whitelist must have version=1 and entries[]', { code: 'invalid-whitelist' });
  }
  const seenSources = new Set();
  const seenTargets = new Set();
  const entries = value.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new PublishError(`whitelist entry ${index} must be an object`, { code: 'invalid-whitelist' });
    }
    const source = normalizeRelativePath(entry.source, `whitelist entry ${index}.source`);
    const target = normalizeRelativePath(entry.target, `whitelist entry ${index}.target`);
    if (source === 'scripts/publish.mjs') {
      throw new PublishError('scripts/publish.mjs must not be published', { code: 'invalid-whitelist' });
    }
    if (seenSources.has(source) || seenTargets.has(target)) {
      throw new PublishError(`duplicate whitelist mapping: ${source} -> ${target}`, { code: 'invalid-whitelist' });
    }
    seenSources.add(source);
    seenTargets.add(target);
    return { source, target };
  });
  return entries.sort((a, b) => a.source.localeCompare(b.source));
}

function loadManifest(vaultRoot) {
  const path = join(vaultRoot, MANIFEST_RELATIVE_PATH);
  let manifestStat;
  try { manifestStat = lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing', path, entries: [], corruptEntries: [] };
    return { kind: 'corrupt', path, error: error.message, entries: [], corruptEntries: [] };
  }

  let value;
  try {
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('manifest must be a regular non-symlink file');
    assertInside(realpathSync(path), realpathSync(vaultRoot), 'manifest');
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { kind: 'corrupt', path, error: error.message, entries: [], corruptEntries: [] };
  }
  if (value?.version !== 1 || !Array.isArray(value.entries)) {
    return { kind: 'corrupt', path, error: 'expected version=1 and entries[]', entries: [], corruptEntries: [] };
  }

  const entries = [];
  const corruptEntries = [];
  const seenSources = new Set();
  const seenTargets = new Set();
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index];
    let source;
    let target;
    try {
      if (!entry || typeof entry !== 'object') throw new Error('entry must be an object');
      source = normalizeRelativePath(entry.source, `manifest entry ${index}.source`);
      target = normalizeRelativePath(entry.target, `manifest entry ${index}.target`);
      if (!HASH_RE.test(entry.sha256 || '')) throw new Error('sha256 must be 64 lowercase hex characters');
      if (seenSources.has(source) || seenTargets.has(target)) throw new Error('duplicate source or target');
      seenSources.add(source);
      seenTargets.add(target);
      entries.push({ source, target, sha256: entry.sha256 });
    } catch (error) {
      corruptEntries.push({ index, source: source || null, target: target || null, error: error.message });
    }
  }
  return { kind: 'ok', path, entries, corruptEntries, value };
}

function classifyFileState({ whitelisted, manifestEntry, repoHash, vaultHash }) {
  if (whitelisted && !manifestEntry) {
    if (repoHash === null) return 'repo-removed';
    return vaultHash === null ? 'repo-new' : 'untracked-vault';
  }
  if (!whitelisted && manifestEntry) return 'retirement-pending';
  if (!whitelisted || !manifestEntry) throw new Error('classification requires whitelist or manifest entry');
  if (repoHash === null) return 'repo-removed';
  if (vaultHash === null) return 'vault-missing';

  const baselineHash = manifestEntry.sha256;
  if (repoHash === baselineHash && vaultHash === baselineHash) return 'clean';
  if (repoHash !== baselineHash && vaultHash === baselineHash) return 'repo-ahead';
  if (repoHash === baselineHash && vaultHash !== baselineHash) return 'vault-ahead';
  if (repoHash === vaultHash) return 'same-change';
  return 'conflict';
}

function evaluateStates(repoRoot, vaultRoot, whitelist, manifest) {
  if (manifest.kind === 'missing') {
    return [{
      type: 'file',
      path: null,
      target: MANIFEST_RELATIVE_PATH,
      state: 'uninitialized',
      baselineHash: null,
      repoHash: null,
      vaultHash: null,
      message: 'manifest does not exist; run --bootstrap once',
    }];
  }
  if (manifest.kind === 'corrupt') {
    return [{
      type: 'file',
      path: null,
      target: MANIFEST_RELATIVE_PATH,
      state: 'manifest-corrupt',
      baselineHash: null,
      repoHash: null,
      vaultHash: null,
      message: manifest.error,
    }];
  }

  const records = manifest.corruptEntries.map(entry => ({
    type: 'file',
    path: entry.source || `manifest[${entry.index}]`,
    target: entry.target,
    state: 'entry-corrupt',
    baselineHash: null,
    repoHash: null,
    vaultHash: null,
    message: entry.error,
  }));
  const whitelistBySource = new Map(whitelist.map(entry => [entry.source, entry]));
  const manifestBySource = new Map(manifest.entries.map(entry => [entry.source, entry]));
  const sources = [...new Set([...whitelistBySource.keys(), ...manifestBySource.keys()])].sort();

  for (const source of sources) {
    const whitelistEntry = whitelistBySource.get(source) || null;
    const manifestEntry = manifestBySource.get(source) || null;
    if (whitelistEntry && manifestEntry && whitelistEntry.target !== manifestEntry.target) {
      records.push({
        type: 'file', path: source, target: whitelistEntry.target, state: 'entry-corrupt',
        baselineHash: manifestEntry.sha256, repoHash: null, vaultHash: null,
        message: `manifest target ${manifestEntry.target} differs from whitelist target ${whitelistEntry.target}`,
      });
      continue;
    }
    const mapping = whitelistEntry || manifestEntry;
    const repoHash = hashFileOrNull(join(repoRoot, source));
    const vaultHash = hashFileOrNull(join(vaultRoot, mapping.target));
    records.push({
      type: 'file',
      path: source,
      target: mapping.target,
      state: classifyFileState({
        whitelisted: Boolean(whitelistEntry),
        manifestEntry,
        repoHash,
        vaultHash,
      }),
      baselineHash: manifestEntry?.sha256 || null,
      repoHash,
      vaultHash,
      message: null,
    });
  }
  return records;
}

function aggregateState(records) {
  for (const state of STATE_PRIORITY) {
    if (records.some(record => record.state === state)) return state;
  }
  return 'clean';
}

function aggregateExitCode(records) {
  if (records.some(record => REJECT_STATES.has(record.state))) return 2;
  if (records.some(record => CHANGE_STATES.has(record.state))) return 1;
  return 0;
}

function writeJsonLine(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function printRecords(records) {
  for (const record of records) writeJsonLine(record);
  writeJsonLine({
    type: 'summary',
    state: aggregateState(records),
    exitCode: aggregateExitCode(records),
    counts: Object.fromEntries(STATE_PRIORITY.map(state => [state, records.filter(record => record.state === state).length])),
  });
}

function walkTree(root) {
  if (!existsSync(root)) return [];
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    output.push(path);
    if (entry.isDirectory()) output.push(...walkTree(path));
  }
  return output;
}

function assertNoUndeclaredScripts(repoRoot, whitelist) {
  const declared = new Set(whitelist.map(entry => entry.source));
  const scriptsRoot = join(repoRoot, 'scripts');
  const extras = walkTree(scriptsRoot)
    .filter(path => !lstatSync(path).isDirectory())
    .map(path => relative(repoRoot, path).split(sep).join('/'))
    .filter(path => !REPO_ONLY_SCRIPTS.has(path) && !declared.has(path));
  if (extras.length > 0) {
    throw new PublishError(`scripts tree contains undeclared files: ${extras.join(', ')}`, { code: 'undeclared-script' });
  }
}

function assertWorktreeClean(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new PublishError(`cannot inspect git worktree: ${result.error?.message || result.stderr.trim()}`, { code: 'git-error' });
  }
  if (result.stdout.trim()) {
    throw new PublishError('repo worktree is not clean', { code: 'dirty-worktree' });
  }
}

function conflictCopyName(name) {
  const stem = name.slice(0, name.length - extname(name).length);
  return / [234]$/.test(stem) || /conflicted copy/i.test(name);
}

function assertNoConflictCopies(vaultRoot, whitelist, manifest) {
  const mappings = [...whitelist, ...(manifest.kind === 'ok' ? manifest.entries : [])];
  const roots = new Set(mappings.map(entry => join(vaultRoot, dirname(entry.target))));
  roots.add(join(vaultRoot, '00-系统', '.index-cache'));
  const conflicts = [...roots].flatMap(root => walkTree(root)).filter(path => conflictCopyName(basename(path)));
  if (conflicts.length > 0) {
    throw new PublishError(`iCloud conflict copies found: ${conflicts.join(', ')}`, { code: 'conflict-copy' });
  }
}

function snapshotDirectory(path, expectedRoot, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PublishError(`${label} is not a real directory: ${path}`, { code: 'unsafe-directory' });
  }
  const real = realpathSync(path);
  assertInside(real, expectedRoot, label);
  return { path, real, dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function assertSnapshotUnchanged(snapshot, expectedRoot, label) {
  const current = snapshotDirectory(snapshot.path, expectedRoot, label);
  if (current.real !== snapshot.real || current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.mode !== snapshot.mode) {
    throw new PublishError(`${label} changed during publish: ${snapshot.path}`, { code: 'directory-drift' });
  }
}

function validateMappedPath(root, rootReal, relativePath, { allowMissing, label }) {
  const lexical = resolve(root, relativePath);
  assertInside(lexical, root, label);
  const parentSnapshot = snapshotDirectory(dirname(lexical), rootReal, `${label} parent`);
  try {
    const stat = lstatSync(lexical);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PublishError(`${label} is not a regular file: ${lexical}`, { code: 'unsafe-file' });
    }
    assertInside(realpathSync(lexical), rootReal, label);
  } catch (error) {
    if (!(allowMissing && error.code === 'ENOENT')) throw error;
  }
  return { lexical, parentSnapshot };
}

function staticValidation(repoRoot, vaultRoot, whitelist, manifest, { requireClean = true } = {}) {
  const repoReal = realpathSync(repoRoot);
  const vaultReal = realpathSync(vaultRoot);
  if (requireClean) assertWorktreeClean(repoRoot);
  assertNoUndeclaredScripts(repoRoot, whitelist);
  assertNoConflictCopies(vaultRoot, whitelist, manifest);

  const sourceSnapshots = new Map();
  const targetSnapshots = new Map();
  const runtimeSnapshot = snapshotDirectory(
    join(vaultRoot, '00-系统', '.index-cache'),
    vaultReal,
    'runtime directory',
  );
  targetSnapshots.set(runtimeSnapshot.path, runtimeSnapshot);
  const mappings = new Map();
  for (const entry of [...whitelist, ...(manifest.kind === 'ok' ? manifest.entries : [])]) {
    if (!mappings.has(entry.source)) mappings.set(entry.source, entry);
  }
  for (const entry of mappings.values()) {
    const sourcePath = join(repoRoot, entry.source);
    if (existsSync(sourcePath)) {
      const checked = validateMappedPath(repoRoot, repoReal, entry.source, { allowMissing: false, label: 'source' });
      sourceSnapshots.set(checked.parentSnapshot.path, checked.parentSnapshot);
    }
    const checkedTarget = validateMappedPath(vaultRoot, vaultReal, entry.target, { allowMissing: true, label: 'target' });
    targetSnapshots.set(checkedTarget.parentSnapshot.path, checkedTarget.parentSnapshot);
  }
  return { repoReal, vaultReal, sourceSnapshots, targetSnapshots };
}

function fsyncDirectory(path) {
  const fd = openSync(path, fsConstants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function atomicWriteBuffer(path, buffer, mode = 0o600) {
  const parent = dirname(path);
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  let held;
  let renamed = false;
  try {
    fd = openSync(temp, 'wx', mode);
    held = fstatSync(fd);
    writeFileSync(fd, buffer);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, mode);
    if (sha256File(temp) !== sha256Buffer(buffer)) {
      throw new PublishError(`temporary file hash mismatch: ${path}`, { code: 'write-verification' });
    }
    renameSync(temp, path);
    renamed = true;
    fsyncDirectory(parent);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Preserve the write error. */ }
    }
    if (!renamed && held) {
      try {
        const current = lstatSync(temp);
        if (current.dev === held.dev && current.ino === held.ino) unlinkSync(temp);
      } catch { /* Missing or replaced temp files are not ours to remove. */ }
    }
  }
}

function atomicWriteJson(path, value, mode = 0o600) {
  atomicWriteBuffer(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), mode);
}

function trustedTestRoot() {
  return realpathSync('/tmp');
}

function validateTestCapability() {
  let stat;
  try { stat = fstatSync(TEST_CAPABILITY_FD); }
  catch {
    throw new PublishError('test controls require an inherited capability', { code: 'unsafe-test-override' });
  }
  if (!stat.isFile() || stat.nlink !== 0 || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())) {
    throw new PublishError('invalid test capability', { code: 'unsafe-test-override' });
  }
}

function validateHermeticTestPath(path, label, { type = 'any' } = {}) {
  let stat;
  let real;
  try {
    stat = lstatSync(path);
    real = realpathSync(path);
  } catch (error) {
    throw new PublishError(`${label} test path is invalid: ${error.message}`, { code: 'unsafe-test-override' });
  }
  if (stat.isSymbolicLink()
      || (type === 'directory' && !stat.isDirectory())
      || (type === 'file' && !stat.isFile())) {
    throw new PublishError(`${label} test path has an invalid type`, { code: 'unsafe-test-override' });
  }
  const root = trustedTestRoot();
  if (real === root || !isInside(real, root)) {
    throw new PublishError(`${label} test path must stay inside the fixed test tmp root`, { code: 'unsafe-test-override' });
  }
  return real;
}

function runStaleTakeoverBarrier(stage, vaultRoot) {
  const barrierInput = process.env.BRAIN_PUBLISH_TEST_STALE_BARRIER;
  const role = process.env.BRAIN_PUBLISH_TEST_STALE_ROLE;
  if (!barrierInput && !role) return;
  if (process.env.NODE_ENV !== 'test' || !barrierInput || !['a', 'b'].includes(role)) {
    throw new PublishError('invalid stale-lock test barrier', { code: 'unsafe-test-override' });
  }
  validateTestCapability();
  validateHermeticTestPath(vaultRoot, 'vault', { type: 'directory' });
  const barrier = validateHermeticTestPath(barrierInput, 'stale barrier', { type: 'directory' });
  const waitFor = path => {
    const deadline = Date.now() + 5000;
    while (!existsSync(path) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    if (!existsSync(path)) {
      throw new PublishError('stale-lock test barrier timed out', { code: 'test-barrier-timeout' });
    }
  };
  if (stage === 'before') {
    if (role === 'b') {
      writeFileSync(join(barrier, 'b-read-stale'), '', { flag: 'wx', mode: 0o600 });
      waitFor(join(barrier, 'a-created'));
    } else {
      waitFor(join(barrier, 'b-read-stale'));
    }
  } else if (stage === 'after' && role === 'a') {
    writeFileSync(join(barrier, 'a-created'), '', { flag: 'wx', mode: 0o600 });
  }
}

function acquireLock(vaultRoot) {
  const lockPath = join(vaultRoot, LOCK_RELATIVE_PATH);
  snapshotDirectory(dirname(lockPath), realpathSync(vaultRoot), 'runtime directory');
  const removeIfOwned = (path, held) => {
    try {
      const current = lstatSync(path);
      if (current.dev !== held.dev || current.ino !== held.ino) return false;
      unlinkSync(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const create = () => {
    let fd;
    let held;
    try {
      fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      held = fstatSync(fd);
      if (!held.isFile() || held.nlink !== 1) {
        throw new PublishError('publish lock must be a single-link regular file', { code: 'lock-corrupt' });
      }
      writeSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      fsyncSync(fd);
    } catch (error) {
      if (held) removeIfOwned(lockPath, held);
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { removeIfOwned(lockPath, held); } catch { /* A foreign/replaced lock is not ours to remove. */ }
    };
  };
  const read = () => {
    let fd;
    try {
      fd = openSync(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const held = fstatSync(fd);
      if (!held.isFile() || held.nlink !== 1) throw new Error('lock must be a single-link regular file');
      const lock = JSON.parse(readFileSync(fd, 'utf8'));
      if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('invalid pid');
      return { lock, held };
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw new PublishError(`publish lock is corrupt: ${error.message}`, { code: 'lock-corrupt' });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const isDead = ({ pid }) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      if (error.code === 'EPERM') return false;
      throw error;
    }
  };
  const acquireTakeoverClaim = () => {
    const path = `${lockPath}.takeover`;
    const DARWIN_O_EXLOCK = 0x20;
    const DARWIN_O_UNIQUE = 0x2000;
    let fd;
    try {
      fd = openSync(
        path,
        fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NONBLOCK |
          fsConstants.O_NOFOLLOW | DARWIN_O_EXLOCK | DARWIN_O_UNIQUE,
        0o600,
      );
    } catch (error) {
      if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') {
        throw new PublishError('another publisher is resolving a stale lock', { code: 'lock-contended' });
      }
      throw error;
    }
    let held;
    try {
      held = fstatSync(fd);
      if (!held.isFile() || held.nlink !== 1) {
        throw new PublishError('takeover gate must be a single-link regular file', { code: 'lock-corrupt' });
      }
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return () => {
      try { removeIfOwned(path, held); } catch { /* The kernel lock remains authoritative. */ }
      closeSync(fd);
    };
  };

  try {
    return create();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const observed = read();
  if (!isDead(observed.lock)) {
    throw new PublishError(`another publisher holds the lock (pid ${observed.lock.pid})`, { code: 'lock-contended' });
  }
  runStaleTakeoverBarrier('before', vaultRoot);
  const releaseClaim = acquireTakeoverClaim();
  try {
    let current;
    try {
      current = read();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { return create(); }
      catch (createError) {
        if (createError.code === 'EEXIST') {
          throw new PublishError('another publisher won stale-lock recovery', { code: 'lock-contended' });
        }
        throw createError;
      }
    }
    if (!isDead(current.lock)) {
      throw new PublishError(`another publisher holds the lock (pid ${current.lock.pid})`, { code: 'lock-contended' });
    }
    if (!removeIfOwned(lockPath, current.held)) {
      throw new PublishError('publish lock changed during stale takeover', { code: 'lock-contended' });
    }
    try {
      const release = create();
      try {
        runStaleTakeoverBarrier('after', vaultRoot);
        return release;
      } catch (error) {
        release();
        throw error;
      }
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new PublishError('another publisher won stale-lock recovery', { code: 'lock-contended' });
      }
      throw error;
    }
  } finally {
    releaseClaim();
  }
}

function childEnvironment(extraKeys = []) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', ...extraKeys]) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

function resolveLaunchctlConfig(repoRoot, vaultRoot) {
  const commandOverride = process.env.BRAIN_PUBLISH_LAUNCHCTL;
  const directoryOverride = process.env.BRAIN_PUBLISH_LAUNCHAGENT_DIR;
  const testControlKeys = [
    'BRAIN_PUBLISH_TEST_HOOK',
    'BRAIN_PUBLISH_TEST_CRASH_AFTER',
    'BRAIN_PUBLISH_TEST_STALE_BARRIER',
    'BRAIN_PUBLISH_TEST_STALE_ROLE',
  ];
  const hasTestControls = testControlKeys.some(key => process.env[key] !== undefined);
  if (!commandOverride && !directoryOverride && !hasTestControls) {
    return {
      command: '/bin/launchctl',
      directory: join(userInfo().homedir, 'Library', 'LaunchAgents'),
      env: childEnvironment(),
    };
  }
  if (process.env.NODE_ENV !== 'test' || !commandOverride || !directoryOverride) {
    throw new PublishError('launchctl overrides require a complete hermetic test configuration', { code: 'unsafe-test-override' });
  }
  validateTestCapability();
  const backupRoot = resolve(process.env.BRAIN_PUBLISH_BACKUP_ROOT || tmpdir());
  const command = validateHermeticTestPath(commandOverride, 'launchctl', { type: 'file' });
  const directory = validateHermeticTestPath(directoryOverride, 'LaunchAgents', { type: 'directory' });
  for (const [label, path] of [['repo', repoRoot], ['vault', vaultRoot]]) {
    validateHermeticTestPath(path, label, { type: 'directory' });
  }
  try { validateHermeticTestPath(realpathSync(backupRoot), 'backup', { type: 'directory' }); }
  catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError(`backup test path is invalid: ${error.message}`, { code: 'unsafe-test-override' });
  }
  if (process.env.BRAIN_PUBLISH_TEST_HOOK) {
    validateHermeticTestPath(process.env.BRAIN_PUBLISH_TEST_HOOK, 'test hook', { type: 'file' });
  }
  if (!process.env.BRAIN_PUBLISH_MOCK_STATE) {
    throw new PublishError('hermetic launchctl requires a mock state file', { code: 'unsafe-test-override' });
  }
  validateHermeticTestPath(process.env.BRAIN_PUBLISH_MOCK_STATE, 'launchctl state', { type: 'file' });
  if (process.env.BRAIN_PUBLISH_TEST_CRASH_AFTER
      && !/^[1-9]\d*$/.test(process.env.BRAIN_PUBLISH_TEST_CRASH_AFTER)) {
    throw new PublishError('invalid test crash counter', { code: 'unsafe-test-override' });
  }
  testControlsAuthorized = true;
  return {
    command,
    directory,
    env: childEnvironment(['BRAIN_PUBLISH_MOCK_STATE']),
  };
}

function runBootCommand(launchctl, argv, label, action) {
  try {
    return runLaunchctlRetrying(launchctl, argv);
  } catch (error) {
    throw new PublishError(`launchctl ${action} failed for ${label}: ${error.message}`, { code: 'launchctl-error' });
  }
}

function parseLaunchctlPrint(output, label, configuredPath) {
  const stateMatch = String(output).match(/^\s*state\s*=\s*([^\n]+)$/m);
  const pathMatch = String(output).match(/^\s*path\s*=\s*([^\n]+)$/m);
  return {
    label,
    loaded: true,
    state: stateMatch ? stateMatch[1].trim() : 'loaded',
    path: pathMatch ? pathMatch[1].trim() : configuredPath,
  };
}

function inspectServices(launchctl) {
  const domain = `gui/${process.getuid?.() ?? process.env.UID}`;
  const directory = launchctl.directory;
  return LAUNCH_AGENTS.map(label => {
    const configuredPath = join(directory, `${label}.plist`);
    const result = runLaunchctl(launchctl, ['print', `${domain}/${label}`]);
    if (result.error) throw new PublishError(`launchctl print failed for ${label}: ${result.error.message}`, { code: 'launchctl-error' });
    if (result.status !== 0) return { label, loaded: false, state: 'unloaded', path: configuredPath };
    const parsed = parseLaunchctlPrint(result.stdout, label, configuredPath);
    if (parsed.path !== configuredPath) {
      throw new PublishError(`launchctl path mismatch for ${label}`, { code: 'launchctl-path-mismatch' });
    }
    return parsed;
  });
}

function freezeServices(services, launchctl) {
  const domain = `gui/${process.getuid?.() ?? process.env.UID}`;
  const stopped = [];
  try {
    for (const service of services.filter(item => item.loaded)) {
      runBootCommand(launchctl, ['bootout', `${domain}/${service.label}`], service.label, 'bootout');
      stopped.push(service);
    }
  } catch (error) {
    restoreServices(stopped, launchctl);
    throw error;
  }
}

function restoreServices(services, launchctl) {
  const domain = `gui/${process.getuid?.() ?? process.env.UID}`;
  for (const service of services.filter(item => item.loaded)) {
    const before = runLaunchctl(launchctl, ['print', `${domain}/${service.label}`]);
    if (before.error) throw new PublishError(`launchctl print failed for ${service.label}`, { code: 'launchctl-error' });
    if (before.status !== 0) {
      runBootCommand(launchctl, ['bootstrap', domain, service.path], service.label, 'bootstrap');
    }
    const verified = runLaunchctl(launchctl, ['print', `${domain}/${service.label}`]);
    if (verified.error || verified.status !== 0) {
      throw new PublishError(`launchctl verification failed for ${service.label}`, { code: 'launchctl-error' });
    }
    const parsed = parseLaunchctlPrint(verified.stdout, service.label, service.path);
    if (parsed.path !== service.path) {
      throw new PublishError(`launchctl verification path mismatch for ${service.label}`, { code: 'launchctl-path-mismatch' });
    }
  }
}

function validateServicesSchema(services, launchctl) {
  if (!Array.isArray(services) || services.length !== LAUNCH_AGENTS.length) {
    throw new PublishError('recovery services must contain the four allowlisted agents', { code: 'invalid-recovery' });
  }
  const directory = launchctl.directory;
  const byLabel = new Map(services.map(service => [service?.label, service]));
  for (const label of LAUNCH_AGENTS) {
    const service = byLabel.get(label);
    if (!service || typeof service.loaded !== 'boolean' || typeof service.state !== 'string') {
      throw new PublishError(`invalid recovery service: ${label}`, { code: 'invalid-recovery' });
    }
    const expectedPath = join(directory, `${label}.plist`);
    if (service.path !== expectedPath) {
      throw new PublishError(`invalid recovery service path: ${label}`, { code: 'invalid-recovery' });
    }
  }
}

function runTestHook(stage, extra = {}) {
  if (!process.env.BRAIN_PUBLISH_TEST_HOOK) return;
  if (!testControlsAuthorized) {
    throw new PublishError('test hook is not authorized', { code: 'unsafe-test-override' });
  }
  const env = childEnvironment([
    'TEST_MUTATE_TARGET',
    'TEST_SOURCE_GROUP',
    'TEST_SOURCE_MOVED',
    'TEST_LOCK_RELEASE',
    'BRAIN_PUBLISH_TEST_STALE_BARRIER',
    'BRAIN_PUBLISH_TEST_STALE_ROLE',
    'TEST_ATOMIC_TARGET',
  ]);
  env.BRAIN_PUBLISH_HOOK_CONTEXT = JSON.stringify(extra);
  const result = spawnSync(process.env.BRAIN_PUBLISH_TEST_HOOK, [stage], {
    encoding: 'utf8',
    env,
  });
  if (result.error || result.status !== 0) {
    throw new PublishError(`test hook failed at ${stage}`, { code: 'test-hook-error' });
  }
}

function buildNextManifest(whitelist, records) {
  const recordsBySource = new Map(records.map(record => [record.path, record]));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: whitelist.map(entry => {
      const record = recordsBySource.get(entry.source);
      if (!record?.repoHash) throw new PublishError(`cannot build manifest entry for ${entry.source}`, { code: 'manifest-build-error' });
      return { ...entry, sha256: record.repoHash };
    }),
  };
}

function validateBackupRoot(backupRoot, repoRoot, vaultRoot) {
  const absolute = resolve(backupRoot);
  let stat;
  try { stat = lstatSync(absolute); }
  catch (error) {
    throw new PublishError(`backup root must already exist: ${error.message}`, { code: 'invalid-backup' });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PublishError('backup root must be a real directory', { code: 'invalid-backup' });
  }
  const real = realpathSync(absolute);
  if (isInside(real, realpathSync(repoRoot)) || isInside(real, realpathSync(vaultRoot))) {
    throw new PublishError('backup root must be outside repo and vault', { code: 'invalid-backup' });
  }
  return real;
}

function loadRecoveryAuthorizations(vaultRoot, { allowMissing = false } = {}) {
  const path = join(vaultRoot, RECOVERY_AUTHORIZATIONS_RELATIVE_PATH);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') return { path, value: { version: 1, entries: [] } };
    throw new PublishError(`recovery authorization ledger is unavailable: ${error.message}`, { code: 'invalid-recovery' });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())) {
    throw new PublishError('recovery authorization ledger has an unsafe type, mode, or owner', { code: 'invalid-recovery' });
  }
  assertInside(realpathSync(path), realpathSync(vaultRoot), 'recovery authorization ledger');
  const value = readJson(path, 'recovery authorization ledger');
  if (value?.version !== 1 || !Array.isArray(value.entries)) {
    throw new PublishError('invalid recovery authorization ledger schema', { code: 'invalid-recovery' });
  }
  const seen = new Set();
  for (const entry of value.entries) {
    const createdAt = typeof entry?.createdAt === 'string' ? new Date(entry.createdAt) : null;
    if (!entry || typeof entry !== 'object'
        || !/^[a-f0-9]{32}$/.test(entry.transactionId || '')
        || seen.has(entry.transactionId)
        || !createdAt
        || Number.isNaN(createdAt.getTime())
        || createdAt.toISOString() !== entry.createdAt
        || !isAbsolute(entry.backupDir || '')
        || !isAbsolute(entry.repoRoot || '')
        || !isAbsolute(entry.vaultRoot || '')
        || !HASH_RE.test(entry.recoverySha256 || '')) {
      throw new PublishError('invalid recovery authorization entry', { code: 'invalid-recovery' });
    }
    seen.add(entry.transactionId);
  }
  return { path, value };
}

function appendRecoveryAuthorization(vaultRoot, backupDir, recovery, recoveryBuffer) {
  const ledger = loadRecoveryAuthorizations(vaultRoot, { allowMissing: true });
  if (ledger.value.entries.some(entry => entry.transactionId === recovery.transactionId)) {
    throw new PublishError('duplicate recovery transactionId', { code: 'invalid-recovery' });
  }
  ledger.value.entries.push({
    transactionId: recovery.transactionId,
    createdAt: recovery.createdAt,
    backupDir: realpathSync(backupDir),
    repoRoot: recovery.repoRoot,
    vaultRoot: recovery.vaultRoot,
    recoverySha256: sha256Buffer(recoveryBuffer),
  });
  atomicWriteJson(ledger.path, ledger.value, 0o600);
}

function authorizeRecovery(vaultRoot, backupDir, recovery, recoveryBuffer) {
  const { value } = loadRecoveryAuthorizations(vaultRoot);
  const authorization = value.entries.find(entry => entry.transactionId === recovery.transactionId);
  if (!authorization
      || authorization.backupDir !== realpathSync(backupDir)
      || authorization.repoRoot !== recovery.repoRoot
      || authorization.vaultRoot !== recovery.vaultRoot
      || authorization.createdAt !== recovery.createdAt
      || authorization.recoverySha256 !== sha256Buffer(recoveryBuffer)) {
    throw new PublishError('recovery does not match a publisher authorization', { code: 'invalid-recovery' });
  }
}

function createBackup(repoRoot, vaultRoot, records, services, nextManifest, onCreated = () => {}) {
  const backupRoot = resolve(process.env.BRAIN_PUBLISH_BACKUP_ROOT || tmpdir());
  const backupRootReal = validateBackupRoot(backupRoot, repoRoot, vaultRoot);
  let backupDir = null;
  try {
    backupDir = mkdtempSync(join(backupRootReal, 'brainkit-publish-'));
    onCreated(backupDir);
    chmodSync(backupDir, 0o700);
    validateBackupDirectory(backupDir, { repoRoot, vaultRoot });
    runTestHook('after-backup-dir', { backupDir });
    const filesDir = join(backupDir, 'files');
    mkdirSync(filesDir, { mode: 0o700 });

    const entries = [];
    const writeRecords = records.filter(record => record.state === 'repo-ahead' || record.state === 'repo-new');
    for (let index = 0; index < writeRecords.length; index += 1) {
      const record = writeRecords[index];
      const targetPath = join(vaultRoot, record.target);
      const tombstone = record.vaultHash === null;
      let backupFile = null;
      let backupSha256 = null;
      let mode = null;
      if (!tombstone) {
        backupFile = `files/${String(index).padStart(4, '0')}`;
        const backupPath = join(backupDir, backupFile);
        copyFileSync(targetPath, backupPath);
        chmodSync(backupPath, 0o600);
        const backupFd = openSync(backupPath, fsConstants.O_RDONLY);
        try { fsyncSync(backupFd); } finally { closeSync(backupFd); }
        backupSha256 = sha256File(backupPath);
        if (backupSha256 !== record.vaultHash) {
          throw new PublishError(`target changed during backup: ${record.target}`, { code: 'target-drift' });
        }
        mode = lstatSync(targetPath).mode & 0o777;
      }
      entries.push({
        source: record.path,
        target: record.target,
        beforeHash: record.vaultHash,
        afterHash: record.repoHash,
        backupFile,
        backupSha256,
        tombstone,
        mode,
      });
    }

    const manifestPath = join(vaultRoot, MANIFEST_RELATIVE_PATH);
    const manifestBackup = 'files/manifest-before.json';
    const manifestBackupPath = join(backupDir, manifestBackup);
    copyFileSync(manifestPath, manifestBackupPath);
    chmodSync(manifestBackupPath, 0o600);
    const manifestBackupFd = openSync(manifestBackupPath, fsConstants.O_RDONLY);
    try { fsyncSync(manifestBackupFd); } finally { closeSync(manifestBackupFd); }
    const manifestBeforeHash = sha256File(manifestBackupPath);
    if (sha256File(manifestPath) !== manifestBeforeHash) {
      throw new PublishError('manifest changed during backup', { code: 'manifest-drift' });
    }
    const nextManifestBuffer = Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`);
    const recovery = {
      version: 1,
      transactionId: randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
      repoRoot: realpathSync(repoRoot),
      vaultRoot: realpathSync(vaultRoot),
      services,
      entries,
      manifest: {
        target: MANIFEST_RELATIVE_PATH,
        beforeHash: manifestBeforeHash,
        afterHash: sha256Buffer(nextManifestBuffer),
        backupFile: manifestBackup,
        backupSha256: manifestBeforeHash,
      },
    };
    const recoveryBuffer = Buffer.from(`${JSON.stringify(recovery, null, 2)}\n`);
    atomicWriteBuffer(join(backupDir, 'recovery.json'), recoveryBuffer, 0o600);
    fsyncDirectory(filesDir);
    fsyncDirectory(backupDir);
    appendRecoveryAuthorization(vaultRoot, backupDir, recovery, recoveryBuffer);
    return { backupDir, recovery, nextManifestBuffer };
  } catch (error) {
    let cleanupError = null;
    if (backupDir) {
      try { rmSync(backupDir, { recursive: true, force: true }); }
      catch (failure) { cleanupError = failure; }
    }
    const detail = cleanupError ? `${error.message}; partial backup cleanup failed: ${cleanupError.message}` : error.message;
    throw new PublishError(detail, { code: error.code || 'backup-failed', backupDir });
  }
}

function atomicCopySource(sourcePath, targetPath, expectedHash) {
  const source = readFileSync(sourcePath);
  if (sha256Buffer(source) !== expectedHash) {
    throw new PublishError(`source changed before write: ${sourcePath}`, { code: 'source-drift' });
  }
  const sourceMode = lstatSync(sourcePath).mode & 0o777;
  atomicWriteBuffer(targetPath, source, sourceMode);
  if (sha256File(targetPath) !== sha256Buffer(source)) {
    throw new PublishError(`target hash mismatch after write: ${targetPath}`, { code: 'write-verification' });
  }
}

function validateBeforeCommit(repoRoot, vaultRoot, whitelist, records, snapshots, writtenTargets) {
  for (const snapshot of snapshots.sourceSnapshots.values()) {
    assertSnapshotUnchanged(snapshot, snapshots.repoReal, 'source parent');
  }
  for (const snapshot of snapshots.targetSnapshots.values()) {
    assertSnapshotUnchanged(snapshot, snapshots.vaultReal, 'target parent');
  }
  const recordsBySource = new Map(records.map(record => [record.path, record]));
  for (const entry of whitelist) {
    const record = recordsBySource.get(entry.source);
    const currentSourceHash = hashFileOrNull(join(repoRoot, entry.source));
    if (currentSourceHash !== record.repoHash) {
      throw new PublishError(`source changed during publish: ${entry.source}`, { code: 'source-drift' });
    }
    const currentTargetHash = hashFileOrNull(join(vaultRoot, entry.target));
    const expected = writtenTargets.has(entry.target) ? record.repoHash : record.vaultHash;
    if (currentTargetHash !== expected) {
      throw new PublishError(`target changed before manifest commit: ${entry.target}`, { code: 'target-drift' });
    }
  }
}

function validateDirectorySnapshots(snapshots) {
  for (const snapshot of snapshots.sourceSnapshots.values()) {
    assertSnapshotUnchanged(snapshot, snapshots.repoReal, 'source parent');
  }
  for (const snapshot of snapshots.targetSnapshots.values()) {
    assertSnapshotUnchanged(snapshot, snapshots.vaultReal, 'target parent');
  }
}

function restoreBackupEntry(backupDir, vaultRoot, entry, backupFiles, { enforceCurrent = false } = {}) {
  const targetPath = join(vaultRoot, entry.target);
  const current = hashFileOrNull(targetPath);
  if (enforceCurrent && current !== entry.beforeHash && current !== entry.afterHash) {
    throw new PublishError(`recovery refuses third value for ${entry.target}`, { code: 'third-value' });
  }
  if (entry.tombstone) {
    if (current === entry.afterHash) unlinkSync(targetPath);
    return;
  }
  atomicWriteBuffer(
    targetPath,
    readVerifiedBackupFile(backupDir, entry.backupFile, entry.backupSha256, backupFiles.get(entry.backupFile)),
    entry.mode || 0o600,
  );
}

function restoreManifest(backupDir, vaultRoot, manifest, backupFiles, { enforceCurrent = false } = {}) {
  const path = join(vaultRoot, MANIFEST_RELATIVE_PATH);
  const current = hashFileOrNull(path);
  if (enforceCurrent && current !== manifest.beforeHash && current !== manifest.afterHash) {
    throw new PublishError('recovery refuses third value for manifest', { code: 'third-value' });
  }
  atomicWriteBuffer(
    path,
    readVerifiedBackupFile(backupDir, manifest.backupFile, manifest.backupSha256, backupFiles.get(manifest.backupFile)),
    0o600,
  );
}

function rollbackTransaction(backupDir, vaultRoot, recovery) {
  const backupFiles = validateBackupFiles(backupDir, recovery);
  for (const entry of recovery.entries) restoreBackupEntry(backupDir, vaultRoot, entry, backupFiles);
  restoreManifest(backupDir, vaultRoot, recovery.manifest, backupFiles);
}

function validateBackupDirectory(backupDir, { repoRoot, vaultRoot, expectedUid = process.getuid?.() } = {}) {
  const absolute = resolve(backupDir);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PublishError('backup path must be a real directory', { code: 'invalid-backup' });
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new PublishError('backup directory mode must be 0700', { code: 'invalid-backup' });
  }
  if (expectedUid !== undefined && stat.uid !== expectedUid) {
    throw new PublishError('backup directory owner mismatch', { code: 'invalid-backup' });
  }
  const real = realpathSync(absolute);
  if (isInside(real, realpathSync(repoRoot)) || isInside(real, realpathSync(vaultRoot))) {
    throw new PublishError('backup directory must be outside repo and vault', { code: 'invalid-backup' });
  }
  return real;
}

function validateRecoverySchema(recovery, launchctl) {
  const createdAt = typeof recovery?.createdAt === 'string' ? new Date(recovery.createdAt) : null;
  if (recovery?.version !== 1
      || !/^[a-f0-9]{32}$/.test(recovery.transactionId || '')
      || !createdAt
      || Number.isNaN(createdAt.getTime())
      || createdAt.toISOString() !== recovery.createdAt
      || !Array.isArray(recovery.entries)
      || !recovery.manifest) {
    throw new PublishError('invalid recovery schema', { code: 'invalid-recovery' });
  }
  validateServicesSchema(recovery.services, launchctl);
  const seenTargets = new Set();
  for (const entry of recovery.entries) {
    if (!entry || typeof entry !== 'object') throw new PublishError('invalid recovery entry', { code: 'invalid-recovery' });
    normalizeRelativePath(entry.source, 'recovery source');
    normalizeRelativePath(entry.target, 'recovery target');
    if (seenTargets.has(entry.target)) throw new PublishError('duplicate recovery target', { code: 'invalid-recovery' });
    seenTargets.add(entry.target);
    if (entry.beforeHash !== null && !HASH_RE.test(entry.beforeHash || '')) throw new PublishError('invalid beforeHash', { code: 'invalid-recovery' });
    if (!HASH_RE.test(entry.afterHash || '')) throw new PublishError('invalid afterHash', { code: 'invalid-recovery' });
    if (typeof entry.tombstone !== 'boolean') throw new PublishError('invalid tombstone', { code: 'invalid-recovery' });
    if (entry.tombstone !== (entry.beforeHash === null)) throw new PublishError('tombstone mismatch', { code: 'invalid-recovery' });
    if (!entry.tombstone) {
      normalizeRelativePath(entry.backupFile, 'recovery backupFile');
      if (!HASH_RE.test(entry.backupSha256 || '')) throw new PublishError('invalid backupSha256', { code: 'invalid-recovery' });
      if (entry.backupSha256 !== entry.beforeHash) throw new PublishError('backupSha256 must equal beforeHash', { code: 'invalid-recovery' });
    }
  }
  if (recovery.manifest.target !== MANIFEST_RELATIVE_PATH
      || !HASH_RE.test(recovery.manifest.beforeHash || '')
      || !HASH_RE.test(recovery.manifest.afterHash || '')
      || !HASH_RE.test(recovery.manifest.backupSha256 || '')
      || recovery.manifest.backupSha256 !== recovery.manifest.beforeHash) {
    throw new PublishError('invalid recovery manifest entry', { code: 'invalid-recovery' });
  }
  normalizeRelativePath(recovery.manifest.backupFile, 'recovery manifest backupFile');
}

function validateRecoveryRoots(recovery, repoRoot, vaultRoot) {
  if (recovery.repoRoot !== realpathSync(repoRoot) || recovery.vaultRoot !== realpathSync(vaultRoot)) {
    throw new PublishError('recovery roots do not match the current repo and vault', { code: 'invalid-recovery' });
  }
}

function inspectBackupFile(backupDir, relativePath) {
  const backupReal = realpathSync(backupDir);
  let path = backupDir;
  try {
    const parts = normalizeRelativePath(relativePath, 'backup file').split('/');
    for (let index = 0; index < parts.length; index += 1) {
      path = join(path, parts[index]);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`symlink component: ${parts.slice(0, index + 1).join('/')}`);
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`non-directory component: ${parts[index]}`);
      if (index === parts.length - 1 && !stat.isFile()) throw new Error('final component is not a regular file');
    }
    const real = realpathSync(path);
    assertInside(real, backupReal, 'backup file');
    const stat = lstatSync(path);
    return { path, real, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError(`invalid backup item ${relativePath}: ${error.message}`, { code: 'invalid-backup' });
  }
}

function readSnapshottedBackupFile(backupDir, relativePath, expectedSnapshot = null) {
  const snapshot = inspectBackupFile(backupDir, relativePath);
  if (expectedSnapshot
      && (snapshot.real !== expectedSnapshot.real || snapshot.dev !== expectedSnapshot.dev || snapshot.ino !== expectedSnapshot.ino)) {
    throw new PublishError(`backup item changed before read: ${relativePath}`, { code: 'invalid-backup' });
  }
  const fd = openSync(snapshot.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const held = fstatSync(fd);
    if (!held.isFile() || held.dev !== snapshot.dev || held.ino !== snapshot.ino) {
      throw new PublishError(`backup item changed before read: ${relativePath}`, { code: 'invalid-backup' });
    }
    const buffer = readFileSync(fd);
    return { buffer, snapshot };
  } finally {
    closeSync(fd);
  }
}

function readVerifiedBackupFile(backupDir, relativePath, expectedHash, expectedSnapshot = null) {
  const { buffer } = readSnapshottedBackupFile(backupDir, relativePath, expectedSnapshot);
  if (sha256Buffer(buffer) !== expectedHash) {
    throw new PublishError(`backup sha256 mismatch: ${relativePath}`, { code: 'backup-hash-mismatch' });
  }
  return buffer;
}

function validateBackupFiles(backupDir, recovery) {
  const items = [
    ...recovery.entries.filter(entry => !entry.tombstone).map(entry => ({ path: entry.backupFile, hash: entry.backupSha256 })),
    { path: recovery.manifest.backupFile, hash: recovery.manifest.backupSha256 },
  ];
  const snapshots = new Map();
  for (const item of items) {
    const snapshot = inspectBackupFile(backupDir, item.path);
    readVerifiedBackupFile(backupDir, item.path, item.hash, snapshot);
    snapshots.set(item.path, snapshot);
  }
  return snapshots;
}

function allowedRecoveryMappings(whitelist, manifest) {
  if (manifest.kind !== 'ok' || manifest.corruptEntries.length > 0) {
    throw new PublishError('current manifest must be valid for recovery', { code: 'invalid-manifest' });
  }
  return new Set([...whitelist, ...manifest.entries].map(entry => `${entry.source}\0${entry.target}`));
}

function publish(repoRoot, vaultRoot, whitelist, manifest, launchctl) {
  const snapshots = staticValidation(repoRoot, vaultRoot, whitelist, manifest);
  const initialRecords = evaluateStates(repoRoot, vaultRoot, whitelist, manifest);
  if (aggregateExitCode(initialRecords) === 0) {
    printRecords(initialRecords);
    return 0;
  }
  if (manifest.kind !== 'ok' || manifest.corruptEntries.length > 0) {
    printRecords(initialRecords);
    return 2;
  }

  let services = [];
  let backupDir = null;
  let recovery = null;
  let frozen = false;
  try {
    services = inspectServices(launchctl);
    const nextManifest = aggregateExitCode(initialRecords) === 1
      ? buildNextManifest(whitelist, initialRecords)
      : manifest.value;
    const backup = createBackup(
      repoRoot,
      vaultRoot,
      initialRecords,
      services,
      nextManifest,
      created => { backupDir = created; },
    );
    ({ recovery } = backup);
    freezeServices(services, launchctl);
    frozen = true;

    const preflightManifest = loadManifest(vaultRoot);
    const preflightRecords = evaluateStates(repoRoot, vaultRoot, whitelist, preflightManifest);
    if (aggregateExitCode(preflightRecords) === 2) {
      restoreServices(services, launchctl);
      frozen = false;
      printRecords(preflightRecords);
      return 2;
    }
    const initialBySource = new Map(initialRecords.map(record => [record.path, record]));
    for (const record of preflightRecords) {
      const initial = initialBySource.get(record.path);
      if (!initial || initial.repoHash !== record.repoHash || initial.vaultHash !== record.vaultHash || initial.baselineHash !== record.baselineHash) {
        throw new PublishError(`preflight drift: ${record.path}`, { code: 'preflight-drift', backupDir });
      }
    }
    validateDirectorySnapshots(snapshots);

    const writtenTargets = new Set();
    let writeCount = 0;
    for (const record of preflightRecords.filter(item => item.state === 'repo-ahead' || item.state === 'repo-new')) {
      const targetPath = join(vaultRoot, record.target);
      assertSnapshotUnchanged(
        snapshots.sourceSnapshots.get(dirname(join(repoRoot, record.path))),
        snapshots.repoReal,
        'source parent',
      );
      assertSnapshotUnchanged(
        snapshots.targetSnapshots.get(dirname(targetPath)),
        snapshots.vaultReal,
        'target parent',
      );
      if (hashFileOrNull(targetPath) !== record.vaultHash) {
        throw new PublishError(`target changed before write: ${record.target}`, { code: 'target-drift', backupDir });
      }
      runTestHook('before-write', { target: record.target });
      atomicCopySource(join(repoRoot, record.path), targetPath, record.repoHash);
      writtenTargets.add(record.target);
      writeCount += 1;
      runTestHook('after-write', { index: writeCount, source: record.path, target: record.target });
      if (process.env.NODE_ENV === 'test' && Number(process.env.BRAIN_PUBLISH_TEST_CRASH_AFTER) === writeCount) {
        process.kill(process.pid, 'SIGKILL');
      }
    }

    runTestHook('before-commit', { backupDir });
    validateBeforeCommit(repoRoot, vaultRoot, whitelist, preflightRecords, snapshots, writtenTargets);
    if (sha256File(join(vaultRoot, MANIFEST_RELATIVE_PATH)) !== recovery.manifest.beforeHash) {
      throw new PublishError('manifest changed before commit', { code: 'manifest-drift', backupDir });
    }
    atomicWriteBuffer(join(vaultRoot, MANIFEST_RELATIVE_PATH), backup.nextManifestBuffer, 0o600);
    restoreServices(services, launchctl);
    frozen = false;
    const finalRecords = evaluateStates(repoRoot, vaultRoot, whitelist, loadManifest(vaultRoot));
    printRecords(finalRecords);
    writeJsonLine({ type: 'transaction', status: 'committed', backupDir });
    return aggregateExitCode(finalRecords) === 0 ? 0 : 2;
  } catch (error) {
    let rollbackError = null;
    if (backupDir && recovery) {
      try { rollbackTransaction(backupDir, vaultRoot, recovery); }
      catch (failure) { rollbackError = failure; }
    }
    if (frozen) {
      try { restoreServices(services, launchctl); }
      catch (failure) { rollbackError ||= failure; }
    }
    const detail = rollbackError ? `${error.message}; rollback failed: ${rollbackError.message}` : error.message;
    throw new PublishError(detail, { code: error.code || 'transaction-failed', backupDir });
  }
}

function bootstrap(repoRoot, vaultRoot, whitelist) {
  const current = loadManifest(vaultRoot);
  if (current.kind !== 'missing') throw new PublishError('bootstrap requires a missing manifest', { code: 'bootstrap-refused' });
  staticValidation(repoRoot, vaultRoot, whitelist, current);
  const entries = [];
  for (const entry of whitelist) {
    const sourceHash = hashFileOrNull(join(repoRoot, entry.source));
    const vaultHash = hashFileOrNull(join(vaultRoot, entry.target));
    if (!vaultHash) {
      writeJsonLine({
        type: 'warning',
        code: 'bootstrap-vault-missing',
        target: entry.target,
        message: sourceHash === null
          ? 'repo source and vault target are missing; baseline entry skipped, file will show repo-removed'
          : 'vault target is missing; baseline entry skipped, file will show repo-new',
      });
      continue;
    }
    if (sourceHash !== vaultHash) {
      writeJsonLine({
        type: 'warning',
        code: 'bootstrap-drift',
        target: entry.target,
        message: sourceHash === null
          ? 'repo source is missing; baseline uses vault content, file will show repo-removed'
          : 'repo differs from vault; baseline uses vault content, file will show repo-ahead',
      });
    }
    entries.push({ ...entry, sha256: vaultHash });
  }
  const manifestPath = join(vaultRoot, MANIFEST_RELATIVE_PATH);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  atomicWriteJson(manifestPath, { version: 1, generatedAt: new Date().toISOString(), entries });
  const records = evaluateStates(repoRoot, vaultRoot, whitelist, loadManifest(vaultRoot));
  printRecords(records);
  return aggregateExitCode(records);
}

function retire(repoRoot, vaultRoot, whitelist, source) {
  const requested = normalizeRelativePath(source, '--retire path');
  assertWorktreeClean(repoRoot);
  const manifest = loadManifest(vaultRoot);
  if (manifest.kind !== 'ok' || manifest.corruptEntries.length > 0) {
    throw new PublishError('retire requires a valid manifest', { code: 'retire-refused' });
  }
  if (whitelist.some(entry => entry.source === requested)) {
    throw new PublishError('retire requires the path to be absent from whitelist', { code: 'retire-refused' });
  }
  const entry = manifest.entries.find(item => item.source === requested);
  if (!entry) throw new PublishError('retire path is not in manifest', { code: 'retire-refused' });
  staticValidation(repoRoot, vaultRoot, whitelist, manifest);
  if (hashFileOrNull(join(vaultRoot, entry.target)) !== null) {
    throw new PublishError('retire requires the vault target to be removed manually first', { code: 'retire-refused' });
  }
  const next = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: manifest.entries.filter(item => item.source !== requested),
  };
  atomicWriteJson(join(vaultRoot, MANIFEST_RELATIVE_PATH), next);
  writeJsonLine({ type: 'retire', path: requested, target: entry.target, status: 'retired' });
  return 0;
}

function recover(repoRoot, vaultRoot, whitelist, backupDirInput, launchctl) {
  const currentServices = inspectServices(launchctl);
  let frozen = false;
  try {
    freezeServices(currentServices, launchctl);
    frozen = true;
    const backupDir = validateBackupDirectory(backupDirInput, { repoRoot, vaultRoot });
    const recoverySnapshot = inspectBackupFile(backupDir, 'recovery.json');
    const { buffer: recoveryBuffer } = readSnapshottedBackupFile(backupDir, 'recovery.json', recoverySnapshot);
    let recovery;
    try { recovery = JSON.parse(recoveryBuffer.toString('utf8')); }
    catch (error) {
      throw new PublishError(`recovery manifest is not valid JSON: ${error.message}`, { code: 'invalid-recovery' });
    }
    validateRecoverySchema(recovery, launchctl);
    validateRecoveryRoots(recovery, repoRoot, vaultRoot);
    authorizeRecovery(vaultRoot, backupDir, recovery, recoveryBuffer);
    const backupFiles = validateBackupFiles(backupDir, recovery);
    const manifest = loadManifest(vaultRoot);
    const allowed = allowedRecoveryMappings(whitelist, manifest);
    const vaultReal = realpathSync(vaultRoot);
    for (const entry of recovery.entries) {
      if (!allowed.has(`${entry.source}\0${entry.target}`)) {
        throw new PublishError(`recovery mapping is not allowlisted: ${entry.source} -> ${entry.target}`, { code: 'invalid-recovery' });
      }
      const { lexical: targetPath } = validateMappedPath(vaultRoot, vaultReal, entry.target, {
        allowMissing: true,
        label: 'recovery target',
      });
      const current = hashFileOrNull(targetPath);
      if (current !== entry.beforeHash && current !== entry.afterHash) {
        throw new PublishError(`recovery refuses third value for ${entry.target}`, { code: 'third-value' });
      }
    }
    const currentManifestHash = hashFileOrNull(join(vaultRoot, MANIFEST_RELATIVE_PATH));
    if (currentManifestHash !== recovery.manifest.beforeHash && currentManifestHash !== recovery.manifest.afterHash) {
      throw new PublishError('recovery refuses third value for manifest', { code: 'third-value' });
    }
    for (const entry of recovery.entries) {
      restoreBackupEntry(backupDir, vaultRoot, entry, backupFiles, { enforceCurrent: true });
    }
    restoreManifest(backupDir, vaultRoot, recovery.manifest, backupFiles, { enforceCurrent: true });
    restoreServices(recovery.services, launchctl);
    frozen = false;
    writeJsonLine({ type: 'recovery', status: 'restored', backupDir });
    return 0;
  } finally {
    if (frozen) restoreServices(currentServices, launchctl);
  }
}

function parseArgs(argv) {
  if (argv.length === 0) return { command: 'publish' };
  if (argv.length === 1 && argv[0] === '--check') return { command: 'check' };
  if (argv.length === 1 && argv[0] === '--bootstrap') return { command: 'bootstrap' };
  if (argv.length === 2 && argv[0] === '--retire') return { command: 'retire', value: argv[1] };
  if (argv.length === 2 && argv[0] === '--recover') return { command: 'recover', value: argv[1] };
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { command: 'help' };
  throw new PublishError('usage: publish.mjs [--check|--bootstrap|--retire <source>|--recover <backup-dir>]', { code: 'usage' });
}

function printHelp() {
  process.stdout.write('Usage: node scripts/publish.mjs [--check|--bootstrap|--retire <source>|--recover <backup-dir>]\n');
}

function loadVaultPointer() {
  const override = process.env.BRAIN_PUBLISH_CONF;
  const path = resolve(override || join(userInfo().homedir, '.config', 'second-brain', 'brainkit.conf'));
  let values;
  try {
    values = parseEnvFile(path, {
      allowedKeys: ['schema', 'vault', 'routing_json', 'memory_dir'],
      requiredKeys: ['vault'],
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new PublishError(`BRAIN_VAULT_ROOT unset and no vault pointer at ${override ? path : '~/.config/second-brain/brainkit.conf'}`, {
        code: 'missing-vault-root',
      });
    }
    throw new PublishError(`invalid vault pointer at ${path}: ${error.message}`, { code: 'invalid-vault-pointer' });
  }
  if (!isAbsolute(values.vault)) {
    throw new PublishError(`${path} must define vault as an absolute path`, { code: 'invalid-vault-pointer' });
  }
  return values.vault;
}

function resolveRoots() {
  const repoRoot = resolve(process.env.BRAIN_PUBLISH_REPO_ROOT || DEFAULT_REPO_ROOT);
  const vaultValue = process.env.BRAIN_VAULT_ROOT || loadVaultPointer();
  const vaultRoot = resolve(vaultValue);
  if (!existsSync(repoRoot) || !existsSync(vaultRoot)) throw new PublishError('repo and vault roots must exist', { code: 'missing-root' });
  return { repoRoot, vaultRoot };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'help') {
      printHelp();
      return 0;
    }
    const { repoRoot, vaultRoot } = resolveRoots();
    const releaseLock = acquireLock(vaultRoot);
    try {
      const launchctl = resolveLaunchctlConfig(repoRoot, vaultRoot);
      runTestHook('after-lock');
      const whitelist = loadWhitelist(repoRoot);
      if (args.command === 'bootstrap') return bootstrap(repoRoot, vaultRoot, whitelist);
      if (args.command === 'retire') return retire(repoRoot, vaultRoot, whitelist, args.value);
      if (args.command === 'recover') return recover(repoRoot, vaultRoot, whitelist, args.value, launchctl);

      const manifest = loadManifest(vaultRoot);
      if (args.command === 'check') {
        staticValidation(repoRoot, vaultRoot, whitelist, manifest);
        const records = evaluateStates(repoRoot, vaultRoot, whitelist, manifest);
        printRecords(records);
        return aggregateExitCode(records);
      }
      return publish(repoRoot, vaultRoot, whitelist, manifest, launchctl);
    } finally {
      releaseLock();
    }
  } catch (error) {
    writeJsonLine({
      type: 'error',
      code: error.code || 'unexpected-error',
      message: error.message,
      backupDir: error.backupDir || null,
    }, process.stderr);
    return 2;
  }
}

export {
  MANIFEST_RELATIVE_PATH,
  aggregateExitCode,
  aggregateState,
  classifyFileState,
  evaluateStates,
  parseLaunchctlPrint,
  validateBackupDirectory,
};

if (isMain(import.meta.url)) {
  process.exitCode = main();
}

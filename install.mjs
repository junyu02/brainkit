#!/usr/bin/env node
// install.mjs -- brainkit installer entry point.
// Lives at the repo root on purpose: the publisher's assertNoUndeclaredScripts
// rejects anything under scripts/ that is not in publish-whitelist.json, and the
// installer must never be published into the vault (spec §3.1).
//
// This slice implements preflight (§2.3), the install plan (§5.1 step 1) and
// install-state I/O (§4.4). The install transaction itself (§5.1 steps 2+),
// upgrade and uninstall land in later slices.

import {
  accessSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, loadClipEnv, loadObserveEnv, parseEnvFile, renderPlist, validatePrivateFile } from './scripts/lib/plist-render.mjs';
import { runLaunchctl, runLaunchctlRetrying } from './scripts/lib/launchctl.mjs';

const EXIT = { OK: 0, ACTIONABLE: 1, UNSAFE: 2, RECOVERY: 3 };
// `recover` is not in the frozen §3.3 flag table: it is added as its own
// subcommand rather than an `install --recover` flag precisely so none of the
// frozen per-command flag sets change. See the slice-3 report, B-4.
const COMMANDS = ['install', 'doctor', 'upgrade', 'uninstall', 'recover'];
const IMPLEMENTED_COMMANDS = new Set(['install', 'doctor', 'recover', 'upgrade', 'uninstall']);
const ALL_COMPONENTS = ['core', 'clip', 'observe', 'sunday', 'watch'];
const LLM_COMPONENTS = new Set(['clip', 'observe', 'sunday']);
const MIN_NODE_MAJOR = 22;
const MIN_MACOS_MAJOR = 14; // spec §11.3 Q8
const PRIMARY_ARCH = 'arm64';
const MARKER_RE = /^# brainkit-[a-z-]+ v\d+$/;
const NODE_SHIM_NAME = 'brain-node';
const WRAPPER_SHIM_NAME = 'brain-watch-wrapper.sh';
const STATE_STATUSES = new Set(['installing', 'installed', 'upgrading', 'uninstalling', 'recovery-required']);
const MIN_FREE_KB = 50 * 1024;
// The probe crosses a responsible-process boundary it cannot speak for; every
// consumer of terminal_probe must carry this caveat (spec §2.3, §10.1).
const PROBE_CAVEAT = 'this probe uses the current terminal\'s authorization; LaunchAgents are a separate '
  + 'responsible process, so a passing probe does NOT mean the background service can read the vault. '
  + 'The daemon-side verdict is the absence of "Operation not permitted" in '
  + '~/Library/Logs/second-brain/daemon.log.';

class InstallError extends Error {
  constructor(message, exitCode = EXIT.ACTIONABLE) {
    super(message);
    this.name = 'InstallError';
    this.exitCode = exitCode;
  }
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function tildify(path, home) {
  return path === home || path.startsWith(home + sep) ? '~' + path.slice(home.length) : path;
}

function containedBy(path, prefix) {
  return path === prefix || path.startsWith(prefix + sep);
}

function lookupExecutable(name, pathEnv) {
  for (const dir of String(pathEnv || '').split(':')) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* next PATH entry */ }
  }
  return null;
}

function shellSingleQuote(value) {
  if (value.includes("'")) {
    throw new InstallError(`path contains a single quote and cannot be encoded into the node shim: ${value}`, EXIT.UNSAFE);
  }
  return `'${value}'`;
}

// --- install state (§4.4) -------------------------------------------------

function configDir(home) {
  return join(home, '.config', 'second-brain');
}

function binDir(home) {
  return join(home, '.local', 'bin');
}

function launchAgentsDir(home) {
  return join(home, 'Library', 'LaunchAgents');
}

function logsDir(home) {
  return join(home, 'Library', 'Logs', 'second-brain');
}

// Directories the installer creates but never owns. Two are shared user
// directories (§9.1: the shim directory is never deleted and never walked) and
// two are long-lived infrastructure that outlives any single transaction. They
// are made with mkdirTracked(null, ...) so they cannot enter txn.createdDirs,
// and they are deliberately absent from ARTIFACTS so no manifest can name them.
// Adding a row here without adding one to ARTIFACTS is the whole point.
function infrastructureDirs(home) {
  return [configDir(home), binDir(home), launchAgentsDir(home), logsDir(home)];
}

function installStatePath(home) {
  return join(configDir(home), 'install-state.json');
}

// One O_NOFOLLOW open, then fstat and read on that same fd. Every state and
// shim read in this file goes through here (env and legacy brainkit.conf go
// through the imported parseEnvFile instead): an lstat followed by a
// path-based reopen leaves a window in which the path can become a symlink
// between the two calls. O_NONBLOCK keeps a FIFO or device from blocking the
// open before fstat can reject it; on a regular file it has no effect.
// Returns null when absent, { symlink: true } when the leaf is a symlink.
// ponytail: equivalent to plist-render.mjs:55 readPrivateFile, which is not
// exported. Export it there and delete this one in the first slice allowed to
// touch that whitelisted file (slice 2 must not).
function readNoFollow(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') return { symlink: true, stat: null, content: null };
    throw error;
  }
  try {
    // fstat before reading: opening a directory succeeds, and reading one
    // throws EISDIR out of a function whose whole job is to classify safely.
    const stat = fstatSync(fd);
    return { symlink: false, stat, content: stat.isFile() ? readFileSync(fd) : null };
  } finally {
    closeSync(fd);
  }
}

// Marks a refusal as "the disk would not answer" rather than "the answer was
// not allowed". A caller checking many paths under one root uses it to stop
// after the first: they all walk the same ancestors, so a single unreadable
// directory otherwise reports itself once per path.
function unreadable(error) {
  error.unreadable = true;
  return error;
}

// Every component of a managed root, from the home directory down, must be a
// real directory: a swapped parent moves an installer write outside the paths
// §9.1 enumerates, and checking only the leaf file misses it entirely.
// Components above the home belong to the OS (macOS resolves /var to
// /private/var) and are deliberately not our business, so the walk starts at
// the canonical home rather than at /.
function assertManagedRoot(path, label, home) {
  const inner = relative(home, path);
  if (!inner || inner.startsWith('..') || isAbsolute(inner)) {
    throw new InstallError(`${label} is outside the home directory: ${path}`, EXIT.UNSAFE);
  }
  let current = realpathSync(home);
  for (const part of inner.split(sep)) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return path; // not created yet, so nothing below it exists either
      // Anything else means we cannot tell what is at this path, and one we
      // cannot inspect is not one we may write through. Wrapped rather than
      // re-thrown: a bare `EACCES: permission denied, lstat '...'` says nothing
      // about which directory to look at or what to do about it, and the same
      // misleading-message cost applies here as anywhere else.
      throw unreadable(new InstallError(
        `${label} cannot be inspected: ${current} could not be read (${error.code ?? error.message}). `
        + 'Check that it is readable by this user and is not a broken link, then run the installer again.',
        EXIT.UNSAFE,
      ));
    }
    if (stat.isSymbolicLink()) throw new InstallError(`${label} escapes its literal path via a symlinked component: ${current}`, EXIT.UNSAFE);
    if (!stat.isDirectory()) throw new InstallError(`${label} has a non-directory component: ${current}`, EXIT.UNSAFE);
  }
  return path;
}

// The one definition of "this is a real install state". There were three, and
// they did not agree: this set of checks, a weaker copy inside operationState
// that looked only at whether the bytes parsed, and an id comparison in
// planCloseout that ran after the fact. The weak copy was the one deciding
// whether the file gets deleted, so a state whose mode had been changed out
// from under the run still counted as ours and was unlinked.
//
// Takes the facts from an already-open read rather than a path: re-opening
// would be a second look at a file that can change between the two, which is
// the whole class of problem here.
function installStateFrom(found, path) {
  if (found === null) return { reject: `${path} does not exist`, code: 'ENOENT' };
  if (found.symlink || !found.stat.isFile()) return { reject: `${path} must be a regular non-symlink file` };
  if (found.stat.uid !== process.getuid()) return { reject: `${path} owner mismatch` };
  if ((found.stat.mode & 0o777) !== 0o600) return { reject: `${path} mode must be 0600` };
  let state;
  try {
    state = JSON.parse(found.content.toString('utf8'));
  } catch {
    return { reject: `install state at ${path} is not valid JSON` };
  }
  if (state?.schema !== 1) return { reject: `install state at ${path} has unsupported schema` };
  if (!STATE_STATUSES.has(state.status)) return { reject: `install state at ${path} has unknown status` };
  for (const key of ['repo_root', 'vault_root']) {
    if (!isAbsolute(String(state[key] || ''))) return { reject: `install state at ${path} has a non-absolute ${key}` };
  }
  return { state };
}

// What must not change under a running transaction: the whole record except
// `status`. That one field is exempt because moving it to recovery-required is
// the write this path exists to make -- and it is the only exemption, so the
// list is "everything else" rather than a handful of fields someone remembered.
// An earlier version named five fields while the comment claimed everything,
// and the eight it left out included the file inventories.
const STATE_EXEMPT = 'status';

function sameStateIdentity(a, b) {
  const bare = record => JSON.stringify(Object.fromEntries(
    Object.entries(record ?? {}).filter(([key]) => key !== STATE_EXEMPT).sort(([x], [y]) => x.localeCompare(y)),
  ));
  return bare(a) === bare(b);
}

// Re-read and compare against the snapshot this run started from. Returns a
// reason when the file is no longer the same install state, null when it still
// is. Called immediately before each action that changes the disk on the
// strength of that identity, because the snapshot is minutes old by then.
function stateDrift(home, snapshot) {
  const path = installStatePath(home);
  const found = installStateFrom(readNoFollow(path), path);
  if (found.reject) return `${path} is no longer a state this run can act on: ${found.reject}`;
  if (!sameStateIdentity(found.state, snapshot)) {
    return `${path} changed while this recovery was running; it now names transaction ${found.state.last_txn}`;
  }
  return null;
}

function readPrivateText(path) {
  const found = readNoFollow(path);
  if (found === null) {
    const error = new Error(`${path} does not exist`);
    error.code = 'ENOENT';
    throw error;
  }
  if (found.symlink || !found.stat.isFile()) throw new InstallError(`${path} must be a regular non-symlink file`, EXIT.UNSAFE);
  if (found.stat.uid !== process.getuid()) throw new InstallError(`${path} owner mismatch`, EXIT.UNSAFE);
  if ((found.stat.mode & 0o777) !== 0o600) throw new InstallError(`${path} mode must be 0600`, EXIT.UNSAFE);
  return found.content.toString('utf8');
}

function readInstallState(home) {
  const path = installStatePath(home);
  assertManagedRoot(configDir(home), 'config directory', home);
  const found = installStateFrom(readNoFollow(path), path);
  if (found.code === 'ENOENT') return null;
  if (found.reject) throw new InstallError(found.reject, EXIT.UNSAFE);
  return found.state;
}

// `txn` routes the state file through the transaction writer like every other
// managed file. It used to be written first and added to the record afterwards,
// which is the same unaccounted-crash-window the directories had.
function writeInstallState(home, state, txn = null) {
  if (state.schema !== 1) throw new InstallError('install state schema must be 1');
  if (!STATE_STATUSES.has(state.status)) throw new InstallError(`unknown install state status: ${state.status}`);
  const path = installStatePath(home);
  const directory = assertManagedRoot(configDir(home), 'config directory', home);
  if (txn) {
    applyManagedWrite(txn, path, `${JSON.stringify(state, null, 2)}\n`, artifactMode('state'));
    // What this transaction last put on disk. Kept here rather than at the call
    // sites so it cannot go stale: every write through a transaction updates it,
    // and the rollback's drift check compares against it. Without this the check
    // was dead code on the install path -- it is guarded by the snapshot being
    // set, and only recover used to set one.
    txn.stateSnapshot = state;
    return path;
  }
  const temp = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  // From the registry rather than a literal, so the mode the plan and the gates
  // read is the mode this write actually uses.
  const fd = openSync(temp, 'wx', artifactMode('state'));
  try {
    writeFileSync(fd, JSON.stringify(state, null, 2) + '\n');
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  renameSync(temp, path);
  const dirFd = openSync(directory, fsConstants.O_RDONLY);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return path;
}

// --- shims (§2.3, §6.0, §6.2) ---------------------------------------------

function nodeShimContent(target) {
  return `#!/bin/sh
# brainkit-node-shim v2
# Frozen target -- rewritten by \`node install.mjs install|upgrade\`. Never
# self-resolving: a self-resolving shim would silently bypass the installer's
# Node >=${MIN_NODE_MAJOR} preflight.
set -eu
TARGET=${shellSingleQuote(target)}
if [ ! -x "$TARGET" ]; then
  echo "brain-node: frozen node target missing: $TARGET" >&2
  echo "brain-node: fix with  node install.mjs upgrade --no-pull  (from the brainkit clone)" >&2
  exit 78
fi
exec "$TARGET" "$@"
`;
}

function shimMarker(content) {
  const lines = content.split('\n', 2);
  const candidate = (lines[0] || '').startsWith('#!') ? lines[1] : lines[0];
  const trimmed = (candidate || '').trim();
  return MARKER_RE.test(trimmed) ? trimmed : null;
}

// The single decision. It takes the registry row's takeover policy and the file
// on disk, and returns everything the callers need -- including `retain`, so no
// call site re-derives the policy by comparing the verdict string. That
// re-derivation was the whole defect: the column existed, the behaviour did not
// come from it, and flipping the column changed nothing.
// Verdicts: create | idempotent | overwrite | adopt | adopt-required |
//           takeover-forbidden | unsafe.
function judgeShim({ path, pendingContent, adoptShims = false, takeover = null }) {
  const pendingSha256 = sha256(pendingContent);
  const base = { path, pendingSha256, marker: null, sha256: null, mode: null, adopted: false, retain: false };
  const file = readNoFollow(path);
  if (file === null) return { ...base, verdict: 'create', exit: EXIT.OK };
  if (file.symlink || !file.stat.isFile()) {
    return { ...base, verdict: 'unsafe', exit: EXIT.UNSAFE, reason: 'existing path is a symlink or not a regular file' };
  }
  const currentSha256 = sha256(file.content);
  const marker = shimMarker(file.content.toString('utf8'));
  const found = { ...base, marker, sha256: currentSha256, mode: file.stat.mode & 0o777 };
  if (currentSha256 === pendingSha256) return { ...found, verdict: 'idempotent', exit: EXIT.OK };
  if (marker) return { ...found, verdict: 'overwrite', exit: EXIT.OK };
  // No marker: this file is not ours. Only a row the registry marks adoptable
  // may be taken over at all, and an absent policy is a refusal rather than a
  // default -- a new row has to opt in deliberately.
  if (takeover !== 'adopt') {
    return {
      ...found,
      verdict: 'takeover-forbidden',
      exit: EXIT.UNSAFE,
      reason: `existing file carries no brainkit marker and this path's takeover policy is ${JSON.stringify(takeover)}; brainkit will not replace it`,
    };
  }
  if (adoptShims) return { ...found, verdict: 'adopt', adopted: true, retain: true, exit: EXIT.OK };
  return {
    ...found,
    verdict: 'adopt-required',
    exit: EXIT.UNSAFE,
    reason: 'existing file carries no brainkit marker; re-run with --adopt-shims to back it up and take it over',
  };
}

// Derived from the registry, so a new shim is one row and not an edit here as
// well as in the shapes, the plan and the writer.
function plannedShims(context, answers) {
  const roots = artifactRoots(context.home, null);
  return artifactsFor(answers.components).filter(entry => entry.shim).map(entry => {
    const path = artifactPath(roots, entry);
    if (entry.shim === 'node') {
      return { id: entry.shim, entry, path, pendingContent: Buffer.from(nodeShimContent(context.nodeTarget), 'utf8') };
    }
    const templatePath = join(context.repoRoot, ...entry.source.split('/'));
    return { id: entry.shim, entry, path, pendingContent: readFileSync(templatePath), templatePath };
  });
}

// /bin/launchctl unless a test points it elsewhere, and the override is only
// honoured under NODE_ENV=test -- the same shape as validateApiBase's loopback
// exception (§9.2), so a stray environment variable cannot redirect service
// control on a real machine. The run seam is context.run for the same reason
// everything else uses it: tests must never reach the real launchctl.
function launchctlHandle(context) {
  return {
    command: context.launchctlPath,
    env: publisherEnv(context.env),
    run: (handle, argv) => context.run(handle.command, argv, { env: handle.env }),
  };
}


// --- TCC (§2.3) ------------------------------------------------------------

function protectedPrefixes(home) {
  return [
    join(home, 'Library', 'Mobile Documents'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Downloads'),
  ];
}

function protectedHits(home, paths) {
  const prefixes = protectedPrefixes(home);
  const hits = [];
  for (const path of paths) {
    if (!path) continue;
    for (const prefix of prefixes) {
      if (containedBy(path, prefix) && !hits.includes(prefix)) hits.push(prefix);
    }
  }
  return hits;
}

// Reads the vault directly from this process. Spawning any binary to do it
// re-resolves a pathname at exec time, which is the window the probe kept
// reopening; there is nothing to re-resolve when the read happens here. Same
// answer either way -- both forms measure the current terminal's identity, and
// the result never gates the verdict.
function probeTerminalReachability(vaultPath) {
  try {
    readdirSync(vaultPath);
    return { result: 'ok', detail: 'current terminal identity can read the vault' };
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      return { result: 'eperm', detail: 'current terminal identity is denied' };
    }
    return { result: 'skipped', detail: `probe inconclusive (${error.code})` };
  }
}

// --- answers & plan (§3.2, §3.3, §5.1 step 1) ------------------------------

function normalizeComponents(raw) {
  if (raw === 'all') return [...ALL_COMPONENTS];
  const requested = String(raw).split(',').map(part => part.trim()).filter(Boolean);
  if (requested.length === 0) throw new InstallError('--components must not be empty');
  for (const component of requested) {
    if (!ALL_COMPONENTS.includes(component)) throw new InstallError(`unknown component: ${component}`);
  }
  const selected = new Set(['core', ...requested]);
  return ALL_COMPONENTS.filter(component => selected.has(component));
}

// The single normalization point for both the flag path and the future TTY
// wizard, so the two cannot drift into different plans (§10.2).
function normalizeAnswers(raw) {
  const answers = {
    vaultInput: raw.vault ?? null,
    vaultMode: raw.vaultMode ?? null,
    components: normalizeComponents(raw.components ?? 'core'),
    watchRoot: raw.watchRoot ?? null,
    keyFile: raw.keyFile ?? null,
    reusePrivateConfig: Boolean(raw.reusePrivateConfig),
    adoptShims: Boolean(raw.adoptShims),
    verifyOnline: Boolean(raw.verifyOnline),
  };
  if (!answers.vaultInput) throw new InstallError('--vault is required');
  if (!isAbsolute(answers.vaultInput)) throw new InstallError('--vault must be an absolute path', EXIT.UNSAFE);
  if (!['new', 'existing'].includes(answers.vaultMode)) throw new InstallError('--vault-mode must be new or existing');
  if (answers.components.includes('watch')) {
    if (!answers.watchRoot) throw new InstallError('--watch-root is required when the watch component is selected');
    if (!isAbsolute(answers.watchRoot)) throw new InstallError('--watch-root must be an absolute path', EXIT.UNSAFE);
  } else if (answers.watchRoot) {
    throw new InstallError('--watch-root is only valid with the watch component');
  }
  if (answers.keyFile && !isAbsolute(answers.keyFile)) throw new InstallError('--deepseek-key-file must be an absolute path', EXIT.UNSAFE);
  return answers;
}

function plannedConfigFiles(home, components) {
  const roots = artifactRoots(home, null);
  return artifactsFor(components)
    .filter(entry => entry.root === 'config' && entry.kind === 'file')
    .map(entry => artifactPath(roots, entry));
}

function plannedPlists(home, components) {
  const roots = artifactRoots(home, null);
  return artifactsFor(components).filter(entry => entry.service).map(entry => artifactPath(roots, entry));
}

// --- preflight (§2.3) ------------------------------------------------------

function record(id, level, message, exit = level === 'error' ? EXIT.ACTIONABLE : EXIT.OK) {
  return { id, level, message, exit };
}

function checkPlatform(context, checks) {
  if (context.platform !== 'darwin') {
    checks.push(record('platform', 'error', `brainkit installs on macOS only; this host reports platform=${context.platform}`));
    return false;
  }
  const version = context.run('/usr/bin/sw_vers', ['-productVersion']);
  const productVersion = version.error || version.status !== 0 ? null : String(version.stdout).trim();
  const major = Number.parseInt(String(productVersion).split('.')[0], 10);
  if (!Number.isFinite(major)) {
    checks.push(record('platform', 'error', 'cannot determine the macOS product version via /usr/bin/sw_vers'));
    return false;
  }
  if (major < MIN_MACOS_MAJOR) {
    checks.push(record('platform', 'error', `macOS ${MIN_MACOS_MAJOR} or newer is required; this host runs ${productVersion}`));
    return false;
  }
  const archNote = context.arch === PRIMARY_ARCH ? '' : ` (arch=${context.arch} is best-effort; ${PRIMARY_ARCH} is the verified architecture)`;
  checks.push(record('platform', context.arch === PRIMARY_ARCH ? 'ok' : 'warn', `macOS ${productVersion} ${context.arch}${archNote}`));
  return true;
}

function checkNode(context, checks) {
  let target;
  try {
    target = realpathSync(context.execPath);
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error('not a regular file');
    accessSync(target, fsConstants.X_OK);
  } catch (error) {
    checks.push(record('node', 'error', `the running node executable is not a usable regular file: ${error.message}`));
    return;
  }
  const major = Number.parseInt(String(context.nodeVersion).replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    checks.push(record('node', 'error', `Node >=${MIN_NODE_MAJOR} is required; this process runs ${context.nodeVersion}`));
    return;
  }
  checks.push(record('node', 'ok', `node ${context.nodeVersion} at ${target} (this realpath becomes the frozen shim target)`));
}

function checkGit(context, checks, { requireClean }) {
  const version = context.run('git', ['--version']);
  if (version.error || version.status !== 0) {
    checks.push(record('git', 'error', 'git is required but was not found on PATH'));
    return;
  }
  const inside = context.run('git', ['-C', context.repoRoot, 'rev-parse', '--is-inside-work-tree']);
  if (inside.error || inside.status !== 0 || String(inside.stdout).trim() !== 'true') {
    checks.push(record('git', 'error', `${context.repoRoot} is not a git worktree; clone the repository first`));
    return;
  }
  if (!requireClean) {
    checks.push(record('git', 'ok', 'repo is a git worktree'));
    return;
  }
  const status = context.run('git', ['-C', context.repoRoot, 'status', '--porcelain', '--untracked-files=all']);
  if (status.error || status.status !== 0) {
    checks.push(record('git', 'error', 'cannot inspect the git worktree state'));
    return;
  }
  if (String(status.stdout).trim()) {
    checks.push(record('git', 'error', 'repo worktree is not clean; commit or remove local changes (the installer never stashes or resets)'));
    return;
  }
  checks.push(record('git', 'ok', 'repo worktree is clean'));
}

function checkLaunchTools(context, checks) {
  for (const tool of ['/usr/bin/plutil', '/bin/launchctl']) {
    try {
      accessSync(tool, fsConstants.X_OK);
    } catch {
      checks.push(record('launch-tools', 'error', `${tool} is missing; brainkit cannot render or mount LaunchAgents`));
      return;
    }
  }
  checks.push(record('launch-tools', 'ok', '/usr/bin/plutil and /bin/launchctl are present'));
}

function checkVault(context, checks, answers) {
  const input = answers.vaultInput;
  const exists = existsSync(input);
  if (answers.vaultMode === 'new') {
    if (exists) {
      checks.push({ ...record('vault', 'error', `${input} already exists; an existing directory (even an empty one) must be installed with --vault-mode existing`), exit: EXIT.UNSAFE });
      return null;
    }
  } else if (!exists) {
    checks.push(record('vault', 'error', `${input} does not exist; use --vault-mode new to create it`));
    return null;
  }
  let canonical;
  try {
    canonical = canonicalPath(input, 'vault');
  } catch (error) {
    checks.push({ ...record('vault', 'error', `cannot resolve ${input}: ${error.message}`), exit: EXIT.UNSAFE });
    return null;
  }
  if (exists && !statSync(canonical).isDirectory()) {
    checks.push({ ...record('vault', 'error', `${canonical} is not a directory`), exit: EXIT.UNSAFE });
    return null;
  }
  const parent = dirname(canonical);
  try {
    accessSync(parent, fsConstants.W_OK);
  } catch {
    checks.push(record('vault', 'error', `${parent} is not writable`));
    return null;
  }
  const free = context.run('/bin/df', ['-k', parent]);
  if (!free.error && free.status === 0) {
    const available = Number.parseInt(String(free.stdout).trim().split('\n').pop().split(/\s+/)[3], 10);
    if (Number.isFinite(available) && available < MIN_FREE_KB) {
      checks.push(record('vault-capacity', 'warn', `${parent} has ${Math.round(available / 1024)} MB free; the installer wants at least ${MIN_FREE_KB / 1024} MB of headroom`));
    }
  }
  const resolvedNote = canonical === input ? '' : ` (input ${input} resolves here)`;
  checks.push(record('vault', 'ok', `vault ${answers.vaultMode}: ${canonical}${resolvedNote}`));
  return canonical;
}

// One reader for the project map, so the preflight and the skeleton cannot come
// to different conclusions about the same file. Returns what was found, or null
// when there is nothing there yet. It reads and checks; it never writes, which
// is what lets an existing map be validated before the run commits to anything.
function projectMapFile(path) {
  const file = readManagedFile(path, 'project map');
  if (!file) return null;
  let parsed;
  try {
    parsed = JSON.parse(file.content.toString('utf8'));
  } catch (error) {
    throw new InstallError(`${path} is not valid JSON: ${error.message}`, EXIT.UNSAFE);
  }
  if (!Array.isArray(parsed?.mappings)) throw new InstallError(`${path} has no mappings array`, EXIT.UNSAFE);
  return file;
}

// §4.3: an existing vault only ever gains the directories it is missing. Three
// shapes make that impossible -- a managed path that is a symlink, one that
// exists as something other than a directory, and one reached through a
// symlinked parent -- and §5.1 step 0 is where the spec puts the path and
// collision checks.
//
// It matters that they are refused here rather than where the skeleton is
// actually made. Step 3 runs after step 2 has written config, env and state, so
// the same refusal down there is a rollback, not a refusal: correct, but it has
// already touched the disk to get there.
//
// The check is assertManagedRoot with the same anchor mkdirTracked uses, and
// the map goes through the same reader the skeleton uses. One predicate per
// rule -- two of them is how a preflight and a writer come to disagree.
function checkVaultSchema(context, checks, answers, vaultCanonical) {
  if (!vaultCanonical || answers.vaultMode !== 'existing') return;
  const rows = ARTIFACTS.filter(entry => entry.root === 'vault' && entry.kind === 'dir' && entry.path !== '');
  let refused = false;
  const refuse = error => {
    checks.push({ ...record('vault-schema', 'error', error.message), exit: error.exitCode ?? EXIT.UNSAFE });
    refused = true;
  };
  let present = 0;
  let blind = false;
  for (const entry of rows) {
    const path = join(vaultCanonical, entry.path);
    try {
      assertManagedRoot(path, `vault path ${entry.path}`, vaultCanonical);
    } catch (error) {
      refuse(error);
      // Every row walks the same ancestors, so a directory that will not answer
      // reports itself once per row -- one unreadable vault produced 25 copies
      // of a single finding. A symlink or a wrong file type is a fact about
      // that one path, so those keep going.
      if (error.unreadable) { blind = true; break; }
      continue;
    }
    if (existsSync(path)) present += 1;
  }
  // The map is a file, so it is checked as one: the directory above it is
  // already covered by the rows, and what is left is whether the file itself is
  // a regular file this installer can read and understand. Skipped once the
  // walk has already come back blind -- it reads through the same ancestors.
  if (!blind) {
    try {
      projectMapFile(join(vaultCanonical, ARTIFACTS.find(entry => entry.id === 'project-map').path));
    } catch (error) {
      refuse(error);
    }
  }
  if (refused) return;
  checks.push(record('vault-schema', 'ok',
    `${present} of ${rows.length} schema directories already exist; the missing ${rows.length - present} will be added and nothing existing is rewritten`));
}

function checkTcc(context, checks, { vaultInput, vaultCanonical }) {
  const hits = protectedHits(context.home, [vaultInput, vaultCanonical]);
  if (hits.length === 0) {
    checks.push(record('tcc', 'ok', 'vault is outside every TCC-protected prefix'));
    return { protected_prefix: null, terminal_probe: 'skipped' };
  }
  const probe = vaultCanonical && existsSync(vaultCanonical)
    ? probeTerminalReachability(vaultCanonical)
    : { result: 'skipped', detail: 'vault does not exist yet' };
  // Deliberately a warning whatever the probe says: the probe cannot predict
  // daemon behaviour, so letting it gate the install would bake in a false green.
  checks.push(record('tcc', 'warn', [
    `vault is under a TCC-protected prefix (${hits.map(hit => tildify(hit, context.home)).join(', ')}).`,
    'Background services need Full Disk Access: System Settings -> Privacy & Security -> Full Disk Access,',
    'add the interpreter that runs the LaunchAgents, then re-verify with  node install.mjs doctor.',
    `Terminal reachability probe: ${probe.result} (${probe.detail}). NOTE: ${PROBE_CAVEAT}`,
  ].join('\n    ')));
  return { protected_prefix: tildify(hits[0], context.home) + sep, terminal_probe: probe.result };
}

// §2.3 asks whether a directory exists *or can be created*: a fresh account has
// no ~/.local and no ~/Library/LaunchAgents at all, so walk up to whatever does
// exist and ask whether that is writable.
function creatableDirectory(path) {
  let probe = path;
  while (!existsSync(probe)) probe = dirname(probe);
  try {
    accessSync(probe, fsConstants.W_OK);
    return null;
  } catch {
    return `${probe} is not writable, so ${path} cannot be created`;
  }
}

function checkShims(context, checks, answers) {
  const shimDir = binDir(context.home);
  try {
    assertManagedRoot(shimDir, 'shim directory', context.home);
  } catch (error) {
    checks.push({ ...record('shims', 'error', error.message), exit: error.exitCode ?? EXIT.UNSAFE });
    return [];
  }
  const unwritable = creatableDirectory(shimDir);
  if (unwritable) {
    checks.push(record('shims', 'error', unwritable));
    return [];
  }
  const judged = [];
  for (const shim of plannedShims(context, answers)) {
    const verdict = { ...shim, ...judgeShim({ ...shim, adoptShims: answers.adoptShims, takeover: shim.entry.takeover }) };
    judged.push(verdict);
    const label = `${tildify(shim.path, context.home)} -> ${verdict.verdict}`;
    if (verdict.exit === EXIT.UNSAFE) {
      checks.push({ ...record('shims', 'error', `${label}: ${verdict.reason}`), exit: EXIT.UNSAFE });
    } else if (verdict.verdict === 'adopt') {
      checks.push(record('shims', 'warn', `${label}: --adopt-shims will back the current file up under the recovery directory before overwriting it`));
    } else {
      checks.push(record('shims', 'ok', label));
    }
  }
  return judged;
}

// Step 6 writes plists and step 7 mounts them, so an unwritable LaunchAgents
// directory or a missing launchctl has to stop the run here, before step 2
// creates anything. B-1: failure atomicity is refusing to start, not stopping
// halfway.
function checkLaunchAgents(context, checks, answers) {
  const plists = plannedPlists(context.home, answers.components);
  if (plists.length === 0) {
    checks.push(record('launch-agents', 'ok', 'core only: no LaunchAgent is installed and no service is mounted'));
    return;
  }
  for (const directory of [launchAgentsDir(context.home), logsDir(context.home)]) {
    try {
      assertManagedRoot(directory, 'LaunchAgents directory', context.home);
    } catch (error) {
      checks.push({ ...record('launch-agents', 'error', error.message), exit: error.exitCode ?? EXIT.UNSAFE });
      return;
    }
    const unwritable = creatableDirectory(directory);
    if (unwritable) {
      checks.push(record('launch-agents', 'error', unwritable));
      return;
    }
  }
  try {
    accessSync(context.launchctlPath, fsConstants.X_OK);
  } catch {
    checks.push(record('launch-agents', 'error', `${context.launchctlPath} is not executable, so the selected services cannot be mounted`));
    return;
  }
  checks.push(record('launch-agents', 'ok', `${plists.length} LaunchAgent(s) will be written and mounted via ${context.launchctlPath}`));
}

function checkComponentDependencies(context, checks, answers) {
  if (answers.components.includes('watch')) {
    const fswatch = lookupExecutable('fswatch', context.pathEnv);
    if (!fswatch) {
      checks.push(record('fswatch', 'error', 'the watch component needs fswatch on PATH; install it with  brew install fswatch'));
    } else {
      const probe = context.run(fswatch, ['--version']);
      if (probe.error || probe.status !== 0) checks.push(record('fswatch', 'error', `${fswatch} is not executable`));
      else checks.push(record('fswatch', 'ok', `fswatch at ${fswatch}`));
    }
    if (!existsSync(answers.watchRoot) || !statSync(answers.watchRoot).isDirectory()) {
      checks.push(record('watch-root', 'error', `--watch-root ${answers.watchRoot} must be an existing directory`));
    } else {
      checks.push(record('watch-root', 'ok', `watching ${answers.watchRoot}`));
    }
  }
  if (answers.components.includes('clip')) {
    // §2.3 wants xcrun first and PATH second. An xcrun that exits 0 with no
    // path on stdout has not found anything, and taking its empty answer as
    // final skipped the fallback entirely.
    const found = context.run('xcrun', ['--find', 'swiftc']);
    const reported = !found.error && found.status === 0 ? String(found.stdout).trim() : '';
    const swiftc = reported || lookupExecutable('swiftc', context.pathEnv);
    if (!swiftc) checks.push(record('swiftc', 'error', 'the clip component needs swiftc; install the Xcode Command Line Tools with  xcode-select --install'));
    else checks.push(record('swiftc', 'ok', `swiftc at ${swiftc}`));
  }
}

// loadClipEnv / loadObserveEnv are the repo's existing readers: O_NOFOLLOW read,
// owner/0600/regular check, key allowlist, and the HTTPS-only rule via
// validateApiBase. Calling them is what keeps a plain-http base URL out of a
// config the installer would otherwise stamp "validated" (S3 P1-3).
function neededEnvFiles(components) {
  return artifactsFor(components).filter(entry => entry.env).map(entry => [entry.path, ENV_LOADERS[entry.env]]);
}

function verifyExistingEnv(context, checks, needed, { source, label }) {
  // ponytail: last-moment re-check, not a closed window. preflight's configRootOk
  // is taken at the very start, and a dozen checks run before we get here, so
  // re-lstat'ing immediately before the first loader shrinks the gap from
  // "whole preflight" to "these few statements". It does not eliminate it: an
  // active same-UID process can still swap the parent between this lstat and
  // the loader's open. That attacker is outside the threat model spec §9.3
  // (L836) declares -- P2 defends against mistakes, path escapes, incidental
  // corruption and non-malicious concurrency, and explicitly does not claim a
  // sandbox against a same-UID attacker. Closing it properly needs
  // dirfd-relative opens, which Node does not expose.
  try {
    assertManagedRoot(configDir(context.home), 'config directory', context.home);
  } catch (error) {
    checks.push({ ...record('deepseek-key', 'error', `not read: ${error.message}`), exit: error.exitCode ?? EXIT.UNSAFE });
    return null;
  }
  const files = [];
  for (const [file, load] of needed) {
    const path = join(configDir(context.home), file);
    try {
      load(path);
    } catch (error) {
      checks.push({ ...record('deepseek-key', 'error', `${label} rejected ${path}: ${error.message}`), exit: EXIT.UNSAFE });
      return null;
    }
    files.push(file);
  }
  checks.push(record('deepseek-key', 'ok', `${label} passed for ${files.join(', ')}; no key value is read into the plan`));
  return { source, files };
}

function checkSecretSource(context, checks, answers, { command, configRootOk }) {
  const needed = neededEnvFiles(answers.components);
  if (needed.length === 0) {
    checks.push(record('deepseek-key', 'ok', 'no component needs a DeepSeek key'));
    return null;
  }
  // A rejected config root is a precondition failure, not an independent
  // check: the loaders' O_NOFOLLOW only guards the leaf, so reading through a
  // root already judged unsafe would follow the symlinked parent and stamp an
  // outside credential file "validated" (S3 P1-R2-2).
  if (!configRootOk) {
    checks.push({ ...record('deepseek-key', 'error', `not read: ${tildify(configDir(context.home), context.home)} was rejected above`), exit: EXIT.UNSAFE });
    return null;
  }
  // doctor never collects a key (spec §10.1); it only verifies what is already
  // on disk, so an installed clip/observe host stays checkable offline.
  if (command === 'doctor') {
    return verifyExistingEnv(context, checks, needed, { source: 'existing-private-config', label: 'private config check' });
  }
  if (answers.keyFile) {
    try {
      if (lstatSync(answers.keyFile).isSymbolicLink()) throw new Error('must be a regular non-symlink file');
      validatePrivateFile(answers.keyFile);
    } catch (error) {
      checks.push({ ...record('deepseek-key', 'error', `--deepseek-key-file ${answers.keyFile} rejected: ${error.message}`), exit: EXIT.UNSAFE });
      return null;
    }
    checks.push(record('deepseek-key', 'ok', `key will be read from ${answers.keyFile} (mode 0600, owned by this uid); the value is never printed or passed in argv`));
    return { source: 'key-file', path: answers.keyFile };
  }
  if (answers.reusePrivateConfig) {
    return verifyExistingEnv(context, checks, needed, { source: 'reuse-private-config', label: '--reuse-private-config' });
  }
  checks.push(record('deepseek-key', 'error', 'clip/observe/sunday need a DeepSeek key: pass --deepseek-key-file <0600 file> or --reuse-private-config (the key is never accepted on the command line)'));
  return null;
}

function checkPriorInstall(context, checks, { command }) {
  const path = installStatePath(context.home);
  let state;
  try {
    state = readInstallState(context.home);
  } catch (error) {
    checks.push({ ...record('install-state', 'error', error.message), exit: error.exitCode ?? EXIT.UNSAFE });
    return null;
  }
  if (!state) {
    checks.push(record('install-state', command === 'doctor' ? 'error' : 'ok', command === 'doctor'
      ? `no install state at ${tildify(path, context.home)}; nothing has been installed yet`
      : 'no previous brainkit install state on this machine'));
    return null;
  }
  if (command === 'install' && state.status === 'installed') {
    checks.push(record('install-state', 'error', `brainkit is already installed from ${state.repo_root}; run  node install.mjs upgrade  instead`));
  } else if (state.status !== 'installed') {
    // fail-closed until recovery lands in a later slice: §4.4 forbids stacking
    // new writes onto a half-installed system, so a non-terminal state blocks
    // rather than warns (S3 P1-4).
    checks.push(record('install-state', 'error', `previous run left status=${state.status}; run  node install.mjs recover  to see what it left, deal with it, then install again`));
  } else {
    checks.push(record('install-state', 'ok', `installed at commit ${state.installed_commit} with components ${(state.components || []).join(', ')}`));
  }
  return state;
}

function checkOrphanTransactions(context, checks, state) {
  const orphans = orphanTransactions(context.home, state?.last_txn);
  if (orphans.length === 0) return;
  checks.push(record('recovery-material', 'warn',
    `${orphans.length} recovery transaction(s) in ${tildify(join(configDir(context.home), 'recovery'), context.home)} belong to no current install; left in place, remove by hand once you are satisfied`));
}

function checkOnline(context, checks, answers) {
  if (!answers.verifyOnline) {
    checks.push(record('online', 'ok', 'online verification is opt-in and disabled; pass --verify-online to enable it'));
    return;
  }
  checks.push(record('online', 'warn', 'online verification is requested but lands with the component smoke tests in a later slice'));
}

function preflight(context, answers, { command = 'install' } = {}) {
  const checks = [];
  let configRootOk = true;
  try {
    assertManagedRoot(configDir(context.home), 'config directory', context.home);
  } catch (error) {
    checks.push({ ...record('config-root', 'error', error.message), exit: error.exitCode ?? EXIT.UNSAFE });
    configRootOk = false;
  }
  const darwin = checkPlatform(context, checks);
  checkNode(context, checks);
  checkGit(context, checks, { requireClean: command === 'install' || command === 'upgrade' });
  if (darwin) checkLaunchTools(context, checks);
  const vaultCanonical = checkVault(context, checks, answers);
  checkVaultSchema(context, checks, answers, vaultCanonical);
  const shims = checkShims(context, checks, answers);
  checkLaunchAgents(context, checks, answers);
  const tcc = checkTcc(context, checks, { vaultInput: answers.vaultInput, vaultCanonical });
  checkComponentDependencies(context, checks, answers);
  const keySource = checkSecretSource(context, checks, answers, { command, configRootOk });
  const state = checkPriorInstall(context, checks, { command });
  checkOrphanTransactions(context, checks, state);
  checkOnline(context, checks, answers);
  const exitCode = checks.reduce((worst, check) => Math.max(worst, check.exit), EXIT.OK);
  return { checks, exitCode, vaultCanonical, tcc, shims, keySource, state };
}

function buildPlan(context, answers, report) {
  return {
    command: 'install',
    repo_root: context.repoRoot,
    vault_input: answers.vaultInput,
    vault_root: report.vaultCanonical,
    vault_mode: answers.vaultMode,
    components: answers.components,
    watch_root: answers.watchRoot,
    config_files: plannedConfigFiles(context.home, answers.components),
    memory_dir: join(context.home, 'Library', 'Application Support', 'brainkit', 'memory'),
    plists: plannedPlists(context.home, answers.components),
    shims: report.shims.map(shim => ({ id: shim.id, path: shim.path, verdict: shim.verdict, adopted: shim.adopted })),
    node_target: context.nodeTarget,
    key_source: report.keySource ? report.keySource.source : null,
    tcc: report.tcc,
  };
}

const SHIM_VERDICT_TEXT = {
  create: 'new file',
  idempotent: 'already byte-identical, write skipped',
  overwrite: 'brainkit-marked older version, backed up then replaced',
  adopt: 'unmarked file adopted via --adopt-shims, backed up then replaced',
  'adopt-required': 'unmarked file present -- re-run with --adopt-shims to take it over',
  'takeover-forbidden': 'unmarked file present and this path may not be taken over at all',
  unsafe: 'refused: not a regular file',
};

function formatPlan(plan, home) {
  const short = path => tildify(path, home);
  const lines = [
    'Install plan (nothing has been written yet)',
    `  repo            : ${plan.repo_root}`,
    `  vault (input)   : ${plan.vault_input}`,
    `  vault (real)    : ${plan.vault_root ?? '<unresolved>'}`,
    `  vault mode      : ${plan.vault_mode}`,
    `  components      : ${plan.components.join(', ')}`,
  ];
  if (plan.watch_root) lines.push(`  watch root      : ${plan.watch_root}`);
  lines.push('  config files    :');
  for (const file of plan.config_files) lines.push(`      ${short(file)}`);
  lines.push(`  memory index    : ${short(plan.memory_dir)}`);
  lines.push('  local shims     :');
  for (const shim of plan.shims) lines.push(`      ${short(shim.path)} -- ${SHIM_VERDICT_TEXT[shim.verdict] ?? shim.verdict}`);
  lines.push(`  frozen node     : ${plan.node_target}`);
  lines.push(`  LaunchAgents    : ${plan.plists.length ? plan.plists.map(short).join(', ') : 'none (core only)'}`);
  lines.push(`  DeepSeek key    : ${plan.key_source ?? 'not needed by the selected components'} (values are never displayed)`);
  if (plan.tcc.protected_prefix) {
    lines.push(`  TCC             : vault under ${plan.tcc.protected_prefix}; terminal probe ${plan.tcc.terminal_probe}`);
  }
  return lines.join('\n');
}

// --- apply: §5.1 steps 1-5 --------------------------------------------------

// §4.3 vault schema 1. Parameterised at the root only: these names appear in
// routing, protocols, the publisher whitelist and Obsidian links.
// The deployed-code prefix. Named once because §8.2 step 6 selects exactly the
// VAULT_DIRS rows under it, and a second hand-kept list of those four names
// would be free to drift away from this one.
const SCRIPTS_DIR = '00-系统/scripts/';
const VAULT_DIRS = [
  '00-系统/.index-cache', '00-系统/attachments', '00-系统/logs',
  `${SCRIPTS_DIR}bin`, `${SCRIPTS_DIR}cli`, `${SCRIPTS_DIR}daemon`, `${SCRIPTS_DIR}lib`,
  '01-项目', '02-知识', '03-经验', '04-对话', '05-persona', '06-归档', '07-随笔', '08-观察', '09-周报',
  '99-inbox/projects', '99-inbox/knowledge', '99-inbox/experience', '99-inbox/sessions',
  '99-inbox/persona', '99-inbox/notes', '99-inbox/observations', '99-inbox/weekly',
  'raw/pending',
];

const MEMORY_INDEXES = [
  'MEMORY-knowledge.md', 'MEMORY-experience.md', 'MEMORY-project.md',
  'MEMORY-persona.md', 'MEMORY-archive.md', 'MEMORY-notes.md',
];

// --- artifact registry ------------------------------------------------------
// One row per thing the installer creates. Every other view of "what exists" is
// derived from it: the creation calls, the plan display, the env loaders, and
// the set a recovery manifest is allowed to name. Adding an artifact is one
// row. Before this, those were four hand-synchronised lists, and keeping them
// in step by hand is where four rounds of review findings came from -- the
// authorisation set kept lagging the creation set.
//
//   root     : key into artifactRoots
//   kind     : 'file' | 'dir'
//   when     : components that need it; absent means always
//   env      : marks the two files whose contents are a provider key
//   content  : produces the bytes; mutually exclusive with `writer`
//   writer   : names the dedicated writer that owns this row instead
//   takeover : how a pre-existing file at this path is handled (see below)
//   mode     : permissions for rows a dedicated writer creates
//
// `takeover` is the whole of the adopted-shim policy, and it lives here rather
// than at the call site because the three lifecycles -- created, marked
// overwrite, adopted unmarked -- differ only in what the registry says about
// the path plus what is actually on disk:
//   absent    a pre-existing file is backed up into the transaction and its
//             backup dies with the transaction.
//   'adopt'   an unmarked pre-existing file needs --adopt-shims, and its backup
//             is kept after a successful install (§4.4): it is the only copy of
//             a third-party file in a shared user directory.
const ARTIFACTS = [
  { id: 'conf', root: 'config', path: 'brainkit.conf', kind: 'file', content: c => c.conf },
  { id: 'routing', root: 'config', path: 'vault-routing.json', kind: 'file', content: () => `${JSON.stringify(defaultRouting(), null, 2)}\n` },
  { id: 'clip-env', root: 'config', path: 'clip.env', kind: 'file', when: ['clip'], env: 'clip', content: c => `DEEPSEEK_API_KEY=${JSON.stringify(c.secret)}\n` },
  {
    id: 'observe-env', root: 'config', path: 'observe.env', kind: 'file', when: ['observe', 'sunday'], env: 'observe',
    content: c => [`OPENAI_API_KEY=${JSON.stringify(c.secret)}`, 'OPENAI_BASE_URL=https://api.deepseek.com',
      'OBSERVE_MODEL=deepseek-v4-flash', 'HARVEST_JUDGE_MODEL=deepseek-v4-flash', ''].join('\n'),
  },
  // Written by writeInstallState rather than the artifact writer, but listed so
  // it is authorised for rollback and shown in the plan like everything else.
  { id: 'state', root: 'config', path: 'install-state.json', kind: 'file', writer: 'state', mode: 0o600 },
  // §6.0: exactly two files in ~/.local/bin, both mode 0700, both adoptable.
  // Note what is NOT here: a path '' row for the bin root. ~/.local/bin is a
  // shared user directory, so no manifest may ever name it.
  { id: 'node-shim', root: 'bin', path: NODE_SHIM_NAME, kind: 'file', writer: 'shim', shim: 'node', mode: 0o700, takeover: 'adopt' },
  {
    id: 'wrapper-shim', root: 'bin', path: WRAPPER_SHIM_NAME, kind: 'file', writer: 'shim', shim: 'wrapper',
    mode: 0o700, takeover: 'adopt', when: ['watch'],
    // The template is the single source (§6.3), so the row names it rather than
    // leaving the one place that reads it to decide where it lives.
    source: 'templates/watch-wrapper.sh',
  },
  // §5.4: one plist per selected service, rendered from the repo templates.
  // Ordinary managed files -- a pre-existing plist is backed up into the
  // transaction and the backup goes away with it. ~/Library/LaunchAgents gets
  // no path '' row for the same reason ~/.local/bin does not.
  ...['clip', 'observe', 'sunday', 'watch'].map(service => ({
    id: `plist-${service}`, root: 'agents', path: `com.second-brain.${service}.plist`, kind: 'file',
    writer: 'plist', service, mode: 0o600, when: [service],
  })),
  // path '' is the root itself. Only roots a transaction actually creates and
  // can therefore roll back get one: memory and vault do, the config root does
  // not (mkdirTracked(null, ...), infrastructure, outlives transactions).
  { id: 'memory-root', root: 'memory', path: '', kind: 'dir' },
  { id: 'memory-dir', root: 'memory', path: 'memory', kind: 'dir' },
  { id: 'memory-md', root: 'memory', path: 'memory/MEMORY.md', kind: 'file', content: () => memoryMdContent() },
  ...MEMORY_INDEXES.map(name => ({
    id: `memory-${name}`, root: 'memory', path: `memory/${name}`, kind: 'file',
    content: () => `# ${name.replace(/\.md$/, '')}\n`,
  })),
  { id: 'project-map', root: 'vault', path: '00-系统/.project-map.json', kind: 'file', content: () => `${JSON.stringify({ mappings: [] }, null, 2)}\n` },
  { id: 'vault-root', root: 'vault', path: '', kind: 'dir' },
  ...VAULT_DIRS.map(path => ({ id: `vault-${path}`, root: 'vault', path, kind: 'dir' })),
];

const ENV_LOADERS = { clip: loadClipEnv, observe: loadObserveEnv };

const ARTIFACT_ROOTS = ['config', 'memory', 'bin', 'agents', 'vault'];

function artifactRoots(home, vaultRoot) {
  return {
    config: configDir(home),
    memory: join(home, 'Library', 'Application Support', 'brainkit'),
    bin: binDir(home),
    agents: launchAgentsDir(home),
    vault: vaultRoot,
  };
}

function artifactsFor(components) {
  return ARTIFACTS.filter(entry => !entry.when || entry.when.some(name => components.includes(name)));
}

function artifactPath(roots, entry) {
  return join(roots[entry.root], entry.path);
}

function artifactMode(id) {
  const entry = ARTIFACTS.find(row => row.id === id);
  if (!entry || typeof entry.mode !== 'number') throw new InstallError(`artifact ${id} declares no mode`, EXIT.UNSAFE);
  return entry.mode;
}

// 'a/b/c' -> ['a', 'a/b', 'a/b/c']; mkdirTracked records every level it makes,
// so authorisation has to cover the intermediate ones too.
function pathPrefixes(relativePath) {
  const parts = relativePath.split('/').filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

// Must match brain-write.mjs:1210 exactly or the hot section is not found and
// writes silently fall back to appending at the end of the file.
const HOT_SECTION_HEADER = '## 🔥 热记忆（容量 40，按 type 配额+FIFO）';

// §4.2: covers every type brain-write.mjs accepts (VALID_TYPES at :64).
// Conservative by default -- projects must be registered, new knowledge and
// experience subfolders land in 99-inbox rather than creating themselves.
function defaultRouting() {
  const inbox = section => ({ [section]: `99-inbox/${{
    '01-项目/': 'projects', '02-知识/': 'knowledge', '03-经验/': 'experience',
    '04-对话/': 'sessions', '05-persona/': 'persona', '07-随笔/': 'notes',
    '08-观察/': 'observations', '09-周报/': 'weekly',
  }[section]}/` });
  return {
    version: 2,
    routes: [
      { type: 'feedback', path: '03-经验/', scope: 'global' },
      { type: 'experience', path: '03-经验/', scope: 'global' },
      { type: 'project', path: '01-项目/{project-name}/', scope: 'project' },
      { type: 'reference', path: '02-知识/', scope: 'global' },
      { type: 'user-profile', path: '05-persona/', scope: 'global' },
      { type: 'session', path: '04-对话/', scope: 'global' },
      { type: 'note', path: '07-随笔/', scope: 'global' },
      { type: 'observation', path: '08-观察/', scope: 'global' },
      { type: 'weekly', path: '09-周报/', scope: 'global' },
    ],
    section_policies: {
      '01-项目/': { policy: 'bind_to_project', requires_subfolder: true, new_subfolder_policy: 'deny' },
      '02-知识/': { policy: 'existing_only', requires_subfolder: true, new_subfolder_policy: 'deny' },
      '03-经验/': { policy: 'existing_only', requires_subfolder: true, new_subfolder_policy: 'deny' },
      '04-对话/': { policy: 'allow_root', requires_subfolder: false },
      '05-persona/': { policy: 'allow_root', requires_subfolder: false },
      '07-随笔/': { policy: 'allow_root', requires_subfolder: false },
      '08-观察/': { policy: 'pattern', requires_subfolder: true, subfolder_pattern: '^(chronicle-)?\\d{4}-\\d{2}$' },
      '09-周报/': { policy: 'allow_root', requires_subfolder: false },
    },
    inbox_root: '99-inbox/',
    inbox_subfolders: Object.assign({}, ...['01-项目/', '02-知识/', '03-经验/', '04-对话/', '05-persona/', '07-随笔/', '08-观察/', '09-周报/'].map(inbox)),
    exempt_files: [],
  };
}

function memoryMdContent() {
  return [
    '# Memory Index', '',
    HOT_SECTION_HEADER, '',
    '<auto-maintained by brain-write.mjs, FIFO capacity 40>', '',
    '## 📚 领域索引（按需读取）', '',
    ...MEMORY_INDEXES.map(file => `- [${file}](./${file})`),
    '',
  ].join('\n');
}

// A file's identity as this installer cares about it: what is in it, how big it
// is, who owns it and what it may be executed as. Recorded twice for every
// managed path -- once for what was there before (`pre`) and once for what we
// put there (`post`) -- because a rollback both deletes and overwrites, and
// neither is safe against a file that is no longer the one we left behind.
function imageOf(content, { mode, uid }) {
  // Bytes, not characters. A string's length counts code units, and the routing
  // and memory files are full of multi-byte text, so measuring the string made
  // every one of them look like a different size once read back off disk.
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return { sha256: sha256(bytes), size: bytes.length, mode: mode & 0o777, uid };
}

// Ties the fields of an image together so a manifest cannot be edited one field
// at a time. This detects an inconsistent record, NOT a forged one -- anything
// that can rewrite the manifest can recompute this too. That is the right level
// for §9.3's threat model, which covers drift and partial corruption and
// explicitly does not claim protection against a same-uid attacker. It is what
// makes a lone `mode` edit from 0755 to 0777 a refusal instead of a silent
// permission widening.
function imageDigest(image) {
  return sha256(Buffer.from(`v1|${image.sha256}|${image.size}|${image.mode}|${image.uid}`, 'utf8'));
}

function sameImage(left, right) {
  return Boolean(left) && Boolean(right)
    && left.sha256 === right.sha256 && left.size === right.size
    && left.mode === right.mode && left.uid === right.uid;
}

function describeFile(file) {
  return imageOf(file.content, { mode: file.stat.mode, uid: file.stat.uid });
}

// Split from the rename so a caller can get the bytes onto disk, record what it
// is about to publish, and only then make it visible. That ordering is what
// removes the crash window: a manifest entry always exists before the file it
// describes appears, so the worst a crash leaves is a declared change that
// never happened -- which a rollback recognises and skips.
function writeTempFile(path, content, mode) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', mode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  chmodSync(temp, mode);
  return temp;
}

function commitTempFile(temp, path) {
  renameSync(temp, path);
  const dirFd = openSync(dirname(path), fsConstants.O_RDONLY);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return path;
}

function writeFileAtomic(path, content, mode) {
  return commitTempFile(writeTempFile(path, content, mode), path);
}

// The one reader every managed path goes through. readNoFollow is the slice-2
// primitive: single O_NOFOLLOW + O_NONBLOCK open, fstat and read on that same
// fd, so a symlink or FIFO sitting at the path is refused rather than followed
// or blocked on. Returns null when absent.
function readManagedFile(path, label) {
  let file;
  try {
    file = readNoFollow(path);
  } catch (error) {
    // Absent and symlink are answers readNoFollow returns; anything else is a
    // read that could not be made at all, and it used to come out as the raw
    // Node error -- `EACCES: permission denied, open '...'`.
    //
    // The lstat walk in assertManagedRoot was wrapped first, and the assertion
    // written for it only excluded `lstat '`. That named the one syscall that
    // had been fixed rather than the property being claimed, so this one went
    // on leaking. The wrapping belongs here, where every managed read passes
    // and the label is known.
    throw unreadable(new InstallError(
      `${label} cannot be read: ${path} (${error.code ?? error.message}). `
      + 'Check that it is readable by this user, then run the installer again.',
      EXIT.UNSAFE,
    ));
  }
  if (file === null) return null;
  if (file.symlink || !file.stat.isFile()) {
    throw new InstallError(`${label} must be a regular non-symlink file: ${path}`, EXIT.UNSAFE);
  }
  return file;
}

function lockPath(home) {
  return join(configDir(home), 'install.lock');
}

// wx creates or fails; a leftover lock is only reclaimed when its recorded pid
// is gone (ESRCH). A live pid means another installer owns the transaction.
function acquireLock(home) {
  const path = lockPath(home);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readManagedFile(path, 'installer lock');
      const owner = Number.parseInt(String(existing?.content ?? '').trim(), 10);
      if (Number.isFinite(owner)) {
        // Own pid included on purpose: re-entering the lock inside one process
        // would mean two overlapping transactions, which is a bug, not reuse.
        let alive = true;
        try { process.kill(owner, 0); } catch (probe) { alive = probe.code !== 'ESRCH'; }
        if (alive) throw new InstallError(`another installer holds ${tildify(path, home)} (pid ${owner})`);
      }
      unlinkSync(path);
    }
  }
  throw new InstallError(`could not acquire ${tildify(path, home)}`);
}

// The component list comes out of install-state.json, which is an editable
// file, so it is treated like every other value in there: unknown names are
// dropped instead of trusted. Dropping can only narrow the authorised set, so
// the worst case is a rollback that refuses a path, never one that removes a
// path it had no business removing. core is unconditional.
function selectedComponents(claimed) {
  const named = Array.isArray(claimed) ? claimed : [];
  return ALL_COMPONENTS.filter(name => name === 'core' || named.includes(name));
}

// The exact shapes the installer creates, as paths relative to each root --
// not basenames. A basename set was not an authority: a tampered vault_root
// plus a file called MEMORY.md anywhere inside it satisfied the check, and
// createdDirs had no name check at all. Position is what makes a path ours.
// Derived from ARTIFACTS, never hand-listed: what recovery may touch is by
// construction what installation creates.
function managedShapes(home, vaultRoot, components) {
  const roots = artifactRoots(home, vaultRoot);
  const selected = selectedComponents(components);
  const shapes = [];
  for (const kind of ARTIFACT_ROOTS) {
    // A vault root the conf did not corroborate is null, and then the vault
    // contributes no shape at all rather than a narrowed one.
    if (!roots[kind]) continue;
    // Filtered by component, not just by root: a core-only install must not
    // authorise clip.env or the observe plist. Authorising every row whatever
    // was installed is the same defect as authorising a root nothing creates,
    // one conditional step removed.
    const rows = ARTIFACTS.filter(entry => entry.root === kind
      && (!entry.when || entry.when.some(name => selected.includes(name))));
    shapes.push({
      root: roots[kind],
      files: new Set(rows.filter(entry => entry.kind === 'file').map(entry => entry.path)),
      // No unconditional '' here. A root is only rollback-eligible if the
      // registry says so with a row of its own (path ''), because whether a
      // transaction can remove a root is a fact about the root, not something
      // to infer. The config root has no such row: it is created with txn=null
      // and outlives every transaction, so authorising it would let a manifest
      // name a directory no real transaction can produce.
      dirs: new Set(rows.filter(entry => entry.kind === 'dir').flatMap(entry => [entry.path, ...pathPrefixes(entry.path)])),
    });
  }
  // ~/Library and ~/Library/Application Support are made on the way to the
  // memory root, so they belong to home rather than to any artifact root.
  const toMemory = pathPrefixes(relative(home, roots.memory));
  shapes.push({ root: home, files: new Set(), dirs: new Set(toMemory.slice(0, -1)) });
  return shapes;
}

function shapeOf(path, shapes, kind) {
  for (const shape of shapes) {
    if (!realDescendant(path, shape.root)) continue;
    const inner = relative(shape.root, path).split(sep).join('/');
    if (shape[kind].has(inner)) return true;
  }
  return false;
}

const TXN_MANIFEST = 'transaction.json';
// The same record under a different name, which is the whole consumption
// protocol: renaming it is the atomic point after which the anchors are done
// and only disposal is left. Kept readable rather than deleted so a resumed
// closeout still has the operations it needs to finish.
const TXN_SPENT = 'transaction.spent.json';
// §4.4: the one kind of backup that outlives its transaction.
const ADOPTED_DIR = 'adopted-shims';

// One row per managed path, files and directories alike, each with what was
// there before and what this transaction put there. Four parallel arrays --
// created, backups, createdDirs, observed -- said the same thing four ways and
// drifted four ways: one of them had no post-image, one had no identity, one
// had no consumer, and each had its own local rules in the writer, the reader
// and the rollback. There is one shape now, and every rule is written once.
//
//   kind    'file' | 'dir'
//   pre     what was there before, or null if nothing was
//   post    what this transaction left there, or null if it changed nothing
//   backup  where the previous bytes were copied (files it replaced only)
//   retain  §4.4: the copy outlives the transaction (adopted third-party shims)
//
// The four combinations of pre/post say everything the old arrays did:
//   pre null, post set     created it       -> rollback removes it
//   pre set,  post set     replaced it      -> rollback restores pre
//   pre set,  post null    looked, left it  -> rollback does nothing
//   pre null, post null    never happens    -> the reader refuses it
const TXN_SCHEMA = 7;

// `active` until the rollback is proven complete, then `rolled-back`. The value
// is never trusted on its own: a manifest claiming `rolled-back` is re-verified
// against the disk before anything acts on it. A phase that could be edited into
// existence would skip the rollback entirely and then delete the evidence.
const TXN_PHASES = ['active', 'rolled-back'];

// A directory's identity, not just its inode. Inodes get reused, so the same
// number can name a directory the user made after deleting ours; device and
// creation time separate them.
function directoryIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: Math.round(stat.birthtimeMs) };
}

function sameIdentity(left, right) {
  return Boolean(left) && Boolean(right)
    && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function dirStateOf(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return null; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { foreign: true };
  return { mode: stat.mode & 0o777, identity: directoryIdentity(stat) };
}

function sameDirState(left, right) {
  return Boolean(left) && Boolean(right) && !left.foreign && !right.foreign
    && left.mode === right.mode && sameIdentity(left.identity, right.identity);
}

// The digest ties one row's fields together so a manifest cannot be edited a
// field at a time -- a `mode` quietly widened, a `created` flag flipped. It
// detects an inconsistent record, not a forged one: anything that can rewrite
// the manifest can recompute this too. That is the right level for §9.3's
// threat model, which covers drift and partial corruption and explicitly does
// not claim protection from a same-uid attacker.
function operationDigest(operation) {
  return sha256(Buffer.from(`v2|${JSON.stringify([
    operation.kind, operation.path, operation.pre ?? null, operation.post ?? null,
    operation.backup ?? null, operation.retain === true,
  ])}`, 'utf8'));
}

// The plan is the transaction's expected surface, taken once at the start
// from the registry and the answers -- never from what the writer happened to
// do. `existed` is the disk as it was before anything was touched, which is
// what makes "this path is here now and no operation claims it" answerable.
function planDigest(plan) {
  return sha256(Buffer.from(`v1|${JSON.stringify(plan.map(entry => [entry.kind, entry.path, entry.existed]))}`, 'utf8'));
}

function serialiseTransaction(txn) {
  return {
    schema: TXN_SCHEMA,
    phase: txn.phase,
    plan: txn.plan.map(entry => ({ kind: entry.kind, path: entry.path, existed: entry.existed })),
    planDigest: planDigest(txn.plan),
    operations: txn.operations.map(operation => ({
      kind: operation.kind,
      path: operation.path,
      pre: operation.pre ?? null,
      post: operation.post ?? null,
      backup: operation.backup ?? null,
      retain: operation.retain === true,
      digest: operationDigest(operation),
    })),
    services: txn.services.map(entry => ({ label: entry.label, loaded: entry.loaded, plist: entry.plist })),
  };
}

// THE commit primitive. Build the next record, put it through the same
// invariant the reader uses, write it atomically, and only then let the caller
// mutate the filesystem. Nothing reaches disk that this version could not load
// back, and nothing is mutated that was not written down first.
// Previously the writer appended to whichever array it felt applied and the
// reader checked something adjacent; the two were kept in step by hand, which
// is how a producer came to emit a manifest its own reader rejected.
function commitTransaction(txn, mutate = () => {}) {
  const record = serialiseTransaction(txn);
  // The reader's own rules, run on the writer's output. `shapes` is the same
  // authorised set recover will use, so a path the reader would refuse cannot
  // be committed here either.
  validateRecord(record, txn.dir, txn.shapes, txn.home);
  writeFileAtomic(join(txn.dir, TXN_MANIFEST), `${JSON.stringify(record, null, 2)}\n`, 0o600);
  // Each commit replaces the file, so the identity the marker later checks
  // against has to be the one this write produced. Left at whatever was read
  // originally, an ordinary phase commit would look like someone had swapped
  // the record out from under the transaction.
  txn.record = markerEntry(join(txn.dir, TXN_MANIFEST));
  if (txn.onRecord) txn.onRecord(record);
  return mutate();
}

// Every path the registry authorises for this component selection, paired with
// whether it was already on disk. Both the writer and the reader derive it the
// same way from the same shapes, so neither can invent a surface the other does
// not know about.
function planFor(shapes) {
  const { files, dirs } = authorisedPathsFor(shapes);
  return [
    ...dirs.map(path => ({ kind: 'dir', path })),
    ...files.map(path => ({ kind: 'file', path })),
  ].map(entry => ({ ...entry, existed: existsSync(entry.path) }));
}

function beginTransaction(home, { launchctl, shapes, onRecord = null, failpoint = null } = {}) {
  const id = randomBytes(8).toString('hex');
  const txn = {
    id, home, launchctl, shapes, onRecord, failpoint, phase: 'active',
    dir: join(configDir(home), 'recovery', id),
    plan: planFor(shapes),
    operations: [], services: [],
  };
  mkdirTracked(null, txn.dir, { anchor: home, label: 'recovery directory' });
  commitTransaction(txn);
  return txn;
}

function findOperation(txn, path) {
  return txn.operations.find(operation => operation.path === path);
}

// Declares a file write and performs it, in that order. The bytes go to a temp
// file, the record is committed, and only then does the rename make them
// visible -- so a crash leaves a declared change that never landed, which the
// rollback recognises and skips, rather than a change nobody declared.
function applyManagedWrite(txn, path, content, mode, { retain = false, service = null } = {}) {
  const existing = readManagedFile(path, 'managed file');
  const post = imageOf(content, { mode, uid: process.getuid() });
  const already = findOperation(txn, path);
  // Rewriting a file with exactly what is already in it changes nothing, and
  // recording it as a change made the rollback unprovable: pre and post are the
  // same image, so afterwards the file satisfies both, operationState answers
  // `installed` because it checks post first, and the post-rollback check --
  // which wants `undone` -- calls a clean rollback an unknown state.
  //
  // §8.1 makes this the common case rather than a curiosity: the node shim is
  // rebuilt even when its target has not moved, and a plist usually re-renders
  // byte for byte, so every failed upgrade would have reported a false alarm.
  // installShims already reached for observeManagedPath by hand for its own
  // idempotent case; this is the same answer, made available to every caller.
  //
  // The write still happens. Only the record changes, because the record is
  // what was wrong: nothing about this path is different afterwards.
  const unchanged = !already && existing && sameImage(describeFile(existing), post);
  const temp = writeTempFile(path, content, mode);
  try {
    if (already) {
      // Written twice in one transaction: one `pre`, one backup, latest `post`.
      already.post = post;
      if (service) txn.services.push(service);
      commitTransaction(txn);
    } else if (unchanged) {
      // No backup either: there is nothing to restore it to that it is not
      // already at, and a backup nothing can consume is one more thing the
      // rollback has to be told to ignore.
      txn.operations.push({ kind: 'file', path, pre: describeFile(existing), post: null, backup: null, retain: false });
      if (service) txn.services.push(service);
      commitTransaction(txn);
    } else {
      const operation = { kind: 'file', path, pre: null, post, backup: null, retain: false };
      if (existing) {
        const directory = retain ? join(txn.dir, ADOPTED_DIR) : txn.dir;
        if (retain) mkdirTracked(null, directory, { anchor: txn.dir, label: 'adopted shim backup directory' });
        operation.pre = describeFile(existing);
        operation.backup = join(directory, `${txn.operations.length}-${basename(path)}`);
        operation.retain = retain;
        writeFileAtomic(operation.backup, existing.content, 0o600);
      }
      txn.operations.push(operation);
      if (service) txn.services.push(service);
      commitTransaction(txn);
    }
  } catch (error) {
    try { unlinkSync(temp); } catch { /* nothing to clean up */ }
    throw error;
  }
  return commitTempFile(temp, path);
}

// A managed path this transaction looked at and deliberately left alone: pre is
// what is there, post is null. It is a real row rather than a note, because the
// leftover sweep compares what survived against what the manifest says was
// there, and "already here, kept on purpose" is one of the answers.
function observeManagedPath(txn, path, label) {
  if (findOperation(txn, path)) return;
  const file = readManagedFile(path, label);
  if (!file) return;
  txn.operations.push({ kind: 'file', path, pre: describeFile(file), post: null, backup: null, retain: false });
  commitTransaction(txn);
}

function writeManagedFile(txn, path, content, mode) {
  return applyManagedWrite(txn, path, content, mode);
}

// Declares a directory operation and performs it. Same shape as a file: `pre`
// is what was there (null when we make it), `post` is what we leave. A
// pre-existing directory whose mode we tighten gets both, so the rollback can
// put the mode back -- it used to be recorded and then never read.
function applyManagedDir(txn, path, mode) {
  const before = dirStateOf(path);
  if (before?.foreign) throw new InstallError(`managed directory exists and is not a directory: ${path}`, EXIT.UNSAFE);
  const already = findOperation(txn, path);
  if (already) {
    if (mode !== null && before && before.mode !== mode) {
      chmodSync(path, mode);
      already.post = dirStateOf(path);
      commitTransaction(txn);
    }
    return path;
  }
  const operation = { kind: 'dir', path, pre: before, post: null, backup: null, retain: false };
  txn.operations.push(operation);
  // Declared before the mkdir so a crash cannot leave a directory nothing knows
  // about; `post: null` at this point means "may not have happened", and the
  // rollback treats a directory that does not match a committed post as none of
  // its business.
  commitTransaction(txn);
  // post is set only when something actually changed. A directory that was
  // already there at the right mode is an observation, not an operation, and
  // saying otherwise would have the rollback consider undoing it.
  if (!before) {
    mkdirSync(path, { mode: mode ?? 0o755 });
    operation.post = dirStateOf(path);
  } else if (mode !== null && before.mode !== mode) {
    chmodSync(path, mode);
    operation.post = dirStateOf(path);
  }
  commitTransaction(txn);
  return path;
}

// mkdir -p that refuses symlinked components and declares every level it
// touches, created or already there.
function mkdirTracked(txn, path, { anchor, label, mode = 0o700 }) {
  assertManagedRoot(path, label, anchor);
  const missing = [];
  let probe = path;
  while (!existsSync(probe)) {
    missing.unshift(probe);
    probe = dirname(probe);
  }
  if (!txn) {
    for (const dir of missing) mkdirSync(dir, { mode });
    if (missing.length === 0 && !statSync(path).isDirectory()) {
      throw new InstallError(`${label} exists and is not a directory: ${path}`, EXIT.UNSAFE);
    }
    // mkdir's mode argument does nothing to a directory that already exists, so
    // a pre-existing 0755 config or memory directory has to be tightened here.
    if (mode === 0o700) chmodSync(path, 0o700);
    return path;
  }
  // Infrastructure is never declared, for the same reason it is never
  // authorised: it is shared or long-lived, it outlives every transaction, and
  // a manifest that could name it could ask for it to be removed. It is created
  // here without a record and left alone by every rollback.
  const infrastructure = new Set(infrastructureDirs(txn.home));
  for (const dir of missing) {
    if (infrastructure.has(dir)) mkdirSync(dir, { mode });
    else applyManagedDir(txn, dir, mode);
  }
  if (missing.length === 0 && !infrastructure.has(path)) {
    applyManagedDir(txn, path, mode === 0o700 ? 0o700 : null);
  } else if (missing.length === 0 && mode === 0o700) {
    chmodSync(path, 0o700);
  }
  return path;
}

// beginTransaction ids are randomBytes(8) hex. Anything else in state.last_txn
// is either corruption or an attempt to point the recovery path somewhere else,
// and it gets nowhere near a join().
const TXN_ID_RE = /^[0-9a-f]{16}$/;

// String containment is not containment: a symlinked component inside an
// otherwise legal prefix passes startsWith and still resolves somewhere else.
// Walks root -> path lstat'ing each component. A component that does not exist
// yet is fine; there is nothing there to follow.
function realDescendant(path, root) {
  if (!containedBy(path, root)) return false;
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch { return true; }
    if (stat.isSymbolicLink()) return false;
    if (!stat.isDirectory() && current !== path) return false;
  }
  return true;
}

// The one set of rules about what a transaction record may say. The writer runs
// it before every commit and the reader runs it on load, so "the producer wrote
// something its own reader rejects" is not a state that can exist.
function validateRecord(parsed, dir, shapes, home) {
  if (parsed?.schema !== TXN_SCHEMA) {
    throw new InstallError(
      `recovery manifest at ${dir} declares schema ${JSON.stringify(parsed?.schema ?? null)}, not ${TXN_SCHEMA}; `
      + 'it was written by a different version of the installer. Nothing has been changed and the material is kept.',
      EXIT.UNSAFE,
    );
  }
  if (!TXN_PHASES.includes(parsed.phase)) {
    throw new InstallError(`recovery manifest declares an unknown phase ${JSON.stringify(parsed.phase ?? null)}`, EXIT.UNSAFE);
  }

  const image = (value, what) => {
    if (typeof value?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new InstallError(`recovery manifest ${what} has no sha256 digest`, EXIT.UNSAFE);
    if (!Number.isInteger(value.size) || value.size < 0) throw new InstallError(`recovery manifest ${what} has no valid size`, EXIT.UNSAFE);
    if (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) throw new InstallError(`recovery manifest ${what} has no valid mode`, EXIT.UNSAFE);
    if (!Number.isInteger(value.uid) || value.uid < 0) throw new InstallError(`recovery manifest ${what} has no valid uid`, EXIT.UNSAFE);
    return { sha256: value.sha256, size: value.size, mode: value.mode, uid: value.uid };
  };
  const dirState = (value, what) => {
    if (!Number.isInteger(value?.mode) || value.mode < 0 || value.mode > 0o777) throw new InstallError(`recovery manifest ${what} has no valid mode`, EXIT.UNSAFE);
    const identity = value.identity;
    for (const field of ['dev', 'ino', 'birthtimeMs']) {
      if (!Number.isInteger(identity?.[field])) throw new InstallError(`recovery manifest ${what} has no valid ${field}`, EXIT.UNSAFE);
    }
    return { mode: value.mode, identity: { dev: identity.dev, ino: identity.ino, birthtimeMs: identity.birthtimeMs } };
  };

  // Recomputed from the registry and the recorded component selection, not
  // taken from the file being checked. A manifest cannot vouch for its own
  // expected surface -- that was the hole the vault-root omission lived in.
  if (!Array.isArray(parsed?.plan)) throw new InstallError('recovery manifest field plan is not an array', EXIT.UNSAFE);
  const plan = parsed.plan.map(entry => {
    if (entry?.kind !== 'file' && entry?.kind !== 'dir') throw new InstallError('recovery manifest plan has an entry of unknown kind', EXIT.UNSAFE);
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path)) throw new InstallError('recovery manifest plan has a non-absolute path', EXIT.UNSAFE);
    if (typeof entry.existed !== 'boolean') throw new InstallError(`recovery manifest plan has no existed flag for ${entry.path}`, EXIT.UNSAFE);
    return { kind: entry.kind, path: entry.path, existed: entry.existed };
  });
  if (parsed.planDigest !== planDigest(plan)) {
    throw new InstallError('recovery manifest plan does not match its own digest; one of its entries was changed on its own', EXIT.UNSAFE);
  }
  const expected = planFor(shapes);
  const shape = entries => entries.map(entry => `${entry.kind}:${entry.path}`).sort().join('\n');
  if (shape(plan) !== shape(expected)) {
    throw new InstallError(
      'recovery manifest plan is not the surface this installer would plan for that component selection',
      EXIT.UNSAFE,
    );
  }
  if (!Array.isArray(parsed?.operations)) throw new InstallError('recovery manifest field operations is not an array', EXIT.UNSAFE);
  const seen = new Set();
  const metadata = [dir, join(dir, TXN_MANIFEST), join(dir, TXN_SPENT)];
  const operations = parsed.operations.map(entry => {
    if (entry?.kind !== 'file' && entry?.kind !== 'dir') throw new InstallError(`recovery manifest has an operation of unknown kind ${JSON.stringify(entry?.kind ?? null)}`, EXIT.UNSAFE);
    // The plan above was already compared against the surface the registry
    // authorises for these shapes, so asking the registry per operation is the
    // same question a second time. It is asked here rather than through the
    // plan only because this is where a path can still be a non-string.
    const shapeKind = entry.kind === 'file' ? 'files' : 'dirs';
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path) || !shapeOf(entry.path, shapes, shapeKind)) {
      throw new InstallError(`recovery manifest field operations is not a path this installer creates: ${JSON.stringify(entry.path ?? null)}`, EXIT.UNSAFE);
    }
    if (seen.has(entry.path)) throw new InstallError(`recovery manifest lists the same path more than once: ${entry.path}`, EXIT.UNSAFE);
    seen.add(entry.path);
    // A manifest that lists its own bookkeeping would delete the record of what
    // it was doing halfway through doing it.
    if (metadata.includes(entry.path) || containedBy(entry.path, dir)) {
      throw new InstallError(`recovery manifest points at its own transaction material: ${entry.path}`, EXIT.UNSAFE);
    }
    const shaped = entry.kind === 'file'
      ? {
        kind: 'file',
        path: entry.path,
        pre: entry.pre === null ? null : image(entry.pre, 'operation pre-image'),
        post: entry.post === null ? null : image(entry.post, 'operation post-image'),
      }
      : {
        kind: 'dir',
        path: entry.path,
        pre: entry.pre === null ? null : dirState(entry.pre, 'directory pre-state'),
        post: entry.post === null ? null : dirState(entry.post, 'directory post-state'),
      };
    // Neither image is legal for exactly one thing: a directory declared but
    // not yet made. mkdir and its record cannot be one atomic step, so the
    // declaration goes first and says so, and the rollback treats it as "may or
    // may not exist". A file never needs this -- its bytes go to a temp file
    // before the record and are renamed after, so the record always describes
    // something real.
    if (shaped.pre === null && shaped.post === null && shaped.kind !== 'dir') {
      throw new InstallError(`recovery manifest has an operation that neither creates nor observes anything: ${entry.path}`, EXIT.UNSAFE);
    }
    if (typeof entry.retain !== 'boolean') throw new InstallError(`recovery manifest has an operation without a boolean retain flag: ${entry.path}`, EXIT.UNSAFE);
    shaped.retain = entry.retain;
    shaped.backup = entry.backup ?? null;
    if (shaped.backup !== null) {
      // A backup file may only live inside this transaction's own directory --
      // checked per component, so a symlink planted inside cannot point the
      // read (and the later unlink) somewhere else.
      if (typeof shaped.backup !== 'string' || !realDescendant(shaped.backup, dir)) {
        throw new InstallError(`recovery manifest has a backup stored outside its transaction directory: ${entry.path}`, EXIT.UNSAFE);
      }
      if (shaped.kind !== 'file' || shaped.pre === null) {
        throw new InstallError(`recovery manifest keeps a backup for something it did not replace: ${entry.path}`, EXIT.UNSAFE);
      }
    } else if (shaped.kind === 'file' && shaped.pre !== null && shaped.post !== null) {
      throw new InstallError(`recovery manifest replaced ${entry.path} but kept no copy of what was there`, EXIT.UNSAFE);
    }
    if (shaped.retain !== realDescendant(String(shaped.backup), join(dir, ADOPTED_DIR))) {
      throw new InstallError(`recovery manifest disagrees with itself about where a retained backup lives: ${entry.path}`, EXIT.UNSAFE);
    }
    if (entry.digest !== operationDigest(shaped)) {
      throw new InstallError(`recovery manifest operation for ${entry.path} does not match its own digest; one of its fields was changed on its own`, EXIT.UNSAFE);
    }
    return shaped;
  });

  const txn = { home, dir, phase: parsed.phase, plan, operations };

  // The pre-install service state drives a bootstrap, so it is validated as
  // strictly as the paths: a known label, a boolean, and either null or exactly
  // the one plist this installer manages that label from.
  if (!Array.isArray(parsed.services)) throw new InstallError('recovery manifest field services is not an array', EXIT.UNSAFE);
  const managed = managedServicePlists(home);
  const labels = new Set();
  // Both sets used to test `post !== null`, which was standing in for "this
  // transaction has a record for this path". That stopped being true when a
  // write of identical bytes started being recorded as an observation: the
  // plist is accounted for, it simply did not change. `replaced` asks the
  // narrower question -- is there an earlier state to put the file back to --
  // and an observed file is already at it.
  const replaced = new Set(operations.filter(op => op.kind === 'file' && op.pre !== null).map(op => op.path));
  const touched = new Set(operations.filter(op => op.kind === 'file').map(op => op.path));
  txn.services = parsed.services.map(entry => {
    const plist = managed.get(entry?.label);
    if (!plist) throw new InstallError(`recovery manifest names a service this installer does not manage: ${JSON.stringify(entry?.label ?? null)}`, EXIT.UNSAFE);
    if (labels.has(entry.label)) throw new InstallError(`recovery manifest lists ${entry.label} more than once`, EXIT.UNSAFE);
    labels.add(entry.label);
    if (typeof entry.loaded !== 'boolean') throw new InstallError(`recovery manifest has a non-boolean loaded flag for ${entry.label}`, EXIT.UNSAFE);
    if (entry.loaded ? entry.plist !== plist : entry.plist !== null) {
      throw new InstallError(`recovery manifest records ${entry.label} against a plist this installer does not manage`, EXIT.UNSAFE);
    }
    if (!touched.has(plist)) throw new InstallError(`recovery manifest names ${entry.label}, whose plist this transaction never wrote`, EXIT.UNSAFE);
    // A job running before the install can only be put back if there is an
    // earlier plist to put back. Created means this transaction made the file,
    // so a rollback would delete it and have nothing to bootstrap from.
    if (entry.loaded && !replaced.has(plist)) {
      throw new InstallError(`recovery manifest says ${entry.label} was running but keeps no earlier copy of ${plist} to restore`, EXIT.UNSAFE);
    }
    return { label: entry.label, loaded: entry.loaded, plist: entry.plist };
  });
  // ...and the same check the other way, so a set with an entry missing cannot
  // let the service layer be skipped while the files roll back.
  for (const [label, plist] of managed) {
    if (touched.has(plist) && !labels.has(label)) {
      throw new InstallError(`recovery manifest has no pre-install state for ${label}, whose plist this transaction wrote`, EXIT.UNSAFE);
    }
  }
  return txn;
}

// state.vault_root is a value in an editable file, so it cannot authorise a
// deletion root on its own. It is only honoured when brainkit.conf -- written
// and validated independently -- agrees with it. No conf, or a disagreement,
// and the vault contributes no authority at all: the manifest may then only
// name paths under the fixed HOME roots.
function verifiedVaultRoot(home, claimed) {
  if (!claimed) return null;
  const conf = join(configDir(home), 'brainkit.conf');
  if (!existsSync(conf)) return null;
  let values;
  try {
    values = parseEnvFile(conf, { allowedKeys: ['schema', 'vault', 'routing_json', 'memory_dir'], requiredKeys: ['vault'] });
  } catch {
    return null;
  }
  return values.vault === claimed ? claimed : null;
}

// Whether the two files still tell the same story about what this install was
// required to produce. The manifest's plan carries the historical `existed`
// flags that decide which paths must have an operation, and a manifest can
// recompute its own digest over whatever it likes -- so on its own that digest
// only proves the plan has not been edited by something that could not do
// arithmetic. The install state records the same digest independently, which
// raises the bar from "edit one file" to "edit two files consistently".
//
// What this defends against, deliberately scoped: a manifest edited or damaged
// on its own, a state edited on its own, and the two drifting apart -- which
// covers accidental corruption, partial writes, and stale material from another
// install. What it does not claim: an attacker running as this same user, who
// can rewrite both 0600 files consistently. The frozen spec (§836) puts that
// outside P2's threat model, which is about mis-operation, path escape,
// incidental damage and non-malicious concurrency, not a same-UID sandbox.
//
// Nothing external can reconstruct these flags at recover time -- they are an
// observation of the filesystem as it was before the install -- so a fully
// independent authority does not exist for them. Two files that must agree is
// the strongest available position, not a compromise on a reachable one.
function requirednessAgrees(txn, expected) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new InstallError(
      'install state does not record what this transaction was required to produce, so the manifest has nothing to agree with',
      EXIT.UNSAFE,
    );
  }
  const actual = planDigest(txn.plan);
  if (actual !== expected) {
    throw new InstallError(
      `the recovery manifest and the install state disagree about what this install was required to produce (${actual} vs ${expected}); refusing to touch anything`,
      EXIT.UNSAFE,
    );
  }
}

function loadTransaction(home, id, claimedVaultRoot, claimedComponents, requiredness) {
  if (!TXN_ID_RE.test(String(id ?? ''))) {
    throw new InstallError(`install state names a malformed transaction id: ${String(id ?? '<missing>')}`, EXIT.UNSAFE);
  }
  const dir = join(configDir(home), 'recovery', id);
  assertManagedRoot(dir, 'recovery transaction directory', home);
  // Either name: a spent record is the same record, and the name is how a
  // resumed closeout knows the anchors are already released. Both names for two
  // different files is refused -- see manifestState.
  const named = manifestState(dir);
  if (named.kind === 'conflict') {
    throw new InstallError(`${dir} holds both ${TXN_MANIFEST} and a different ${TXN_SPENT}; only one of them can be this transaction's record`, EXIT.UNSAFE);
  }
  if (named.kind === 'invalid') {
    throw new InstallError(`${join(dir, named.name)} is a ${named.why}, not this transaction's record`, EXIT.UNSAFE);
  }
  const spent = named.kind === 'spent' || named.kind === 'linked';
  const file = readManagedFile(join(dir, spent ? TXN_SPENT : TXN_MANIFEST), 'recovery manifest');
  if (!file) return null;
  let parsed;
  try {
    parsed = JSON.parse(file.content.toString('utf8'));
  } catch (error) {
    throw new InstallError(`recovery manifest at ${dir} is unreadable: ${error.message}`, EXIT.UNSAFE);
  }
  // Once the closeout has marked a record spent it has also released
  // brainkit.conf, so the conf can no longer corroborate state.vault_root. For
  // those records the corroboration is the plan digest the manifest and the
  // install state must both carry -- the same two-file agreement requiredness
  // rests on -- and the phase that follows touches nothing but the two anchors,
  // whose paths come from home rather than from the record.
  const vaultRoot = spent ? (claimedVaultRoot || null) : verifiedVaultRoot(home, claimedVaultRoot);
  const shapes = managedShapes(home, vaultRoot, claimedComponents);
  const txn = validateRecord(parsed, dir, shapes, home);
  // Before the caller can reach executeRollback: a manifest whose requiredness
  // no longer matches the state's copy is refused with nothing yet touched.
  // Unconditional on purpose -- an absent second copy is a refusal, not a
  // bypass, or a state edited to drop the field would be the easiest way past.
  requirednessAgrees(txn, requiredness);
  txn.shapes = shapes;
  // The id comes from the directory this record was found in, not from the
  // record: a manifest naming its own id would be a field the reader takes on
  // trust, and the directory name has already been checked against TXN_ID_RE
  // and derived from the install state's own pointer.
  txn.id = id;
  txn.services = txn.services ?? [];
  // A record only gets that name after its rollback finished and its anchors
  // were released, so anything else under it is a contradiction rather than a
  // shortcut to skipping the rollback.
  if (spent && txn.phase !== 'rolled-back') {
    throw new InstallError(`${join(dir, TXN_SPENT)} is marked spent but does not record a finished rollback`, EXIT.UNSAFE);
  }
  txn.spent = spent;
  // Which file this record is, not just which name it had. A name can be made
  // to point at something else between here and the moment it is consumed, and
  // the marker has no other way to tell that it happened.
  txn.record = markerEntry(join(dir, spent ? TXN_SPENT : TXN_MANIFEST));
  return txn;
}

// Transactions whose owning state is gone. Reported, never auto-deleted: an
// orphan is by definition material we can no longer prove is spent, and this
// command's whole job is to not destroy recovery material on uncertainty.
function orphanTransactions(home, activeId) {
  const root = join(configDir(home), 'recovery');
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root).filter(entry => entry !== activeId);
  } catch {
    return [];
  }
}

// Does this backup still hold what it held when it was taken? Returns a reason
// string when it does not, so the preflight and the restore refuse on the same
// rule -- writing whatever bytes happen to be at the backup path is how a file
// truncated after the install gets restored over the original as if it were the
// original. Size is reported apart from the digest only because "truncated to 0
// bytes" reads better than "hash mismatch".
function backupMismatch(operation, content) {
  if (content.length !== operation.pre.size) {
    return `backup ${operation.backup}: is ${content.length} bytes but the manifest recorded ${operation.pre.size}; refusing to restore ${operation.path}`;
  }
  if (sha256(content) !== operation.pre.sha256) {
    return `backup ${operation.backup}: contents do not match the manifest digest; refusing to restore ${operation.path}`;
  }
  return null;
}

// What is at this path now, compared with what the manifest says.
//   'installed'  matches `post`: this transaction's doing, and ours to undo.
//   'undone'     matches `pre` (or is absent when `pre` is null): the change
//                never landed or has already been reverted, so undoing it is a
//                no-op rather than an error.
//   'drifted'    neither: somebody changed it afterwards, and deleting or
//                overwriting it would destroy work this installer never did.
// An operation with `post: null` changed nothing, so `pre` is the only state it
// can legitimately be in.
function operationState(operation, txn = null) {
  if (operation.kind === 'dir') {
    const current = dirStateOf(operation.path);
    if (operation.post && sameDirState(current, operation.post)) return 'installed';
    if (operation.pre === null ? current === null : sameDirState(current, operation.pre)) return 'undone';
    // Declared but never confirmed -- the crash window between mkdir and its
    // record. It sits at a path this installer creates and it is empty, so
    // removing it is right; anything inside it belongs to somebody else and
    // makes it none of our business.
    if (operation.pre === null && operation.post === null && current && !current.foreign) {
      try { return readdirSync(operation.path).length === 0 ? 'installed' : 'drifted'; } catch { return 'drifted'; }
    }
    return 'drifted';
  }
  const file = readNoFollow(operation.path);
  // Absent and "there but not a regular file" are different answers. Treating a
  // directory or symlink at the path as absent made it look already undone, and
  // the rollback walked straight past it.
  if (file !== null && (file.symlink || !file.stat.isFile())) return 'drifted';
  const current = file === null ? null : describeFile(file);
  if (operation.post && sameImage(current, operation.post)) return 'installed';
  if (operation.pre === null ? current === null : sameImage(current, operation.pre)) return 'undone';
  // install-state.json is the one managed file the installer rewrites outside
  // the transaction: marking recovery-required has to work even when the
  // transaction directory does not, so it cannot be recognised byte for byte.
  // It is recognised by naming THIS transaction instead. A state naming another
  // one belongs to another install -- possibly a live one -- and since this
  // operation has no pre-image, calling it ours would have the rollback delete
  // it. The id comes from the transaction rather than from the backup path: on
  // a fresh install there is no earlier state, so there is no backup to read it
  // out of, and every such install would fall through to whatever came next.
  if (txn && operation.path === installStatePath(txn.home)) {
    const found = installStateFrom(file, operation.path);
    if (!found.reject && found.state.last_txn === txn.id) return 'installed';
  }
  return 'drifted';
}

// The two files that make a transaction interpretable at all: install-state
// says which transaction to load, and brainkit.conf is what lets its vault
// paths be authorised. Undoing either one before the rest is proven leaves a
// transaction that can no longer be read -- so they are released last, after
// the phase is durable, and everything else is undone first.
function anchorPaths(home) {
  return [installStatePath(home), join(configDir(home), 'brainkit.conf')];
}

// Undo one file operation, whatever it was. Shared by the rollback and by the
// closeout's anchor release so the rule is written once.
function revertFileOperation(txn, operation) {
  const state = operationState(operation, txn);
  if (state === 'undone') return null;
  if (state === 'drifted') return `${operation.path}: no longer what this install left there`;
  if (operation.pre === null) {
    unlinkSync(operation.path);
    return { done: `removed ${operation.path}` };
  }
  const saved = readManagedFile(operation.backup, 'recovery backup');
  if (!saved) return `${operation.path}: backup file is missing`;
  const corrupt = backupMismatch(operation, saved.content);
  if (corrupt) return corrupt;
  writeFileAtomic(operation.path, saved.content, operation.pre.mode);
  return { done: `restored ${operation.path}` };
}

function writableDirectory(path, label) {
  const parent = dirname(path);
  let stat;
  try {
    stat = lstatSync(parent);
  } catch (error) {
    return `${label} ${path}: parent is unusable (${error.message})`;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return `${label} ${path}: parent is not a real directory`;
  try {
    accessSync(parent, fsConstants.W_OK);
  } catch {
    return `${label} ${path}: parent is not writable`;
  }
  return null;
}

// BSD immutable flags stop unlink and rmdir with EPERM, and Node's Stats has no
// st_flags, so this is the only way to see them before trying. One stat(1) call
// for the whole set; unavailable or non-darwin means no flags to worry about.
// UF_IMMUTABLE 0x2, SF_IMMUTABLE 0x20000.
function immutablePaths(paths) {
  const existing = paths.filter(path => { try { lstatSync(path); return true; } catch { return false; } });
  if (existing.length === 0 || process.platform !== 'darwin') return new Set();
  const result = defaultRun('/usr/bin/stat', ['-f', '%f %N', ...existing]);
  if (result.error || result.status !== 0) return new Set();
  const locked = new Set();
  for (const line of String(result.stdout || '').split('\n')) {
    const split = line.indexOf(' ');
    if (split < 1) continue;
    const flags = Number.parseInt(line.slice(0, split), 10);
    if (Number.isFinite(flags) && (flags & 0x2 || flags & 0x20000)) locked.add(line.slice(split + 1));
  }
  return locked;
}

// label -> the one plist path this installer will ever manage it from.
function managedServicePlists(home) {
  const agents = launchAgentsDir(home);
  return new Map(ARTIFACTS.filter(entry => entry.service)
    .map(entry => [`com.second-brain.${entry.service}`, join(agents, entry.path)]));
}

function serviceDomain() {
  return `gui/${process.getuid()}`;
}

// macOS resolves /var through /private, so launchd reports a path spelled
// differently from the one we passed it. Compare canonically; the transaction
// keeps the literal spelling, which is what containment is anchored to.
function samePlist(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  try { return canonicalPath(left) === canonicalPath(right); } catch { return false; }
}

// launchd's own "no such service" answer, and nothing else. A status in the
// not-found range OR any stderr used to be enough, so a permission error that
// happened to exit 113 was recorded as "not loaded" and the rollback then left
// a running job pointing at the wrong plist. Both halves must agree now.
const NOT_LOADED_STATUS = new Set([113, 3]);
const NOT_LOADED_STDERR = /could not find|no such process|not find service/i;

function readService(launchctl, label) {
  const printed = runLaunchctl(launchctl, ['print', `${serviceDomain()}/${label}`]);
  if (!printed.error && printed.status === 0) {
    const plist = servicePlistFrom(printed.stdout);
    if (!plist) {
      throw new InstallError(`launchctl did not report a plist path for ${label}; refusing to guess whether it is running`, EXIT.UNSAFE);
    }
    return { label, loaded: true, plist };
  }
  const stderr = String(printed.stderr || '').trim();
  const notLoaded = !printed.error
    && NOT_LOADED_STATUS.has(printed.status)
    && (stderr === '' || NOT_LOADED_STDERR.test(stderr));
  if (!notLoaded) {
    throw new InstallError(
      `cannot determine whether ${label} is running (${printed.error?.message || stderr || `exit ${printed.status}`}); `
      + 'refusing to install over a service whose state is unknown',
      EXIT.UNSAFE,
    );
  }
  return { label, loaded: false, plist: null };
}

// The `path = ...` line launchd prints, and only that line. The install path
// used to ask whether the plist path appeared anywhere in the output, which any
// environment variable or program argument holding that string would satisfy --
// while its own comment claimed it proved the job came from that file. The
// recovery path already did this properly; there is one reader now.
function servicePlistFrom(stdout) {
  const match = /^\s*path\s*=\s*(.+)$/m.exec(String(stdout || ''));
  return match ? match[1].trim() : null;
}

function serviceLoadedFrom(launchctl, label) {
  const printed = runLaunchctl(launchctl, ['print', `${serviceDomain()}/${label}`]);
  if (printed.error || printed.status !== 0) return null;
  return servicePlistFrom(printed.stdout);
}

// launchctl bootout of a job that is not loaded fails, and the exit code for
// that case is not something to guess at. The question that matters is whether
// the label is still loaded afterwards, and `print` answers it read-only.
function bootoutService(launchctl, label) {
  try {
    runLaunchctlRetrying(launchctl, ['bootout', `${serviceDomain()}/${label}`]);
    return null;
  } catch (error) {
    // print deliberately does NOT use the retry primitive: a non-zero print is
    // the legitimate "not loaded" signal, and retrying it turns a normal
    // verdict into a six-second wait (§6.4).
    if (serviceLoadedFrom(launchctl, label) === null) return null;
    return `${label}: still loaded after bootout (${error.message})`;
  }
}

// Checks every item a rollback would touch WITHOUT touching any of them, so a
// caller can refuse before the first destructive syscall rather than discover
// the problem halfway through with files already gone.
function planRollback(txn) {
  const problems = [];
  if (txn.services.length > 0) {
    try {
      accessSync(txn.launchctl.command, fsConstants.X_OK);
    } catch {
      problems.push(`${txn.launchctl?.command ?? '<no launchctl>'}: not executable, so the services cannot be unloaded before their plists are touched`);
    }
  }
  for (const path of immutablePaths(txn.operations.map(operation => operation.path))) {
    problems.push(`${path}: immutable flag set (chflags nouchg to clear)`);
  }
  for (const operation of txn.operations) {
    const state = operationState(operation, txn);
    if (state === 'drifted') {
      problems.push(`${operation.path}: no longer what this install left there; refusing to touch it`);
      continue;
    }
    if (state === 'undone' || operation.post === null) continue;
    const parent = writableDirectory(operation.path, operation.kind === 'dir' ? 'created directory' : 'managed file');
    if (parent) problems.push(parent);
    if (operation.backup === null) continue;
    let saved;
    try {
      saved = readManagedFile(operation.backup, 'recovery backup');
    } catch (error) {
      problems.push(`backup ${operation.backup}: ${error.message}`);
      continue;
    }
    if (!saved) {
      problems.push(`backup ${operation.backup}: missing, cannot restore ${operation.path}`);
      continue;
    }
    const corrupt = backupMismatch(operation, saved.content);
    if (corrupt) problems.push(corrupt);
  }
  return problems;
}

// Every path the registry authorises, so the inventory can be checked from the
// other side. Bounded by the registry: a fixed set of names, never a walk.
function authorisedPathsFor(shapes) {
  const files = [];
  const dirs = [];
  for (const shape of shapes) {
    for (const inner of shape.files) files.push(join(shape.root, inner));
    for (const inner of shape.dirs) dirs.push(inner === '' ? shape.root : join(shape.root, inner));
  }
  return { files, dirs };
}

// Every path install-state claims this installation put on disk, from the three
// places §4.4 keeps them.
// The one enumeration of what an install put on this machine. Every consumer
// derives from it -- the rollback's expectations and uninstall's plan -- so a
// class of product cannot be visible to one and invisible to the other. It
// used to be paths only, and uninstall re-listed the same four sources to get
// the kinds it needed; the two copies agreeing was an unenforced coincidence.
function installedProducts(state) {
  if (!state) return [];
  return [
    ...(state.managed_files || []).map(entry => ({ path: entry?.path, kind: 'config', record: entry })),
    ...Object.entries(state.shims || {}).map(([id, shim]) => ({ path: shim?.path, kind: 'shim', id, record: shim })),
    ...Object.entries(state.plists || {}).map(([service, entry]) => {
      const record = plistRecord(entry);
      return { path: record?.path, kind: 'plist', id: service, record };
    }),
    ...Object.entries(state.artifacts || {}).map(([id, entry]) => ({ path: entry?.path, kind: 'artifact', id, record: entry })),
  ].filter(entry => entry.path);
}

// A plist is recorded as { path, sha256 } since uninstall needed a content
// baseline to delete against. States written before that recorded the bare
// path, and reading those as the new shape gives `undefined` -- which drops the
// row out of this enumeration entirely, so the plist becomes both undeletable
// and unreported. That is the exact failure this one enumeration exists to
// prevent, so the old shape is read as a record with no baseline: enumerated,
// kept, and told to the user with a reason.
function plistRecord(entry) {
  return typeof entry === 'string' ? { path: entry } : entry;
}

function declaredArtifacts(state) {
  return installedProducts(state).map(entry => entry.path);
}

// The post-condition a rollback has to satisfy before its phase may advance,
// and the same thing a `rolled-back` manifest is re-checked against before it
// is believed. Every operation must be at its pre-state, every authorised path
// still on disk must be explained, and every service must be back where it was.
// The phase value proves nothing on its own; this does.
function rollbackOutstanding(txn, { declared = [] } = {}) {
  const problems = [];
  const anchors = new Set(anchorPaths(txn.home));
  for (const operation of txn.operations) {
    // The anchors are released last, in the closeout. Undoing them while the
    // rollback is still unproven leaves a transaction nothing can read back.
    if (anchors.has(operation.path)) continue;
    if (operationState(operation, txn) === 'undone') continue;
    // A directory this transaction made can legitimately survive when
    // something else now lives inside it -- infrastructure like
    // ~/Library/LaunchAgents, or a note the user has written since. That is the
    // same tolerance the rmdir has, and what is inside it is checked below.
    if (operation.kind === 'dir' && operation.pre === null && existsSync(operation.path)) {
      const inside = (() => { try { return readdirSync(operation.path); } catch { return []; } })();
      if (inside.length > 0) continue;
    }
    problems.push(`${operation.path} is not back to the state this transaction found it in`);
  }
  const named = new Set(txn.operations.map(operation => operation.path));
  for (const path of declared) {
    if (!named.has(path)) {
      problems.push(`install state says ${path} belongs to this installation, but the manifest never mentions it`);
    }
  }
  // There used to be a second sweep here, comparing the plan against the
  // manifest to catch a planned path that exists but no operation names. It was
  // added to catch a manifest edited on disk between runs, and the only thing
  // that read a manifest from disk and then acted on it was recover's repair.
  // With that gone, the record this runs against is the one this process just
  // built, operation by operation, under record-before-mutation -- so the sweep
  // cannot fire, which is what disabling it and seeing the suite stay green
  // demonstrated. Removed rather than left in place claiming to guard something.
  for (const service of txn.services.filter(entry => entry.loaded)) {
    if (!samePlist(serviceLoadedFrom(txn.launchctl, service.label), service.plist)) {
      problems.push(`${service.label} was running before the install and is not running from ${service.plist} now`);
    }
  }
  return problems;
}

// Runs what planRollback cleared. Reports what it managed to do as well as what
// it did not, because any claim about the filesystem has to be backed by an
// actual result rather than an assumption that the preflight was exhaustive.
function executeRollback(txn) {
  const done = [];
  const failures = [];
  // Services bracket the files. Unload first: removing a plist while launchd
  // still holds the job leaves a running service with no plist behind it.
  for (const { label } of txn.services) {
    try {
      const problem = bootoutService(txn.launchctl, label);
      if (problem) failures.push(problem);
      else done.push(`unloaded ${label}`);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }
  if (failures.length > 0) return { done, failures };

  // Files first, then directories, each in reverse declaration order so
  // children go before their parents.
  // Everything but the anchors, which the closeout releases last. The
  // retained copies are not consumed here either: until `rolled-back` is
  // durable a crash would leave the manifest demanding a backup that no longer
  // exists, which is exactly how a retry became permanently impossible.
  const anchors = new Set(anchorPaths(txn.home));
  const files = txn.operations.filter(operation => operation.kind === 'file'
    && operation.post !== null && !anchors.has(operation.path));
  for (const operation of [...files].reverse()) {
    try {
      const result = revertFileOperation(txn, operation);
      if (typeof result === 'string') throw new Error(result);
      if (result) done.push(result.done);
    } catch (error) { failures.push(`${operation.path}: ${error.message}`); }
  }
  const dirs = txn.operations.filter(operation => operation.kind === 'dir' && operation.post !== null);
  for (const operation of [...dirs].reverse()) {
    try {
      const state = operationState(operation, txn);
      if (state === 'undone') continue;
      if (state === 'drifted') throw new Error('a different directory is at this path now');
      if (operation.pre === null) {
        rmdirSync(operation.path);
        done.push(`removed directory ${operation.path}`);
      } else if (operation.pre.mode !== operation.post.mode) {
        // A directory that was already there and whose mode we tightened: the
        // mode was recorded and then never read, so it never came back.
        chmodSync(operation.path, operation.pre.mode);
        done.push(`restored mode on ${operation.path}`);
      }
    } catch (error) {
      // Only these two are expected: the user put something in the directory,
      // or it is already gone. Anything else is a real failure, and swallowing
      // it is how a run reported success while leaving the directory behind.
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') {
        failures.push(`${operation.path}: ${error.message}`);
      }
    }
  }
  if (failures.length > 0) return { done, failures };

  // The other half of the bracket: put back the jobs that were running before,
  // from the plist the rollback just restored.
  for (const service of txn.services.filter(entry => entry.loaded)) {
    try {
      runLaunchctlRetrying(txn.launchctl, ['bootstrap', serviceDomain(), service.plist]);
      if (!samePlist(serviceLoadedFrom(txn.launchctl, service.label), service.plist)) {
        failures.push(`${service.label}: was loaded before the install and did not come back from ${service.plist}`);
      } else {
        done.push(`reloaded ${service.label}`);
      }
    } catch (error) {
      failures.push(`${service.label}: could not be reloaded from ${service.plist} (${error.message})`);
    }
  }
  return { done, failures };
}

// The one place rollback -> phase -> closeout -> outcome is decided.
//   settled  everything undone and the transaction closed out
//   blocked  refused before touching anything
//   partial  started and stopped; `done` lists what was applied
//   swept    undone and provably so, but the empty directory could not be
//            removed -- recovery succeeded, cleanup left something behind
function settleTransaction(txn, verify = () => [], expectations = {}) {
  // A manifest claiming the rollback finished is not taken at its word. The
  // same post-condition that let the phase advance is re-checked against the
  // disk; a phase edited into a manifest proves nothing and used to skip the
  // rollback, delete the material and exit 0.
  if (txn.phase === 'rolled-back') {
    const unproven = rollbackOutstanding(txn, expectations);
    if (unproven.length > 0) {
      return { tag: 'blocked', problems: [
        'the manifest says the rollback finished, but the system does not agree:',
        ...unproven,
      ], done: [] };
    }
    return closeOut(txn, []);
  }

  const closeout = planCloseout(txn);
  const problems = [...planRollback(txn), ...(closeout ? [closeout] : [])];
  if (problems.length > 0) return { tag: 'blocked', problems, done: [] };

  const { done, failures } = executeRollback(txn);
  if (failures.length > 0) return { tag: 'partial', problems: failures, done };
  const outstanding = [...verify(), ...rollbackOutstanding(txn, expectations)];
  if (outstanding.length > 0) return { tag: 'partial', problems: outstanding, done };

  // The rollback is provably complete, so record that before consuming
  // anything. Everything after this point is cleanup, and a crash in cleanup
  // resumes from here instead of trying to roll back twice.
  txn.failpoint?.('before-phase');
  txn.phase = 'rolled-back';
  try {
    commitTransaction(txn);
  } catch (error) {
    return { tag: 'partial', problems: [`${txn.dir}: the rollback finished but could not be recorded (${error.message})`], done };
  }
  return closeOut(txn, done);
}

const SETTLE_REASON = {
  blocked: 'the restore could not be started safely',
  partial: 'the restore stopped partway',
  leftover: 'the restore finished but its directory could not be emptied',
};

// Both entry points say the same thing about a leftover, because it is the same
// terminal: the rollback finished, the anchors are back, the pointer is
// deliberately gone, and what remains is a directory whose own record says it is
// spent. Neither may mark the state recovery-required -- that would claim there
// is still business to undo.
function leftoverNotice(settled) {
  return [
    'Everything is restored, but the recovery directory could not be cleaned up:',
    ...settled.problems.map(line => `  ${line}`),
    '',
    `Its ${TXN_SPENT} records that the rollback finished, so nothing is pending.`,
    'Remove the directory by hand once you have dealt with what is in it.',
    '',
  ];
}

// Cleanup, and only cleanup: by the time this runs the rollback is proven done
// and recorded, so nothing here can leave the system half-restored.
//
// The ordering problem underneath: install-state.json is both the pointer that
// makes this transaction findable and one of the two files the rollback has to
// put back. Restoring it destroys the pointer. Meanwhile releasing either anchor
// needs the manifest, because the manifest is the only record of what those
// files held before the install -- so the manifest cannot go first either.
//
// Rather than build a second authority to carry that information across, the
// manifest is never deleted while it is still needed. It is *renamed*. That
// rename is one atomic filesystem operation and it is the only consumption
// point in the whole closeout:
//
//   before it   the transaction is live; recover replays from the manifest
//   after it    the anchors are done and only disposal is left
//
// Nothing moves, so every backup path in the manifest stays valid and every
// operation digest still verifies -- which is why the marker is the manifest's
// name and not the directory's. What remains afterwards is provably spent:
// a directory whose manifest says so.
function closeOut(txn, done, { releaseState = true } = {}) {
  const blocked = planCloseout(txn);
  if (blocked) return { tag: 'blocked', problems: [blocked], done };
  const stopped = (reason, error) => ({ tag: 'partial', problems: [`${reason}: ${error.message}`], done });
  const retained = txn.operations.filter(operation => operation.retain && operation.backup);
  const anchors = anchorPaths(txn.home);
  const stateFile = installStatePath(txn.home);

  if (!txn.spent) {
    // 1. The backups the manifest names, and only those. Enumerating the
    //    directory instead would delete whatever else happened to be in it.
    try {
      for (const operation of txn.operations) {
        if (!operation.backup || !existsSync(operation.backup)) continue;
        // An anchor's copy is what its own release restores from, so it is
        // spent only once that release has happened -- which is later, and
        // which deletes it there.
        if (releaseState && anchors.includes(operation.path)) continue;
        // §4.4 keeps a copy only while its original is NOT back at its own path.
        if (operation.retain && operationState(operation, txn) !== 'undone') continue;
        unlinkSync(operation.backup);
        // Inside the loop, not only around it: an interruption with some copies
        // already gone and others still there is a different situation from one
        // before the first, and it is the one that has to be resumable.
        txn.failpoint?.('during-backups');
      }
    } catch (error) { return stopped(`${txn.dir}: a spent backup could not be removed`, error); }
    txn.failpoint?.('after-backups');

  }

  // 2. The marker, and the point the transaction is consumed. Everything before
  //    it needed the full record and the full authorisation that brainkit.conf
  //    underwrites; everything after it touches nothing but the two anchors and
  //    this directory. Outside the guard above because it is idempotent and a
  //    run resuming from the half-finished state still has to finish it.
  try {
    markSpent(txn);
  } catch (error) {
    // Only a record that is actually there counts as consumed. "Not live" is
    // the complement of a set, and it quietly includes 'none' -- both names
    // gone -- which is the opposite of consumed: it is the record having
    // vanished. Calling that spent left the install state pointing at a
    // transaction with no record at all, which no later run could finish.
    const recovered = manifestState(txn.dir).kind;
    if (recovered === 'spent' || recovered === 'linked') txn.spent = true;
    if (recovered === 'none') {
      // The record is gone but this process still holds it, and it was
      // validated on the way in. Writing it back under the spent name restores
      // the durable authority the retry needs; the run still stops, because
      // something removed a file it had no business removing.
      try {
        txn.failpoint?.('before-rebuild');
        rebuildSpentRecord(txn);
        txn.spent = true;
        return { tag: 'partial', problems: [
          `${join(txn.dir, TXN_MANIFEST)} disappeared before it could be consumed; its record has been written back as ${TXN_SPENT} so this can be finished`,
        ], done };
      } catch (rebuild) {
        return stopped(`${join(txn.dir, TXN_SPENT)} could not be rebuilt after ${TXN_MANIFEST} disappeared`, rebuild);
      }
    }
    return stopped(`${join(txn.dir, TXN_MANIFEST)} could not be marked spent`, error);
  }
  txn.spent = true;
  txn.failpoint?.('after-manifest');

  // 3. The anchors, in reverse order so the state file goes last. Both paths
  //    come from home, never from the record, so a spent manifest cannot widen
  //    what this phase is able to touch. Each release goes through
  //    revertFileOperation, so the pre/post/third-value rules are the same ones
  //    the rollback uses: only a file still holding what this install put there
  //    is restored, anything else is refused rather than overwritten.
  if (releaseState) {
    for (const path of [...anchors].reverse()) {
      if (path === stateFile) continue;
      const released = releaseAnchor(txn, path, done);
      if (released) return released;
    }
    txn.failpoint?.('after-anchors');
    // The state file is the pointer, so releasing it is what ends this
    // transaction's discoverable life. Only disposal follows, and disposal
    // cannot lose anything: what is left is a directory whose own manifest
    // says it is spent.
    const released = releaseAnchor(txn, stateFile, done);
    if (released) return released;
  }
  txn.failpoint?.('after-state');

  const kept = retained.filter(operation => existsSync(operation.backup));
  if (kept.length > 0) {
    // Same rule as the disposal below: exit 0 has to mean the directory holds
    // exactly what this transaction owns, and here that is the originals.
    const strays = unownedEntries(txn);
    if (strays.length > 0) {
      return { tag: 'leftover', problems: [`${txn.dir} still holds ${strays.join(', ')}, which this install did not put there`], done };
    }
    // §4.4: the directory outlives the transaction, holding nothing but the
    // third-party originals this install replaced -- so the spent record goes
    // too, or "nothing but" would not be true.
    try { unlinkSync(join(txn.dir, TXN_SPENT)); }
    catch (error) { if (error.code !== 'ENOENT') return stopped(`${join(txn.dir, TXN_SPENT)} could not be removed`, error); }
    return { tag: 'settled', problems: [], done, retained: join(txn.dir, ADOPTED_DIR) };
  }

  // 5. Disposal. Checked before the proof is destroyed: anything this
  //    transaction does not own means the directory is not disposable, and
  //    saying so while the spent marker is still there leaves a durable record
  //    of what happened. Removing the marker first and then discovering the
  //    directory is not empty would throw away the only thing that explains the
  //    leftover.
  const late = unownedEntries(txn);
  if (late.length > 0) {
    return { tag: 'leftover', problems: [`${txn.dir} still holds ${late.join(', ')}, which this install did not put there`], done };
  }
  // Between the check and the removal. The gap is real -- something can arrive
  // in it -- so it is a seam, which is what lets the re-read below be gated
  // rather than taken on trust.
  txn.failpoint?.('before-rmdir');
  try {
    unlinkSync(join(txn.dir, TXN_SPENT));
    if (retained.length > 0) rmdirSync(join(txn.dir, ADOPTED_DIR));
    rmdirSync(txn.dir);
    return { tag: 'settled', problems: [], done, retained: null };
  } catch (error) {
    // Read the directory again rather than trusting the check above: something
    // can arrive between the two, and the question is what is in there now, at
    // the moment the removal failed.
    // Same question as the check above, asked through the same rule. Filtering
    // by hand here would be a second definition of "ours", and two definitions
    // of the same thing drift -- which is exactly how the container-versus-leaf
    // defect got in.
    const now = unownedEntries(txn);
    if (now.length > 0) {
      // The spent record was removed a moment ago and the directory turns out
      // not to be disposable after all, so put the record back: it is the only
      // thing that says this transaction finished, and a leftover without it is
      // indistinguishable from live recovery material.
      const problems = [`${txn.dir} still holds ${now.join(', ')}: ${error.message}`];
      try { rebuildSpentRecord(txn); }
      catch (rebuild) { problems.push(`${join(txn.dir, TXN_SPENT)} could not be put back: ${rebuild.message}`); }
      return { tag: 'leftover', problems, done };
    }
    // Only reachable with the directory read and found empty, so this really is
    // "empty but unremovable" rather than an assumption about what a failed
    // rmdir usually means.
    return { tag: 'swept', problems: [`${txn.dir}: ${error.message}`], done, retained: null };
  }
}

// Which of the two names the record is under. The consumption is a link
// followed by an unlink, so "both names" is a real intermediate state -- but
// only when they are one file under two names. Two different files is a name
// this transaction does not own, and no amount of it being the expected name
// makes it ours.
function manifestState(dir) {
  const live = markerEntry(join(dir, TXN_MANIFEST));
  const spent = markerEntry(join(dir, TXN_SPENT));
  // A name that exists but is not a regular file is not "no record there". It
  // is something this transaction does not own sitting where its record goes,
  // and merging it into absent is what let a symlink survive the preflight and
  // stop the closeout only after the rollback had run.
  if (live.kind !== 'regular' && live.kind !== 'absent') return { kind: 'invalid', name: TXN_MANIFEST, why: live.kind };
  if (spent.kind !== 'regular' && spent.kind !== 'absent') return { kind: 'invalid', name: TXN_SPENT, why: spent.kind };
  if (live.kind === 'absent' && spent.kind === 'absent') return { kind: 'none' };
  if (spent.kind === 'absent') return { kind: 'live' };
  if (live.kind === 'absent') return { kind: 'spent' };
  if (live.dev === spent.dev && live.ino === spent.ino) return { kind: 'linked' };
  return { kind: 'conflict' };
}

function markerEntry(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return error.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' };
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink' };
  if (stat.isDirectory()) return { kind: 'directory' };
  if (!stat.isFile()) return { kind: 'not-a-regular-file' };
  return { kind: 'regular', dev: stat.dev, ino: stat.ino };
}

// Consume the record by giving it a second name and dropping the first. link(2)
// fails with EEXIST when the target exists, so this can never overwrite
// whatever happens to be sitting at that name -- a plain rename would, and did.
// Both steps are idempotent, so the intermediate state resumes.
function markSpent(txn) {
  const dir = txn.dir;
  const failpoint = txn.failpoint;
  const state = manifestState(dir);
  if (state.kind === 'spent') return;
  // The file under the live name has to still be the file this transaction
  // loaded. Otherwise something replaced it after it was validated, and giving
  // that a second name would adopt a stranger as this transaction's record --
  // consuming a file nobody authorised and destroying the one that was.
  const live = markerEntry(join(dir, TXN_MANIFEST));
  if (live.kind === 'regular' && txn.record?.kind === 'regular'
    && (live.dev !== txn.record.dev || live.ino !== txn.record.ino)) {
    throw new InstallError(
      `${join(dir, TXN_MANIFEST)} is no longer the record this transaction read; refusing to consume it`,
      EXIT.UNSAFE,
    );
  }
  // Not a second opinion about what link decides. link answers "is the target
  // taken"; it cannot answer "is either name a regular file at all", and a
  // symlink or directory at one of them is not this transaction's record to
  // consume. The preflight refuses these too -- this is the same question asked
  // again at the moment of use, because the answer can change in between.
  if (state.kind === 'invalid') {
    throw new InstallError(`${join(dir, state.name)} is a ${state.why}, not this transaction's record`, EXIT.UNSAFE);
  }
  // Every remaining case goes through link, and link is what decides. It
  // succeeds only from `live`; on `conflict` it raises EEXIST because the name
  // is taken by something else, and on `none` ENOENT because there is nothing
  // to consume. Deciding those here instead would be a second opinion about a
  // question the primitive already answers atomically.
  if (state.kind !== 'linked') linkSync(join(dir, TXN_MANIFEST), join(dir, TXN_SPENT));
  // The window where both names exist. It is a real state, not a theoretical
  // one, so it gets a seam like every other boundary.
  failpoint?.('during-mark');
  // The live name is only this transaction's to remove while it is still the
  // same file the spent name now holds. Something can arrive in the window
  // above, and deleting whatever happens to be sitting there would destroy a
  // file nobody authorised -- the same mistake the link half was fixed for.
  const paired = manifestState(dir);
  if (paired.kind === 'spent') return;
  if (paired.kind !== 'linked') {
    throw new InstallError(
      `${join(dir, TXN_MANIFEST)} changed while it was being consumed; refusing to remove it`,
      EXIT.UNSAFE,
    );
  }
  unlinkSync(join(dir, TXN_MANIFEST));
}

// Everything inside the transaction directory that this transaction cannot
// account for. Its own material is the record under whichever name it currently
// has, the backups it declared, and the adopted-shims directory §4.4 keeps.
// Exactly what this transaction may have left in its own directory, by leaf
// rather than by container. Naming the container instead made it a pass for
// anything nested inside it, which is how an unknown file under adopted-shims
// came to be counted as this install's own material.
//
// Deliberately not TXN_MANIFEST: by the time anything asks this question the
// record has been consumed, so the live name still being there is a fact worth
// reporting rather than one to swallow.
function ownedEntries(txn) {
  const owned = new Set([TXN_SPENT]);
  // The container itself, when §4.4 has a reason for it to exist. Its contents
  // are still named leaf by leaf below -- this only says the empty directory is
  // ours, which it has to now that an empty directory is a reportable entry.
  if (txn.operations.some(operation => operation.retain && operation.backup)) owned.add(ADOPTED_DIR);
  for (const operation of txn.operations) {
    if (!operation.backup) continue;
    // The path as remainingEntries reports it: nested copies keep the one
    // level of directory they live under.
    owned.add(relative(txn.dir, operation.backup).split(sep).join('/'));
  }
  return owned;
}

function unownedEntries(txn) {
  const owned = ownedEntries(txn);
  return remainingEntries(txn.dir).filter(name => !owned.has(name));
}

// One anchor, released through the same rules as every other file: undone is a
// no-op, drifted refuses, and only a file still holding this install's own
// output is restored from a backup checked against its digest. Returns a
// terminal verdict when it refuses, null when it is done.
function releaseAnchor(txn, path, done) {
  const operation = txn.operations.find(entry => entry.path === path);
  if (!operation || operation.post === null) return null;
  // The snapshot this run started from is old by now, and releasing an anchor
  // is authorised by it. Both anchors are covered here: brainkit.conf is what
  // authorises the paths, the state file is the pointer itself.
  if (txn.stateSnapshot) {
    const drifted = stateDrift(txn.home, txn.stateSnapshot);
    if (drifted) return { tag: 'blocked', problems: [`${drifted}; refusing to release ${path}`], done };
  }
  let result;
  try { result = revertFileOperation(txn, operation); }
  catch (error) { return { tag: 'partial', problems: [`${path} could not be released: ${error.message}`], done }; }
  if (typeof result === 'string') return { tag: 'partial', problems: [`${result}; refusing to release it`], done };
  if (result) done.push(result.done);
  // Only now is the copy spent: the original is back at its own path. A resumed
  // closeout reaches here with the release already done and still clears it.
  try { if (operation.backup && existsSync(operation.backup)) unlinkSync(operation.backup); }
  catch (error) { return { tag: 'partial', problems: [`${operation.backup} could not be removed: ${error.message}`], done }; }
  return null;
}

// Put the record back under the spent name, without overwriting anything that
// may have arrived at that name. Same no-clobber shape as the marker: write a
// temporary file, link it into place so an occupied name raises EEXIST, drop the
// temporary. Used wherever the record has to be restored from the copy this
// process is holding.
function rebuildSpentRecord(txn) {
  const spent = join(txn.dir, TXN_SPENT);
  const temp = join(txn.dir, `.${TXN_SPENT}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileAtomic(temp, `${JSON.stringify(serialiseTransaction(txn), null, 2)}\n`, 0o600);
  try {
    linkSync(temp, spent);
  } finally {
    try { unlinkSync(temp); } catch { /* nothing to clean up */ }
  }
}

// Everything still inside the transaction directory, one level of nesting deep.
// Used to decide whether a failed rmdir really means "an empty directory nobody
// could remove" -- the only cleanup failure allowed to report success.
function remainingEntries(dir) {
  const walk = directory => {
    let entries;
    try { entries = readdirSync(directory); } catch { return ['<unreadable>']; }
    return entries.flatMap(name => {
      const path = join(directory, name);
      let stat;
      try { stat = lstatSync(path); } catch { return [name]; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return [name];
      const inner = walk(path);
      // An empty directory is still something in here. Reporting nothing for it
      // made a foreign empty directory invisible to the inventory, so a
      // transaction directory containing one was called clean and the rmdir
      // failure that followed was reported as a success.
      return inner.length === 0 ? [name] : inner.map(child => `${name}/${child}`);
    });
  };
  return walk(dir);
}

// The exact permitted contents of adopted-shims/, checked before anything is
// deleted. Bounded by refusing depth rather than by a recursion limit: the only
// legal entries are regular files this manifest names, so a subdirectory is
// itself the anomaly and there is nowhere deeper to look.
function inspectAdoptedDir(txn, retained) {
  const root = join(txn.dir, ADOPTED_DIR);
  if (!existsSync(root)) return null;
  const allowed = new Set(retained.filter(operation => existsSync(operation.backup)).map(operation => basename(operation.backup)));
  let entries;
  try {
    entries = readdirSync(root);
  } catch (error) {
    return `cannot read ${root}: ${error.message}`;
  }
  const unexpected = entries.filter(name => !allowed.has(name));
  if (unexpected.length > 0) {
    return `${root} holds unexpected entries (${unexpected.join(', ')}); manifest kept for inspection`;
  }
  for (const name of entries) {
    const stat = lstatSync(join(root, name));
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return `${root}/${name} is not a regular file; manifest kept for inspection`;
    }
  }
  // A permitted name is not a valid backup. This directory may be kept as the
  // only copy of a third-party file, so what is kept has to still be that file.
  for (const operation of retained) {
    const file = readManagedFile(operation.backup, 'adopted shim backup');
    if (!file) continue;
    const corrupt = backupMismatch(operation, file.content);
    if (corrupt) return `${corrupt}; manifest kept for inspection`;
  }
  return null;
}

// Everything the closeout can decide by looking, and nothing it decides by
// doing. Run before the rollback starts, so a directory that was already
// unusable stops the run while the config a retry would need is still on disk.
function planCloseout(txn) {
  // Nothing is consumed -- not the rollback, not a single unlink -- unless
  // something on disk will still name this transaction afterwards. The install
  // state is that pointer. Without it a crash partway through would leave work
  // no later run could discover, so this refuses here, before the rollback,
  // with every scrap intact.
  const pointer = readInstallState(txn.home);
  if (!pointer) {
    return `${installStatePath(txn.home)} is gone, so nothing would be able to find this transaction again; refusing to touch it`;
  }
  // Existing is not the same as pointing here. A state left by a different
  // install names a different transaction, and consuming this one on the
  // strength of it would leave this transaction's work undiscoverable while
  // touching material the other install still owns.
  if (pointer.last_txn !== txn.id) {
    return `${installStatePath(txn.home)} names transaction ${pointer.last_txn}, not ${txn.id}; refusing to touch it`;
  }
  // Two different files under the record's two names is a state this protocol
  // cannot produce, so one of them belongs to something else. Refused here,
  // before the rollback, because the consumption would otherwise have to decide
  // which one to believe.
  const named = manifestState(txn.dir);
  if (named.kind === 'conflict') {
    return `${txn.dir} holds both ${TXN_MANIFEST} and a different ${TXN_SPENT}; only one of them can be this transaction's record`;
  }
  if (named.kind === 'invalid') {
    return `${join(txn.dir, named.name)} is a ${named.why}, not this transaction's record`;
  }
  const retained = txn.operations.filter(operation => operation.retain && operation.backup);
  const expected = new Set([
    TXN_MANIFEST,
    TXN_SPENT,
    ...txn.operations.filter(operation => operation.backup && !operation.retain).map(operation => basename(operation.backup)),
    ...(retained.length > 0 ? [ADOPTED_DIR] : []),
  ]);
  let entries;
  try {
    entries = readdirSync(txn.dir);
  } catch (error) {
    return `cannot read ${txn.dir}: ${error.message}`;
  }
  const unexpected = entries.filter(entry => !expected.has(entry));
  if (unexpected.length > 0) {
    return `${txn.dir} holds unexpected entries (${unexpected.join(', ')}); manifest kept for inspection`;
  }
  const nested = inspectAdoptedDir(txn, retained);
  if (nested) return nested;
  // Readable and correctly populated is not removable. A transaction directory
  // left read-only before recover started used to let the whole rollback run
  // and fail at the first unlink. Deleting needs write and execute on the
  // containing directory, so that is what gets checked.
  for (const directory of [txn.dir, ...(retained.length > 0 ? [join(txn.dir, ADOPTED_DIR)] : [])]) {
    if (!existsSync(directory)) continue;
    try {
      accessSync(directory, fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      return `${directory} cannot be emptied (no write permission); the transaction cannot be closed out`;
    }
  }
  try {
    accessSync(dirname(txn.dir), fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    return `${dirname(txn.dir)} cannot be modified, so ${txn.dir} cannot be removed`;
  }
  // The anchors are released during the closeout, so their removability is a
  // closeout precondition too. Checking it here is what keeps step 3 from being
  // the step that discovers the config directory is read-only.
  try {
    accessSync(configDir(txn.home), fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    return `${configDir(txn.home)} cannot be modified, so the install state cannot be released`;
  }
  const immutable = immutablePaths([
    txn.dir,
    join(txn.dir, TXN_MANIFEST),
    ...anchorPaths(txn.home),
    ...txn.operations.filter(operation => operation.backup).map(operation => operation.backup),
  ]);
  if (immutable.size > 0) {
    return `${[...immutable].join(', ')}: immutable flag set (chflags nouchg to clear); the transaction cannot be closed out`;
  }
  return null;
}

function ensureVaultSkeleton(vaultRoot, txn) {
  const vaultRows = ARTIFACTS.filter(entry => entry.root === 'vault');
  // A path '' row states that the root is rollback-eligible; it is not a
  // create instruction. The vault root itself is made by applyPlan, and the
  // memory root by the ancestor walk in mkdirTracked.
  for (const entry of vaultRows.filter(row => row.kind === 'dir' && row.path !== '')) {
    mkdirTracked(txn, join(vaultRoot, entry.path), { anchor: vaultRoot, label: `vault path ${entry.path}`, mode: 0o755 });
  }
  const map = vaultRows.find(entry => entry.id === 'project-map');
  const projectMap = join(vaultRoot, map.path);
  if (!projectMapFile(projectMap)) {
    writeManagedFile(txn, projectMap, map.content(), 0o644);
    return;
  }
  // Kept as it was found, and declared as such: an authorised path still on
  // disk after a rollback has to be explained by the manifest, and "it was
  // already here and we left it alone" is one of the explanations.
  observeManagedPath(txn, projectMap, 'project map');
}

function writeConfigFiles(context, answers, vaultRoot, txn, secret) {
  const roots = artifactRoots(context.home, vaultRoot);
  const routingPath = join(roots.config, 'vault-routing.json');
  const memoryDir = join(roots.memory, 'memory');
  const ctx = {
    secret,
    conf: [
      'schema=1',
      `vault=${JSON.stringify(vaultRoot)}`,
      `routing_json=${JSON.stringify(routingPath)}`,
      `memory_dir=${JSON.stringify(memoryDir)}`,
      '',
    ].join('\n'),
  };

  const written = [];
  for (const entry of artifactsFor(answers.components)) {
    // vault side is the skeleton's job; state has its own writer; a path ''
    // row is an authorisation fact, not something to create here.
    if (entry.root === 'vault' || entry.path === '' || !entry.content) continue;
    // Only for components that need it, and only when we hold a key: no empty
    // secret file that later reads as valid configuration (§4.1).
    if (entry.env && !secret) continue;
    const path = artifactPath(roots, entry);
    if (entry.kind === 'dir') {
      mkdirTracked(txn, path, { anchor: context.home, label: `${entry.id} directory` });
      continue;
    }
    mkdirTracked(txn, dirname(path), { anchor: context.home, label: `${entry.id} directory` });
    written.push(writeManagedFile(txn, path, entry.content(ctx), 0o600));
  }
  return written;
}

// --- §5.1 step 6: shims and plists ------------------------------------------

// Written back after the file is on disk, whatever produced it. Every clause is
// one of §6.0's hard constraints, and they are asserted rather than assumed
// because the idempotent branch does not write at all -- the file it accepts is
// one this process never saw being created.
function assertShimContract(entry, path) {
  const file = readNoFollow(path);
  if (file === null) throw new InstallError(`${entry.id} was not written: ${path}`, EXIT.UNSAFE);
  if (file.symlink || !file.stat.isFile()) throw new InstallError(`${entry.id} must be a regular non-symlink file: ${path}`, EXIT.UNSAFE);
  if (file.stat.uid !== process.getuid()) throw new InstallError(`${entry.id} is not owned by this user: ${path}`, EXIT.UNSAFE);
  if ((file.stat.mode & 0o777) !== entry.mode) {
    throw new InstallError(`${entry.id} must be mode ${entry.mode.toString(8).padStart(4, '0')}: ${path}`, EXIT.UNSAFE);
  }
  if (!shimMarker(file.content.toString('utf8'))) throw new InstallError(`${entry.id} carries no brainkit marker: ${path}`, EXIT.UNSAFE);
  return file.content;
}

// §6.2: the shim is executed for real once it is written. A frozen target that
// is wrong, unreadable or too old is exactly the failure the shim exists to
// make loud, and writing it without ever running it would leave that promise
// untested until launchd tried it at 3am.
function verifyNodeShim(context, path) {
  const probe = context.run(path, ['--version']);
  if (probe.error || probe.status !== 0) {
    const detail = probe.error?.message || String(probe.stderr || '').trim() || `exit status ${probe.status}`;
    throw new InstallError(`${path} did not run: ${detail}`, EXIT.UNSAFE);
  }
  const reported = String(probe.stdout || '').trim();
  const major = Number.parseInt(reported.replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new InstallError(`${path} resolves to node ${reported || '<no version>'}; Node >=${MIN_NODE_MAJOR} is required`, EXIT.UNSAFE);
  }
  return reported;
}

function installShims(context, answers, txn) {
  mkdirTracked(null, binDir(context.home), { anchor: context.home, label: 'shim directory', mode: 0o755 });
  const shims = {};
  for (const shim of plannedShims(context, answers)) {
    // Judged again here rather than reusing the preflight verdict: preflight
    // ran before the lock and before the publisher, and the file may have
    // changed since. A stale "safe to overwrite" is the one verdict that must
    // not be cached.
    const verdict = judgeShim({ ...shim, adoptShims: answers.adoptShims, takeover: shim.entry.takeover });
    if (verdict.exit !== EXIT.OK) throw new InstallError(`${shim.path}: ${verdict.reason}`, verdict.exit);
    if (verdict.verdict === 'idempotent' && verdict.mode === shim.entry.mode) {
      // §2.3: byte-identical means no write and no recovery material -- but
      // only when there is genuinely nothing to change, which means content AND
      // mode. Declared as observed even so, because the inventory has to
      // account for every managed path found on disk afterwards.
      observeManagedPath(txn, shim.path, `${shim.entry.id} shim`);
    } else {
      // The machine's existing shims are 0755 (§6.0), so a byte-identical file
      // at the wrong mode still needs changing, and that goes through the same
      // writer as everything else. retain comes from the decision, not from
      // re-reading the verdict string.
      applyManagedWrite(txn, shim.path, shim.pendingContent, shim.entry.mode, { retain: verdict.retain });
    }
    assertShimContract(shim.entry, shim.path);
    const record = { path: shim.path, sha256: verdict.pendingSha256, adopted: verdict.adopted };
    if (shim.templatePath) {
      // §6.3: the wrapper is a byte-for-byte copy, so the two hashes are the
      // same number twice. Recorded twice anyway because doctor compares the
      // installed file against both, and asserted here so a copy that silently
      // diverged never reaches the state file.
      record.template_sha256 = sha256(readFileSync(shim.templatePath));
      if (record.template_sha256 !== record.sha256) {
        throw new InstallError(`${shim.path} does not match ${shim.templatePath} byte for byte`, EXIT.UNSAFE);
      }
    }
    if (shim.id === 'node') record.target = context.nodeTarget;
    shims[shim.id] = record;
  }
  verifyNodeShim(context, join(binDir(context.home), NODE_SHIM_NAME));
  return shims;
}

// §5.4 / §9.3: the file an interpreter reads and executes must be on local
// disk, because /bin/sh is its own responsible process and holds no iCloud
// authorization. WATCH_ROOT is deliberately absent -- N1: it is a data argument
// to fswatch, not a script, and it is allowed under a protected prefix.
const LOCAL_SCRIPT_VARS = new Set(['WATCH_WRAPPER_PATH']);

function plistVariables(context, answers, vaultRoot, service) {
  const node = join(binDir(context.home), NODE_SHIM_NAME);
  const log = join(logsDir(context.home), 'daemon.log');
  const deployed = (...parts) => join(vaultRoot, '00-系统', 'scripts', ...parts);
  if (service === 'clip') return { NODE_PATH: node, CLIP_HANDLER_PATH: deployed('daemon', 'brain-clip-handler.mjs'), LOG_PATH: log };
  if (service === 'observe') return { NODE_PATH: node, OBSERVE_PATH: deployed('cli', 'observe.mjs'), LOG_PATH: log };
  if (service === 'sunday') return { NODE_PATH: node, SUNDAY_PATH: deployed('cli', 'brain-sunday.mjs'), LOG_PATH: log };
  const fswatch = lookupExecutable('fswatch', context.pathEnv);
  if (!fswatch) throw new InstallError('fswatch is no longer on PATH; the watch service cannot be rendered', EXIT.ACTIONABLE);
  return {
    WATCH_WRAPPER_PATH: join(binDir(context.home), WRAPPER_SHIM_NAME),
    FSWATCH_PATH: fswatch,
    WATCH_ROOT: answers.watchRoot,
    NODE_PATH: node,
    WATCH_HANDLER_PATH: deployed('daemon', 'brain-watch-handler.mjs'),
    LOG_PATH: log,
  };
}

function assertPlistContract(entry, path, service) {
  const file = readManagedFile(path, `${service} plist`);
  if (!file) throw new InstallError(`${service} plist was not written: ${path}`, EXIT.UNSAFE);
  if ((file.stat.mode & 0o777) !== entry.mode) throw new InstallError(`${service} plist must be mode 0600: ${path}`, EXIT.UNSAFE);
  const text = file.content.toString('utf8');
  if (!text.includes(`<string>com.second-brain.${service}</string>`)) {
    throw new InstallError(`${service} plist does not carry its own label: ${path}`, EXIT.UNSAFE);
  }
  // §5.4 and §9.2: no EnvironmentVariables block at all, so there is no place
  // for a vault path or a provider key to end up in a world-readable-ish file.
  if (text.includes('EnvironmentVariables')) {
    throw new InstallError(`${service} plist declares EnvironmentVariables, which brainkit never writes: ${path}`, EXIT.UNSAFE);
  }
}

function installPlists(context, answers, vaultRoot, txn) {
  const plists = { clip: null, observe: null, sunday: null, watch: null };
  const rows = ARTIFACTS.filter(entry => entry.service && answers.components.includes(entry.service));
  if (rows.length === 0) return plists;
  // Both are infrastructure: created untracked, never rolled back. The log
  // directory has to exist before rendering because canonicalPath resolves each
  // variable's parent, and LOG_PATH's parent is this directory.
  mkdirTracked(null, logsDir(context.home), { anchor: context.home, label: 'service log directory', mode: 0o755 });
  mkdirTracked(null, launchAgentsDir(context.home), { anchor: context.home, label: 'LaunchAgents directory', mode: 0o755 });
  const roots = artifactRoots(context.home, vaultRoot);
  for (const entry of rows) {
    const path = artifactPath(roots, entry);
    const label = `com.second-brain.${entry.service}`;
    // Read the label's pre-install state before touching its plist, and record
    // it in the transaction. Without this the rollback restores the old plist
    // and leaves the service that was running off -- the file layer back where
    // it started and the service layer not.
    const before = readService(txn.launchctl, label);
    if (before.loaded && !samePlist(before.plist, path)) {
      throw new InstallError(
        `${label} is already loaded from ${before.plist ?? '<unknown path>'}, not ${path}; `
        + 'brainkit will not take over a service it did not install',
        EXIT.UNSAFE,
      );
    }
    // A running job whose plist is not on disk cannot be put back: the rollback
    // would delete what we write and have nothing to bootstrap from. The reader
    // refuses that pairing, so the producer must refuse to create it -- the two
    // used to disagree, and the installer could write a manifest its own reader
    // would then reject.
    if (before.loaded && !readManagedFile(path, `${label} plist`)) {
      throw new InstallError(
        `${label} is running but ${path} is not on disk, so an interrupted install could not put it back; `
        + 'resolve the service by hand before installing',
        EXIT.UNSAFE,
      );
    }
    const variables = plistVariables(context, answers, vaultRoot, entry.service);
    for (const name of Object.keys(variables)) {
      if (!LOCAL_SCRIPT_VARS.has(name)) continue;
      if (!containedBy(variables[name], binDir(context.home))) {
        throw new InstallError(`${entry.service} plist would have an interpreter read ${name} from outside the shim directory: ${variables[name]}`, EXIT.UNSAFE);
      }
    }
    // Rendered and linted inside the transaction directory first, then placed
    // by the same writer as every other managed file. renderPlist does its own
    // temp-write-lint-rename, which would put the file on disk before anything
    // was declared; running it on a scratch path keeps plutil's verdict and
    // hands the resulting bytes to the one writer that records what it does.
    const scratch = join(txn.dir, `render-${entry.service}.plist`);
    let rendered;
    try {
      renderPlist({
        templatePath: join(context.repoRoot, 'templates', `com.second-brain.${entry.service}.plist.template`),
        outputPath: scratch,
        variables,
      });
      rendered = readFileSync(scratch);
    } finally {
      try { unlinkSync(scratch); } catch { /* never created */ }
    }
    // The pre-state and the plist's own entry are handed over together, so one
    // manifest write records both. The plist path is normalised to the literal
    // spelling so the manifest keeps one.
    applyManagedWrite(txn, path, rendered, entry.mode, {
      service: { label, loaded: before.loaded, plist: before.loaded ? path : null },
    });
    assertPlistContract(entry, path, entry.service);
    // The hash is recorded for the same reason the shims' is: uninstall has to
    // be able to prove the file it is about to delete is still the one this
    // install wrote. The contract alone cannot -- it passes any file with our
    // label and mode, including one whose ProgramArguments the user rewrote.
    plists[entry.service] = { path, sha256: sha256(rendered) };
  }
  return plists;
}

// §5.1 step 7. bootout first so a re-run replaces a running job rather than
// racing it, then bootstrap through the retry primitive because the two
// operations collide for 2-4 seconds on a KeepAlive job (§6.4).
// `only` is §8.1 step 8: an upgrade restarts what it found running and nothing
// else. A service the user had stopped stays stopped, and its plist is still
// rewritten -- the file layer is brought up to date either way, it is the
// bootstrap that is withheld. Install passes no set and mounts everything.
function mountServices(context, plists, { only = null } = {}) {
  const launchctl = launchctlHandle(context);
  const domain = serviceDomain();
  const mounted = [];
  for (const [service, entry] of Object.entries(plists)) {
    const path = entry?.path;
    if (!path) continue;
    const label = `com.second-brain.${service}`;
    if (only && !only.has(label)) continue;
    const problem = bootoutService(launchctl, label);
    if (problem) throw new InstallError(`cannot replace the running ${label}: ${problem}`, EXIT.ACTIONABLE);
    runLaunchctlRetrying(launchctl, ['bootstrap', domain, path]);
    // The same reader the recovery path uses: the `path = ...` line, compared
    // canonically. This used to ask whether the plist path appeared anywhere in
    // the output, which any environment variable or program argument holding
    // that string would satisfy -- while the comment claimed it proved the job
    // came from that file. The strict version was already in this file.
    const loaded = serviceLoadedFrom(launchctl, label);
    if (loaded === null) {
      throw new InstallError(`${label} was bootstrapped but launchd does not report it loaded`, EXIT.ACTIONABLE);
    }
    if (!samePlist(loaded, path)) {
      throw new InstallError(`${label} is loaded from ${loaded}, not the ${path} just written`, EXIT.UNSAFE);
    }
    mounted.push(label);
  }
  return mounted;
}

function manifestPath(vaultRoot) {
  return join(vaultRoot, '00-系统', '.index-cache', 'publish-manifest.json');
}

// §5.2. A and B both bootstrap; C is "manifest exists but no install state",
// which publish.mjs:1377 refuses to bootstrap over, so it skips straight to
// --check. A corrupt manifest is a hard stop, never a silent re-bootstrap.
function bootstrapBranch(vaultRoot, vaultMode) {
  const path = manifestPath(vaultRoot);
  const file = readManagedFile(path, 'publish manifest');
  if (!file) return { branch: vaultMode === 'new' ? 'A' : 'B', bootstrap: true };
  try {
    JSON.parse(file.content.toString('utf8'));
  } catch (error) {
    throw new InstallError(`publish manifest at ${path} is unreadable (${error.message}); resolve it manually before installing`, EXIT.UNSAFE);
  }
  return { branch: 'C', bootstrap: false };
}

// Allowlist, not a blocklist: the publisher needs a shell PATH, a HOME for git,
// a TMPDIR for its backup directory and locale/TZ for formatting. Copying the
// parent env minus a few keys forwarded whatever else happened to be exported,
// including provider API keys the publisher has no use for. Deleting the known
// override keys as well keeps the pointer honest even if one is allowlisted
// later by mistake (§4.1).
const PUBLISHER_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME'];

function publisherEnv(env) {
  const allowed = {};
  for (const key of PUBLISHER_ENV_KEYS) {
    if (key === 'BRAIN_VAULT_ROOT' || key === 'NODE_ENV' || key.startsWith('BRAIN_PUBLISH_')) continue;
    if (env[key] !== undefined) allowed[key] = env[key];
  }
  return allowed;
}

function runPublisher(context, args) {
  return context.run(context.execPath, [join(context.repoRoot, 'scripts', 'publish.mjs'), ...args], {
    cwd: context.repoRoot,
    env: publisherEnv(context.env),
  });
}

function publisherRecords(result) {
  return String(result.stdout || '').trim().split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// A spawn that died on a signal, could not start, or returned a status outside
// the documented set is an anomaly, not a verdict: stdout from such a run may
// be truncated or stale, so it is never parsed for a decision.
function assertPublisherStatus(result, allowed, label) {
  if (result.error) throw new InstallError(`${label} could not run: ${result.error.message}`, EXIT.UNSAFE);
  if (result.signal) throw new InstallError(`${label} was killed by ${result.signal}`, EXIT.UNSAFE);
  if (!allowed.includes(result.status)) {
    throw new InstallError(`${label} exited ${result.status}: ${String(result.stderr || '').trim() || 'no stderr'}`, EXIT.UNSAFE);
  }
}

const CHECK_NEEDS_CONFIRMATION = new Set(['repo-ahead', 'repo-new', 'same-change']);

// §5.2: the target list is shown, and then confirmed. Interactively that is a
// question; under --non-interactive there is nobody to ask, so it is --yes or
// nothing. Either form returns normally to proceed and throws to refuse, which
// keeps the wording of the refusal with whichever one did the asking.
function flagTargetConfirmation(options) {
  return state => {
    if (options.yes) return;
    throw new InstallError(`publish --check reports ${state}; re-run with --yes to accept these target changes`);
  };
}

function publishStep(context, branchInfo, requireTargetConfirmation, onCommitted = () => {}) {
  if (branchInfo.bootstrap) {
    const bootstrap = runPublisher(context, ['--bootstrap']);
    // 0 and 1 only: §5.2 branch A reports every target as repo-new and exits 1
    // by design, so 1 is a success here. 2 is a reject state and 3/127/signal
    // mean the publisher never got to make a judgement.
    assertPublisherStatus(bootstrap, [0, 1], 'publish --bootstrap');
  }
  // N-e: step 5 always re-runs --check rather than reusing step 4's result.
  const check = runPublisher(context, ['--check']);
  assertPublisherStatus(check, [0, 1, 2], 'publish --check');
  const records = publisherRecords(check);
  const summary = records.find(record => record.type === 'summary');
  if (!summary) {
    throw new InstallError(`publish --check produced no summary: ${String(check.stderr || '').trim()}`, EXIT.UNSAFE);
  }
  // The summary carries its own exitCode; if it disagrees with the process's,
  // the stdout does not belong to this run and must not drive the decision.
  if (summary.exitCode !== check.status) {
    throw new InstallError(`publish --check exited ${check.status} but its summary claims ${summary.exitCode}; refusing to act on it`, EXIT.UNSAFE);
  }
  if (summary.state !== 'clean' && !CHECK_NEEDS_CONFIRMATION.has(summary.state)) {
    throw new InstallError(`publish --check reports ${summary.state}; resolve it manually (installer does not auto-repair)`, EXIT.UNSAFE);
  }
  if (CHECK_NEEDS_CONFIRMATION.has(summary.state)) {
    // §5.2 wants the target paths and their hash states, not just a tally.
    context.stdout(`  publisher will change ${records.filter(r => r.type !== 'summary').length} vault target(s) (${summary.state}):\n`);
    for (const record of records.filter(r => r.type !== 'summary' && r.state !== 'clean')) {
      context.stdout(`      ${record.state.padEnd(14)} ${record.target ?? record.source ?? '<unknown>'}\n`);
    }
    requireTargetConfirmation(summary.state);
  }
  const published = runPublisher(context, []);
  // §8.1 step 7 keeps the publisher's backup directory until acceptance is
  // over, because step 9's `publish --recover` needs it. Read BEFORE the exit
  // code is judged, and reported through the callback rather than the return
  // value, because the two questions are independent: publish.mjs writes the
  // manifest, restores services and prints its committed receipt, and only
  // then decides whether to exit 0 or 2. Judging the status first meant a
  // publisher that had already changed the vault and then exited 2 was
  // reported as never having published, and its backup was never recovered.
  //
  // The receipt is the authority for "was the vault changed"; the exit code is
  // the authority for "did it succeed". A backup directory is only usable if
  // it is an absolute path, so anything else is treated as no receipt at all.
  const receipt = publisherBackupDir(published);
  if (receipt) onCommitted(receipt);
  assertPublisherStatus(published, [0], 'publish');
  return { state: summary.state, backupDir: receipt };
}

// Both shapes the publisher reports a usable backup directory in: the
// committed-transaction line on stdout, and -- when it failed with material
// worth keeping -- its error record on stderr. Absent means "no backup", which
// is not the same as "nothing was changed"; the caller decides what to do with
// that, but it must not be handed a path it cannot recover from.
function publisherBackupDir(result) {
  const stdout = publisherRecords(result)
    .find(entry => entry.type === 'transaction' && entry.status === 'committed');
  const stderr = String(result.stderr || '').trim().split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).find(entry => entry?.type === 'error' && entry.backupDir);
  const dir = stdout?.backupDir ?? stderr?.backupDir ?? null;
  return typeof dir === 'string' && isAbsolute(dir) ? dir : null;
}

// Built in one place because both the `installing` record and the
// `recovery-required` one carry the same fields; assembling them separately is
// how the two paths drifted before.
function installStateRecord(context, answers, report, vaultRoot, txn, { status, managed = [], shims = {}, plists = null }) {
  return {
    schema: 1,
    status,
    repo_root: context.repoRoot,
    vault_root: vaultRoot,
    installed_commit: null,
    components: answers.components,
    watch_root: answers.watchRoot,
    plists: plists ?? { clip: null, observe: null, sunday: null, watch: null },
    // §4.4 gives shims and plists their own fields, so they are deliberately
    // not mirrored into managed_files: one fact, one place.
    shims,
    artifacts: {},
    // N-a: installer-owned files only. Vault deploy targets belong to
    // publish-manifest.json and are deliberately not mirrored here.
    managed_files: managed.map(path => ({ path, sha256: sha256(readFileSync(path)) })),
    tcc_warning: report.tcc,
    last_txn: txn.id,
    // The same requiredness facts the manifest carries in its own plan, kept in
    // a second file so neither one can quietly rewrite history on its own. See
    // requirednessAgrees for what this does and does not defend against.
    plan_digest: planDigest(txn.plan),
  };
}

// requireTargetConfirmation defaults to the flag form, so a caller that has no
// way to ask -- every test that drives applyPlan directly, and the
// --non-interactive path -- behaves exactly as it did.
function applyPlan(context, answers, report, options, secret, requireTargetConfirmation = flagTargetConfirmation(options)) {
  const home = context.home;
  const vaultRoot = report.vaultCanonical;
  // Both the config directory and the lock are created here rather than inside
  // the try: everything from acquireLock onwards has to be unwound, and a
  // failure in beginTransaction used to skip the finally and strand the lock.
  mkdirTracked(null, configDir(home), { anchor: home, label: 'config directory' });
  let lock = null;
  let txn = null;
  try {
    lock = acquireLock(home);
    txn = beginTransaction(home, {
      launchctl: launchctlHandle(context),
      // The authorised set the commit primitive validates against is the same
      // one recover will use, so the writer cannot publish a record its own
      // reader would refuse.
      shapes: managedShapes(home, vaultRoot, answers.components),
      onRecord: context.onManifest,
      failpoint: context.failpoint,
    });
    // The first managed operation this transaction performs -- including ahead
    // of the vault root, which used to go first and left a manifest declaring a
    // vault-root operation, quite possibly a created directory, with nothing on
    // disk pointing at either.
    //
    // Not the first thing written, though: beginTransaction has already created
    // the recovery directory and committed transaction.json. So a window does
    // still exist between those two, and it looks like a manifest with no state.
    // What closes it is the lock, not the ordering: recover takes the lock
    // before it reads anything, finds this install's lock held by a live
    // process, and says so instead of calling the transaction an orphan.
    // status stays `installing` for the whole slice: the final verification and
    // the doctor pass are later steps, so claiming `installed` here would be a
    // lie the P1-4 gate would then happily let a second run stack writes on.
    writeInstallState(home, installStateRecord(context, answers, report, vaultRoot, txn, { status: 'installing' }), txn);
    if (answers.vaultMode === 'new') mkdirTracked(txn, vaultRoot, { anchor: dirname(vaultRoot), label: 'vault root', mode: 0o755 });
    const managed = writeConfigFiles(context, answers, vaultRoot, txn, secret);
    writeInstallState(home, installStateRecord(context, answers, report, vaultRoot, txn, { status: 'installing', managed }), txn);

    ensureVaultSkeleton(vaultRoot, txn);
    const branchInfo = bootstrapBranch(vaultRoot, answers.vaultMode);
    context.stdout(`  bootstrap branch ${branchInfo.branch} (${branchInfo.bootstrap ? 'runs --bootstrap' : 'skips --bootstrap, manifest already present'})\n`);
    const { state } = publishStep(context, branchInfo, requireTargetConfirmation);

    // §5.1 step 6, then step 7. Files first and services last, in the order the
    // rollback undoes them backwards: nothing is mounted before the file it
    // points at exists and has been checked.
    const shims = installShims(context, answers, txn);
    const plists = installPlists(context, answers, vaultRoot, txn);
    const mounted = mountServices(context, plists);
    writeInstallState(home, installStateRecord(context, answers, report, vaultRoot, txn, { status: 'installing', managed, shims, plists }), txn);

    // §4.4 discards a transaction that only held temp material once the install
    // is *complete*. This slice ends at `installing`, so the transaction is not
    // spent yet: it is the only record of what to undo, and `recover` reads it
    // back from disk. Discarding here would delete the rescue path B-4 adds.
    // The discard belongs at the point status becomes `installed` (slice 6).
    return { branch: branchInfo.branch, checkState: state, txn, recoveryKept: true, shims, plists, mounted };
  } catch (error) {
    if (!txn) throw error;
    // Anything short of `settled` leaves material behind, so it goes through
    // the same terminal handling recover uses: state marked recovery-required
    // and pointing at the transaction, exit 3.
    const settled = settleTransaction(txn, () => [], { declared: declaredArtifacts(readInstallState(home)) });
    // A leftover means the rollback finished and the anchors are back; only the
    // directory could not be emptied. Marking the state recovery-required here
    // would claim there is still business to undo and would put back a pointer
    // the closeout deliberately released. Same terminal as recover's, so it is
    // reported the same way.
    if (settled.tag === 'leftover') {
      context.stdout(`${leftoverNotice(settled).join('\n')}\n`);
      throw new InstallError(`${error.message} (${SETTLE_REASON.leftover})`, EXIT.RECOVERY);
    }
    if (settled.tag !== 'settled' && settled.tag !== 'swept') {
      recoveryRequired(context, installStateRecord(context, answers, report, vaultRoot, txn, { status: 'recovery-required' }), txn, settled);
      throw new InstallError(`${error.message} (${SETTLE_REASON[settled.tag]})`, EXIT.RECOVERY);
    }
    throw error;
  } finally {
    if (lock) { try { unlinkSync(lock); } catch { /* already gone */ } }
  }
}

// B-4: the minimum self-rescue that keeps `installing` from being a dead end.
// Full recovery semantics (upgrade/uninstall interplay, service restore) are
// slice 7; this only has to undo what slice 3 writes.
// Recovery is the last line of defence, so it fails in the opposite direction
// to everything else: an ordinary operation rolls back on failure, but a failed
// recovery must keep every scrap of material and hand the problem to a human.
// Nothing is deleted until the restore has fully succeeded.
// Diagnosis, not repair. `recover` reads what is on disk, works out what state
// the machine is in, and prints what to do about it. It does not delete, write,
// rename, unlink or unload anything.
//
// It used to do the repair itself, and four rounds of review found the same
// class of defect each time: the state file that says which transaction to undo
// is itself one of the files being undone, so every check of "is this still the
// install I decided to act on" raced the actions taken on the strength of it.
// The rollback that runs inside a failed install does not have that problem --
// it never left the process that wrote the state -- so that path still repairs.
// This one only reports, which is a floor that cannot lose data.
//
// Nothing is locked, because nothing is written. A live installer is still worth
// noticing, so the lock file is read rather than taken: an exclusive lock here
// would fail on a machine that has no config directory at all and turn "nothing
// to recover" into "an install seems to be running".
// An interrupted upgrade is not an interrupted install, and the difference is
// not cosmetic: the machine was already installed, install-state is the record
// of that working installation, and the install wording tells the user to
// delete it and start over. Following that advice on an upgrade throws away
// the only description of what is on the machine. §14 A2 flagged that recover
// had only been proven against `installing`; this is that gap.
// §8.2 batch 1: decide what uninstall would remove and what it would keep, and
// write nothing. Not even the lock -- taking it creates a file, and "zero disk
// change" has to survive being read literally.
//
// Completeness is by construction rather than by a hand-kept list: every row
// comes from installedProducts -- the single enumeration the rollback also
// derives from -- plus the state file. delete + keep is therefore exactly what
// the state claims, and a class of product that stops being enumerated leaves
// both lists at once instead of quietly becoming undeletable.
//
// Deletion authority is bound to three things at once, because an independent
// review found each of them being replaced by something adjacent to it:
//   * the RECORD must exist and carry a content baseline -- a path with no
//     recorded hash is never deletable (artifacts.clip_helper has no producer
//     at all, so the clip helper is always kept);
//   * the CONTENT at that path must still match that baseline -- byte for
//     byte. assertPlistContract is not consulted here at all: it passes any
//     file carrying our label at our mode, including one whose
//     ProgramArguments the user rewrote, so it cannot narrow what the hash
//     already decides and keeping it would only suggest it were adding
//     something. Plists are judged the way shims and config are;
//   * the LOCATION must be one this installer creates -- state is an editable
//     file, so a path it names is a claim, not a licence. Every row is checked
//     against managedShapes, the same "location is what confers ownership"
//     model recovery already uses.
// A row failing any of the three is kept with the reason, never deleted.
function uninstallPlan(context, state, options = {}) {
  const home = context.home;
  const rows = [];
  // `policy` marks a keep that is a decision rather than a problem -- config
  // left alone because --purge-config was not given. Everything else that is
  // kept is drift, and drift has to reach the exit code (§8.2 step 3).
  const keep = (path, why, kind, policy = false) => rows.push({ path, kind, action: 'keep', why, policy });
  const drop = (path, kind) => rows.push({ path, kind, action: 'delete', why: null, policy: false });

  // The vault root is only trusted when brainkit.conf corroborates it, which is
  // what verifiedVaultRoot exists for; an uncorroborated one contributes no
  // shape and its rows are refused rather than authorised on the state's word.
  const shapes = managedShapes(home, verifiedVaultRoot(home, state.vault_root), state.components);
  const authorised = path => shapeOf(path, shapes, 'files');

  for (const product of installedProducts(state)) {
    const { path, kind, id, record } = product;
    if (!authorised(path)) {
      keep(path, 'this path is not one the installer creates, whatever the state records', kind);
      continue;
    }
    if (kind === 'plist' || kind === 'shim' || kind === 'config') {
      if (kind === 'config' && !options.purgeConfig) {
        keep(path, 'configuration is kept unless --purge-config is given', kind, true);
        continue;
      }
      if (typeof record?.sha256 !== 'string') {
        keep(path, `${id} has no recorded content baseline to verify against`, kind);
        continue;
      }
      const file = readNoFollow(path);
      if (!file || file.symlink || !file.stat.isFile()) { keep(path, `${id} is not a regular file any more`, kind); continue; }
      // marker AND hash for shims: a marker with the wrong bytes is some other
      // brainkit's file, and the right bytes with the marker stripped is
      // somebody having edited it on purpose.
      if (kind === 'shim' && !shimMarker(file.content.toString('utf8'))) {
        keep(path, `${id} shim no longer carries the brainkit marker`, kind);
        continue;
      }
      if (sha256(file.content) !== record.sha256) {
        keep(path, `${id} has been modified since this install wrote it`, kind);
        continue;
      }
      drop(path, kind);
      continue;
    }
    keep(path, `${id} has no recorded baseline to verify against`, kind);
  }

  // §8.2 step 9. Only plists this run is actually going to delete may name a
  // log: a plist already judged foreign or drifted is not a source of authority
  // for anything. The paths are confined to the log directory the installer
  // creates, and deduplicated because the real templates point several services
  // at one daemon.log.
  //
  // Deduplication alone was half the fix. Both halves are the same defect --
  // a delete row whose unlink cannot succeed, reported afterwards as a partial
  // failure -- and the second half is commoner than the first: a service that
  // never ran has a plist naming a log that was never created, so an otherwise
  // clean uninstall exited 2. Absence is not drift, so the row is a keep the
  // exit code ignores; it is still a row, because a path that quietly leaves
  // the enumeration is one nobody can account for afterwards.
  if (options.purgeLogs) {
    const logs = logsDir(home);
    const targets = new Set(rows
      .filter(row => row.kind === 'plist' && row.action === 'delete')
      .flatMap(row => plistLogTargets(row.path))
      .filter(path => realDescendant(path, logs)));
    for (const path of targets) {
      if (existsSync(path)) drop(path, 'log');
      else keep(path, 'declared by a plist, but the service never created it', 'log', true);
    }
  }

  // The state file is a product and goes. The lock is not -- it is a transient
  // this run does not even hold, so listing it either way would be noise.
  drop(installStatePath(home), 'state');
  return rows;
}

// The Std{Out,Err}Path values a plist actually declares. Derived rather than
// assumed: §8.2 step 9 grants deletion only over paths the installer can point
// at in its own plist, and ~/Library/Logs/second-brain holds files this
// installer never wrote.
function plistLogTargets(path) {
  const file = readManagedFile(path, 'plist');
  if (!file) return [];
  const text = file.content.toString('utf8');
  const found = [];
  for (const key of ['StandardOutPath', 'StandardErrorPath']) {
    const match = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
    if (match && isAbsolute(match[1])) found.push(match[1]);
  }
  return [...new Set(found)];
}

function recoverSubject(status, { haveManifest = true } = {}) {
  if (status === 'upgrading') {
    return {
      what: 'An upgrade',
      noun: 'the upgrade',
      finish: home => (haveManifest
        ? [
          `  2. Put ${tildify(installStatePath(home), home)} back to its pre-upgrade record`,
          '     using the  restore  line above -- that copy IS the record, including the',
          '     last_txn and plan_digest fields, which the upgrade rewrote along with the status.',
          // Without this step the advice is a loop: upgrade refuses to run at
          // any status but `installed`, so "just run upgrade again" sends the
          // user straight back to recover.
          '     This step is not optional -- upgrade refuses to run while the status is',
          '     `upgrading`, so skipping it means recover and upgrade send you to each other.',
          '  3. Run  node install.mjs upgrade  again once you are satisfied.',
        ]
        : [
          // Hand-editing only the status used to be the advice here. It is
          // wrong: the claim rewrote last_txn and plan_digest too, so the file
          // now points at a record that no longer exists. Flipping the status
          // back would dress an unprovable half-upgrade up as a machine that
          // is ready to be upgraded again.
          '  2. This is not automatically recoverable. The state file names a transaction',
          '     whose record is gone, so nothing can say what the upgrade changed, and its',
          '     last_txn and plan_digest fields describe that missing record rather than',
          '     this machine. Do NOT just set the status back and re-run.',
          '  3. Establish what is actually on the machine first:  node install.mjs doctor',
          `     and compare ${tildify(binDir(home), home)} and the LaunchAgents against what`,
          '     you expect. Keep the state file either way -- it is the only record there is.',
          '  4. Ask before going further. There is no safe automatic next step from here.',
        ]),
    };
  }
  return {
    what: 'An install',
    noun: 'the install',
    finish: home => [
      `  2. Remove ${tildify(installStatePath(home), home)} once you are satisfied.`,
      '  3. Run  node install.mjs install  again.',
    ],
  };
}

function recoverInstall(context) {
  const home = context.home;
  const holder = lockHolder(home);
  if (holder.alive) {
    context.stdout([
      `An install is running now (pid ${holder.pid}).`,
      'Nothing was inspected. Wait for it to finish, then run  node install.mjs recover  again',
      'if you still think something is wrong.',
      '',
    ].join('\n'));
    return EXIT.ACTIONABLE;
  }

  const state = readInstallState(home);
  const stranded = orphanTransactions(home, state?.last_txn ?? null);
  if (!state) {
    context.stdout([
      'No install state; there is no half-finished install to undo.',
      ...(stranded.length > 0 ? [
        '',
        `${stranded.length} recovery transaction(s) remain in ${tildify(join(configDir(home), 'recovery'), home)}:`,
        ...stranded.map(id => `  ${id}`),
        'They belong to no current install. Nothing here can prove they are spent,',
        'so they are left alone -- remove them by hand once you are satisfied.',
      ] : []),
      '',
    ].join('\n'));
    return EXIT.OK;
  }
  if (state.status === 'installed') {
    throw new InstallError('brainkit is fully installed; use  node install.mjs uninstall  instead of recover');
  }

  const recovery = tildify(join(configDir(home), 'recovery'), home);
  const txn = loadTransaction(home, state.last_txn, state.vault_root, state.components, state.plan_digest);
  const subject = recoverSubject(state.status, { haveManifest: Boolean(txn) });
  if (!txn) {
    context.stdout([
      `${subject.what} stopped partway (status=${state.status}) and its record is missing.`,
      `Install state names transaction ${state.last_txn}, but there is no manifest for it in ${recovery}.`,
      '',
      `Without that record nothing can say what ${subject.noun} changed, so nothing here will guess.`,
      'What is on disk has been left exactly as it is.',
      '',
      `  1. Look through ${recovery} and keep anything you recognise.`,
      ...subject.finish(home),
      '',
    ].join('\n'));
    return EXIT.RECOVERY;
  }

  // What the manifest recorded is what the install meant to do. What has to be
  // put back is what is still that way now -- a failed install may already have
  // undone some of it, and a file it merely observed was never changed at all.
  // Grouping by the record's own fields said otherwise on both counts: it called
  // an untouched file "replaced" and pointed at a backup that does not exist.
  const rolledBack = txn.phase === 'rolled-back';
  const outstanding = txn.operations.filter(operation => operation.kind === 'file'
    && operation.post !== null
    && operationState(operation, txn) === 'installed');
  const restorable = outstanding.filter(operation => operation.pre !== null);
  // An upgrade runs on a machine that is already installed, so its install
  // state is never something to delete -- whatever a transaction's record
  // says. A record that claims to have created that file disagrees with the
  // status, and the safe reading of a disagreement is to keep the file and say
  // the two do not match, not to print a delete line for the only description
  // of what is on this machine. The classification is by `pre === null`, which
  // is right for an install and cannot be right here.
  const stateFile = installStatePath(home);
  const inconsistent = state.status === 'upgrading'
    && outstanding.some(operation => operation.pre === null && operation.path === stateFile);
  const removable = outstanding.filter(operation => operation.pre === null
    && !(state.status === 'upgrading' && operation.path === stateFile));
  // Every label this transaction touched, asked of launchd now. The record's
  // `loaded` flag says whether the service was running *before* the install, so
  // filtering on it reported the ones the install did not start and hid every
  // one it did -- exactly backwards, and the dangerous direction.
  const launchctl = launchctlHandle(context);
  const running = [...new Set(txn.services.map(entry => entry.label))]
    .filter(label => serviceLoadedFrom(launchctl, label) !== null);
  context.stdout([
    `${subject.what} stopped partway (status=${state.status}).`,
    ...(inconsistent ? [
      `Its record says it created ${tildify(stateFile, home)}, which an upgrade cannot have`,
      'done -- this machine was already installed. The two disagree, so the file is left',
      'alone and is not listed below. Treat the record as the untrustworthy one.',
      '',
    ] : []),
    rolledBack && outstanding.length + running.length === 0
      ? `Transaction ${state.last_txn} had already finished undoing itself; only its own cleanup was left.`
      : `Transaction ${state.last_txn} recorded ${txn.operations.length} change(s); ${outstanding.length + running.length} of them are still in place.`,
    '',
    // `rolledBack` used to hide this list outright. It should not: a manifest
    // that finished rolling back can still be waiting on the anchor release,
    // and the state file is one of the anchors -- exactly the thing an
    // interrupted upgrade needs put back, and the thing "only cleanup was
    // left" talked the user out of looking for.
    ...(outstanding.length + running.length === 0 ? [] : [
      'Still in place, and what putting each one back means:',
      ...removable.map(operation => `  delete   ${tildify(operation.path, home)}`),
      ...restorable.map(operation => `  restore  ${tildify(operation.path, home)}`
        + `\n           from ${tildify(operation.backup, home)}`),
      ...running.map(label => `  unload   ${label}   launchctl bootout ${serviceDomain()}/${label}`),
      '',
    ]),
    'The exact list, with the original contents of everything it replaced, is in:',
    `  ${recovery}/${state.last_txn}`,
    '',
    'Nothing has been changed. Work through that directory by hand, then:',
    ...subject.finish(home),
    ...(stranded.length > 0 ? [
      '',
      `${stranded.length} older recovery transaction(s) are also in ${recovery}; they belong to no current install.`,
    ] : []),
    '',
  ].join('\n'));
  return EXIT.RECOVERY;
}

// Who holds the installer lock, without taking it. Reading is enough to tell a
// running install from a stale file, and taking an exclusive lock in a
// read-only command would fail on a machine that has no config directory yet.
function lockHolder(home) {
  const found = readNoFollow(lockPath(home));
  if (found === null || found.symlink || !found.stat.isFile()) return { alive: false, pid: null };
  const pid = Number.parseInt(found.content.toString('utf8').trim(), 10);
  if (!Number.isFinite(pid)) return { alive: false, pid: null };
  try {
    process.kill(pid, 0);
    return { alive: true, pid };
  } catch (error) {
    return { alive: error.code !== 'ESRCH', pid };
  }
}

// Keeps the state file, keeps the manifest, and marks the state so the install
// gate stays closed. §3.4 code 3 is "rollback or recovery incomplete", which is
// exactly this: production is still half-installed and we could not fix it.
function recoveryRequired(context, state, txn, settled) {
  const home = context.home;
  const reason = SETTLE_REASON[settled.tag] ?? settled.tag;
  const touched = settled.done;
  let failures = settled.problems;
  // Once the manifest has been marked spent the transaction is consumed, so
  // the marker no longer goes through it: committing to a manifest that is on
  // its way out would write the record back into a directory being disposed of.
  const spent = txn?.spent === true;
  // The marker is built from the snapshot this run read at the start. Writing
  // it without looking again is how a refusal further down got overwritten by
  // the layer reporting it: the disk had moved on, the lower layer declined to
  // touch it, and this wrote the stale copy back on top regardless.
  const drifted = stateDrift(home, txn?.stateSnapshot ?? state);
  if (drifted) {
    context.stdout([
      `Recovery did not complete: ${reason}.`,
      ...failures.map(line => `  ${line}`),
      '',
      `${drifted}.`,
      'Nothing was written: this run will not put its own copy back over whatever is there now.',
      '',
    ].join('\n'));
    return EXIT.RECOVERY;
  }
  // Built from what is actually on disk when there is one, so the marker is
  // that record with its status moved and nothing else touched. Building it
  // from a fresh record would drop every field the fresh one does not carry.
  const marker = { ...(txn?.stateSnapshot ?? state), status: 'recovery-required' };
  // Through the transaction when it can be, so the record stays accurate. When
  // it cannot -- an unwritable transaction directory is one of the failures
  // that lands here -- the marker still gets written, because closing the
  // install gate matters more than the bookkeeping. targetState knows this file
  // by what it says rather than byte for byte, so a retry is not blocked either
  // way.
  try {
    writeInstallState(home, marker, spent ? null : txn);
  } catch {
    try {
      writeInstallState(home, marker);
    } catch (error) {
      failures = [...failures, `${installStatePath(home)}: could not mark recovery-required (${error.message})`];
    }
  }
  context.stdout([
    `Recovery did not complete: ${reason}.`,
    ...failures.map(line => `  ${line}`),
    '',
    // Say what actually happened. An unconditional "nothing was deleted" was a
    // claim the code could not support, and it was wrong precisely when it
    // mattered: the user reads it, believes the system is untouched, and it is
    // already missing files.
    ...(touched.length === 0
      ? ['No changes were made: the problems above were found before anything was touched.']
      : [`${touched.length} change(s) were already applied before the failure:`, ...touched.map(line => `  ${line}`)]),
    '',
    'install state is marked recovery-required and the install gate stays closed.',
    ...(txn ? [`Recovery material is intact at ${txn.dir}`] : [`Expected recovery material under ${tildify(join(configDir(home), 'recovery'), home)}`]),
    `Current config: ${tildify(configDir(home), home)}`,
    // recover reports; it does not repair (A2). This used to say it "picks up
    // from where this one stopped", which was true while it still undid things.
    // A user who believes that runs it, reads a list, and thinks the machine
    // has been put back.
    '',
    'What to do:',
    '  1. node install.mjs recover',
    '     It prints what is on disk and the steps to undo it. It only reports:',
    '     it will not put anything back, and running it changes nothing.',
    '  2. Work through those steps by hand. The recovery directory above holds',
    '     the originals; nothing deletes it for you.',
    `  3. Remove ${tildify(installStatePath(home), home)} when you are satisfied --`,
    '     the install gate stays closed while it is there.',
    '  4. node install.mjs install',
    '',
  ].join('\n'));
  return EXIT.RECOVERY;
}

// --- §3.2 interactive wizard ------------------------------------------------

// The tty is passed in as { ask, say } so the prompt sequence can be driven in
// a test without a real terminal; withTty builds the real one.
function askChoice(tty, question, choices) {
  for (;;) {
    const answer = tty.ask(`${question} [${choices.join('/')}]: `);
    if (choices.includes(answer)) return answer;
    tty.say(`  expected one of ${choices.join(', ')}\n`);
  }
}

// §3.2's seven prompts. Returns the same shape the flag path builds, so both
// go through normalizeAnswers and cannot drift into different plans.
function runWizard(context, tty) {
  const vaultMode = askChoice(tty, '1/7 vault', ['new', 'existing']);
  let vault = '';
  while (!isAbsolute(vault)) {
    vault = tty.ask('2/7 absolute vault path: ');
    if (!isAbsolute(vault)) tty.say('  an absolute path is required\n');
  }
  if (existsSync(vault)) {
    tty.say(`      resolves to: ${realpathSync(vault)}\n`);
  }
  if (protectedHits(context.home, [vault, existsSync(vault) ? realpathSync(vault) : null]).length > 0) {
    tty.say('      NOTE: this path is under a TCC-protected prefix; background services will need Full Disk Access.\n');
  }
  const components = tty.ask(`3/7 components (comma separated from ${ALL_COMPONENTS.join(', ')}, or "all") [core]: `) || 'core';
  if (components === 'all' || components.split(',').some(name => name.trim() === 'observe')) {
    tty.say([
      '      observe reads these directories, which may contain your full AI conversations:',
      `        ${join(context.home, '.claude', 'projects')}`,
      `        ${join(context.home, '.codex', 'sessions')}`,
      `        ${join(context.home, '.codex', 'chronicle')}`,
      '',
    ].join('\n'));
  }
  const needsWatch = components === 'all' || components.split(',').some(name => name.trim() === 'watch');
  const watchRoot = needsWatch ? tty.ask('4/7 absolute watch root: ') : null;

  const answers = normalizeAnswers({ vault, vaultMode, components, watchRoot });
  let secret = null;
  let reusePrivateConfig = false;
  if (neededEnvFiles(answers.components).length > 0) {
    const source = askChoice(tty, '5/7 DeepSeek key', ['reuse', 'enter']);
    if (source === 'reuse') reusePrivateConfig = true;
    else secret = tty.ask('      key (not echoed): ', { echo: false });
  }
  return { answers: { ...answers, reusePrivateConfig }, secret };
}

function withTty(fn) {
  const input = openSync('/dev/tty', 'r');
  const output = openSync('/dev/tty', 'w');
  // Echo must come back on every exit path, including ^C during the key prompt,
  // or the user is left with a terminal that shows nothing they type (§9.2).
  const restore = () => { spawnSync('/bin/stty', ['echo'], { stdio: [input, 'ignore', 'ignore'] }); };
  process.on('SIGINT', restore);
  process.on('SIGTERM', restore);
  const tty = {
    say: text => { writeFileSync(output, text); },
    ask(question, { echo = true } = {}) {
      writeFileSync(output, question);
      if (!echo) spawnSync('/bin/stty', ['-echo'], { stdio: [input, 'ignore', 'ignore'] });
      try {
        const buffer = Buffer.alloc(4096);
        let text = '';
        while (!text.includes('\n')) {
          const read = readSync(input, buffer, 0, buffer.length, null);
          if (read === 0) break;
          text += buffer.toString('utf8', 0, read);
        }
        return text.split('\n')[0].trim();
      } finally {
        if (!echo) {
          restore();
          writeFileSync(output, '\n');
        }
      }
    },
  };
  try {
    return fn(tty);
  } finally {
    restore();
    process.off('SIGINT', restore);
    process.off('SIGTERM', restore);
    closeSync(input);
    closeSync(output);
  }
}

// --- CLI (§3.1, §3.3, §3.4) -------------------------------------------------

const FLAGS = {
  install: {
    value: { '--vault': 'vault', '--vault-mode': 'vaultMode', '--components': 'components', '--watch-root': 'watchRoot', '--deepseek-key-file': 'keyFile' },
    boolean: { '--reuse-private-config': 'reusePrivateConfig', '--adopt-shims': 'adoptShims', '--verify-online': 'verifyOnline', '--non-interactive': 'nonInteractive', '--yes': 'yes' },
  },
  // --resumed-after-pull is how the process the pull hands off to knows not to
  // pull again. Deliberately absent from the help: it is the handoff talking to
  // itself, and a user who passes it by hand has only said --no-pull twice.
  upgrade: { value: {}, boolean: { '--pull': 'pull', '--no-pull': 'noPull', '--adopt-shims': 'adoptShims', '--verify-online': 'verifyOnline', '--resumed-after-pull': 'resumedAfterPull' } },
  uninstall: { value: {}, boolean: { '--purge-config': 'purgeConfig', '--purge-logs': 'purgeLogs', '--non-interactive': 'nonInteractive', '--yes': 'yes' } },
  doctor: { value: {}, boolean: { '--online': 'online' } },
  recover: { value: {}, boolean: {} },
};

function redactFlag(arg) {
  const split = arg.indexOf('=');
  return split < 0 ? arg : arg.slice(0, split);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  if (!COMMANDS.includes(command)) throw new InstallError(`unknown command: ${redactFlag(command)} (expected one of ${COMMANDS.join(', ')})`);
  const spec = FLAGS[command];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const split = arg.indexOf('=');
    const name = split > 0 ? arg.slice(0, split) : arg;
    const inlineValue = split > 0 ? arg.slice(split + 1) : null;
    if (Object.hasOwn(spec.value, name)) {
      const value = inlineValue ?? argv[++index];
      if (value === undefined) throw new InstallError(`${name} requires a value`);
      options[spec.value[name]] = value;
    } else if (Object.hasOwn(spec.boolean, name)) {
      if (inlineValue !== null) throw new InstallError(`${name} does not take a value`);
      options[spec.boolean[name]] = true;
    } else {
      // Redacted: an unknown --deepseek-key=<secret> must not be echoed back.
      throw new InstallError(`unknown flag for ${command}: ${redactFlag(name)}`);
    }
  }
  return { command, options };
}

function createContext(overrides = {}) {
  const home = overrides.home ?? homedir();
  const execPath = overrides.execPath ?? process.execPath;
  const env = overrides.env ?? process.env;
  let nodeTarget = null;
  try { nodeTarget = realpathSync(execPath); } catch { nodeTarget = execPath; }
  return {
    home,
    // No environment variable reads this. Tests and the hermetic end-to-end
    // harness both drive main() with overrides, so an env-var override would be
    // a second way in that only production could be surprised by.
    launchctlPath: overrides.launchctlPath ?? '/bin/launchctl',
    repoRoot: overrides.repoRoot ?? dirname(fileURLToPath(import.meta.url)),
    platform: overrides.platform ?? process.platform,
    arch: overrides.arch ?? process.arch,
    execPath,
    nodeVersion: overrides.nodeVersion ?? process.version,
    nodeTarget: overrides.nodeTarget ?? nodeTarget,
    pathEnv: overrides.pathEnv ?? process.env.PATH,
    env,
    interactive: overrides.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    tty: overrides.tty ?? null,
    run: overrides.run ?? defaultRun,
    stdout: overrides.stdout ?? (text => process.stdout.write(text)),
    onManifest: overrides.onManifest ?? null,
    // Test-only seam, inert unless a caller passes one: it lets a regression
    // interrupt the closeout at a named point and prove the retry story,
    // which is otherwise a race nothing can construct.
    failpoint: overrides.failpoint ?? null,
  };
}

const LEVEL_PREFIX = { ok: 'ok   ', warn: 'WARN ', error: 'FAIL ' };

function printChecks(context, checks) {
  context.stdout('Preflight\n');
  for (const check of checks) context.stdout(`  ${LEVEL_PREFIX[check.level]} ${check.id}: ${check.message}\n`);
}

function installFlow(context, options, { answers, secret, confirm, confirmTargets }) {
  const report = preflight(context, answers, { command: 'install' });
  printChecks(context, report.checks);
  // §3.2 step 6: the plan, with no secret values in it.
  const planText = formatPlan(buildPlan(context, answers, report), context.home);
  context.stdout('\n' + planText + '\n');
  if (report.exitCode !== EXIT.OK) {
    context.stdout('\nPreflight did not pass; nothing was written.\n');
    return report.exitCode;
  }
  // §3.2 step 7: the last confirmation, before the first write.
  if (!confirm()) {
    context.stdout('\nNot confirmed; nothing was written.\n');
    return EXIT.ACTIONABLE;
  }
  let keyValue = secret;
  if (!keyValue && answers.keyFile && neededEnvFiles(answers.components).length > 0) {
    keyValue = readPrivateText(answers.keyFile);
  }
  // B-7: an empty or whitespace-only key would silently skip the env write and
  // report success with a component that cannot run. Refuse before write one.
  if (neededEnvFiles(answers.components).length > 0 && !answers.reusePrivateConfig && !String(keyValue || '').trim()) {
    throw new InstallError('the DeepSeek key is empty; the selected components cannot run without it');
  }
  context.stdout('\nApplying:\n');
  const applied = applyPlan(context, answers, report, options, String(keyValue || '').trim() || null, confirmTargets);
  const adopted = Object.entries(applied.shims).filter(([, shim]) => shim.adopted);
  context.stdout([
    '',
    `Config, vault schema and published code are in place (branch ${applied.branch}, publish --check was ${applied.checkState}).`,
    `Shims: ${Object.values(applied.shims).map(shim => tildify(shim.path, context.home)).join(', ')}`,
    applied.mounted.length > 0
      ? `Services mounted: ${applied.mounted.join(', ')}`
      : 'Services: none (core only installs no LaunchAgent).',
    ...(adopted.length > 0 ? [
      '',
      'These files were not brainkit\'s and were taken over with --adopt-shims:',
      ...adopted.map(([id, shim]) => `  ${id}: ${tildify(shim.path, context.home)}`),
      `Their originals are kept under ${tildify(join(configDir(context.home), 'recovery', applied.txn.id, ADOPTED_DIR), context.home)}`,
      'and are never deleted automatically. Remove them yourself once you are sure you do not want them back.',
    ] : []),
    '',
    // §5.1 step 9 / §6.2 NB2: the frozen Node target is an operating
    // commitment, so it is stated at install time rather than discovered in a
    // log after four services have quietly stopped.
    `The background services are frozen to this Node: ${applied.shims.node.target}`,
    'Any Node upgrade or version switch (brew upgrade node, nvm removing an old version, asdf/volta reinstalls)',
    'makes that path vanish and every service stops with a clear error. Fix it with one command from this clone:',
    '  node install.mjs upgrade --no-pull',
    '',
    'install-state status is "installing": the final verification pass is a later slice,',
    'so this system is deliberately not marked installed and a second install run will refuse to stack onto it.',
    // Not "run recover to deal with it". This install succeeded; there is
    // nothing to undo, and recover has not been able to undo anything since
    // A2 anyway. It lists what is on disk, which is all it is good for here.
    'That is expected, not a fault. If you want to see what this run put where,',
    'node install.mjs recover  will list it -- it only reports and changes nothing.',
    '',
  ].join('\n'));
  return EXIT.OK;
}

function runInstall(context, options) {
  // §3.2: a TTY without --non-interactive gets the wizard; anything else must
  // supply every selection as a flag, because non-TTY never guesses defaults.
  if (!options.nonInteractive && context.interactive) {
    // context.tty is the same kind of injection seam as context.run: absent in
    // production, where withTty opens the real /dev/tty.
    const session = context.tty ? (fn => fn(context.tty)) : withTty;
    return session(tty => {
      const { answers, secret } = runWizard(context, tty);
      return installFlow(context, options, {
        answers,
        secret,
        // --yes is explicit authorization and still skips only this prompt.
        confirm: () => options.yes || askChoice(tty, '6/7 plan shown above. 7/7 apply it?', ['yes', 'no']) === 'yes',
        // The plan cannot say which vault targets will be replaced -- that is
        // only known once the publisher has run its check, which is well after
        // the plan was confirmed. So it gets its own question, asked with the
        // list already on screen. Demanding --yes here instead made an
        // interactive install into an existing vault impossible whenever any
        // target differed, which for branch B is the ordinary case.
        confirmTargets: state => {
          if (options.yes) return;
          if (askChoice(tty, 'replace the vault targets listed above?', ['yes', 'no']) === 'no') {
            throw new InstallError(`publish --check reports ${state}; the target changes were not confirmed`);
          }
        },
      });
    });
  }
  return installFlow(context, options, {
    answers: normalizeAnswers(options),
    secret: null,
    confirm: () => {
      if (options.yes) return true;
      context.stdout('\nRe-run with --yes to confirm this plan.\n');
      return false;
    },
    confirmTargets: flagTargetConfirmation(options),
  });
}

// `extra` exists for upgrade: the answers come from the recorded install, but
// --adopt-shims is a decision the user makes on this run, not one the state
// remembers. doctor passes nothing and is unaffected.
function doctorAnswers(context, extra = {}) {
  const state = readInstallState(context.home);
  if (state) {
    return normalizeAnswers({
      vault: state.vault_root,
      vaultMode: 'existing',
      components: (state.components || ['core']).join(','),
      watchRoot: state.watch_root ?? undefined,
      ...extra,
    });
  }
  const conf = join(configDir(context.home), 'brainkit.conf');
  if (!existsSync(conf)) throw new InstallError(`no install state and no vault pointer at ${tildify(conf, context.home)}; run  node install.mjs install  first`);
  const values = parseEnvFile(conf, { allowedKeys: ['schema', 'vault', 'routing_json', 'memory_dir'], requiredKeys: ['vault'] });
  return normalizeAnswers({ vault: values.vault, vaultMode: 'existing', components: 'core' });
}

// §8.1 steps 1-4. Everything past the test gate is the next batch, so this
// stops there and says so rather than reporting an upgrade that did not happen.
function runUpgrade(context, options) {
  const home = context.home;
  const state = readInstallState(home);
  if (!state) {
    throw new InstallError(`no install state at ${tildify(installStatePath(home), home)}; run  node install.mjs install  first`);
  }
  if (state.status !== 'installed') {
    throw new InstallError(
      `install state says status=${state.status}; upgrade only runs on a finished install. `
      + 'Run  node install.mjs recover  to see what the last run left behind.',
    );
  }
  // §8.1 step 1, and the part that two agreeing records cannot cover: a root
  // that moved away with a symlink left at the old path keeps every recorded
  // string valid and changes only the disk. Both files would still say the same
  // thing, and the upgrade would rebuild the recorded identity on top of a
  // different directory. So each recorded root is re-resolved and has to still
  // be itself. A root that is simply gone is checkVault's business, not this
  // one's -- this is about identity, not existence.
  for (const [label, recorded] of [['repo', state.repo_root], ['vault', state.vault_root]]) {
    let now;
    try {
      now = canonicalPath(recorded, `recorded ${label}`);
    } catch {
      // Not defensive padding: canonicalPath throws a raw ENOENT when the
      // recorded path's own parent is gone, and a raw filesystem error is the
      // one thing this file refuses to hand a user. Named, like every other
      // refusal here.
      throw new InstallError(
        `the recorded ${label} ${recorded} cannot be resolved any more; `
        + 'reinstall from where it lives now',
        EXIT.UNSAFE,
      );
    }
    if (now !== recorded) {
      throw new InstallError(
        `the ${label} has moved from its recorded location: ${recorded} now resolves to ${now}; `
        + 'upgrading would rebuild the recorded install on top of a different directory. Reinstall from where it lives now',
        EXIT.UNSAFE,
      );
    }
  }

  // Which clone this process was started from, as opposed to whether the
  // recorded one is still itself. Both can fail independently.
  const repoNow = canonicalPath(context.repoRoot, 'repo root');
  if (repoNow !== state.repo_root) {
    throw new InstallError(
      `this clone is ${repoNow} but the install was made from ${state.repo_root}; `
      + 'run upgrade from the clone that installed it, or reinstall from this one',
      EXIT.UNSAFE,
    );
  }
  if (verifiedVaultRoot(home, state.vault_root) !== state.vault_root) {
    throw new InstallError(
      `install state names vault ${state.vault_root}, and ${tildify(join(configDir(home), 'brainkit.conf'), home)} does not agree; `
      + 'refusing to upgrade a vault neither file confirms',
      EXIT.UNSAFE,
    );
  }

  // Taken before the worktree check, per step 1: a second installer competing
  // for this machine is a reason to stop immediately, not after doing work.
  //
  // Outside the try on purpose, unlike applyPlan's. When acquireLock refuses,
  // the lock on disk belongs to the other installer, and a finally that ran
  // would delete it -- a refusal that helpfully clears the way for the very
  // collision it just refused. Moving this line inside the try is exactly that
  // bug.
  let lock = acquireLock(home);
  const release = () => {
    if (!lock) return;
    try { unlinkSync(lock); } catch { /* already gone */ }
    lock = null;
  };
  try {
    // §8.1 step 2 is inside this: checkGit runs with requireClean for upgrade,
    // and it only reads -- nothing here stashes, resets or switches branch.
    //
    // One answers object for the whole run. Building a second one for step 5
    // let --adopt-shims reach the shim writer while preflight still judged the
    // same files without it, so an adoption the user had asked for was refused
    // one step before it would have happened.
    const answers = doctorAnswers(context, { adoptShims: options.adoptShims });
    const report = preflight(context, answers, { command: 'upgrade' });
    printChecks(context, report.checks);
    if (report.exitCode !== EXIT.OK) {
      context.stdout('\nPreflight did not pass; nothing was changed.\n');
      return report.exitCode;
    }

    if (options.pull && !options.resumedAfterPull) {
      const pulled = context.run('git', ['-C', context.repoRoot, 'pull', '--ff-only']);
      if (pulled.error || pulled.status !== 0) {
        throw new InstallError(
          `git pull --ff-only failed: ${pulled.error?.message || String(pulled.stderr || '').trim() || `exit ${pulled.status}`}`,
        );
      }
      // §8.1 step 3. From here the new HEAD's installer runs, not this one: an
      // old installer driving a new publisher and new templates is the thing
      // this step exists to prevent. The parent's remaining job is the handoff
      // and nothing else -- no publisher, no plists, no launchctl.
      //
      // The lock goes first so the child can take it. That leaves a moment when
      // neither holds it; §9.3 covers non-malicious concurrency and a competing
      // installer landing inside that window would be refused by the child.
      release();
      const child = context.run(context.execPath, [
        join(context.repoRoot, 'install.mjs'), 'upgrade', '--no-pull', '--resumed-after-pull',
        ...(options.adoptShims ? ['--adopt-shims'] : []),
        ...(options.verifyOnline ? ['--verify-online'] : []),
      ]);
      context.stdout(String(child.stdout ?? ''));
      if (child.stderr) process.stderr.write(String(child.stderr));
      if (child.error) {
        throw new InstallError(`could not hand off to the updated installer: ${child.error.message}`, EXIT.UNSAFE);
      }
      return child.status ?? EXIT.UNSAFE;
    }

    // §8.1 step 4. The suite is the gate, not this command's business to
    // reproduce: it runs it and honours the result. Placed here so a red suite
    // stops the run while everything is still untouched.
    const tests = context.run(context.execPath, [join(context.repoRoot, 'tests', 'run-all.mjs')]);
    if (tests.error || tests.status !== 0) {
      throw new InstallError(
        `node tests/run-all.mjs did not pass (${tests.error?.message || `exit ${tests.status}`}); nothing has been changed`,
        EXIT.UNSAFE,
      );
    }

    // The write half of upgrade is DISABLED. Two rounds of independent review
    // found data-consequence defects of the same family in it -- the last one
    // could lose recovery material while reporting success -- and the slice's
    // pre-agreed stop-loss says that is where it stops being a command that
    // touches the disk. upgradeApply and everything under it stay in the tree,
    // still tested, still the starting point for reinstating it; nothing
    // reaches them from here. There is deliberately no flag or environment
    // variable that turns this back on: a switch would be the same command
    // with an extra step, not a disabled one.
    return upgradePlan(context, answers, state, report);
  } finally {
    release();
  }
}

// What an upgrade would change, and how to do it by hand. Everything here is
// read from the same places the disabled apply path used, so the two cannot
// drift into disagreeing about what is on the machine.
function upgradePlan(context, answers, state, report) {
  const short = path => tildify(path, context.home);
  const check = runPublisher(context, ['--check']);
  const summary = publisherRecords(check).find(entry => entry.type === 'summary');
  const vaultState = check.error || !summary ? 'could not be read' : summary.state;
  const shims = report.shims.filter(shim => shim.verdict !== 'idempotent');
  const plists = plannedPlists(context.home, answers.components);
  const loaded = [...loadedServiceLabels(launchctlHandle(context), answers.components)];

  context.stdout([
    '',
    'Checks pass. This command does NOT upgrade anything: the write half is disabled',
    'after two rounds of independent review found defects that could lose recovery',
    'material while reporting success. What it would have changed:',
    '',
    `  vault code   : publish --check reports ${vaultState}`,
    `  shims        : ${shims.length === 0 ? 'already current' : shims.map(shim => `${short(shim.path)} (${shim.verdict})`).join(', ')}`,
    `  plists       : ${plists.length === 0 ? 'none' : plists.map(plist => short(plist.path ?? plist)).join(', ')}`,
    `  services     : ${loaded.length === 0 ? 'none running' : `${loaded.join(', ')} would be restarted`}`,
    '',
    'To do it by hand, from this clone, in this order:',
    '',
    `  1. node scripts/publish.mjs --check        # read it; stop unless it says clean`,
    '  2. node scripts/publish.mjs                # deploys the vault code',
    ...loaded.map((label, index) => `  ${index + 3}. launchctl kickstart -k ${serviceDomain()}/${label}`),
    `  ${loaded.length + 3}. node install.mjs doctor                 # confirm the result`,
    '',
    'The shims and plists above are rebuilt only by the disabled path; if one of them',
    'is listed as needing a change, that part cannot be done by hand safely -- say so',
    'rather than editing ~/.local/bin or ~/Library/LaunchAgents yourself.',
    '',
  ].join('\n'));
  return EXIT.ACTIONABLE;
}

// §8.1 steps 5-8, inside one transaction. The rollback slice 4 built is what
// puts the shims back when step 6 stops -- upgrade deliberately does not get a
// restore path of its own, because a second one is a second thing to be wrong.
//
// Step 9 (doctor and the component smoke tests, and the publisher --recover
// that a failure there needs) is the next batch. Everything here still unwinds
// on failure, through the same settleTransaction applyPlan uses; what is not
// built yet is the reporting that tells those two failures apart.
function upgradeApply(context, answers, state) {
  const home = context.home;
  const vaultRoot = state.vault_root;
  const txn = beginTransaction(home, {
    launchctl: launchctlHandle(context),
    shapes: managedShapes(home, vaultRoot, answers.components),
    onRecord: context.onManifest,
    failpoint: context.failpoint,
  });
  // Which of the two fork states the user is in, if this throws. It flips the
  // moment the publisher has been allowed to change the vault, so a step-6 hard
  // stop is still reported as "nothing published" rather than "rolled back".
  let published = false;
  let backupDir = null;
  try {
    // Claimed before anything is touched, and it has to be the first managed
    // write: the rollback refuses to act unless install-state names the
    // transaction it is unwinding, so an upgrade that mutated first and claimed
    // later would have no rollback at all -- it rebuilt the shims and then
    // declined to put them back, which is how this was found.
    //
    // The cost is real and belongs in the open: a crash between here and the
    // end leaves status=upgrading, and 14 A2 says recover has only been proven
    // against installing. Batch 3 owns closing that.
    // plan_digest goes with last_txn, always. loadTransaction refuses any
    // transaction whose plan digest disagrees with the state's, and carrying
    // the install's digest forward guaranteed that disagreement: an upgrade's
    // plan is rebuilt against today's disk, where the paths the install created
    // now exist. Every real interrupted upgrade would have been unrecoverable
    // -- recover would refuse to load the transaction it exists to diagnose.
    writeInstallState(home, {
      ...state, status: 'upgrading', last_txn: txn.id, plan_digest: planDigest(txn.plan),
    }, txn);

    // §8.1 step 5. installShims judges each existing shim under §2.3 again --
    // an unmarked file still needs --adopt-shims here, exactly as at install
    // time, and the original goes to the recovery directory before it is
    // replaced. That backup is the user's only copy.
    const shims = installShims(context, answers, txn);
    context.stdout(`  shims rebuilt: ${Object.keys(shims).join(', ') || 'none'}\n`);

    // Read before anything is published or rewritten: step 8 restarts what was
    // running when the upgrade started, and after the fact there is no way to
    // tell a service the upgrade started from one the user had running.
    const wasLoaded = loadedServiceLabels(txn.launchctl, answers.components);

    // §8.1 steps 6 and 7. The acceptance rule is publishStep's own and is
    // already the one the spec asks for: clean, repo-ahead, repo-new and
    // same-change go through, and everything else -- vault drift, corrupt,
    // repo-removed, retirement-pending -- is a hard stop. No bootstrap: an
    // upgrade is by definition a vault that has been published to before.
    //
    // Nothing to confirm: --yes is not in upgrade's flag set, and the target
    // changes here are the ones the user asked for by running upgrade.
    // backupDir is set from the receipt, which publishStep now reports whatever
    // the exit code was. Setting it only after a clean return meant a publisher
    // that committed and then exited non-zero left backupDir null, and the
    // vault it had already changed was reported as untouched. See publishStep.
    const check = publishStep(context, { bootstrap: false }, () => {}, dir => { backupDir = dir; });

    // §8.1 step 8.
    const plists = installPlists(context, answers, vaultRoot, txn);
    const mounted = mountServices(context, plists, { only: wasLoaded });
    context.stdout(`  services restarted: ${mounted.join(', ') || 'none'}\n`);

    // §8.1 step 9, first half: verify what this run actually produced.
    // preflight under the doctor command answers the platform and takeover
    // questions, and install-state is excluded from it -- and only it --
    // because that check asks whether an install is in flight and the answer
    // inside step 9 is "yes, this one". On its own that set says nothing about
    // the things this upgrade just wrote, so verifyUpgrade covers those.
    //
    // The second half -- actually running clip/observe/sunday -- is NOT here;
    // it lands with the real-machine work in slice 9. upgradeStop prints both
    // halves so nobody has to read this comment to find out.
    const verified = preflight(context, answers, { command: 'doctor' });
    const failures = [
      ...verified.checks.filter(entry => entry.id !== 'install-state' && entry.exit !== EXIT.OK)
        .map(entry => ({ id: entry.id, exit: entry.exit, detail: entry.detail })),
      ...verifyUpgrade(context, { answers, vaultRoot, plists, wasLoaded, shims }),
    ];
    if (failures.length > 0) {
      printChecks(context, verified.checks);
      for (const failure of failures) context.stdout(`  FAIL  ${failure.id}: ${failure.detail ?? ''}\n`);
      throw new InstallError(
        `the upgraded system did not pass its own checks: ${failures.map(entry => entry.id).join(', ')}`,
        failures.reduce((worst, entry) => Math.max(worst, entry.exit ?? EXIT.UNSAFE), EXIT.OK),
      );
    }

    // §8.1 step 10. A commit that could not be read is a failed step 10, not a
    // successful one with a null in it: the state's whole job here is to say
    // which version production is running, and "null" is that record claiming
    // less than the spec says it carries.
    const head = headCommit(context);
    if (!/^[0-9a-f]{40}$/.test(String(head))) {
      throw new InstallError(
        `git -C ${context.repoRoot} rev-parse HEAD did not return a commit, so this upgrade cannot record which version it installed`,
        EXIT.UNSAFE,
      );
    }
    writeInstallState(home, {
      ...state,
      status: 'installed',
      installed_commit: head,
      shims,
      plists,
      last_txn: txn.id,
      plan_digest: planDigest(txn.plan),
    }, txn);

    // §14 A1: a transaction is kept while the status is non-terminal and
    // consumed once it reaches `installed`. releaseState is false because this
    // is the success path -- the anchors hold what this upgrade just wrote and
    // must not be reverted to the pre-image; only the backups and the manifest
    // are spent. Adopted third-party originals are kept by closeOut itself.
    const closed = closeOut(txn, [], { releaseState: false });
    if (closed.tag !== 'settled' && closed.tag !== 'swept' && closed.tag !== 'leftover') {
      throw new InstallError(
        `the upgrade finished but its transaction could not be consumed: ${closed.problems.join('; ')}`,
        EXIT.RECOVERY,
      );
    }
    return upgradeStop(context, { checkState: check.state, mounted, wasLoaded, shims, closed });
  } catch (error) {
    // No `declared` expectation, unlike applyPlan's. There it means "this
    // transaction produced the whole installation, so every path the state
    // claims must appear in its manifest". An upgrade's transaction owns only
    // what it touched -- the config and memory files belong to the original
    // install -- so that expectation reports every one of them as missing and
    // blocks a rollback with nothing wrong with it. What this run wrote is
    // still checked: every write went through the transaction, so its own
    // manifest is the complete record of what there is to undo.
    const settled = settleTransaction(txn);
    // §8.1 step 9 in the order the spec gives, and the order is not decoration:
    // the plists and shims first -- settleTransaction just did that -- and the
    // publisher, which owns the vault's code and manifest, only afterwards.
    //
    // `leftover` counts as recovered per §14 A4: it means the rollback finished
    // and the anchors are back, and only the directory could not be emptied.
    // `blocked` and `partial` do not: changing a second authority while the
    // first is known to be unfinished turns a stopped rollback into two
    // half-restored layers. The backup directory is kept and named instead.
    const localRestored = ['settled', 'swept', 'leftover'].includes(settled.tag);
    const recovered = backupDir === null
      ? null
      : localRestored
        ? recoverPublished(context, backupDir)
        : { ok: false, skipped: true, problem: null };
    context.stdout(`\n${upgradeForkState({ backupDir, settled, localRestored, recovered }).join('\n')}\n`);
    if (!localRestored) {
      throw new InstallError(`${error.message} (${SETTLE_REASON[settled.tag] ?? settled.tag})`, EXIT.RECOVERY);
    }
    throw error;
  }
}

// The three-way the spec's step 6 and step 9 are careful to keep apart, and
// which docs/INSTALLER.md publishes as a table. Only the first two exist in
// this batch; step 9's "production was changed and put back" is batch 3, and
// saying it here would be claiming a rollback nobody has written yet.
// §8.1 step 9's "repo may stay at the new HEAD, and say so". The three wordings
// are kept apart on purpose and are not interchangeable: what the user does
// next differs in each. docs/INSTALLER.md publishes the same three as a table.
// Split on what is true of production, not on the name of a transaction tag,
// and report the two layers separately -- the local one this installer owns,
// and the vault the publisher owns. Folding them into one sentence is what let
// a cleanup-only leftover be announced as an unknown state, and swallowed a
// failed publisher recovery along with the backup directory the user needs.
function upgradeForkState({ backupDir, settled, localRestored, recovered }) {
  const local = localRestored
    ? ['Shims, plists and services are back as they were before this run.',
      // A leftover is a restored system with an untidy directory. Saying so is
      // the difference between "clean up when you like" and "stop".
      ...(settled.tag === 'leftover'
        ? ['The recovery directory could not be emptied, which is tidying, not damage:',
          ...settled.problems.map(line => `  ${line}`)]
        : [])]
    : ['This upgrade could not put the local layer back, so production is in an unknown',
      'state. Run  node install.mjs recover  to see what is on disk before anything else.',
      ...settled.problems.map(line => `  ${line}`)];

  if (backupDir === null) {
    return [...local, 'The publisher never reported changing the vault, so there is nothing of its',
      'to undo. Your clone is left at whatever commit it is on now.'];
  }
  if (recovered.skipped) {
    return [...local,
      'The publisher HAD changed the vault, and its recovery was deliberately not run:',
      'undoing it while the local layer is unfinished would leave two half-restored',
      'layers instead of one. Its backup is kept and is the thing to use, in this order:',
      `  1. deal with the local layer above`,
      `  2. node scripts/publish.mjs --recover ${backupDir}`,
      '  3. node install.mjs doctor'];
  }
  if (recovered.ok) {
    return [...local,
      'The repo is new and production has been rolled back: the publisher put the vault',
      'code and its manifest back from its own backup. Nothing is half-upgraded.',
      'Your clone may still be at the newer commit -- that is allowed, and running',
      '  node install.mjs upgrade  again is how you retry.'];
  }
  return [...local,
    'The vault code the publisher wrote is NOT back: its own recovery did not complete.',
    ...(recovered.problem ? [`  ${recovered.problem}`] : []),
    `  its backup is still at ${backupDir}`,
    'Production is part new and part old. Do not run upgrade again until this is resolved.'];
}

// §8.1 step 9, the half that is in scope: does what this run just wrote match
// what it meant to write, and is the machine in the state it claims. preflight
// answers none of these -- it checks whether an install *could* proceed, which
// is a different question from whether this one landed.
//
// Deliberately not here: executing clip/observe/sunday. That is the component
// smoke half, and it needs a real machine (slice 9). upgradeStop says so out
// loud rather than letting exit 0 imply it happened.
function verifyUpgrade(context, { answers, vaultRoot, plists, wasLoaded, shims }) {
  const failures = [];
  const fail = (id, detail) => failures.push({ id, exit: EXIT.UNSAFE, detail });

  // The publisher's own verdict on the vault it just wrote. Anything but clean
  // means the deployed code is not what this repo says it should be.
  const after = runPublisher(context, ['--check']);
  const summary = publisherRecords(after).find(entry => entry.type === 'summary');
  if (!summary) fail('published-code', `publish --check produced no summary: ${String(after.stderr || '').trim()}`);
  else if (summary.state !== 'clean') fail('published-code', `publish --check still reports ${summary.state} after publishing`);

  // The plists this run rendered, read back off disk. assertPlistContract is
  // the same reader installPlists uses, so this catches a file that changed
  // between being written and now rather than re-deriving the rules.
  for (const [service, written] of Object.entries(plists)) {
    if (!written?.path) continue;
    const path = written.path;
    try {
      assertPlistContract(ARTIFACTS.find(entry => entry.service === service), path, service);
    } catch (error) {
      fail(`plist-${service}`, error.message);
    }
  }

  // The shims, through the same contract check, plus the node shim executed for
  // real -- a frozen target that no longer resolves is the failure mode §6.2
  // exists for, and it is invisible to every static check.
  for (const [id, shim] of Object.entries(shims)) {
    try {
      assertShimContract(ARTIFACTS.find(entry => entry.shim === id), shim.path);
    } catch (error) {
      fail(`shim-${id}`, error.message);
    }
  }
  try {
    verifyNodeShim(context, join(binDir(context.home), NODE_SHIM_NAME));
  } catch (error) {
    fail('shim-node-runs', error.message);
  }

  // §8.1 step 8's promise, checked rather than assumed: everything that was
  // running when this started is running now.
  const launchctl = launchctlHandle(context);
  for (const label of wasLoaded) {
    if (serviceLoadedFrom(launchctl, label) === null) {
      fail(`service-${label}`, `${label} was running before this upgrade and is not running now`);
    }
  }
  return failures;
}

// The publisher's own recovery, run as one step and reported as one fact. It
// is not retried and not second-guessed: it either put the vault back or it
// did not, and pretending otherwise is how a half-recovered vault gets called
// clean.
function recoverPublished(context, backupDir) {
  const result = runPublisher(context, ['--recover', backupDir]);
  if (!result.error && result.status === 0) return { ok: true, problem: null };
  const detail = result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`;
  return { ok: false, problem: `publish --recover ${backupDir} failed: ${detail}` };
}

// §8.1 step 10: which commit this machine is now running. Read-only, and the
// same seam every other git call goes through.
function headCommit(context) {
  const result = context.run('git', ['-C', context.repoRoot, 'rev-parse', 'HEAD']);
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

// §8.1 step 8, first half: the set of managed labels launchd reports as loaded
// right now. Read through the transaction's handle so it goes through the same
// seam every other service call does.
function loadedServiceLabels(launchctl, components) {
  const loaded = new Set();
  for (const entry of ARTIFACTS) {
    if (!entry.service || !components.includes(entry.service)) continue;
    const label = `com.second-brain.${entry.service}`;
    if (readService(launchctl, label).loaded) loaded.add(label);
  }
  return loaded;
}

function upgradeStop(context, { checkState, mounted, wasLoaded, shims, closed }) {
  const notRestarted = [...wasLoaded].filter(label => !mounted.includes(label));
  context.stdout([
    '',
    `Upgrade complete (publish --check reported ${checkState}).`,
    ...(notRestarted.length ? [`Not restarted, and they were running: ${notRestarted.join(', ')}`] : []),
    '',
    // §8.1 step 9 is two halves and only one of them ran. Exit 0 would
    // otherwise imply the components were exercised, which is the reading that
    // costs someone an afternoon when a component turns out to be broken.
    'Verified: the vault code matches this repo (publish --check clean), the plists and',
    'shims are the ones this run wrote and pass their contracts, the node shim executes,',
    'and every service that was running before is running now.',
    'NOT executed, deferred to the real-machine work: the component smoke tests. No',
    'component was actually run, so "complete" means checked, not exercised.',
    ...(closed?.tag === 'leftover'
      ? ['', 'The recovery directory could not be emptied; nothing is pending, remove it by hand:',
        ...closed.problems.map(line => `  ${line}`)]
      : []),
    ...(closed?.retained ? ['', `Third-party files this run took over are kept at ${tildify(closed.retained, context.home)}`] : []),
    '',
    // §5.1 step 9 / §6.2 NB2, restated here because an upgrade is exactly when
    // the frozen target changes: the shims were just rebuilt against whichever
    // Node is running now, and the user last saw this sentence at install time
    // against a different one.
    `The background services are frozen to this Node: ${shims.node.target}`,
    'Any Node upgrade or version switch (brew upgrade node, nvm removing an old version, asdf/volta reinstalls)',
    'makes that path vanish and every service stops with a clear error. Fix it with one command from this clone:',
    '  node install.mjs upgrade --no-pull',
    '',
    'The component smoke tests are still a later slice, so what passed here is doctor',
    'and nothing more. If a component misbehaves, that is where to look first.',
    '',
  ].join('\n'));
  return EXIT.OK;
}

// §8.2 batch 1. Reads, decides, prints, and stops. Nothing here writes -- the
// lock is deliberately not taken, because taking it is itself a write.
function runUninstall(context, options) {
  const state = readInstallState(context.home);
  if (!state) {
    throw new InstallError(`no install state at ${tildify(installStatePath(context.home), context.home)}; there is nothing to uninstall`);
  }
  // One guard for every non-terminal status rather than a special case for
  // each. A machine mid-install or mid-upgrade has a live transaction that
  // still claims these files; deleting them leaves that transaction's rollback
  // pointing at backups whose originals are gone. recover's advice is already
  // per-status, so it is the right place to send all of them.
  if (state.status !== 'installed') {
    throw new InstallError(
      `install state says status=${state.status}, and uninstall only runs on a finished install. `
      + 'A run that stopped partway still owns these files: use  node install.mjs recover  first.',
      EXIT.UNSAFE,
    );
  }

  const planned = uninstallPlan(context, state, options);
  printUninstallPlan(context, planned);
  context.stdout(uninstallNotes(context, state).join('\n'));

  // The execution half of uninstall is DISABLED. Two rounds of independent
  // review found data-consequence defects of the same family in it -- the last
  // round found deletion still not bound to the object just verified, a shape
  // check that authorised one product's path for another product, and a vault
  // root corroborated by string rather than by identity -- and the slice's
  // pre-agreed stop-loss says that is where it stops being a command that
  // touches the disk. uninstallExecute and everything under it stay in the
  // tree, still tested, still the starting point for reinstating it; nothing
  // reaches them from here. There is deliberately no flag or environment
  // variable that turns this back on: a switch would be the same command with
  // an extra step, not a disabled one.
  context.stdout([
    '',
    'This command does NOT remove anything: the execution half is disabled after two',
    'rounds of independent review found defects of the same family in it -- deletion',
    'that was not bound to the file just verified, and paths authorised by something',
    'adjacent to them rather than by themselves. Everything above is what it WOULD',
    'have removed and kept, decided by the same judgement the removals used.',
    '',
    'Nothing was stopped, nothing was deleted, and the services named above are still',
    'running. To remove brainkit from this machine, follow the manual steps in',
    'docs/INSTALLER.md section 6 -- they are the whole procedure, not a supplement.',
    '',
  ].join('\n'));
  return EXIT.ACTIONABLE;
}

// The execution half, entire: the purge confirmation, the lock, the identity
// recheck under it, and the removals. Kept whole and in one piece so that
// reinstating it is one call site rather than a reassembly, and so the gates
// that guard each of those steps still have something to run against.
// runUninstall does not reach it -- see the banner there -- and being exported
// is not a way back in from the command line.
function uninstallExecute(context, state, options, planned) {
  // §8.2 step 8: the purge flags are the only destructive widening, so they are
  // the only thing asked about. --yes is the non-interactive form of the same
  // answer, and without a TTY there is nobody to ask.
  if (options.purgeConfig || options.purgeLogs) {
    // Both flags named, not just the first: the question has to describe the
    // whole widening the user is agreeing to.
    const asked = [options.purgeConfig && '--purge-config', options.purgeLogs && '--purge-logs'].filter(Boolean).join(' and ');
    if (options.yes) { /* authorized on the command line */ }
    // --non-interactive means "there is nobody to ask" even on a TTY, which is
    // what it means everywhere else in this file.
    else if (options.nonInteractive || !context.interactive) {
      throw new InstallError(`${asked} deletes files this install did not create for you to keep; re-run with --yes`);
    } else {
      const session = context.tty ? (fn => fn(context.tty)) : withTty;
      const answer = session(tty => askChoice(tty, `${asked}: delete the files listed above?`, ['yes', 'no']));
      if (answer === 'no') throw new InstallError(`${asked} was not confirmed; nothing has been changed`);
    }
  }

  const lock = acquireLock(context.home);
  try {
    // Re-read under the lock and require it to be the same record. Everything
    // above -- the plan, the printed report, the confirmation the user answered
    // -- was decided from a snapshot taken before the lock existed, and a state
    // replaced in that window would otherwise be deleted having never been
    // judged. Identity is the whole record, not a field of it: the same
    // comparison recover makes, plus `status`, which sameStateIdentity exempts
    // for a transaction rewriting its own field and which is not exempt here --
    // uninstall refused every status but `installed` at the entrance, so that
    // field is part of what was judged.
    const current = readInstallState(context.home);
    if (!current || current.status !== state.status || !sameStateIdentity(current, state)) {
      throw new InstallError(
        `${tildify(installStatePath(context.home), context.home)} changed between the plan and the lock; nothing has been removed. Re-run to plan against what is there now.`,
        EXIT.UNSAFE,
      );
    }
    return executeUninstall(context, current, options, planned);
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

function printUninstallPlan(context, rows, { done = false } = {}) {
  const short = path => tildify(path, context.home);
  const removing = rows.filter(row => row.action === 'delete');
  const keeping = rows.filter(row => row.action === 'keep');
  context.stdout([
    '',
    done ? 'Uninstalled.' : 'Uninstall plan.',
    '',
    `${done ? 'Removed' : 'Would remove'} (${removing.length}):`,
    ...removing.map(row => `  ${row.kind.padEnd(7)} ${short(row.path)}`),
    '',
    `${done ? 'Kept' : 'Would keep'} (${keeping.length}):`,
    ...keeping.map(row => `  ${row.kind.padEnd(7)} ${short(row.path)}\n          ${row.why}`),
    '',
  ].join('\n'));
}

// §8.2 steps 1-3 and 5. The judgement is not repeated here: the plan is
// recomputed by the same function immediately before anything is unlinked, and
// only a path both runs call deletable is deleted. That is the mirror of slice
// 4's declare-before-mutate -- judge-before-unlink -- and it means there is one
// implementation of "is this still ours", not two that must agree.
function executeUninstall(context, state, options, planned) {
  const launchctl = launchctlHandle(context);
  // Read before anything is unlinked. state.vault_root is a claim like every
  // other path the state names, and brainkit.conf is what corroborates it --
  // but --purge-config deletes that conf below, so asking afterwards would make
  // step 6 depend on which flags this run was given.
  const vaultRoot = verifiedVaultRoot(context.home, state.vault_root);

  // §8.2 steps 1 and 2. readService, not serviceLoadedFrom: the weaker reader
  // folds "launchctl could not tell us" into "not loaded", so a permission
  // error read as unloaded let this delete a plist while its job was still
  // running -- and then say nothing runs any more. readService raises on an
  // unknown state, which is the only honest answer to "is it stopped".
  const services = Object.entries(state.plists || {})
    .map(([service, entry]) => ({ label: `com.second-brain.${service}`, path: plistRecord(entry)?.path }))
    .filter(row => row.path);

  // Every label is read before any is stopped: one loaded from somewhere else
  // means this machine has been misread, and the answer is to touch nothing.
  const running = [];
  for (const { label, path } of services) {
    const found = readService(launchctl, label);
    if (!found.loaded) continue;
    if (!samePlist(found.plist, path)) {
      throw new InstallError(
        `${label} is loaded from ${found.plist}, not the ${path} this install recorded; refusing to stop or remove anything`,
        EXIT.UNSAFE,
      );
    }
    running.push(label);
  }

  for (const label of running) {
    const problem = bootoutService(launchctl, label);
    if (problem) throw new InstallError(`cannot stop ${label}: ${problem}`, EXIT.ACTIONABLE);
    if (readService(launchctl, label).loaded) {
      throw new InstallError(`${label} is still loaded after bootout; refusing to remove its plist`, EXIT.UNSAFE);
    }
    context.stdout(`  stopped ${label}\n`);
  }

  // The last-moment re-judgement. Anything that was deletable when the plan was
  // printed and is not now has changed underneath us, and the answer is the
  // same as everywhere else here: keep it, say so, carry on, exit 2.
  const now = new Map(uninstallPlan(context, state, options).map(row => [row.path, row]));
  const drifted = [];
  const outcome = [];
  // The state file goes last: it is the record that this machine was installed,
  // and losing it before the rest is done leaves a failure with no account.
  const ordered = [...planned].sort((a, b) => Number(a.kind === 'state') - Number(b.kind === 'state'));
  // Drift the plan already found counts too. It used to reach `outcome` and
  // stop there, so a machine with a hand-edited shim reported success, lost its
  // state, and left the shim -- with no record left to try again from.
  drifted.push(...planned.filter(row => row.action === 'keep' && !row.policy).map(row => row.path));

  for (const row of ordered) {
    if (row.action !== 'delete') { outcome.push(row); continue; }
    // The state file is the commit step, not just the last one. Removing it
    // while anything else was kept or failed would throw away the only account
    // of what is still on this machine -- which is exactly the situation that
    // needs an account.
    if (row.kind === 'state' && drifted.length > 0) {
      outcome.push({ ...row, action: 'keep', why: 'kept: this run did not finish, and it is the only record of what is still here' });
      continue;
    }
    const fresh = now.get(row.path);
    if (!fresh || fresh.action !== 'delete') {
      const why = fresh?.why ?? 'it is no longer there';
      drifted.push(row.path);
      outcome.push({ ...row, action: 'keep', why: `changed while this uninstall was running: ${why}` });
      continue;
    }
    try {
      unlinkSync(row.path);
      outcome.push(row);
    } catch (error) {
      // One failure is not a reason to abandon the rest: a half-removed machine
      // with no report is worse than a fully-reported partial one.
      drifted.push(row.path);
      outcome.push({ ...row, action: 'keep', why: `could not be removed: ${error.message}` });
    }
  }

  // §8.2 step 6: only directories that are already empty, only the ones the
  // registry names, and only under the corroborated vault root read above --
  // reaching through state.vault_root directly would be the one path in this
  // function that authorises itself. rmdir refuses a non-empty directory
  // itself, so the check and the action are the same syscall with no window
  // between them.
  if (vaultRoot && drifted.length === 0) {
    for (const inner of VAULT_DIRS.filter(path => path.startsWith(SCRIPTS_DIR))) {
      try { rmdirSync(join(vaultRoot, inner)); } catch { /* not empty, or not there */ }
    }
  }

  printUninstallPlan(context, outcome, { done: true });
  context.stdout(uninstallNotes(context, state).join('\n'));
  if (drifted.length > 0) {
    throw new InstallError(
      `${drifted.length} item(s) were kept rather than removed; they are listed above with the reason`,
      EXIT.UNSAFE,
    );
  }
  return EXIT.OK;
}

// §8.2 step 5 and its two notes. All three exist because the machine afterwards
// does not look like "brainkit is gone", and a user who is surprised by that
// will go looking for what went wrong.
function uninstallNotes(context, state) {
  return [
    // "was not touched" and "none of it runs" were both past tense, and this is
    // now printed by a command that stops before touching or stopping anything.
    // A sentence that is only true when the execution half runs is exactly the
    // kind of claim two rounds of review kept finding.
    'The vault is not touched by this command. The deployed code under 00-系统/scripts/',
    'and its publish-manifest.json stay where they are; once no LaunchAgent points at',
    'them, none of it runs. Remove that directory by hand if you want it gone.',
    '',
    'Two things that will surprise you otherwise:',
    // Was "running brain-clip.mjs by hand recompiles it": that compile lived in
    // brain-clip.mjs install, which slice 8 deleted along with the rest of the
    // second installer. Nothing rebuilds the helper on its own any more.
    '  * brain-clip-helper is never rebuilt on its own. If it is missing, the clip',
    '    handler prints the swiftc line to run; nothing recompiles it behind you.',
    '  * installing again over this vault skips the publisher bootstrap and goes',
    '    straight to a check, because the manifest survived. That is branch C and',
    '    it is expected, not a fault.',
    '',
    // §8.2 step 4 promises this path is printed. It is the only copy of a file
    // the user wrote, so "it is somewhere under recovery" is not good enough.
    ...(Object.values(state.shims || {}).some(shim => shim?.adopted)
      ? ['Files this install took over with --adopt-shims were never restored and never',
        'deleted. Their originals are the only copies there are, and they are here:',
        `  ${tildify(join(configDir(context.home), 'recovery', state.last_txn, ADOPTED_DIR), context.home)}`,
        '']
      : []),
    `The install state named ${state.repo_root} as the clone it came from; this`,
    'command never touched the clone.',
    '',
  ];
}


function runDoctor(context, options) {
  const answers = doctorAnswers(context);
  if (options.online) context.stdout('note: --online probes land with the component smoke tests in a later slice\n');
  const report = preflight(context, answers, { command: 'doctor' });
  printChecks(context, report.checks);
  context.stdout('\nRead-only: doctor wrote nothing. Publisher, plist and service checks (spec §10.1) land in later slices.\n');
  return report.exitCode;
}

function printHelp(context) {
  context.stdout([
    'Usage: node install.mjs <command> [flags]',
    '',
    '  install    --vault <absolute-path> --vault-mode <new|existing>',
    '             [--components <core|core,clip,observe,sunday,watch|all>] [--watch-root <absolute-path>]',
    '             [--deepseek-key-file <0600-regular-file>] [--reuse-private-config] [--adopt-shims]',
    '             [--verify-online] [--non-interactive --yes]',
    '  doctor     [--online]',
    '  recover    report what an interrupted install left behind, and what to do about it',
    // Which of the pair is the default is the one thing a reader cannot guess,
    // and guessing wrong means expecting a git pull that never happened.
    '  upgrade    [--pull|--no-pull] [--adopt-shims] [--verify-online]   (--no-pull is the default)',
    '  uninstall  [--purge-config] [--purge-logs] [--non-interactive --yes]',
    '',
    'Exit codes: 0 done, 1 actionable problem (production unchanged), 2 unsafe path or refused takeover, 3 incomplete rollback.',
    'The DeepSeek key is never accepted as a command-line value; use --deepseek-key-file.',
    '',
  ].join('\n'));
}

function main(argv, overrides = {}) {
  const context = createContext(overrides);
  try {
    const { command, options } = parseArgs(argv);
    if (command === 'help') {
      printHelp(context);
      return EXIT.OK;
    }
    if (!IMPLEMENTED_COMMANDS.has(command)) {
      // Built from the set rather than restated, so it cannot go stale the way
      // it already had: it still named install and doctor after recover and
      // upgrade had landed.
      throw new InstallError(
        `${command} is not implemented yet; available commands are ${[...IMPLEMENTED_COMMANDS].sort().join(', ')}`,
      );
    }
    if (command === 'install') return runInstall(context, options);
    if (command === 'recover') return recoverInstall(context);
    if (command === 'upgrade') return runUpgrade(context, options);
    if (command === 'uninstall') return runUninstall(context, options);
    return runDoctor(context, options);
  } catch (error) {
    if (error instanceof InstallError) {
      process.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

export {
  ADOPTED_DIR,
  operationDigest,
  closeOut,
  commitTransaction,
  ARTIFACTS,
  EXIT,
  InstallError,
  TXN_SCHEMA,
  acquireLock,
  applyPlan,
  imageDigest,
  imageOf,
  infrastructureDirs,
  loadTransaction,
  operationState,
  managedShapes,
  settleTransaction,
  shapeOf,
  bootstrapBranch,
  buildPlan,
  createContext,
  defaultRouting,
  formatPlan,
  installStateFrom,
  installStatePath,
  judgeShim,
  main,
  nodeShimContent,
  normalizeAnswers,
  parseArgs,
  planDigest,
  preflight,
  protectedHits,
  publisherEnv,
  readInstallState,
  recoverInstall,
  COMMANDS,
  IMPLEMENTED_COMMANDS,
  // The judgement half of uninstall. Exported so its tests can assert on rows
  // rather than scraping the printed report -- the wording is a presentation
  // detail and coupling the gate to it made batch 2 red for no reason.
  uninstallPlan,
  // The write half of upgrade, exported for the tests that keep guarding it
  // while it is disabled. main() does not call it -- upgradePlan is what the
  // CLI reaches -- and an export is not a way back in from the command line.
  upgradeApply,
  // The same arrangement for uninstall's execution half, disabled after the
  // second review round. runUninstall stops at the plan; these two are what the
  // gates drive directly so the disabled code keeps being checked.
  uninstallExecute,
  executeUninstall,
  doctorAnswers,
  runWizard,
  shimMarker,
  writeInstallState,
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}

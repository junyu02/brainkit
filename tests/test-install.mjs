#!/usr/bin/env node

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadObserveEnv, parseEnvFile } from '../scripts/lib/plist-render.mjs';
import {
  ADOPTED_DIR,
  ARTIFACTS,
  EXIT,
  TXN_SCHEMA,
  acquireLock,
  applyPlan,
  buildPlan,
  closeOut as discardTransaction,
  commitTransaction,
  imageOf,
  operationDigest,
  infrastructureDirs,
  loadTransaction,
  managedShapes,
  settleTransaction,
  shapeOf,
  createContext,
  COMMANDS,
  IMPLEMENTED_COMMANDS,
  doctorAnswers,
  upgradeApply,
  formatPlan,
  installStateFrom,
  installStatePath,
  judgeShim,
  main,
  nodeShimContent,
  normalizeAnswers,
  operationState,
  parseArgs,
  planDigest,
  preflight,
  protectedHits,
  publisherEnv,
  readInstallState,
  recoverInstall,
  runWizard,
  shimMarker,
  writeInstallState,
} from '../install.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_TARGET = '/opt/brainkit-test/bin/node';
// Executable so the preflight's X_OK check passes, and loud if it is ever
// actually run: every test reaches launchctl through context.run, so a real
// exec of this file means the injection seam was bypassed.
const FAKE_BIN = mkdtempSync(join(tmpdir(), 'brainkit-launchctl-'));
const FAKE_HEAD = '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f';
const FAKE_LAUNCHCTL = join(FAKE_BIN, 'launchctl');
writeFileSync(FAKE_LAUNCHCTL, '#!/bin/sh\necho "tests must never exec launchctl" >&2\nexit 99\n', { mode: 0o755 });
chmodSync(FAKE_LAUNCHCTL, 0o755);
const WRAPPER_TEMPLATE = join(REPO_ROOT, 'templates', 'watch-wrapper.sh');
// For the few assertions that pin a literal the installer prints. A
// `doesNotMatch` on wording that has since changed passes for no reason, so
// those gates check the wording still exists before checking it is absent.
const installSource = readFileSync(join(REPO_ROOT, 'install.mjs'), 'utf8');

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'brainkit-install-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(join(home, '.config', 'second-brain'), { recursive: true, mode: 0o700 });
  return home;
}

// A PATH directory holding the two external tools the component preflight
// resolves for real: watch needs an absolute fswatch (it ends up in the plist)
// and clip needs a swiftc.
function fakeToolsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'brainkit-bin-'));
  for (const [name, body] of [['fswatch', 'echo 1.18.3'], ['swiftc', 'exit 0']]) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

// A stand-in for /bin/launchctl that models the one piece of state the
// installer reads back: which labels are loaded and from which plist. It is
// reached through context.run, so no test can fall through to the real one.
// `beforeFailure` fires the moment the install is about to fail, which is the
// moment before its rollback starts. Nothing else on that path gives a seam
// there: the failpoints all sit inside the closeout, after the rollback has
// already run. Tests that need the disk in a particular shape when the rollback
// begins set it up here.
function launchctlMock({ bootstrapFails = null, bootoutFails = null, beforeFailure = null } = {}) {
  const loaded = new Map();
  const calls = [];
  return {
    calls,
    loaded,
    answer(command, args) {
      if (command !== FAKE_LAUNCHCTL) return undefined;
      const [sub, target, plist] = args;
      calls.push(args.join(' '));
      const label = String(target || '').split('/').pop();
      if (sub === 'bootout') {
        // Status 1 rather than 5: 5 is retryable and would make a failure test
        // sit through the six-second backoff.
        if (bootoutFails === label) return { status: 1, stdout: '', stderr: 'Operation not permitted' };
        if (!loaded.has(label)) return { status: 3, stdout: '', stderr: 'No such process' };
        loaded.delete(label);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (sub === 'bootstrap') {
        const name = basename(String(plist || '')).replace(/\.plist$/, '');
        if (bootstrapFails === name) {
          beforeFailure?.();
          return { status: 1, stdout: '', stderr: 'Operation not permitted' };
        }
        loaded.set(name, plist);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (sub === 'print') {
        if (!loaded.has(label)) return { status: 113, stdout: '', stderr: 'Could not find specified service' };
        return { status: 0, stdout: `gui/501/${label} = {\n\tpath = ${loaded.get(label)}\n\tstate = running\n}\n`, stderr: '' };
      }
      return undefined;
    },
  };
}

function makeRun(custom = () => undefined, launchctl = launchctlMock()) {
  return (command, args = []) => {
    const answer = custom(command, args);
    if (answer) return { status: 0, stdout: '', stderr: '', ...answer };
    const service = launchctl.answer(command, args);
    if (service) return service;
    if (command === '/usr/bin/sw_vers') return { status: 0, stdout: '14.6\n', stderr: '' };
    if (command === '/bin/df') return { status: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity\n/dev/disk1 100 10 900000 1%\n', stderr: '' };
    // Two different rev-parse calls, and they are not interchangeable:
    // --is-inside-work-tree wants a boolean, HEAD wants a commit. Answering
    // both with "true" wrote the string "true" into installed_commit.
    if (command === 'git' && args.includes('rev-parse')) {
      return { status: 0, stdout: args.includes('HEAD') ? `${FAKE_HEAD}\n` : 'true\n', stderr: '' };
    }
    // The installed node shim is a shell script pointing at a target that does
    // not exist in a fixture, so its --version is answered here. Executing it
    // for real is asserted separately, against a shim whose target is this very
    // process, in the slice-4 verifyNodeShim case.
    if (String(command).endsWith(`${sep}brain-node`) && args[0] === '--version') return { status: 0, stdout: 'v22.11.0\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

function makeContext(home, overrides = {}) {
  return createContext({
    home,
    repoRoot: REPO_ROOT,
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v22.11.0',
    nodeTarget: NODE_TARGET,
    pathEnv: '',
    launchctlPath: FAKE_LAUNCHCTL,
    run: makeRun(),
    stdout: () => {},
    ...overrides,
  });
}

function baseAnswers(vault, extra = {}) {
  return normalizeAnswers({ vault, vaultMode: 'existing', components: 'core', ...extra });
}

function makeVault(home) {
  const vault = join(home, 'vault');
  mkdirSync(vault, { recursive: true });
  return vault;
}

function check(report, id) {
  return report.checks.find(entry => entry.id === id);
}

// --- shim takeover semantics (spec §2.3, §10.2) ----------------------------

test('shim takeover has four outcomes: create, idempotent, marked overwrite, unmarked adopt', () => {
  const home = makeHome();
  const path = join(home, '.local', 'bin', 'brain-node');
  const pending = Buffer.from(nodeShimContent(NODE_TARGET), 'utf8');
  // Read from the registry rather than written here, so this decision table is
  // exercised with the policy the installer actually ships.
  const takeover = ARTIFACTS.find(row => row.id === 'node-shim').takeover;
  const judge = extra => judgeShim({ path, pendingContent: pending, takeover, ...extra });

  assert.equal(judge().verdict, 'create');

  writeFileSync(path, pending, { mode: 0o700 });
  const idempotent = judge();
  assert.equal(idempotent.verdict, 'idempotent');
  assert.equal(idempotent.exit, EXIT.OK);
  assert.equal(idempotent.sha256, idempotent.pendingSha256);
  assert.equal(idempotent.mode, 0o700, 'the mode is part of the decision, not just the content');

  writeFileSync(path, '#!/bin/sh\n# brainkit-node-shim v1\nexec /old/node "$@"\n', { mode: 0o700 });
  const marked = judge();
  assert.equal(marked.verdict, 'overwrite');
  assert.equal(marked.exit, EXIT.OK);
  assert.equal(marked.marker, '# brainkit-node-shim v1');
  assert.equal(marked.retain, false, 'our own older version has another copy: the shipped one');

  writeFileSync(path, '#!/bin/sh\n# somebody elses node wrapper\nexec /usr/bin/node "$@"\n', { mode: 0o700 });
  const refused = judge();
  assert.equal(refused.verdict, 'adopt-required');
  assert.equal(refused.exit, EXIT.UNSAFE);
  assert.equal(refused.marker, null);

  const adopted = judge({ adoptShims: true });
  assert.equal(adopted.verdict, 'adopt');
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.retain, true, 'retain is decided here, so no call site has to re-derive it');
  assert.equal(adopted.exit, EXIT.OK);

  // The same unmarked file under any other policy: refused outright, and
  // --adopt-shims does not unlock it. An absent policy refuses too, so a new
  // registry row has to opt in rather than inherit adoptability.
  for (const policy of ['forbid', undefined, null]) {
    for (const adoptShims of [false, true]) {
      const forbidden = judgeShim({ path, pendingContent: pending, takeover: policy, adoptShims });
      assert.equal(forbidden.verdict, 'takeover-forbidden', `policy=${policy} adoptShims=${adoptShims}`);
      assert.equal(forbidden.exit, EXIT.UNSAFE);
      assert.equal(forbidden.retain, false);
    }
  }
});

test('a symlink in the shim directory is refused rather than followed', () => {
  const home = makeHome();
  const path = join(home, '.local', 'bin', 'brain-node');
  symlinkSync('/usr/bin/true', path);
  const verdict = judgeShim({ path, pendingContent: Buffer.from('#!/bin/sh\n') });
  assert.equal(verdict.verdict, 'unsafe');
  assert.equal(verdict.exit, EXIT.UNSAFE);
});

test('the marker is the first non-shebang line and must match the brainkit pattern', () => {
  assert.equal(shimMarker('#!/bin/sh\n# brainkit-watch-wrapper v1\nset -eu\n'), '# brainkit-watch-wrapper v1');
  assert.equal(shimMarker('#!/bin/sh\nset -eu\n# brainkit-watch-wrapper v1\n'), null);
  assert.equal(shimMarker('#!/bin/sh\n# brain-node — stable node entrypoint\n'), null);
});

test('the node shim is frozen, never self-resolving, and refuses unquotable targets', () => {
  const content = nodeShimContent(NODE_TARGET);
  assert.equal(content.split('\n')[1], '# brainkit-node-shim v2');
  assert.match(content, /^TARGET='\/opt\/brainkit-test\/bin\/node'$/m);
  assert.doesNotMatch(content, /\bls\b|\bsort\b|\btail\b|exec node/);
  assert.match(content, /exit 78/);
  assert.throws(() => nodeShimContent("/tmp/it's/node"), /single quote/);
});

// --- install state (spec §4.4) ---------------------------------------------

test('install state round-trips through a private 0600 file and rejects foreign schemas', () => {
  const home = makeHome();
  const path = installStatePath(home);
  assert.equal(readInstallState(home), null);

  const state = {
    schema: 1,
    status: 'installed',
    repo_root: REPO_ROOT,
    vault_root: join(home, 'vault'),
    installed_commit: 'deadbeef',
    components: ['core', 'watch'],
    watch_root: null,
    plists: { clip: null, observe: null, sunday: null, watch: '/x.plist' },
    shims: {
      node: { path: join(home, '.local/bin/brain-node'), sha256: 'a', target: NODE_TARGET, adopted: false },
      wrapper: { path: join(home, '.local/bin/brain-watch-wrapper.sh'), sha256: 'b', template_sha256: 'b', adopted: true },
    },
    artifacts: {},
    managed_files: [],
    tcc_warning: { protected_prefix: '~/Library/Mobile Documents/', terminal_probe: 'ok' },
    last_txn: 'abc',
  };
  writeInstallState(home, state);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const loaded = readInstallState(home);
  assert.deepEqual(loaded, state);
  assert.equal(loaded.shims.wrapper.adopted, true);
  assert.equal(loaded.tcc_warning.terminal_probe, 'ok');

  writeFileSync(path, JSON.stringify({ schema: 2, status: 'installed', repo_root: '/a', vault_root: '/b' }), { mode: 0o600 });
  assert.throws(() => readInstallState(home), /unsupported schema/);
  writeFileSync(path, JSON.stringify({ schema: 1, status: 'weird', repo_root: '/a', vault_root: '/b' }), { mode: 0o600 });
  assert.throws(() => readInstallState(home), /unknown status/);
  assert.throws(() => writeInstallState(home, { schema: 1, status: 'weird' }), /unknown install state status/);
});

// --- argument contract (spec §3.3, §9.2) ------------------------------------

test('the CLI has no --deepseek-key flag and never echoes an inline secret', () => {
  assert.throws(() => parseArgs(['install', '--deepseek-key', 'sk-live-abc']), error =>
    /unknown flag for install: --deepseek-key$/.test(error.message) && !error.message.includes('sk-live-abc'));
  assert.throws(() => parseArgs(['install', '--deepseek-key=sk-live-abc']), error =>
    !error.message.includes('sk-live-abc'));
  assert.throws(() => parseArgs(['install', '--vault']), /--vault requires a value/);
  assert.throws(() => parseArgs(['bootstrap']), /unknown command: bootstrap/);
  assert.deepEqual(parseArgs([]), { command: 'help' });
  assert.deepEqual(parseArgs(['doctor', '--online']), { command: 'doctor', options: { online: true } });
});

test('flag answers and wizard answers normalize to the same plan input', () => {
  const fromFlags = normalizeAnswers(parseArgs([
    'install', '--vault', '/tmp/v', '--vault-mode', 'existing', '--components', 'watch,core', '--watch-root', '/tmp/v/raw',
  ]).options);
  const fromWizard = normalizeAnswers({ vault: '/tmp/v', vaultMode: 'existing', components: 'core,watch', watchRoot: '/tmp/v/raw' });
  assert.deepEqual(fromFlags, fromWizard);
  assert.deepEqual(fromFlags.components, ['core', 'watch']);
  assert.deepEqual(normalizeAnswers({ vault: '/tmp/v', vaultMode: 'new', components: 'all', watchRoot: '/tmp/v/raw' }).components,
    ['core', 'clip', 'observe', 'sunday', 'watch']);
});

test('missing or relative selections are refused before any write', () => {
  assert.throws(() => normalizeAnswers({ vaultMode: 'new' }), /--vault is required/);
  assert.throws(() => normalizeAnswers({ vault: 'relative/path', vaultMode: 'new' }), error => error.exitCode === EXIT.UNSAFE);
  assert.throws(() => normalizeAnswers({ vault: '/tmp/v' }), /--vault-mode/);
  assert.throws(() => normalizeAnswers({ vault: '/tmp/v', vaultMode: 'new', components: 'watch' }), /--watch-root is required/);
  assert.throws(() => normalizeAnswers({ vault: '/tmp/v', vaultMode: 'new', components: 'nope' }), /unknown component: nope/);

  const home = makeHome();
  const code = main(['install', '--vault', join(home, 'vault')], { home, repoRoot: REPO_ROOT, stdout: () => {} });
  assert.equal(code, EXIT.ACTIONABLE);
  assert.deepEqual(readdirSync(join(home, '.config', 'second-brain')), []);
  assert.equal(existsSync(installStatePath(home)), false);
});

// --- TCC (spec §2.3, §10.2) -------------------------------------------------

test('protected prefixes match on path components, not string prefixes', () => {
  const home = '/Users/x';
  assert.deepEqual(protectedHits(home, ['/Users/x/Desktop/vault']), ['/Users/x/Desktop']);
  assert.deepEqual(protectedHits(home, ['/Users/x/Desktopfoo/vault']), []);
  assert.deepEqual(protectedHits(home, ['/Users/x/Library/Mobile Documents/iCloud~md~obsidian/Documents/v']), ['/Users/x/Library/Mobile Documents']);
  assert.deepEqual(protectedHits(home, ['/Users/x/code/vault']), []);
});

test('a protected vault always warns and the terminal probe never gates the verdict', () => {
  const home = makeHome();
  const vault = join(home, 'Desktop', 'vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'brain-node'), nodeShimContent(NODE_TARGET), { mode: 0o700 });

  // The probe reads the vault in-process, so denial is produced by making the
  // directory genuinely unreadable rather than by faking a subprocess result.
  //
  // 0o300 rather than 0o000, so the two fixtures differ in the one dimension
  // this case is about. The probe is a readdir, which -wx denies; every other
  // vault check stats named paths, which -wx still allows. At 0o000 the schema
  // check could not stat anything either, so the verdicts below differed for a
  // reason that had nothing to do with the probe.
  const passing = preflight(makeContext(home), baseAnswers(vault));
  const deniedVault = join(home, 'Desktop', 'locked');
  mkdirSync(deniedVault, { recursive: true });
  chmodSync(deniedVault, 0o300);
  const denied = preflight(makeContext(home), baseAnswers(deniedVault));
  chmodSync(deniedVault, 0o700);

  assert.equal(passing.tcc.terminal_probe, 'ok');
  assert.equal(denied.tcc.terminal_probe, 'eperm');
  assert.equal(passing.exitCode, denied.exitCode, 'the probe result must not move the preflight verdict');
  for (const report of [passing, denied]) {
    const tcc = check(report, 'tcc');
    assert.equal(tcc.level, 'warn');
    assert.equal(tcc.exit, EXIT.OK);
    assert.match(tcc.message, /Full Disk Access/);
    assert.match(tcc.message, /node install\.mjs doctor/);
    assert.match(tcc.message, /does NOT mean the background service can read the vault/);
    assert.match(tcc.message, /daemon\.log/);
  }
  assert.equal(passing.tcc.protected_prefix, '~/Desktop/');
});

test('a vault outside every protected prefix reports no TCC warning', () => {
  const home = makeHome();
  const report = preflight(makeContext(home), baseAnswers(makeVault(home)));
  assert.equal(check(report, 'tcc').level, 'ok');
  assert.equal(report.tcc.terminal_probe, 'skipped');
  assert.equal(report.exitCode, EXIT.OK);
});

// --- preflight rejections (spec §2.3, §10.2) --------------------------------

test('preflight refuses a non-Darwin host, an old macOS, an old Node and a dirty worktree', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const answers = baseAnswers(vault);

  const linux = preflight(makeContext(home, { platform: 'linux' }), answers);
  assert.equal(check(linux, 'platform').level, 'error');
  assert.equal(linux.exitCode, EXIT.ACTIONABLE);
  assert.equal(check(linux, 'launch-tools'), undefined, 'launchd checks must not run off-Darwin');

  const oldMac = preflight(makeContext(home, { run: makeRun(command => (command === '/usr/bin/sw_vers' ? { stdout: '13.6\n' } : undefined)) }), answers);
  assert.match(check(oldMac, 'platform').message, /macOS 14 or newer/);

  const oldNode = preflight(makeContext(home, { nodeVersion: 'v20.11.0' }), answers);
  assert.match(check(oldNode, 'node').message, /Node >=22 is required/);
  assert.equal(oldNode.exitCode, EXIT.ACTIONABLE);

  const dirty = preflight(makeContext(home, {
    run: makeRun((command, args) => (command === 'git' && args.includes('status') ? { stdout: ' M install.mjs\n' } : undefined)),
  }), answers);
  assert.match(check(dirty, 'git').message, /not clean/);

  const intel = preflight(makeContext(home, { arch: 'x64' }), answers);
  assert.equal(check(intel, 'platform').level, 'warn');
  assert.equal(intel.exitCode, EXIT.OK, 'Intel is best-effort, not a hard stop');
});

test('component dependencies are only probed for the components that need them', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const bare = preflight(makeContext(home), baseAnswers(vault));
  assert.equal(check(bare, 'fswatch'), undefined);
  assert.equal(check(bare, 'swiftc'), undefined);

  const watch = preflight(makeContext(home), baseAnswers(vault, { components: 'watch', watchRoot: join(vault, 'raw') }));
  assert.match(check(watch, 'fswatch').message, /brew install fswatch/);
  assert.equal(watch.exitCode, EXIT.ACTIONABLE);

  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  const fswatch = join(binDir, 'fswatch');
  writeFileSync(fswatch, '#!/bin/sh\n', { mode: 0o755 });
  const found = preflight(makeContext(home, { pathEnv: binDir }), baseAnswers(vault, { components: 'watch', watchRoot: join(vault, 'raw') }));
  assert.equal(check(found, 'fswatch').level, 'ok');
  assert.match(check(found, 'watch-root').message, /must be an existing directory/, 'a watch root that does not exist would fail silently at runtime');
  mkdirSync(join(vault, 'raw'));
  const rooted = preflight(makeContext(home, { pathEnv: binDir }), baseAnswers(vault, { components: 'watch', watchRoot: join(vault, 'raw') }));
  assert.equal(check(rooted, 'watch-root').level, 'ok');
  assert.equal(rooted.exitCode, EXIT.OK);

  const clip = preflight(makeContext(home, {
    run: makeRun((command, args) => (command === 'xcrun' && args[1] === 'swiftc' ? { status: 1, stderr: 'not found\n' } : undefined)),
  }), baseAnswers(vault, { components: 'clip', keyFile: null, reusePrivateConfig: false }));
  assert.match(check(clip, 'swiftc').message, /xcode-select --install/);

  // xcrun first, PATH second. An xcrun that exits 0 but names nothing has not
  // found a compiler, and treating its empty answer as final skipped the
  // fallback that §2.3 puts second.
  const viaXcrun = preflight(makeContext(home, {
    run: makeRun((command, args) => (command === 'xcrun' && args[1] === 'swiftc' ? { status: 0, stdout: '/usr/bin/swiftc\n' } : undefined)),
  }), baseAnswers(vault, { components: 'clip', reusePrivateConfig: true }));
  assert.match(check(viaXcrun, 'swiftc').message, /swiftc at \/usr\/bin\/swiftc/);

  const viaPath = preflight(makeContext(home, { pathEnv: fakeToolsDir() }),
    baseAnswers(vault, { components: 'clip', reusePrivateConfig: true }));
  assert.equal(check(viaPath, 'swiftc').level, 'ok');
  assert.match(check(viaPath, 'swiftc').message, /brainkit-bin-/, 'an empty xcrun answer must fall through to PATH');
});

test('an LLM component without a key source stops preflight, and a key file is validated without being read', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const noKey = preflight(makeContext(home), baseAnswers(vault, { components: 'observe' }));
  assert.match(check(noKey, 'deepseek-key').message, /never accepted on the command line/);
  assert.equal(noKey.exitCode, EXIT.ACTIONABLE);

  const keyFile = join(home, 'key.txt');
  writeFileSync(keyFile, 'sk-live-should-never-be-printed\n', { mode: 0o644 });
  const loose = preflight(makeContext(home), baseAnswers(vault, { components: 'observe', keyFile }));
  assert.equal(check(loose, 'deepseek-key').exit, EXIT.UNSAFE);
  assert.match(check(loose, 'deepseek-key').message, /mode must be 0600/);

  chmodSync(keyFile, 0o600);
  const ok = preflight(makeContext(home), baseAnswers(vault, { components: 'observe', keyFile }));
  const message = check(ok, 'deepseek-key').message;
  assert.equal(check(ok, 'deepseek-key').level, 'ok');
  assert.doesNotMatch(message, /sk-live/);
});

test('an existing installed state sends install to upgrade but leaves doctor alone', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const state = {
    schema: 1,
    status: 'installed',
    repo_root: REPO_ROOT,
    vault_root: vault,
    installed_commit: 'abc1234',
    components: ['core'],
  };
  writeInstallState(home, state);
  const answers = baseAnswers(vault);
  const install = preflight(makeContext(home), answers, { command: 'install' });
  assert.match(check(install, 'install-state').message, /node install\.mjs upgrade/);
  assert.equal(install.exitCode, EXIT.ACTIONABLE);
  const doctor = preflight(makeContext(home), answers, { command: 'doctor' });
  assert.equal(check(doctor, 'install-state').level, 'ok');
  assert.equal(doctor.exitCode, EXIT.OK);
});

// --- plan (spec §3.2 item 6, §5.1 step 1) -----------------------------------

test('the plan names both shim paths with their takeover verdicts and no secret values', () => {
  const home = makeHome();
  const vault = join(home, 'Desktop', 'vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'brain-node'), '#!/bin/sh\n# not ours\nexec node "$@"\n', { mode: 0o700 });
  const keyFile = join(home, 'key.txt');
  writeFileSync(keyFile, 'sk-live-should-never-be-printed\n', { mode: 0o600 });

  const answers = baseAnswers(vault, { components: 'clip,watch', watchRoot: join(vault, 'raw'), keyFile, adoptShims: true });
  const context = makeContext(home);
  const report = preflight(context, answers);
  const plan = buildPlan(context, answers, report);
  const text = formatPlan(plan, home);

  assert.deepEqual(plan.shims.map(shim => shim.id), ['node', 'wrapper']);
  assert.equal(plan.shims[0].verdict, 'adopt');
  assert.equal(plan.shims[0].adopted, true);
  assert.equal(plan.shims[1].verdict, 'create');
  assert.match(text, /~\/\.local\/bin\/brain-node -- unmarked file adopted via --adopt-shims/);
  assert.match(text, /~\/\.local\/bin\/brain-watch-wrapper\.sh -- new file/);
  assert.match(text, /~\/Library\/LaunchAgents\/com\.second-brain\.clip\.plist/);
  assert.match(text, /~\/Library\/LaunchAgents\/com\.second-brain\.watch\.plist/);
  assert.match(text, /vault \(input\)\s*: /);
  assert.match(text, /vault \(real\)\s*: /);
  assert.match(text, new RegExp(`frozen node\\s*: ${NODE_TARGET}`));
  assert.match(text, /DeepSeek key\s*: key-file/);
  assert.doesNotMatch(text, /sk-live/);
  assert.deepEqual(plan.config_files.map(file => file.split('/').pop()).sort(),
    ['brainkit.conf', 'clip.env', 'install-state.json', 'vault-routing.json']);
  // The probe runs the verified node target, so an unmarked third-party shim
  // sitting at the shim path does not affect it either way (see S3 P1-R2-1).
  assert.equal(plan.tcc.terminal_probe, 'ok');
});

test('an unmarked shim without --adopt-shims exits 2 and the plan says so', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const shim = join(home, '.local', 'bin', 'brain-node');
  writeFileSync(shim, '#!/bin/sh\n# not ours\nexec node "$@"\n', { mode: 0o700 });
  const answers = baseAnswers(vault);
  const context = makeContext(home);
  const report = preflight(context, answers);
  assert.equal(report.exitCode, EXIT.UNSAFE);
  assert.match(check(report, 'shims').message, /--adopt-shims/);
  assert.match(formatPlan(buildPlan(context, answers, report), home), /re-run with --adopt-shims/);

  // Spec §10.2 case 3 is "exits 2 AND does not overwrite". The exit code was
  // asserted; the second half was not. Driven through main() rather than
  // preflight so the claim covers the whole command, not the stage that
  // happens not to write.
  const before = fileFacts(shim);
  assert.equal(main(['install', '--vault', vault, '--vault-mode', 'existing', '--non-interactive', '--yes'],
    { ...context, stdout: () => {} }), EXIT.UNSAFE);
  assert.deepEqual(fileFacts(shim), before, 'the third-party file must be untouched, bytes and mode');
});

test('install without --yes stops at the plan and writes nothing', () => {
  const home = makeHome();
  const vault = makeVault(home);
  let output = '';
  const overrides = { home, repoRoot: REPO_ROOT, platform: 'darwin', arch: 'arm64', nodeTarget: NODE_TARGET, pathEnv: '', run: makeRun(), stdout: text => { output += text; } };
  const before = managedSnapshot(home, vault);
  assert.equal(main(['install', '--vault', vault, '--vault-mode', 'existing'], overrides), EXIT.ACTIONABLE);
  assert.match(output, /Re-run with --yes/);
  assert.deepEqual(managedSnapshot(home, vault), before, 'every managed root is untouched without --yes');
});

// --- S3 review regressions (P1-1..P1-4, P2-1) -------------------------------

test('S3 P1-1: a symlinked node shim is never executed by the TCC probe', () => {
  const home = makeHome();
  const vault = join(home, 'Desktop', 'vault');
  mkdirSync(vault, { recursive: true });
  // A symlink whose target carries a valid marker: the pre-fix order read the
  // target through the link and ran it before judgeShim could reject it.
  const target = join(home, 'marked-target');
  writeFileSync(target, nodeShimContent(NODE_TARGET), { mode: 0o700 });
  symlinkSync(target, join(home, '.local', 'bin', 'brain-node'));

  const attempted = [];
  const report = preflight(makeContext(home, {
    run: makeRun(command => {
      if (command.endsWith('brain-node') || command === target) attempted.push(command);
      return undefined;
    }),
  }), baseAnswers(vault));

  assert.deepEqual(attempted, [], 'preflight must not execute a symlinked shim');
  assert.equal(report.tcc.terminal_probe, 'ok', 'the probe runs the verified node target, not the shim');
  assert.equal(report.exitCode, EXIT.UNSAFE);
  assert.match(check(report, 'shims').message, /symlink or not a regular file/);
  assert.ok(
    report.checks.findIndex(entry => entry.id === 'shims') < report.checks.findIndex(entry => entry.id === 'tcc'),
    'the shim verdict must be settled before the TCC probe runs',
  );
});

test('S3 P1-2: a symlinked shim directory or config directory exits 2 and blocks the state write', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const elsewhere = mkdtempSync(join(tmpdir(), 'brainkit-elsewhere-'));

  rmSync(join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(elsewhere, join(home, '.local', 'bin'));
  const shimEscape = preflight(makeContext(home), baseAnswers(vault));
  assert.equal(shimEscape.exitCode, EXIT.UNSAFE);
  assert.match(check(shimEscape, 'shims').message, /symlinked component/);

  const config = join(home, '.config', 'second-brain');
  rmSync(config, { recursive: true });
  symlinkSync(elsewhere, config);
  const state = { schema: 1, status: 'installed', repo_root: REPO_ROOT, vault_root: vault };
  assert.throws(() => writeInstallState(home, state), error =>
    error.exitCode === EXIT.UNSAFE && /symlinked component/.test(error.message));
  assert.equal(existsSync(join(elsewhere, 'install-state.json')), false, 'nothing may land outside the lexical config root');
  assert.throws(() => readInstallState(home), error => error.exitCode === EXIT.UNSAFE);
  assert.equal(check(preflight(makeContext(home), baseAnswers(vault)), 'config-root').exit, EXIT.UNSAFE);
});

test('S3 P1-3: --reuse-private-config rejects a plain-http base URL', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const observe = join(home, '.config', 'second-brain', 'observe.env');
  writeFileSync(observe, 'OPENAI_API_KEY=sk-test123\nOPENAI_BASE_URL=http://evil.example/v1\n', { mode: 0o600 });

  const answers = baseAnswers(vault, { components: 'observe', reusePrivateConfig: true });
  const external = preflight(makeContext(home), answers);
  assert.equal(external.exitCode, EXIT.UNSAFE);
  assert.match(check(external, 'deepseek-key').message, /https/);

  writeFileSync(observe, 'OPENAI_API_KEY=sk-test123\nOPENAI_BASE_URL=https://api.deepseek.com\n', { mode: 0o600 });
  const secure = preflight(makeContext(home), answers);
  assert.equal(check(secure, 'deepseek-key').level, 'ok');
  assert.doesNotMatch(check(secure, 'deepseek-key').message, /sk-test123/);
});

test('S3 P1-4: a non-terminal install state blocks install instead of warning', () => {
  const home = makeHome();
  const vault = makeVault(home);
  for (const status of ['recovery-required', 'installing', 'uninstalling']) {
    writeInstallState(home, {
      schema: 1, status, repo_root: REPO_ROOT, vault_root: vault,
    });
    const report = preflight(makeContext(home), baseAnswers(vault), { command: 'install' });
    assert.equal(check(report, 'install-state').level, 'error', `${status} must block`);
    assert.notEqual(report.exitCode, EXIT.OK, `${status} must not exit 0`);
    assert.match(check(report, 'install-state').message, /node install\.mjs recover/,
      'the block must name the way out, not just refuse');
  }
});

test('S3 P2-1: doctor verifies existing private config instead of demanding a key', () => {
  const home = makeHome();
  const vault = makeVault(home);
  writeFileSync(join(home, '.config', 'second-brain', 'observe.env'),
    'OPENAI_API_KEY=sk-test123\nOPENAI_BASE_URL=https://api.deepseek.com\n', { mode: 0o600 });
  writeInstallState(home, {
    schema: 1, status: 'installed', repo_root: REPO_ROOT, vault_root: vault,
    installed_commit: 'abc1234', components: ['core', 'observe'],
  });
  const answers = baseAnswers(vault, { components: 'core,observe' });

  const doctor = preflight(makeContext(home), answers, { command: 'doctor' });
  assert.equal(check(doctor, 'deepseek-key').level, 'ok');
  assert.equal(doctor.exitCode, EXIT.OK);
  assert.equal(doctor.keySource.source, 'existing-private-config');

  const install = preflight(makeContext(home), answers, { command: 'install' });
  assert.equal(check(install, 'deepseek-key').level, 'error', 'install still requires an explicit key source');
});

// --- S3 round-2 regressions (P1-R2-1..P1-R2-3) ------------------------------

test('S3 R3-1: the TCC probe spawns nothing at all', () => {
  const home = makeHome();
  const vault = join(home, 'Desktop', 'vault');
  mkdirSync(vault, { recursive: true });
  const shimPath = join(home, '.local', 'bin', 'brain-node');
  // Byte-identical, so the shim earns the most trusted verdict there is.
  writeFileSync(shimPath, nodeShimContent(NODE_TARGET), { mode: 0o700 });
  const swapTarget = join(home, 'attacker-target');
  writeFileSync(swapTarget, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const spawned = [];
  const report = preflight(makeContext(home, {
    run: makeRun(command => {
      spawned.push(command);
      // Swap the shim at every command boundary: a path-based probe would
      // re-resolve the name here, after the verdict was taken.
      if (existsSync(shimPath)) {
        rmSync(shimPath);
        symlinkSync(swapTarget, shimPath);
      }
      return undefined;
    }),
  }), baseAnswers(vault));

  // The probe reads the vault in this process, so no pathname is re-resolved
  // at exec time -- neither the shim's nor the node binary's.
  assert.equal(spawned.includes(shimPath), false, 'the shim pathname must never be spawned');
  assert.equal(spawned.includes(swapTarget), false, 'the swapped target must never be executed');
  assert.equal(spawned.includes(NODE_TARGET), false, 'the probe must not spawn a node binary either');
  assert.equal(report.tcc.terminal_probe, 'ok');
});

test('S3 R3-2: the config root is re-checked immediately before any env loader runs', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const configRoot = join(home, '.config', 'second-brain');
  const outside = mkdtempSync(join(tmpdir(), 'brainkit-outside-'));
  writeFileSync(join(outside, 'observe.env'),
    'OPENAI_API_KEY=sk-test123\nOPENAI_BASE_URL=https://api.deepseek.com\n', { mode: 0o600 });
  // A local file that parses, so preflight's opening config-root check passes
  // and the swap below is the only thing the late lstat can catch.
  writeFileSync(join(configRoot, 'observe.env'),
    'OPENAI_API_KEY=sk-local\nOPENAI_BASE_URL=https://api.deepseek.com\n', { mode: 0o600 });

  let swapped = false;
  const report = preflight(makeContext(home, {
    run: makeRun(() => {
      // Swap the root after preflight's initial verdict, before checkSecretSource.
      if (!swapped) {
        swapped = true;
        rmSync(configRoot, { recursive: true });
        symlinkSync(outside, configRoot);
      }
      return undefined;
    }),
  }), baseAnswers(vault, { components: 'observe', reusePrivateConfig: true }));

  assert.equal(check(report, 'config-root'), undefined, 'the opening check must have passed for this to be meaningful');
  assert.equal(check(report, 'deepseek-key').level, 'error', 'the late lstat must catch the swapped root');
  assert.match(check(report, 'deepseek-key').message, /symlinked component/);
  assert.equal(report.keySource, null, 'no outside credential file may be recorded as validated');
});

test('S3 P1-R2-2: a rejected config root stops every loader under it', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const outside = mkdtempSync(join(tmpdir(), 'brainkit-outside-'));
  // Valid on its own terms: if any loader ran, the check would report ok.
  writeFileSync(join(outside, 'observe.env'),
    'OPENAI_API_KEY=sk-test123\nOPENAI_BASE_URL=https://api.deepseek.com\n', { mode: 0o600 });
  rmSync(join(home, '.config', 'second-brain'), { recursive: true });
  symlinkSync(outside, join(home, '.config', 'second-brain'));

  for (const [label, extra] of [
    ['reuse', { components: 'observe', reusePrivateConfig: true }],
    ['doctor', { components: 'observe' }],
  ]) {
    const report = preflight(makeContext(home), baseAnswers(vault, extra), { command: label === 'doctor' ? 'doctor' : 'install' });
    assert.equal(check(report, 'config-root').exit, EXIT.UNSAFE, `${label}: root must be rejected`);
    assert.equal(check(report, 'deepseek-key').level, 'error', `${label}: outside config must not be validated`);
    assert.match(check(report, 'deepseek-key').message, /was rejected above/);
    assert.equal(report.keySource, null, `${label}: no key source may be recorded`);
  }
});

test('S3 P1-R2-3: a FIFO private config is refused in bounded time', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const fifo = join(home, '.config', 'second-brain', 'observe.env');
  assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', fifo]).status, 0, 'mkfifo must succeed');

  // Bounded in a child process: a regression blocks the open forever, which
  // would hang the suite rather than fail this case.
  const child = spawnSync(process.execPath, [
    '-e',
    'import("./install.mjs").then(m => {'
    + ' const [home, vault] = process.argv.slice(1);'
    + ' const context = m.createContext({ home, platform: "darwin", arch: "arm64", pathEnv: "",'
    + '   run: (c, a) => c === "/usr/bin/sw_vers" ? { status: 0, stdout: "14.6\\n", stderr: "" } : { status: 0, stdout: "true\\n", stderr: "" },'
    + '   stdout: () => {} });'
    + ' const answers = m.normalizeAnswers({ vault, vaultMode: "existing", components: "observe", reusePrivateConfig: true });'
    + ' const report = m.preflight(context, answers);'
    + ' const key = report.checks.find(c => c.id === "deepseek-key");'
    + ' process.stdout.write(key.level + ":" + key.message); })',
    home, vault,
  ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 5000 });

  assert.notEqual(child.signal, 'SIGTERM', 'preflight blocked past the timeout instead of refusing the FIFO');
  assert.match(child.stdout, /^error:.*must be a regular non-symlink file/);
});

// --- slice 3: config write, vault schema, bootstrap branches ----------------

// A publisher stand-in that records its argv, so a test can assert which
// subcommands ran and in what order.
const CHECK_EXIT = { clean: 0, 'repo-ahead': 1, 'repo-new': 1, 'same-change': 1, 'vault-ahead': 2, conflict: 2 };

function publisherMock({ checkState = 'clean', bootstrapStatus = 1, bootstrapSignal = null, checkStatus = null } = {}, fallback = makeRun()) {
  const calls = [];
  // Mirrors publish.mjs: one record line per target, then the summary, whose
  // exitCode matches the process status unless a test deliberately breaks it.
  const output = (state, exitCode) => [
    JSON.stringify({ type: 'record', source: 'scripts/cli/brain-write.mjs', target: '00-系统/scripts/cli/brain-write.mjs', state }),
    JSON.stringify({ type: 'summary', state, exitCode, counts: { [state]: 1 } }),
    '',
  ].join('\n');
  return {
    calls,
    run: (command, args = [], options) => {
      // One fallback for the whole fixture, not a fresh one per call: the
      // launchctl stand-in keeps state, and rebuilding it each time would make
      // every service look unloaded no matter what just happened to it.
      if (!String(args[0] || '').endsWith('publish.mjs')) return fallback(command, args, options);
      const sub = args[1] ?? 'publish';
      calls.push({ sub, env: options?.env ?? {} });
      if (sub === '--bootstrap') return { status: bootstrapSignal ? null : bootstrapStatus, signal: bootstrapSignal, stdout: output('repo-new', 1), stderr: '' };
      if (sub === '--check') {
        const status = checkStatus ?? CHECK_EXIT[checkState] ?? 0;
        return { status, stdout: output(checkState, CHECK_EXIT[checkState] ?? 0), stderr: '' };
      }
      return { status: 0, stdout: output('clean', 0), stderr: '' };
    },
  };
}

function installFixture(overrides = {}) {
  const home = overrides.home ?? makeHome();
  const vault = join(home, 'vault');
  const launchctl = overrides.launchctl ?? launchctlMock();
  const publisher = publisherMock(overrides.publisher, makeRun(() => undefined, launchctl));
  const context = makeContext(home, {
    run: publisher.run,
    env: { PATH: '/usr/bin', BRAIN_VAULT_ROOT: '/leak', NODE_ENV: 'test', BRAIN_PUBLISH_CONF: '/leak.conf' },
    ...overrides.context,
  });
  const answers = normalizeAnswers({ vault, vaultMode: 'new', components: 'core', ...overrides.answers });
  return { home, vault, context, answers, publisher, launchctl };
}

// A fixture for an arbitrary component selection: watch needs a real fswatch on
// PATH and a directory to watch, the three LLM components need a key file.
function selectionFixture(components, overrides = {}) {
  const home = overrides.home ?? makeHome();
  const named = components === 'all' ? ['clip', 'observe', 'sunday', 'watch'] : components.split(',').map(name => name.trim());
  const answers = { components };
  if (named.includes('watch')) {
    answers.watchRoot = join(home, 'watched');
    mkdirSync(answers.watchRoot, { recursive: true });
  }
  if (named.some(name => ['clip', 'observe', 'sunday'].includes(name))) {
    answers.keyFile = join(home, 'key.txt');
    writeFileSync(answers.keyFile, 'sk-fixture\n', { mode: 0o600 });
    chmodSync(answers.keyFile, 0o600);
  }
  return installFixture({
    ...overrides,
    home,
    context: { pathEnv: fakeToolsDir(), ...overrides.context },
    answers: { ...answers, ...overrides.answers },
  });
}

function readManifest(home, id) {
  return JSON.parse(readFileSync(join(home, '.config', 'second-brain', 'recovery', id, 'transaction.json'), 'utf8'));
}

// Hand-built manifest entries have to be internally valid, or a test aimed at
// one rule gets stopped by another. These build the real shape from the real
// file, so a fixture exercises the check it is named for.
// Hand-built operations have to be internally valid, or a test aimed at one
// rule gets stopped by another. These build the real shape from the real file.
function operation(fields) {
  const shaped = { kind: 'file', pre: null, post: null, backup: null, retain: false, ...fields };
  return { ...shaped, digest: operationDigest(shaped) };
}

function createdEntry(path) {
  const stat = statSync(path);
  return operation({ kind: 'file', path, post: imageOf(readFileSync(path), { mode: stat.mode, uid: stat.uid }) });
}

function dirEntry(path) {
  const stat = lstatSync(path);
  return operation({
    kind: 'dir',
    path,
    post: { mode: stat.mode & 0o777, identity: { dev: stat.dev, ino: stat.ino, birthtimeMs: Math.round(stat.birthtimeMs) } },
  });
}

// The four views the manifest used to keep as separate arrays.
const createdOps = manifest => manifest.operations.filter(op => op.kind === 'file' && op.pre === null && op.post !== null);
const backupOps = manifest => manifest.operations.filter(op => op.backup !== null);
const dirOps = manifest => manifest.operations.filter(op => op.kind === 'dir');

// Everything a transaction brought into being or took a copy of, which is the
// set an authorisation has to match. Backup targets count: an overwritten file
// is just as much this transaction's business as one it created.
function producedPaths(manifest) {
  return new Set(manifest.operations.map(entry => entry.path));
}

function authorisedPaths(shapes) {
  const out = [];
  for (const shape of shapes) {
    for (const inner of shape.files) out.push(join(shape.root, inner));
    for (const inner of shape.dirs) out.push(inner === '' ? shape.root : join(shape.root, inner));
  }
  return out;
}

function fileFacts(path) {
  const stat = lstatSafe(path);
  if (!stat) return { present: false };
  return {
    present: true,
    mode: stat.mode & 0o777,
    uid: stat.uid,
    symlink: stat.isSymbolicLink(),
    sha256: stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null,
  };
}

test('slice 3: a new-vault install writes config, schema and state, and scrubs the publisher env', () => {
  const { home, vault, context, answers, publisher } = installFixture();
  const report = preflight(context, answers);
  assert.equal(report.exitCode, EXIT.OK);
  const applied = applyPlan(context, answers, report, { yes: true }, null);

  assert.equal(applied.branch, 'A');
  assert.deepEqual(publisher.calls.map(call => call.sub), ['--bootstrap', '--check', 'publish']);
  for (const key of ['BRAIN_VAULT_ROOT', 'NODE_ENV', 'BRAIN_PUBLISH_CONF']) {
    assert.equal(Object.hasOwn(publisher.calls[0].env, key), false, `${key} must not reach the publisher`);
  }

  const conf = join(home, '.config', 'second-brain', 'brainkit.conf');
  assert.equal(statSync(conf).mode & 0o777, 0o600);
  assert.equal(
    parseEnvFile(conf, { allowedKeys: ['schema', 'vault', 'routing_json', 'memory_dir'], requiredKeys: ['vault'] }).vault,
    realpathSync(vault),
    'the pointer must hold the canonical realpath, not the path as typed',
  );
  const routing = JSON.parse(readFileSync(join(home, '.config', 'second-brain', 'vault-routing.json'), 'utf8'));
  assert.deepEqual(routing.routes.map(route => route.type).sort(),
    ['experience', 'feedback', 'note', 'observation', 'project', 'reference', 'session', 'user-profile', 'weekly']);
  assert.equal(statSync(join(home, '.config', 'second-brain', 'vault-routing.json')).mode & 0o777, 0o600);

  const memoryDir = join(home, 'Library', 'Application Support', 'brainkit', 'memory');
  assert.match(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), /^## 🔥 热记忆（容量 40，按 type 配额\+FIFO）$/m);
  for (const file of ['MEMORY-knowledge.md', 'MEMORY-experience.md', 'MEMORY-project.md', 'MEMORY-persona.md', 'MEMORY-archive.md', 'MEMORY-notes.md']) {
    assert.ok(existsSync(join(memoryDir, file)), `${file} must exist`);
  }

  for (const dir of ['00-系统/.index-cache', '01-项目', '08-观察', '99-inbox/weekly', 'raw/pending']) {
    assert.ok(statSync(join(vault, dir)).isDirectory(), `${dir} must exist`);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(vault, '00-系统', '.project-map.json'), 'utf8')), { mappings: [] });

  const state = readInstallState(home);
  assert.equal(state.status, 'installing', 'the slice stops before shims/plists, so it must not claim installed');
  assert.equal(state.vault_root, realpathSync(vault));
  assert.ok(state.managed_files.length > 0);
  assert.equal(state.managed_files.some(entry => entry.path.includes('publish-manifest')), false,
    'vault deploy targets belong to the manifest, not managed_files (N-a)');
  assert.equal(existsSync(join(home, '.config', 'second-brain', 'install.lock')), false, 'the lock must be released');
});

test('slice 3: a fresh home with no ~/.local still passes the shim check', () => {
  const home = mkdtempSync(join(tmpdir(), 'brainkit-fresh-'));
  mkdirSync(join(home, '.config', 'second-brain'), { recursive: true, mode: 0o700 });
  const vault = makeVault(home);
  assert.equal(existsSync(join(home, '.local')), false, 'the fixture must start without ~/.local');
  const report = preflight(makeContext(home), baseAnswers(vault));
  assert.equal(check(report, 'shims').level, 'ok', '~/.local/bin only has to be creatable, not already there');
  assert.equal(report.exitCode, EXIT.OK);
});

test('slice 3: no component needing a key means no env file is created', () => {
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const directory = join(home, '.config', 'second-brain');
  assert.equal(existsSync(join(directory, 'clip.env')), false);
  assert.equal(existsSync(join(directory, 'observe.env')), false);
});

test('slice 3: an enabled LLM component writes a 0600 env file holding the supplied key', () => {
  const keyHome = makeHome();
  const keyFile = join(keyHome, 'key.txt');
  writeFileSync(keyFile, 'sk-fixture-value\n', { mode: 0o600 });
  const { home, context, answers } = installFixture({ answers: { components: 'observe', keyFile } });
  applyPlan(context, answers, preflight(context, answers), { yes: true }, 'sk-fixture-value');

  const observe = join(home, '.config', 'second-brain', 'observe.env');
  assert.equal(statSync(observe).mode & 0o777, 0o600);
  const values = loadObserveEnv(observe);
  assert.equal(values.OPENAI_API_KEY, 'sk-fixture-value');
  assert.equal(values.OPENAI_BASE_URL, 'https://api.deepseek.com');
  assert.equal(existsSync(join(home, '.config', 'second-brain', 'clip.env')), false, 'clip was not selected');
});

test('slice 3: branch C skips --bootstrap and goes straight to --check', () => {
  const { vault, context, answers, publisher } = installFixture({ answers: { vaultMode: 'existing' } });
  mkdirSync(join(vault, '00-系统', '.index-cache'), { recursive: true });
  writeFileSync(join(vault, '00-系统', '.index-cache', 'publish-manifest.json'), JSON.stringify({ entries: [] }));

  const applied = applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  assert.equal(applied.branch, 'C');
  assert.deepEqual(publisher.calls.map(call => call.sub), ['--check', 'publish'],
    'publish.mjs refuses to bootstrap over an existing manifest, so branch C must not call it');
});

test('slice 3: branch B bootstraps an existing vault that has no manifest', () => {
  const { vault, context, answers, publisher } = installFixture({ answers: { vaultMode: 'existing' } });
  mkdirSync(vault, { recursive: true });
  const applied = applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  assert.equal(applied.branch, 'B');
  assert.equal(publisher.calls[0].sub, '--bootstrap');
});

test('slice 3: a corrupt manifest and a rejecting check both hard stop', () => {
  const corrupt = installFixture({ answers: { vaultMode: 'existing' } });
  mkdirSync(join(corrupt.vault, '00-系统', '.index-cache'), { recursive: true });
  writeFileSync(join(corrupt.vault, '00-系统', '.index-cache', 'publish-manifest.json'), '{ not json');
  assert.throws(
    () => applyPlan(corrupt.context, corrupt.answers, preflight(corrupt.context, corrupt.answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /unreadable/.test(error.message));

  const drifted = installFixture({ publisher: { checkState: 'vault-ahead' } });
  assert.throws(
    () => applyPlan(drifted.context, drifted.answers, preflight(drifted.context, drifted.answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /vault-ahead/.test(error.message));
});

test('slice 3: repo-ahead needs --yes before the publisher is allowed to replace targets', () => {
  const { context, answers, publisher } = installFixture({ publisher: { checkState: 'repo-ahead' } });
  assert.throws(
    () => applyPlan(context, answers, preflight(context, answers), { yes: false }, null),
    /re-run with --yes/);
  assert.equal(publisher.calls.some(call => call.sub === 'publish'), false, 'no publish without confirmation');
});

test('slice 3: a failure mid-apply restores pre-existing config and removes what it created', () => {
  const { home, context, answers } = installFixture({ publisher: { checkState: 'conflict' } });
  const directory = join(home, '.config', 'second-brain');
  const conf = join(directory, 'brainkit.conf');
  writeFileSync(conf, 'vault="/previous/vault"\n', { mode: 0o600 });
  const before = readFileSync(conf, 'utf8');

  assert.throws(() => applyPlan(context, answers, preflight(context, answers), { yes: true }, null), /conflict/);

  assert.equal(readFileSync(conf, 'utf8'), before, 'the pre-existing config must come back byte for byte');
  assert.equal(statSync(conf).mode & 0o777, 0o600);
  assert.equal(existsSync(join(directory, 'vault-routing.json')), false, 'files this run created must be gone');
  assert.equal(existsSync(installStatePath(home)), false);
  assert.equal(existsSync(join(directory, 'install.lock')), false, 'the lock is released even on failure');
  // A complete rollback put the backup back at its original path, so the
  // transaction is spent and must not be left behind as an orphan (B-4).
  assert.deepEqual(readdirSync(join(directory, 'recovery')), []);
});

test('slice 3: the installer lock refuses a second live holder and reclaims a dead one', () => {
  const home = makeHome();
  const lock = join(home, '.config', 'second-brain', 'install.lock');
  acquireLock(home);
  assert.throws(() => acquireLock(home), /another installer holds/);

  writeFileSync(lock, '2147483646\n', { mode: 0o600 });
  assert.equal(acquireLock(home), lock, 'a lock whose pid is gone is reclaimed');
});

function scriptedTty(replies) {
  const asked = [];
  const said = [];
  return {
    asked,
    said,
    tty: {
      say: text => said.push(text),
      ask(question, options = {}) {
        asked.push({ question, echo: options.echo !== false });
        if (replies.length === 0) throw new Error(`unexpected prompt: ${question}`);
        return replies.shift();
      },
    },
  };
}

test('slice 3: the wizard and the flag path normalize to the same answers', () => {
  const home = makeHome();
  const vault = join(home, 'vault');
  mkdirSync(vault, { recursive: true });
  const driver = scriptedTty(['existing', vault, 'core,observe', 'reuse']);
  const wizard = runWizard(makeContext(home), driver.tty);

  assert.deepEqual(wizard.answers, {
    ...normalizeAnswers({ vault, vaultMode: 'existing', components: 'core,observe' }),
    reusePrivateConfig: true,
  });
  assert.equal(wizard.secret, null, 'choosing reuse must not collect a key');
  assert.match(driver.said.join(''), /may contain your full AI conversations/,
    'the observe consent must spell out what will be scanned');
  assert.match(driver.said.join(''), /\.claude/);
});

test('slice 3: the wizard turns echo off for the key and keeps it out of the transcript', () => {
  const home = makeHome();
  const vault = join(home, 'vault');
  mkdirSync(vault, { recursive: true });
  const driver = scriptedTty(['new', vault, 'clip', 'enter', 'sk-typed-by-hand']);
  const wizard = runWizard(makeContext(home), driver.tty);

  assert.equal(wizard.secret, 'sk-typed-by-hand');
  const keyPrompt = driver.asked.at(-1);
  assert.equal(keyPrompt.echo, false, 'the key prompt must disable echo');
  assert.doesNotMatch(driver.said.join('') + driver.asked.map(entry => entry.question).join(''), /sk-typed-by-hand/);
});

test('slice 3: a protected vault path is flagged during the wizard, before anything is written', () => {
  const home = makeHome();
  const vault = join(home, 'Desktop', 'vault');
  mkdirSync(vault, { recursive: true });
  const driver = scriptedTty(['existing', vault, 'core']);
  runWizard(makeContext(home), driver.tty);
  assert.match(driver.said.join(''), /TCC-protected prefix/);
});

// --- slice-3 S3 review regressions (B-1..B-7, MAJOR-1) ----------------------

// Every one of these paths used to be a bare existsSync/readFileSync/mkdirSync.
test('S3 B-1: a static symlink at the memory, recovery, project-map or lock path is refused', () => {
  const outside = mkdtempSync(join(tmpdir(), 'brainkit-outside-'));

  // memory index directory
  const memoryHome = makeHome();
  mkdirSync(join(memoryHome, 'Library', 'Application Support'), { recursive: true });
  symlinkSync(outside, join(memoryHome, 'Library', 'Application Support', 'brainkit'));
  const memoryFixture = installFixture({ home: memoryHome });
  assert.throws(
    () => applyPlan(memoryFixture.context, memoryFixture.answers, preflight(memoryFixture.context, memoryFixture.answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /symlinked component/.test(error.message));
  assert.equal(existsSync(join(outside, 'memory', 'MEMORY.md')), false, 'nothing may land outside the managed root');

  // recovery directory
  const recoveryHome = makeHome();
  symlinkSync(outside, join(recoveryHome, '.config', 'second-brain', 'recovery'));
  const recoveryFixture = installFixture({ home: recoveryHome });
  const outsideBefore = readdirSync(outside);
  assert.throws(
    () => applyPlan(recoveryFixture.context, recoveryFixture.answers, preflight(recoveryFixture.context, recoveryFixture.answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE);
  assert.deepEqual(readdirSync(outside), outsideBefore, 'no backup may land outside the managed root');

  // .project-map.json
  const mapFixture = installFixture({ answers: { vaultMode: 'existing' } });
  mkdirSync(join(mapFixture.vault, '00-系统'), { recursive: true });
  writeFileSync(join(outside, 'map.json'), '{"mappings":[]}');
  symlinkSync(join(outside, 'map.json'), join(mapFixture.vault, '00-系统', '.project-map.json'));
  assert.throws(
    () => applyPlan(mapFixture.context, mapFixture.answers, preflight(mapFixture.context, mapFixture.answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /regular non-symlink/.test(error.message));

  // install.lock
  const lockHome = makeHome();
  writeFileSync(join(outside, 'lock'), '1\n');
  symlinkSync(join(outside, 'lock'), join(lockHome, '.config', 'second-brain', 'install.lock'));
  assert.throws(() => acquireLock(lockHome), error => error.exitCode === EXIT.UNSAFE && /regular non-symlink/.test(error.message));
  assert.ok(existsSync(join(outside, 'lock')), 'the symlink target must not be deleted as a stale lock');
});

test('S3 B-1: a FIFO at a managed path is refused in bounded time', () => {
  const home = makeHome();
  const conf = join(home, '.config', 'second-brain', 'brainkit.conf');
  assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', conf]).status, 0);

  const child = spawnSync(process.execPath, [
    '-e',
    'import("./install.mjs").then(async m => {'
    + ' const home = process.argv[1];'
    + ' const context = m.createContext({ home, platform: "darwin", arch: "arm64", pathEnv: "", env: {},'
    + '   run: (c) => c === "/usr/bin/sw_vers" ? { status: 0, stdout: "14.6\\n", stderr: "" } : { status: 0, stdout: "true\\n", stderr: "" },'
    + '   stdout: () => {} });'
    + ' const answers = m.normalizeAnswers({ vault: home + "/vault", vaultMode: "new", components: "core" });'
    + ' try { m.applyPlan(context, answers, { vaultCanonical: home + "/vault", tcc: {} }, { yes: true }, null); process.stdout.write("ACCEPTED"); }'
    + ' catch (error) { process.stdout.write("REFUSED:" + error.message); } })',
    home,
  ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 5000 });

  assert.notEqual(child.signal, 'SIGTERM', 'the open blocked instead of being refused');
  assert.match(child.stdout, /^REFUSED:.*regular non-symlink file/);
});

test('S3 B-2: a setup failure releases the lock and rollback removes every created level', () => {
  // beginTransaction fails (recovery root is a file), so the lock must still go.
  const lockHome = makeHome();
  writeFileSync(join(lockHome, '.config', 'second-brain', 'recovery'), 'not a directory\n');
  const blocked = installFixture({ home: lockHome });
  assert.throws(() => applyPlan(blocked.context, blocked.answers, preflight(blocked.context, blocked.answers), { yes: true }, null));
  assert.equal(existsSync(join(lockHome, '.config', 'second-brain', 'install.lock')), false,
    'a failure before the try body used to strand the lock forever');

  // Late failure: every level this run created must be gone again. Compared as
  // a full snapshot of the four managed roots rather than by naming a few.
  const deep = installFixture({ publisher: { checkState: 'conflict' } });
  // The recovery/ directory itself is installer infrastructure, like the config
  // directory that contains it: it outlives any single transaction. Its
  // emptiness is what matters and is asserted separately below.
  const infrastructure = snapshot => snapshot.filter(line => !/second-brain\/recovery mode=/.test(line));
  const before = managedSnapshot(deep.home, deep.vault);
  assert.throws(() => applyPlan(deep.context, deep.answers, preflight(deep.context, deep.answers), { yes: true }, null), /conflict/);
  assert.deepEqual(infrastructure(managedSnapshot(deep.home, deep.vault)), infrastructure(before),
    'a fully rolled back install leaves every managed file and directory as it found it');
  assert.equal(existsSync(deep.vault), false, 'including the vault root this run created');
  assert.deepEqual(readdirSync(join(deep.home, '.config', 'second-brain', 'recovery')), [],
    'a fully rolled back transaction is spent and must not become an orphan');
});

test('S3 B-2: an incomplete install keeps its recovery transaction so recover can read it', () => {
  const { home, context, answers } = installFixture();
  const applied = applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  // §4.4 discards a spent transaction once the install is complete. Slice 3
  // ends at `installing`, so it is not spent: it is the rescue path.
  assert.equal(applied.recoveryKept, true);
  assert.equal(readInstallState(home).status, 'installing');
  const kept = readdirSync(join(home, '.config', 'second-brain', 'recovery'));
  assert.equal(kept.length, 1, 'exactly the one transaction this run opened');
  assert.ok(existsSync(join(home, '.config', 'second-brain', 'recovery', kept[0], 'transaction.json')));
  // And it stays: recover reads it to say what happened, and leaves it alone.
  assert.equal(recoverInstall({ ...context, stdout: () => {} }), EXIT.RECOVERY);
  assert.ok(existsSync(join(home, '.config', 'second-brain', 'recovery', kept[0], 'transaction.json')),
    'reading a transaction must not consume it');
});

test('S3 B-2: a corrupt .project-map.json is exit 2, not a raw SyntaxError', () => {
  const { vault, context, answers } = installFixture({ answers: { vaultMode: 'existing' } });
  mkdirSync(join(vault, '00-系统'), { recursive: true });
  writeFileSync(join(vault, '00-系统', '.project-map.json'), '{ not json');
  assert.throws(
    () => applyPlan(context, answers, preflight(context, answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && error.name === 'InstallError' && /not valid JSON/.test(error.message));
});

test('S3 B-3: publisher process anomalies hard stop instead of being read past', () => {
  for (const [label, publisher] of [
    ['bootstrap status 3', { bootstrapStatus: 3 }],
    ['bootstrap status 127', { bootstrapStatus: 127 }],
    ['bootstrap signal', { bootstrapSignal: 'SIGKILL' }],
  ]) {
    const fixture = installFixture({ publisher });
    assert.throws(
      () => applyPlan(fixture.context, fixture.answers, preflight(fixture.context, fixture.answers), { yes: true }, null),
      error => error.exitCode === EXIT.UNSAFE, label);
    assert.equal(fixture.publisher.calls.some(call => call.sub === 'publish'), false, `${label}: must not reach publish`);
  }

  // status 2 with a stdout summary claiming clean: the stdout does not match the
  // run, so the state it reports must not be acted on.
  const lying = installFixture({ publisher: { checkStatus: 2 } });
  assert.throws(
    () => applyPlan(lying.context, lying.answers, preflight(lying.context, lying.answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /summary claims/.test(error.message));
  assert.equal(lying.publisher.calls.some(call => call.sub === 'publish'), false);
});

test('S3 B-5: the publisher env is an allowlist, so provider secrets never reach it', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/x', TMPDIR: '/tmp', LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'sk-openai', DEEPSEEK_API_KEY: 'sk-deepseek', AWS_SECRET_ACCESS_KEY: 'aws',
    BRAIN_VAULT_ROOT: '/leak', NODE_ENV: 'test', BRAIN_PUBLISH_CONF: '/leak.conf',
  };
  assert.deepEqual(publisherEnv(env), { PATH: '/usr/bin', HOME: '/home/x', TMPDIR: '/tmp', LANG: 'en_US.UTF-8' });

  const fixture = installFixture({ context: { env } });
  applyPlan(fixture.context, fixture.answers, preflight(fixture.context, fixture.answers), { yes: true }, null);
  for (const call of fixture.publisher.calls) {
    for (const secret of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
      assert.equal(Object.hasOwn(call.env, secret), false, `${secret} must not reach the publisher`);
    }
  }
});

test('S3 B-6: pre-existing private directories are tightened to 0700', () => {
  const home = makeHome();
  chmodSync(join(home, '.config', 'second-brain'), 0o755);
  mkdirSync(join(home, 'Library', 'Application Support', 'brainkit', 'memory'), { recursive: true });
  chmodSync(join(home, 'Library', 'Application Support', 'brainkit', 'memory'), 0o777);

  const fixture = installFixture({ home });
  applyPlan(fixture.context, fixture.answers, preflight(fixture.context, fixture.answers), { yes: true }, null);

  assert.equal(statSync(join(home, '.config', 'second-brain')).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'Library', 'Application Support', 'brainkit', 'memory')).mode & 0o777, 0o700);
});

test('S3 B-7: an empty key is refused before the first write', () => {
  const home = makeHome();
  const keyFile = join(home, 'key.txt');
  writeFileSync(keyFile, '   \n', { mode: 0o600 });
  const vault = makeVault(home);
  const publisher = publisherMock();
  let output = '';
  const overrides = {
    home, repoRoot: REPO_ROOT, platform: 'darwin', arch: 'arm64', nodeTarget: NODE_TARGET,
    pathEnv: '', env: {}, interactive: false, run: publisher.run, stdout: text => { output += text; },
  };
  const before = managedSnapshot(home, vault);
  const code = main([
    'install', '--vault', vault, '--vault-mode', 'existing', '--components', 'observe',
    '--deepseek-key-file', keyFile, '--non-interactive', '--yes',
  ], overrides);

  assert.equal(code, EXIT.ACTIONABLE);
  assert.deepEqual(managedSnapshot(home, vault), before, 'nothing may be written at all');
  assert.equal(publisher.calls.length, 0);
});

test('S3 MAJOR-1: the wizard asks for a final confirmation and no means no', () => {
  const home = makeHome();
  const vault = makeVault(home);
  const publisher = publisherMock();
  const asked = [];
  const base = {
    home, repoRoot: REPO_ROOT, platform: 'darwin', arch: 'arm64', nodeTarget: NODE_TARGET,
    pathEnv: '', env: {}, interactive: true, run: publisher.run, stdout: () => {},
  };
  // Stand in for withTty: same { ask, say } shape the real terminal provides.
  const scripted = replies => ({
    ...base,
    tty: {
      say: () => {},
      ask: question => { asked.push(question); return replies.shift(); },
    },
  });

  const declined = main(['install', '--vault', vault, '--vault-mode', 'existing'], scripted(['existing', vault, 'core', 'no']));
  assert.equal(declined, EXIT.ACTIONABLE);
  assert.ok(asked.some(question => /apply it\?/.test(question)), 'step 7 must be an actual prompt');
  assert.equal(publisher.calls.length, 0, 'declining must write nothing');
  assert.equal(existsSync(installStatePath(home)), false);

  asked.length = 0;
  const accepted = main(['install', '--vault', vault, '--vault-mode', 'existing'], scripted(['existing', vault, 'core', 'yes']));
  assert.equal(accepted, EXIT.OK);
  assert.equal(readInstallState(home).status, 'installing');
});

test('S3 MAJOR-1: a changing publisher target is listed by path and state, not just counted', () => {
  const { context, answers } = installFixture({ publisher: { checkState: 'repo-ahead' } });
  let output = '';
  assert.throws(
    () => applyPlan({ ...context, stdout: text => { output += text; } }, answers, preflight(context, answers), { yes: false }, null),
    /re-run with --yes/);
  assert.match(output, /repo-ahead\s+00-系统\/scripts\/cli\/brain-write\.mjs/,
    '§5.2 wants the target paths and their hash states, not a tally');
});

// --- slice-3 r2 regressions: recover's own failure semantics ----------------

// Records enough that "byte-identical" means it: content hash, mode, owner and
// symlink target, not just the path. A name-and-type listing calls a file
// unchanged after its contents and mode have both been rewritten.
function managedSnapshot(home, vault) {
  // Records the entry at `path` itself, then recurses if it is a real directory.
  // Starting at the children instead left every root's own mode, uid, symlink
  // target and even its existence invisible.
  const describe = path => {
    const stat = lstatSafe(path);
    if (!stat) return [`- ${path} absent`];
    const meta = `mode=${(stat.mode & 0o7777).toString(8)} uid=${stat.uid}`;
    if (stat.isSymbolicLink()) return [`l ${path} ${meta} -> ${readlinkSync(path)}`];
    if (stat.isFile()) return [`f ${path} ${meta} sha256=${createHash('sha256').update(readFileSync(path)).digest('hex')}`];
    if (!stat.isDirectory()) return [`? ${path} ${meta}`];
    const out = [`d ${path} ${meta}`];
    let entries;
    try { entries = readdirSync(path); } catch { return out; }
    for (const name of entries.sort()) out.push(...describe(join(path, name)));
    return out;
  };
  const walk = root => describe(root);
  return [
    ...walk(join(home, '.config', 'second-brain')),
    ...walk(join(home, 'Library', 'Application Support', 'brainkit')),
    ...walk(join(home, '.local', 'bin')),
    // The plists are production too, and they were missing from every "nothing
    // moved" assertion that goes through here. Like ~/.local/bin this is a
    // shared user directory, so the whole of it is recorded: a run that writes
    // somebody else's plist is the same failure as one that writes ours.
    ...walk(join(home, 'Library', 'LaunchAgents')),
    ...(vault ? walk(vault) : []),
  ];
}

// Two directories a refused-and-unwound run is allowed to leave behind as empty
// shells: `recovery`, created before the transaction knows whether it will need
// it, and `~/Library/LaunchAgents`, a standard macOS directory that every Mac
// with any agent already has and that deleting could take out from under
// another tool mid-write.
//
// Only the absent -> empty-directory transition is dropped, and only when both
// halves of it are actually there, so a mode change on a shell that already
// existed still shows up. Whatever is *inside* them is compared as normal: a
// leftover plist or manifest still fails.
function ignoringCreatedShells(after, before, home) {
  let [kept, was] = [after, before];
  const shells = [
    [join(home, '.config', 'second-brain', 'recovery'), '700'],
    [join(home, 'Library', 'LaunchAgents'), '755'],
  ];
  for (const [path, mode] of shells) {
    const absent = `- ${path} absent`;
    const empty = `d ${path} mode=${mode} uid=${process.getuid()}`;
    // recovery is reached by readdir, so when it is missing there is no line at
    // all rather than an `absent` one; LaunchAgents is a root and does get one.
    // Dropping each half only if present covers both shapes.
    //
    // `was.includes(empty)` is what keeps this to the created case: a shell
    // that was already there before the run is left in both lists, so a mode
    // or owner change on it still has to compare equal.
    if (!kept.includes(empty) || was.includes(empty)) continue;
    kept = kept.filter(line => line !== empty);
    was = was.filter(line => line !== absent);
  }
  return [kept, was];
}

function lstatSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

test('S3 r4 MAJOR-1: the snapshot notices child, root and symlink-target changes', () => {
  const home = makeHome();
  const configRoot = join(home, '.config', 'second-brain');
  const probe = join(configRoot, 'brainkit.conf');
  writeFileSync(probe, 'vault="/a"\n', { mode: 0o600 });
  const before = managedSnapshot(home, null);

  writeFileSync(probe, 'vault="/b"\n', { mode: 0o600 });
  assert.notDeepEqual(managedSnapshot(home, null), before, 'a child content change must show up');
  writeFileSync(probe, 'vault="/a"\n', { mode: 0o600 });
  assert.deepEqual(managedSnapshot(home, null), before, 'and restoring it must compare equal again');

  chmodSync(probe, 0o644);
  assert.notDeepEqual(managedSnapshot(home, null), before, 'a child mode change must show up');
  chmodSync(probe, 0o600);

  // The root itself: previously invisible, so these two were false greens.
  chmodSync(configRoot, 0o755);
  assert.notDeepEqual(managedSnapshot(home, null), before, 'a ROOT mode change must show up');
  chmodSync(configRoot, 0o700);
  assert.deepEqual(managedSnapshot(home, null), before);

  const first = mkdtempSync(join(tmpdir(), 'brainkit-vault-a-'));
  const second = mkdtempSync(join(tmpdir(), 'brainkit-vault-b-'));
  const vaultLink = join(home, 'vault-link');
  symlinkSync(first, vaultLink);
  const linked = managedSnapshot(home, vaultLink);
  rmSync(vaultLink);
  symlinkSync(second, vaultLink);
  assert.notDeepEqual(managedSnapshot(home, vaultLink), linked,
    'a ROOT symlink retargeted between two identical directories must show up');
});

test('S3 r3 B-2: a symlink inside the transaction directory cannot redirect a backup', () => {
  const outside = mkdtempSync(join(tmpdir(), 'brainkit-outside-'));
  writeFileSync(join(outside, 'saved'), 'OUTSIDE BACKUP\n', { mode: 0o600 });

  const { home, context, answers } = installFixture();
  const conf = join(home, '.config', 'second-brain', 'brainkit.conf');
  writeFileSync(conf, 'vault="/previous/vault"\n', { mode: 0o600 });
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const txnId = readInstallState(home).last_txn;
  const txnDir = join(home, '.config', 'second-brain', 'recovery', txnId);

  // A symlink planted inside the transaction directory: the backup path still
  // starts with the transaction directory, so a string prefix check passes.
  symlinkSync(outside, join(txnDir, 'link'));
  const manifest = JSON.parse(readFileSync(join(txnDir, 'transaction.json'), 'utf8'));
  const real = manifest.operations.find(entry => entry.path === conf);
  manifest.operations = [operation({ ...real, backup: join(txnDir, 'link', 'saved') })];
  writeFileSync(join(txnDir, 'transaction.json'), JSON.stringify(manifest), { mode: 0o600 });

  assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
    error => error.exitCode === EXIT.UNSAFE && /outside its transaction directory/.test(error.message));
  assert.equal(readFileSync(join(outside, 'saved'), 'utf8'), 'OUTSIDE BACKUP\n', 'the outside file must survive');
  assert.notEqual(readFileSync(conf, 'utf8'), 'OUTSIDE BACKUP\n', 'and must never be written into the config');
});

test('S3 r4 B-1: a tampered vault_root authorises nothing, whatever the victim is named', () => {
  // Three victims, each defeating a weaker version of the check: a name the
  // installer never writes, a name it DOES write (basename checks passed this),
  // and a plain empty directory (createdDirs had no name check at all).
  for (const [label, victim, field] of [
    ['unknown name', 'must-not-delete', 'created'],
    ['whitelisted basename', 'MEMORY.md', 'created'],
    ['empty directory', '01-项目', 'createdDirs'],
  ]) {
    const outside = mkdtempSync(join(tmpdir(), 'brainkit-sentinel-'));
    const target = join(outside, victim);
    if (field === 'createdDirs') mkdirSync(target); else writeFileSync(target, 'keep me\n');

    const { home, context, answers } = installFixture();
    applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
    const state = readInstallState(home);
    const txnDir = join(home, '.config', 'second-brain', 'recovery', state.last_txn);
    writeInstallState(home, { ...state, vault_root: outside });
    const manifest = JSON.parse(readFileSync(join(txnDir, 'transaction.json'), 'utf8'));
    manifest.operations = [field === 'created' ? createdEntry(target) : dirEntry(target)];
    manifest.services = [];
    writeFileSync(join(txnDir, 'transaction.json'), JSON.stringify(manifest), { mode: 0o600 });

    assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
      error => error.exitCode === EXIT.UNSAFE
        && /not a path this installer creates|not the surface this installer would plan/.test(error.message), label);
    assert.ok(existsSync(target), `${label}: the victim must survive`);
  }
});

// chflags uchg is a static, user-settable state -- no race, no attacker -- and
// it is the deterministic execution-phase failure I wrongly claimed could not
// be constructed. Both cases must now be caught by the preflight instead.
function chflags(flag, path) {
  return spawnSync('/usr/bin/chflags', [flag, path]).status === 0;
}

test('S3 r4 B-3: applyPlan treats a failed discard as recovery-required, not a printed note', () => {
  const { home, context, answers, publisher } = installFixture({ publisher: { checkState: 'conflict' } });
  // Drop an unexpected file into the transaction directory as the publisher is
  // consulted, so the post-rollback discard cannot close the directory out.
  const recoveryRoot = join(home, '.config', 'second-brain', 'recovery');
  const originalRun = publisher.run;
  const context2 = {
    ...context,
    stdout: () => {},
    run: (command, args, options) => {
      if (String(args?.[0] || '').endsWith('publish.mjs') && existsSync(recoveryRoot)) {
        for (const id of readdirSync(recoveryRoot)) writeFileSync(join(recoveryRoot, id, 'unexpected.txt'), 'x\n');
      }
      return originalRun(command, args, options);
    },
  };

  assert.throws(
    () => applyPlan(context2, answers, preflight(context2, answers), { yes: true }, null),
    // The closeout is now checked with the rollback rather than after it, so an
    // already-unusable directory stops the run before anything is undone. Still
    // exit 3, still the shared SETTLE_REASON wording, but the earlier verdict.
    error => error.exitCode === EXIT.RECOVERY && /could not be started safely/.test(error.message));
  const state = readInstallState(home);
  assert.equal(state.status, 'recovery-required', 'an orphan transaction must not be left with no state pointing at it');
  assert.equal(readdirSync(recoveryRoot).length, 1);
  assert.equal(state.last_txn, readdirSync(recoveryRoot)[0], 'and the state must point at that transaction');
  // The next install is blocked rather than merely warned about.
  assert.notEqual(preflight(context, answers, { command: 'install' }).exitCode, EXIT.OK);

  // The point of checking early is that nothing was undone, so the obstacle can
  // be cleared and the install rerun. recover no longer finishes the job for
  // you, so what matters here is that there was nothing to finish: the install
  // is intact and the gate is closed until someone deals with it.
  rmSync(join(recoveryRoot, state.last_txn, 'unexpected.txt'));
  assert.notEqual(readInstallState(home), null, 'the state is still there to be dealt with');
});

test('S3 r2 B-2: a manifest is untrusted input', () => {
  const outside = mkdtempSync(join(tmpdir(), 'brainkit-sentinel-'));
  const sentinel = join(outside, 'must-not-delete');

  // Path traversal in last_txn.
  const escape = installFixture();
  applyPlan(escape.context, escape.answers, preflight(escape.context, escape.answers), { yes: true }, null);
  const escapeState = readInstallState(escape.home);
  writeInstallState(escape.home, { ...escapeState, last_txn: '../../../external-txn' });
  assert.throws(() => recoverInstall({ ...escape.context, stdout: () => {} }),
    error => error.exitCode === EXIT.UNSAFE && /malformed transaction id/.test(error.message));
  assert.ok(existsSync(installStatePath(escape.home)), 'a refused recover must not delete the state');

  // A manifest naming a file outside the managed roots.
  const forged = installFixture();
  applyPlan(forged.context, forged.answers, preflight(forged.context, forged.answers), { yes: true }, null);
  writeFileSync(sentinel, 'keep me\n');
  const forgedId = readInstallState(forged.home).last_txn;
  const manifest = join(forged.home, '.config', 'second-brain', 'recovery', forgedId, 'transaction.json');
  // TXN_SCHEMA, not a literal: these two fixtures exist to exercise the
  // containment and structure checks, and a stale literal would silently move
  // them onto the schema gate that runs before both.
  const real = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, JSON.stringify({ ...real, operations: [createdEntry(sentinel)], services: [] }), { mode: 0o600 });
  assert.throws(() => recoverInstall({ ...forged.context, stdout: () => {} }),
    error => error.exitCode === EXIT.UNSAFE && /not a path this installer creates/.test(error.message));
  assert.ok(existsSync(sentinel), 'the sentinel outside the managed roots must survive');

  // Structurally broken but syntactically valid JSON: InstallError, not TypeError.
  const broken = installFixture();
  applyPlan(broken.context, broken.answers, preflight(broken.context, broken.answers), { yes: true }, null);
  const brokenId = readInstallState(broken.home).last_txn;
  // Valid schema so the structural check is what this case exercises, not the
  // schema gate that now runs before it.
  writeFileSync(join(broken.home, '.config', 'second-brain', 'recovery', brokenId, 'transaction.json'),
    JSON.stringify({ ...JSON.parse(readFileSync(join(broken.home, '.config', 'second-brain', 'recovery', brokenId, 'transaction.json'), 'utf8')), operations: undefined, services: [] }), { mode: 0o600 });
  assert.throws(() => recoverInstall({ ...broken.context, stdout: () => {} }),
    error => error.name === 'InstallError' && /operations is not an array/.test(error.message));
  assert.ok(existsSync(installStatePath(broken.home)));
});

test('S3 r2 B-3: recover honours the installer lock', () => {
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);

  // A live holder: an install is running, so recover must not touch anything.
  // It used to throw here; it now reports and returns the same exit code an
  // InstallError would have produced, because a busy machine is a situation
  // rather than a fault. Every safety property below is unchanged.
  const lock = join(home, '.config', 'second-brain', 'install.lock');
  writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  let busy = '';
  assert.equal(recoverInstall({ ...context, stdout: text => { busy += text; } }), EXIT.ACTIONABLE);
  assert.match(busy, /An install is running now \(pid \d+\)/, 'and still names the holder');
  assert.ok(existsSync(lock), 'the running installer keeps its lock');
  assert.ok(existsSync(installStatePath(home)), 'and nothing was rolled back under it');

  // A dead holder does not stand in the way. recover no longer takes the lock
  // at all -- it reads it -- so the stale file is simply left where it is for
  // the next install to reclaim.
  writeFileSync(lock, '2147483646\n', { mode: 0o600 });
  assert.equal(recoverInstall({ ...context, stdout: () => {} }), EXIT.RECOVERY);
  assert.ok(existsSync(lock), 'and a read-only command leaves even a stale lock alone');
});

test('S3 r2 B-4: an orphan transaction is reported, never silently deleted', () => {
  const { home, context, answers } = installFixture();
  const orphan = join(home, '.config', 'second-brain', 'recovery', 'a'.repeat(16));
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, 'transaction.json'), '{}', { mode: 0o600 });

  const report = preflight(context, answers, { command: 'install' });
  assert.match(check(report, 'recovery-material').message, /belong to no current install/);
  assert.equal(check(report, 'recovery-material').exit, EXIT.OK, 'reporting only; it must not block');
  assert.ok(existsSync(join(orphan, 'transaction.json')), 'nothing can prove it is spent, so it stays');
});

test('S3 r2 MAJOR-1: refused installs leave every managed root byte-identical', () => {
  // Empty key.
  const emptyKey = installFixture({ answers: { components: 'observe' } });
  const beforeKey = managedSnapshot(emptyKey.home, emptyKey.vault);
  const keyFile = join(emptyKey.home, 'key.txt');
  writeFileSync(keyFile, '   \n', { mode: 0o600 });
  assert.equal(main([
    'install', '--vault', emptyKey.vault, '--vault-mode', 'new', '--components', 'observe',
    '--deepseek-key-file', keyFile, '--non-interactive', '--yes',
  ], { ...emptyKey.context, stdout: () => {} }), EXIT.ACTIONABLE);
  assert.deepEqual(managedSnapshot(emptyKey.home, emptyKey.vault), beforeKey);

  // Wizard answered no.
  const declined = installFixture();
  mkdirSync(declined.vault, { recursive: true });
  const beforeNo = managedSnapshot(declined.home, declined.vault);
  const replies = ['existing', declined.vault, 'core', 'no'];
  assert.equal(main(['install', '--vault', declined.vault, '--vault-mode', 'existing'], {
    ...declined.context,
    interactive: true,
    stdout: () => {},
    tty: { say: () => {}, ask: () => replies.shift() },
  }), EXIT.ACTIONABLE);
  assert.deepEqual(managedSnapshot(declined.home, declined.vault), beforeNo);
  assert.equal(declined.publisher.calls.length, 0);
});

// --- consolidation gates ----------------------------------------------------

test('slice 4 gate 4: authorised and produced are the same set for every component selection', () => {
  // The gate the registry exists for, run both ways and once per selection.
  // Forward catches a write with no row. Reverse catches a row authorising
  // something no transaction produces -- the failure the consolidation itself
  // introduced. Doing this only with every component selected would hide the
  // conditional version of exactly that defect: a core-only install
  // authorising clip.env and four plists it never goes near.
  for (const components of ['core', 'core,clip', 'core,observe', 'core,sunday', 'core,watch', 'all']) {
    const { home, vault, context, answers } = selectionFixture(components);
    const report = preflight(context, answers);
    assert.equal(report.exitCode, EXIT.OK, `${components}: ${report.checks.filter(c => c.level === 'error').map(c => c.message).join('; ')}`);
    applyPlan(context, answers, report, { yes: true }, 'sk-fixture');

    const state = readInstallState(home);
    const manifest = readManifest(home, state.last_txn);
    const shapes = managedShapes(home, realpathSync(vault), state.components);

    for (const entry of createdOps(manifest)) assert.ok(shapeOf(entry.path, shapes, 'files'), `: created file not in the registry: `);
    for (const path of backupOps(manifest).map(entry => entry.path)) assert.ok(shapeOf(path, shapes, 'files'), `${components}: overwritten file not in the registry: ${path}`);
    for (const entry of dirOps(manifest)) assert.ok(shapeOf(entry.path, shapes, 'dirs'), `: directory not in the registry: `);
    assert.ok(createdOps(manifest).length >= 10, `${components}: the fixture must actually create files for this to mean anything`);
    assert.ok(dirOps(manifest).length >= 20, `: and directories`);

    const produced = producedPaths(manifest);
    const unreachable = authorisedPaths(shapes).filter(path => !produced.has(path));
    assert.deepEqual(unreachable, [], `${components}: authorised for rollback but no transaction produces them`);

    // And the narrowing is real, not just self-consistent: a selection that
    // excludes a component must not authorise that component's files.
    if (components === 'core') {
      for (const absent of ['clip.env', 'observe.env']) {
        assert.equal(shapeOf(join(home, '.config', 'second-brain', absent), shapes, 'files'), false,
          `core-only must not authorise ${absent}`);
      }
      for (const service of ['clip', 'observe', 'sunday', 'watch']) {
        assert.equal(shapeOf(join(home, 'Library', 'LaunchAgents', `com.second-brain.${service}.plist`), shapes, 'files'), false,
          `core-only must not authorise the ${service} plist`);
      }
      assert.equal(shapeOf(join(home, '.local', 'bin', 'brain-watch-wrapper.sh'), shapes, 'files'), false,
        'core-only must not authorise the wrapper shim');
    }
    // A name nothing in the registry claims, inside a root that has rows: it is
    // position that makes a path ours, not merely being under a managed root.
    assert.equal(shapeOf(join(home, '.config', 'second-brain', 'not-an-artifact.json'), shapes, 'files'), false,
      `${components}: an unregistered name under a managed root is not authorised`);
  }
});

test('slice 4 gate 3: shared and infrastructure directories are created but never authorised', () => {
  // ~/.local/bin and ~/Library/LaunchAgents are shared user directories, and
  // §9.1 says the shim directory is never deleted or walked. The config root
  // and the log directory outlive every transaction. All four are created by a
  // real install and none of them may ever appear in a manifest.
  const { home, vault, context, answers } = selectionFixture('all');
  applyPlan(context, answers, preflight(context, answers), { yes: true }, 'sk-fixture');
  const state = readInstallState(home);
  const shapes = managedShapes(home, realpathSync(vault), state.components);
  const manifest = readManifest(home, state.last_txn);
  const produced = producedPaths(manifest);

  const infrastructure = infrastructureDirs(home);
  assert.equal(infrastructure.length, 4);
  for (const directory of infrastructure) {
    assert.ok(statSync(directory).isDirectory(), `the install must actually create ${directory}`);
    assert.equal(shapeOf(directory, shapes, 'dirs'), false, `${directory} must never be rollback-authorised`);
    assert.equal(produced.has(directory), false, `${directory} must never enter a transaction`);

    const txnDir = join(home, '.config', 'second-brain', 'recovery', state.last_txn);
    const forged = readManifest(home, state.last_txn);
    forged.operations = [...forged.operations, dirEntry(directory)];
    writeFileSync(join(txnDir, 'transaction.json'), JSON.stringify(forged), { mode: 0o600 });
    assert.throws(() => loadTransaction(home, state.last_txn, state.vault_root, state.components, state.plan_digest),
      error => error.exitCode === EXIT.UNSAFE && /not a path this installer creates/.test(error.message),
      `a manifest naming ${directory} must be refused`);
    writeFileSync(join(txnDir, 'transaction.json'), JSON.stringify(manifest), { mode: 0o600 });
  }

  // The registry is where this is decided, so say it there too: only the two
  // roots a transaction really creates carry a path '' row.
  assert.deepEqual(ARTIFACTS.filter(row => row.path === '').map(row => row.root).sort(), ['memory', 'vault']);
});

test('consolidation: every registry file row names exactly one producer', () => {
  // A row with neither would be written as undefined or silently skipped; a row
  // with both would have two producers disagreeing about the same path. The
  // dedicated writers are named rather than excluded by id, so adding a row
  // that belongs to one of them is a declaration and not an exemption.
  const WRITERS = new Set(['state', 'shim', 'plist']);
  for (const entry of ARTIFACTS.filter(row => row.kind === 'file')) {
    const hasContent = typeof entry.content === 'function';
    assert.equal(hasContent !== Boolean(entry.writer), true, `${entry.id} must have exactly one of content/writer`);
    if (entry.writer) {
      assert.ok(WRITERS.has(entry.writer), `${entry.id} names an unknown writer: ${entry.writer}`);
      assert.equal(typeof entry.mode, 'number', `${entry.id} is written by ${entry.writer} and must declare its mode`);
      continue;
    }
    const produced = entry.content({ secret: 'sk-x', conf: 'schema=1\n' });
    assert.equal(typeof produced, 'string');
    assert.ok(produced.length > 0, `${entry.id} produced nothing`);
  }
});

test('consolidation: a manifest from another schema fails closed and keeps everything', () => {
  const { home, vault, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const state = readInstallState(home);
  const manifestFile = join(home, '.config', 'second-brain', 'recovery', state.last_txn, 'transaction.json');

  // schema 1 by name, not just "some other number": it is the real previous
  // version, and it is the one whose absent `retain` field would have let a
  // discard delete an adopted third-party original. 2 is the version before
  // `services`, whose absence would restore files and leave services down.
  for (const [label, schema] of [['schema 1', 1], ['schema 2', 2], ['future', 99], ['pre-versioning', undefined]]) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (schema === undefined) delete manifest.schema; else manifest.schema = schema;
    writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });

    // No state filter: install-state.json is a managed file in the config root,
    // and the claim is all four roots byte-identical. A schema refusal throws
    // out of loadTransaction before any state write, so it must hold.
    const before = managedSnapshot(home, vault);
    assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
      error => error.exitCode === EXIT.UNSAFE && /declares schema/.test(error.message), label);
    assert.deepEqual(managedSnapshot(home, vault), before,
      `${label}: nothing may be touched on an unreadable schema, state file included`);
    assert.ok(existsSync(manifestFile), `${label}: the material is kept`);
  }
});

test('slice 4: a schema-1 manifest holding an adopted original is refused and everything survives', () => {
  // The specific danger the bump exists for, driven end to end rather than
  // argued: schema 1 has no `retain`, so a version that read it would treat the
  // adopted backup as ordinary and delete the only copy of a third-party file.
  const { home, vault, context, answers, shimPath, seed } = shimVerdictFixture('adopt');
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const state = readInstallState(home);
  const txnDir = join(home, '.config', 'second-brain', 'recovery', state.last_txn);
  const manifestFile = join(txnDir, 'transaction.json');

  const current = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const retained = backupOps(current).find(entry => entry.retain);
  assert.ok(retained, 'the fixture must really have adopted something');
  const adoptedBytes = readFileSync(retained.backup);

  // A faithful schema-1 manifest: no retain, no services.
  writeFileSync(manifestFile, JSON.stringify({
    schema: 1,
    id: current.id,
    operations: current.operations,
    operations: current.operations,
    services: current.services,
  }), { mode: 0o600 });

  const before = managedSnapshot(home, vault);
  assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
    error => error.exitCode === EXIT.UNSAFE && new RegExp(`declares schema 1, not ${TXN_SCHEMA}`).test(error.message));

  assert.deepEqual(managedSnapshot(home, vault), before, 'every managed root byte-identical, state file included');
  assert.ok(existsSync(manifestFile), 'the manifest is kept');
  assert.deepEqual(readFileSync(retained.backup), adoptedBytes, 'and the only copy of the third-party file survives');
  assert.equal(readInstallState(home).status, 'installing', 'the state is untouched, not marked');
  assert.equal(readFileSync(shimPath, 'utf8'), nodeShimContent(NODE_TARGET));
  assert.notEqual(readFileSync(shimPath, 'utf8'), seed);
});

// --- slice 4: shims, plists and services ------------------------------------

const MARKED_OLD_SHIM = '#!/bin/sh\n# brainkit-node-shim v1\nexec /old/node "$@"\n';
const THIRD_PARTY_SHIM = '#!/bin/sh\n# somebody elses node wrapper\nexec /usr/bin/node "$@"\n';

// One install per shim pre-state, so each verdict is produced by the real
// installer rather than asserted about judgeShim in isolation.
// `idempotent` seeds the machine's real shape -- identical bytes at 0755, which
// the installer still has to tighten. `idempotent-exact` seeds the only true
// no-op: identical bytes already at 0700. The old fixture used 0700 for
// `idempotent` and so tested the no-op while calling it the general case.
function shimVerdictFixture(verdict, overrides = {}) {
  const fixture = installFixture({ answers: { adoptShims: verdict === 'adopt' }, ...overrides });
  const path = join(fixture.home, '.local', 'bin', 'brain-node');
  const seed = {
    create: null,
    idempotent: nodeShimContent(NODE_TARGET),
    'idempotent-exact': nodeShimContent(NODE_TARGET),
    overwrite: MARKED_OLD_SHIM,
    adopt: THIRD_PARTY_SHIM,
  }[verdict];
  const mode = verdict === 'idempotent-exact' ? 0o700 : 0o755;
  if (seed !== null) {
    writeFileSync(path, seed, { mode });
    chmodSync(path, mode);
  }
  return { ...fixture, shimPath: path, seed, seedMode: mode };
}

test('slice 4 gate 1: the shim lifecycle comes from the registry plus the file, never the call site', () => {
  // Adoptability is declared, and only on the shims. Nothing else in the tree
  // gets to decide that a path is adoptable.
  assert.deepEqual(ARTIFACTS.filter(row => row.takeover === 'adopt').map(row => row.id).sort(), ['node-shim', 'wrapper-shim']);
  assert.deepEqual(ARTIFACTS.filter(row => row.shim).map(row => row.takeover), ['adopt', 'adopt'],
    'every shim row is adoptable and every adoptable row is a shim');

  // Each lifecycle leaves a different, checkable trace, and the trace follows
  // from the declaration: only takeover:'adopt' plus an unmarked file produces
  // a retained backup.
  const expected = {
    create: { created: true, backup: null },
    // Identical bytes but 0755: the mode still has to be tightened, and that is
    // a change, so it is transactional like any other.
    idempotent: { created: false, backup: { retain: false, inAdopted: false } },
    // Identical bytes AND the right mode: the only case with nothing to do.
    'idempotent-exact': { created: false, backup: null },
    overwrite: { created: false, backup: { retain: false, inAdopted: false } },
    adopt: { created: false, backup: { retain: true, inAdopted: true } },
  };
  for (const [verdict, want] of Object.entries(expected)) {
    const { home, context, answers, shimPath, seed } = shimVerdictFixture(verdict);
    applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
    const state = readInstallState(home);
    const manifest = readManifest(home, state.last_txn);
    const adoptedRoot = join(home, '.config', 'second-brain', 'recovery', state.last_txn, ADOPTED_DIR);

    assert.equal(createdOps(manifest).some(entry => entry.path === shimPath), want.created, `: created`);
    const backup = backupOps(manifest).find(entry => entry.path === shimPath) ?? null;
    if (want.backup === null) {
      assert.equal(backup, null, `${verdict}: must leave no backup`);
      assert.equal(existsSync(adoptedRoot), false, `${verdict}: must not create ${ADOPTED_DIR}`);
    } else {
      assert.equal(backup.retain, want.backup.retain, `${verdict}: retain flag`);
      assert.equal(backup.backup.startsWith(adoptedRoot + sep), want.backup.inAdopted, `${verdict}: backup location`);
      assert.equal(readFileSync(backup.backup, 'utf8'), seed, `${verdict}: the backup must be the original bytes`);
    }
    assert.equal(state.shims.node.adopted, verdict === 'adopt', `${verdict}: state records the adoption`);
  }
});

test('slice 4 gate 1: flipping the registry policy stops a real install dead', () => {
  // The behavioural half, and the half that was missing. The previous gate
  // asserted the column said 'adopt' and that adopt produced a retained backup,
  // but never that the column CAUSED it -- a reviewer changed the row to
  // 'forbid' and the install still adopted. Mutating the shipped registry row
  // in place is the only way to assert causation.
  const row = ARTIFACTS.find(entry => entry.id === 'node-shim');
  const original = row.takeover;
  const command = fixture => ['install', '--vault', fixture.vault, '--vault-mode', 'new',
    '--components', 'core', '--adopt-shims', '--non-interactive', '--yes'];

  const whole = shimVerdictFixture('adopt');
  const beforeWhole = managedSnapshot(whole.home, null);
  const direct = shimVerdictFixture('adopt');
  try {
    row.takeover = 'forbid';
    // The whole command: preflight sees the policy too, so it refuses before
    // the first write rather than writing and undoing.
    assert.equal(main(command(whole), { ...whole.context, stdout: () => {} }), EXIT.UNSAFE);
    // And driven past preflight, the writer refuses on its own account.
    assert.throws(() => applyPlan(direct.context, direct.answers, preflight(direct.context, direct.answers), { yes: true }, null),
      error => error.exitCode === EXIT.UNSAFE && /takeover policy is "forbid"/.test(error.message),
      'a non-adoptable row must refuse even with --adopt-shims');
  } finally {
    row.takeover = original;
  }

  assert.deepEqual(managedSnapshot(whole.home, null), beforeWhole, 'the refused command must write nothing at all');
  assert.equal(existsSync(installStatePath(whole.home)), false);
  // The direct call did write and then unwind, so the claim there is narrower
  // and exact: the third-party file is untouched and no material is left.
  assert.equal(readFileSync(direct.shimPath, 'utf8'), direct.seed, 'the third-party file must be untouched');
  assert.equal(statSync(direct.shimPath).mode & 0o777, direct.seedMode);
  assert.equal(existsSync(installStatePath(direct.home)), false);
  assert.deepEqual(readdirSync(join(direct.home, '.config', 'second-brain', 'recovery')), []);

  // Same fixture, policy restored: now it adopts. Without this the assertion
  // above would also pass on a build where install is simply broken.
  const working = shimVerdictFixture('adopt');
  applyPlan(working.context, working.answers, preflight(working.context, working.answers), { yes: true }, null);
  assert.equal(readInstallState(working.home).shims.node.adopted, true);
});

test('slice 4 gate 2: the wrapper shim is a byte-for-byte copy of the template', () => {
  const { home, context, answers } = selectionFixture('core,watch');
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const wrapper = join(home, '.local', 'bin', 'brain-watch-wrapper.sh');
  const templateBytes = readFileSync(WRAPPER_TEMPLATE);

  assert.deepEqual(readFileSync(wrapper), templateBytes, 'the wrapper is a copy, not a render');
  assert.equal(shimMarker(templateBytes.toString('utf8')), '# brainkit-watch-wrapper v1',
    'NB1: the template carries the marker, which is what lets both assertions hold at once');
  const state = readInstallState(home);
  assert.equal(state.shims.wrapper.sha256, state.shims.wrapper.template_sha256);
  assert.equal(state.shims.wrapper.sha256, createHash('sha256').update(templateBytes).digest('hex'));
  assert.equal(statSync(wrapper).mode & 0o777, 0o700);
});

test('slice 4 gate 5: a discard keeps the adopted originals and removes everything else', () => {
  const { home, context, answers, shimPath } = shimVerdictFixture('adopt');
  // A second, ordinary backup so the discard has both kinds to tell apart.
  writeFileSync(join(home, '.config', 'second-brain', 'brainkit.conf'), 'vault="/previous"\n', { mode: 0o600 });
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);

  const state = readInstallState(home);
  const txnDir = join(home, '.config', 'second-brain', 'recovery', state.last_txn);
  const manifest = readManifest(home, state.last_txn);
  const retained = backupOps(manifest).filter(entry => entry.retain);
  const ordinary = backupOps(manifest).filter(entry => !entry.retain);
  assert.equal(retained.length, 1, 'one adopted shim');
  assert.ok(ordinary.length >= 1, 'and at least one ordinary backup to distinguish it from');
  const keptBytes = readFileSync(retained[0].backup);

  // The success path -- the install completed, so the closeout runs without a
  // rollback. `releaseState: false` is what makes it that path: a completed
  // install keeps its state file, and only a rollback releases the pointer.
  const loaded = loadTransaction(home, state.last_txn, state.vault_root, state.components, state.plan_digest);
  const discarded = discardTransaction(loaded, [], { releaseState: false });
  assert.equal(discarded.tag, 'settled');
  assert.equal(discarded.retained, join(txnDir, ADOPTED_DIR), 'the discard must report the directory it deliberately left behind');
  assert.deepEqual(readFileSync(retained[0].backup), keptBytes, 'the only copy of the third-party file must survive');
  for (const entry of ordinary) assert.equal(existsSync(entry.backup), false, 'ordinary backups are spent');
  assert.equal(existsSync(join(txnDir, 'transaction.json')), false, 'the manifest is spent');
  assert.deepEqual(readdirSync(txnDir), [ADOPTED_DIR], 'and nothing else is left behind');
  assert.equal(existsSync(shimPath), true);
});

test('slice 4 gate 5: anything unexpected inside adopted-shims stops the discard before the manifest goes', () => {
  // The failure the review reproduced: the top-level check let adopted-shims/
  // through as a single entry, the manifest was deleted, and only then did the
  // rmdir hit the stray file. The first recover restored the original but lost
  // the record; the second could only say the manifest was missing.
  for (const [label, plant] of [
    ['a stray file', {
      put: root => writeFileSync(join(root, 'unexpected.txt'), 'planted\n'),
      clear: root => rmSync(join(root, 'unexpected.txt')),
    }],
    ['a subdirectory', {
      put: root => mkdirSync(join(root, 'nested')),
      clear: root => rmSync(join(root, 'nested'), { recursive: true }),
    }],
    ['a symlink', {
      put: root => symlinkSync('/etc/hosts', join(root, 'link')),
      clear: root => rmSync(join(root, 'link')),
    }],
  ]) {
    const { home, context, answers } = shimVerdictFixture('adopt');
    applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
    const state = readInstallState(home);
    const txnDir = join(home, '.config', 'second-brain', 'recovery', state.last_txn);
    plant.put(join(txnDir, ADOPTED_DIR));

    const conf = join(home, '.config', 'second-brain', 'brainkit.conf');
    const beforeConf = fileFacts(conf);
    // Asked of the discard directly. It used to be observed through recover's
    // rollback, which no longer exists -- but the discard is still what the
    // success path runs, and it is still what has to refuse.
    const loaded = loadTransaction(home, state.last_txn, state.vault_root, state.components, state.plan_digest);
    const discarded = discardTransaction(loaded, [], { releaseState: false });
    assert.notEqual(discarded.tag, 'settled', label);
    assert.match(discarded.problems.join(' '), /holds unexpected entries|adopted-shims/, label);
    assert.ok(existsSync(join(txnDir, 'transaction.json')), `${label}: the manifest must survive`);
    // The closeout is checked before anything is consumed, so nothing is undone
    // and the config the next attempt needs is still there.
    assert.deepEqual(fileFacts(conf), beforeConf, `${label}: nothing may be rolled back`);

    // Which leaves a real way out rather than a dead end: clearing the stray
    // lets the discard succeed. It used to be that the first attempt restored
    // the files, deleted brainkit.conf with them, and everything after failed on
    // authorisation.
    plant.clear(join(txnDir, ADOPTED_DIR));
    const retried = discardTransaction(
      loadTransaction(home, state.last_txn, state.vault_root, state.components, state.plan_digest),
      [], { releaseState: false },
    );
    assert.equal(retried.tag, 'settled', `${label}: the retry must be able to finish`);
    // The discard keeps the pointer on purpose -- only a rollback releases it.
    assert.notEqual(readInstallState(home), null, label);
  }
});

test('slice 4 gate 6: a service that will not mount takes the files back with it', () => {
  const launchctl = launchctlMock({ bootstrapFails: 'com.second-brain.watch' });
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });
  const plist = join(home, 'Library', 'LaunchAgents', 'com.second-brain.watch.plist');
  const shim = join(home, '.local', 'bin', 'brain-node');

  assert.throws(() => applyPlan(context, answers, preflight(context, answers), { yes: true }, null),
    error => /Operation not permitted/.test(error.message));

  // Files and services agree: nothing mounted, nothing left on disk.
  assert.equal(launchctl.loaded.size, 0, 'no service may be left loaded');
  assert.equal(existsSync(plist), false, 'the plist this run wrote must be gone');
  assert.equal(existsSync(shim), false, 'and so must the shim');
  assert.equal(existsSync(installStatePath(home)), false);
  assert.deepEqual(readdirSync(join(home, '.config', 'second-brain', 'recovery')), [],
    'a complete rollback leaves no recovery material');
  // The directories themselves stay: they are shared, and §9.1 says so.
  for (const directory of infrastructureDirs(home)) assert.ok(statSync(directory).isDirectory(), `${directory} survives`);
});

test('slice 4 gate 6: a label already loaded from a foreign plist is refused, not taken over', () => {
  const launchctl = launchctlMock();
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });
  const foreign = join(home, 'somebody-elses.plist');
  writeFileSync(foreign, '<plist>not ours</plist>\n');
  launchctl.loaded.set('com.second-brain.watch', foreign);
  const before = managedSnapshot(home, null);

  assert.throws(() => applyPlan(context, answers, preflight(context, answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /will not take over a service it did not install/.test(error.message));
  assert.equal(launchctl.loaded.get('com.second-brain.watch'), foreign, 'their job is left alone');
  // Everything the transaction wrote is unwound. The recovery directory itself
  // stays: it is untracked infrastructure like the config root, created once
  // and never rolled back, and it is empty.
  const recovery = join(home, '.config', 'second-brain', 'recovery');
  assert.deepEqual(readdirSync(recovery), [], 'no recovery material is left behind');
  assert.deepEqual(...ignoringCreatedShells(managedSnapshot(home, null), before, home),
    'and nothing else changed');
  assert.equal(existsSync(installStatePath(home)), false);
  assert.equal(existsSync(join(home, 'Library', 'LaunchAgents', 'com.second-brain.watch.plist')), false);
});

test('r2 BLOCKER-1: the service set is pinned from both ends, so an empty one cannot skip the rollback', () => {
  // services=[] used to validate against a transaction that had replaced a
  // running service's plist: the files rolled back, the service layer was
  // skipped entirely, and recover reported success and deleted the evidence.
  const launchctl = launchctlMock();
  const { home, vault, context, answers } = selectionFixture('core,watch', { launchctl });
  const plist = join(home, 'Library', 'LaunchAgents', 'com.second-brain.watch.plist');
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, '<plist>the version that was already here</plist>\n', { mode: 0o644 });
  chmodSync(plist, 0o644);
  launchctl.loaded.set('com.second-brain.watch', plist);

  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const state = readInstallState(home);
  const manifestFile = join(home, '.config', 'second-brain', 'recovery', state.last_txn, 'transaction.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  assert.deepEqual(manifest.services.map(entry => entry.label), ['com.second-brain.watch']);

  writeFileSync(manifestFile, JSON.stringify({ ...manifest, services: [] }), { mode: 0o600 });
  const installedPlist = fileFacts(plist);
  const before = managedSnapshot(home, vault);
  launchctl.calls.length = 0;

  assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
    error => error.exitCode === EXIT.UNSAFE && /no pre-install state for com\.second-brain\.watch/.test(error.message));

  assert.deepEqual(fileFacts(plist), installedPlist, 'the files must not roll back either');
  assert.deepEqual(managedSnapshot(home, vault), before, 'nothing at all may move');
  assert.deepEqual(launchctl.calls, [], 'and no service call may be made');
  assert.ok(existsSync(manifestFile), 'the manifest is kept');
  assert.equal(readInstallState(home).status, 'installing', 'the state is untouched');
});

test('r2 BLOCKER-1: the service pre-state and its plist land in one manifest write', () => {
  // The reverse hazard of the bidirectional check: if the service were recorded
  // before its plist, a crash between the two would leave a manifest the reader
  // rejects as invalid -- a shape the installer wrote itself. One write, so the
  // half-state cannot exist on disk.
  const launchctl = launchctlMock();
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });

  // EVERY manifest commit, not a sample. The previous version watched
  // context.run and so could only look before the first write or after the
  // second -- the two writes it was meant to catch are adjacent statements with
  // no external call between them, and a build with the old two-write bug
  // passed it 1/1. The installer now hands each committed record to onManifest,
  // which is the only vantage point from which the gap is visible at all.
  const snapshots = [];
  applyPlan({ ...context, onManifest: record => snapshots.push(record) },
    answers, preflight(context, answers), { yes: true }, null);

  const plist = join(home, 'Library', 'LaunchAgents', 'com.second-brain.watch.plist');
  assert.ok(snapshots.length >= 5, `the hook must see every commit, saw ${snapshots.length}`);
  const withService = snapshots.filter(entry => entry.services.length > 0);
  assert.ok(withService.length > 0, 'and at least one of them must carry the service');
  for (const snapshot of withService) {
    const touched = new Set(snapshot.operations.filter(entry => entry.post !== null).map(entry => entry.path));
    assert.ok(touched.has(plist),
      'a manifest naming the service must already name its plist; the two are one write');
  }
  // Every intermediate record must also survive the reader, so no commit is a
  // shape the installer could write but recover would refuse.
  const state = readInstallState(home);
  assert.ok(loadTransaction(home, state.last_txn, state.vault_root, state.components, state.plan_digest));
});

test('r3 BLOCKER-1: a mode changed on its own in the manifest is refused, not restored', () => {
  // The backup bytes and their digest are untouched; only `mode` is edited, to
  // another value inside the legal range. It used to be applied as written --
  // the same hole on a private config file would have widened its permissions.
  const { home, context, answers, shimPath } = shimVerdictFixture('overwrite');
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const state = readInstallState(home);
  const manifestFile = join(home, '.config', 'second-brain', 'recovery', state.last_txn, 'transaction.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const backup = backupOps(manifest).find(entry => entry.path === shimPath);
  assert.equal(backup.pre.mode, 0o755, 'the fixture seeds 0755 so the tamper has somewhere to go');
  backup.pre.mode = 0o777;
  writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });

  assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
    error => error.exitCode === EXIT.UNSAFE && /does not match its own digest/.test(error.message));
  assert.notEqual(statSync(shimPath).mode & 0o777, 0o777, 'and the mode is not widened');
  assert.ok(existsSync(manifestFile), 'the manifest is kept');
});

test('r3 BLOCKER-3: a service whose state cannot be read stops the install', () => {
  // A permission error is not "not loaded". Reading it that way recorded a
  // running service as absent, and the rollback then put the plist back while
  // the job kept running from the installed one.
  const launchctl = launchctlMock();
  const denied = { ...launchctl, answer: (command, args) => {
    if (command === FAKE_LAUNCHCTL && args[0] === 'print') return { status: 1, stdout: '', stderr: 'Operation not permitted' };
    return launchctl.answer(command, args);
  } };
  const { home, context, answers } = selectionFixture('core,watch', { launchctl: denied });
  const before = managedSnapshot(home, null);

  assert.throws(() => applyPlan(context, answers, preflight(context, answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /refusing to install over a service whose state is unknown/.test(error.message));
  const recovery = join(home, '.config', 'second-brain', 'recovery');
  assert.deepEqual(readdirSync(recovery), [], 'the refusal unwinds completely');
  assert.deepEqual(...ignoringCreatedShells(managedSnapshot(home, null), before, home));
  assert.equal(existsSync(installStatePath(home)), false);
});

test('r3 BLOCKER-3: a running service with no earlier plist to restore is refused', () => {
  const launchctl = launchctlMock();
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const state = readInstallState(home);
  const manifestFile = join(home, '.config', 'second-brain', 'recovery', state.last_txn, 'transaction.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const plist = join(home, 'Library', 'LaunchAgents', 'com.second-brain.watch.plist');
  assert.ok(createdOps(manifest).some(entry => entry.path === plist), 'this install created the plist');

  // Claim the job was running before an install that created its plist: there
  // is nothing to bootstrap from once the rollback removes it.
  manifest.services = [{ label: 'com.second-brain.watch', loaded: true, plist }];
  writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });

  assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
    error => error.exitCode === EXIT.UNSAFE && /keeps no earlier copy of/.test(error.message));
  assert.ok(existsSync(plist), 'and nothing is rolled back on the way to finding out');
});

test('r4 BLOCKER-3: a record the reader would refuse is never written', () => {
  // The write-time check, asked directly. The producer builds records out of
  // the authorised shapes, so it cannot generate one the reader refuses -- which
  // is why removing this call left the whole suite green. Handing commitTransaction
  // a record with a path outside the plan is the only way to see it work.
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const state = readInstallState(home);
  const txn = loadTransaction(home, state.last_txn, state.vault_root, state.components, state.plan_digest);
  const before = readFileSync(join(txn.dir, 'transaction.json'));

  txn.operations.push({
    kind: 'file', path: join(home, 'not-in-the-plan.txt'),
    pre: null, post: { sha256: 'x'.repeat(64), size: 1, mode: 0o600, uid: process.getuid() },
    backup: null, retain: false,
  });
  assert.throws(() => commitTransaction(txn), error => error.exitCode === EXIT.UNSAFE,
    'the writer refuses to publish it');
  assert.deepEqual(readFileSync(join(txn.dir, 'transaction.json')), before,
    'and the record on disk is untouched by the attempt');
});

test('r4 BLOCKER-3: the producer refuses a service whose plist is not on disk', () => {
  // The producer used to accept "job loaded from the managed path, but no plist
  // on disk" and write a manifest that loadTransaction then rejected. The
  // install path refuses it now, before the first mutation.
  const launchctl = launchctlMock();
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });
  const plist = join(home, 'Library', 'LaunchAgents', 'com.second-brain.watch.plist');
  // launchd says it is running from the managed path; the file is not there.
  launchctl.loaded.set('com.second-brain.watch', plist);
  const before = managedSnapshot(home, null);

  assert.throws(() => applyPlan(context, answers, preflight(context, answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /is running but .* is not on disk/.test(error.message));
  assert.deepEqual(readdirSync(join(home, '.config', 'second-brain', 'recovery')), [],
    'the refusal unwinds completely');
  assert.deepEqual(...ignoringCreatedShells(managedSnapshot(home, null), before, home));

  // And the general guarantee: every record the writer commits loads back.
  const good = selectionFixture('all');
  const commits = [];
  applyPlan({ ...good.context, onManifest: record => commits.push(record) },
    good.answers, preflight(good.context, good.answers), { yes: true }, 'sk-fixture');
  assert.ok(commits.length >= 20, `every commit is seen, saw ${commits.length}`);
  const state = readInstallState(good.home);
  for (const record of commits) {
    writeFileSync(join(good.home, '.config', 'second-brain', 'recovery', state.last_txn, 'transaction.json'),
      JSON.stringify(record), { mode: 0o600 });
    assert.ok(loadTransaction(good.home, state.last_txn, state.vault_root, state.components, state.plan_digest),
      'a committed record the reader refuses would mean the two disagree');
  }
});

test('r4 BLOCKER-3: a permission error that exits like "not found" is not read as not-running', () => {
  // status 113 with a permission message. Either half alone used to be enough
  // to record the job as absent, so the rollback left it pointing at the plist
  // the install had put there.
  const launchctl = launchctlMock();
  const denied = { ...launchctl, answer: (command, args) => {
    if (command === FAKE_LAUNCHCTL && args[0] === 'print') {
      return { status: 113, stdout: '', stderr: 'Operation not permitted' };
    }
    return launchctl.answer(command, args);
  } };
  const { home, context, answers } = selectionFixture('core,watch', { launchctl: denied });

  assert.throws(() => applyPlan(context, answers, preflight(context, answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /refusing to install over a service whose state is unknown/.test(error.message));
  assert.equal(existsSync(installStatePath(home)), false);
});

test('r4 (b): the mount check reads the plist path, it does not search the output for it', () => {
  // The install path asked whether the plist path appeared anywhere in `print`
  // output. Here launchd reports the job running from somewhere else entirely
  // while mentioning our path in an environment variable -- which the substring
  // check accepted, and which its own comment said it ruled out.
  const launchctl = launchctlMock();
  const elsewhere = '/somewhere/else/com.second-brain.watch.plist';
  const lying = { ...launchctl, answer: (command, args) => {
    if (command === FAKE_LAUNCHCTL && args[0] === 'print') {
      const label = String(args[1] || '').split('/').pop();
      if (!launchctl.loaded.has(label)) return { status: 113, stdout: '', stderr: 'Could not find specified service' };
      return {
        status: 0,
        stdout: `gui/501/${label} = {\n\tpath = ${elsewhere}\n\tenvironment = {\n\t\tPLIST => ${launchctl.loaded.get(label)}\n\t}\n}\n`,
        stderr: '',
      };
    }
    return launchctl.answer(command, args);
  } };
  const { home, context, answers } = selectionFixture('core,watch', { launchctl: lying });

  assert.throws(() => applyPlan(context, answers, preflight(context, answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && new RegExp(`is loaded from ${elsewhere}`).test(error.message));
  assert.equal(existsSync(installStatePath(home)), false, 'and the install unwinds');
});

test('r5 BLOCKER-1: the plan is answerable to the registry, not merely to itself', () => {
  // The counterfactual for the gate above. Deleting a row from `operations`
  // alone is caught by the plan -- but that only means the manifest disagrees
  // with itself. If the plan were taken at face value, the same deletion made
  // in both places, with the digest recomputed to match, would restore the
  // agreement and pass. It has to be refused by rebuilding the expected surface
  // from the registry, which is the only party the manifest cannot edit.
  const { home, vault, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const manifestFile = join(home, '.config', 'second-brain', 'recovery', readInstallState(home).last_txn, 'transaction.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const root = realpathSync(vault);

  const plan = manifest.plan.filter(entry => entry.path !== root);
  assert.equal(plan.length, manifest.plan.length - 1, 'the root must really be in the plan');
  writeFileSync(manifestFile, JSON.stringify({
    ...manifest,
    plan,
    planDigest: planDigest(plan),
    operations: manifest.operations.filter(entry => entry.path !== root),
  }), { mode: 0o600 });

  assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
    error => error.exitCode === EXIT.UNSAFE && /not the surface this installer would plan/.test(error.message),
    'a self-consistent manifest that shrank its own plan is still refused');
  assert.ok(existsSync(root), 'and the row it tried to disown is untouched');
});

test('r6 BLOCKER-1: requiredness has to agree across both files, not just with itself', () => {
  // The review's bypass: keep the plan row, flip the historical `existed` flag
  // that decides whether the row needs an operation, recompute planDigest so
  // the manifest is self-consistent again, then delete the row's operation.
  // The path surface is unchanged, so the registry comparison is satisfied; the
  // completeness sweep then skips the row because the manifest now claims it
  // was already there. Nothing at recover time can re-derive that flag, so the
  // only thing that can contradict it is a second file that recorded it too.
  const flip = (manifest, path) => {
    const plan = manifest.plan.map(entry => entry.path === path ? { ...entry, existed: true } : entry);
    assert.notDeepEqual(plan, manifest.plan, 'the flip must actually change the plan');
    return {
      ...manifest,
      plan,
      planDigest: planDigest(plan),
      operations: manifest.operations.filter(entry => entry.path !== path),
    };
  };

  {
    const { home, vault, context, answers } = installFixture();
    applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
    const root = realpathSync(vault);
    const manifestFile = join(home, '.config', 'second-brain', 'recovery', readInstallState(home).last_txn, 'transaction.json');
    writeFileSync(manifestFile, JSON.stringify(flip(JSON.parse(readFileSync(manifestFile, 'utf8')), root)), { mode: 0o600 });

    assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
      error => error.exitCode === EXIT.UNSAFE && /disagree about what this install was required to produce/.test(error.message),
      'a manifest that rewrites its own history is refused');
    assert.ok(existsSync(root), 'the root it tried to disown is still there');
    assert.ok(existsSync(manifestFile), 'and the material is kept');
    // The refusal happens before anything is written, so the status is left
    // exactly as it was rather than re-marked. It is not `installed`, which is
    // what keeps the install gate shut.
    assert.notEqual(readInstallState(home).status, 'installed');
    assert.match(check(preflight(context, answers, { command: 'install' }), 'install-state').message, /recover/);
  }

  // The mirror case: the state is the file that was edited. Same refusal --
  // neither copy is privileged, they simply have to match.
  {
    const { home, context, answers } = installFixture();
    applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
    const statePath = join(home, '.config', 'second-brain', 'install-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({ ...state, plan_digest: 'f'.repeat(64) }, null, 2), { mode: 0o600 });

    assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
      error => error.exitCode === EXIT.UNSAFE && /disagree about what this install was required to produce/.test(error.message),
      'a state that disagrees with the manifest is refused too');
  }

  // And a state with no copy at all cannot vouch for anything.
  {
    const { home, context, answers } = installFixture();
    applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
    const statePath = join(home, '.config', 'second-brain', 'install-state.json');
    const { plan_digest: _dropped, ...without } = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify(without, null, 2), { mode: 0o600 });

    assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
      error => error.exitCode === EXIT.UNSAFE && /nothing to agree with/.test(error.message),
      'a state with no record of requiredness is refused');
  }
});

test('r6 BLOCKER-1: the disagreement is caught before anything on disk is touched', () => {
  // The review also noted that the plain delete-one refusal happened only after
  // executeRollback had already undone 43 things. This check runs inside
  // loadTransaction, so the refusal lands with the disk untouched.
  const { home, vault, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const root = realpathSync(vault);
  const manifestFile = join(home, '.config', 'second-brain', 'recovery', readInstallState(home).last_txn, 'transaction.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const plan = manifest.plan.map(entry => entry.path === root ? { ...entry, existed: true } : entry);
  writeFileSync(manifestFile, JSON.stringify({
    ...manifest, plan, planDigest: planDigest(plan),
    operations: manifest.operations.filter(entry => entry.path !== root),
  }), { mode: 0o600 });

  const before = managedSnapshot(home, realpathSync(vault));
  assert.throws(() => recoverInstall({ ...context, stdout: () => {} }), /disagree about what this install was required to produce/);
  assert.deepEqual(managedSnapshot(home, realpathSync(vault)), before,
    'not one managed path changed before the refusal');
});

// The rollback engine's only live entry now that recover is read-only: an
// install that fails and undoes itself. The seams fire exactly as before, so
// closeout behaviour is exercised here instead of through recover.
function failingInstall({ failpoint = null, home = null } = {}) {
  const launchctl = launchctlMock({ bootstrapFails: 'com.second-brain.watch' });
  const fixture = selectionFixture('core,watch', {
    ...(home ? { home } : {}),
    launchctl,
    context: failpoint ? { failpoint } : {},
  });
  return fixture;
}

// Runs it and reports what the install did, the way a caller would see it.
function rollbackOf(fixture) {
  let output = '';
  const context = { ...fixture.context, stdout: text => { output += text; } };
  try {
    applyPlan(context, fixture.answers, preflight(context, fixture.answers), { yes: true }, 'sk-fixture');
  } catch (error) {
    return { code: error.exitCode ?? 1, output: output + error.message };
  }
  return { code: EXIT.OK, output };
}

// These guard the rollback that runs inside a failed install -- the one path
// that still repairs anything. They used to be driven through recover, and were
// deleted with it on the reasoning that the property went where its driver went.
// That was wrong: a property lives as long as the code it guards still runs, and
// all of this runs in executeRollback and closeOut either way. Restored with the
// driver swapped and the assertions untouched.
//
// The setup happens in beforeFailure, the instant before the rollback begins,
// because that is the only seam ahead of it on this path.

test('recover: a service this install started is reported, not filtered out', () => {
  // The record's `loaded` flag means "was already running before the install".
  // A service the install started is therefore recorded as loaded:false, and
  // filtering the diagnosis on it hid exactly the ones the user has to stop --
  // they would delete the plist and the script with the job still running.
  const launchctl = launchctlMock();
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });
  applyPlan(context, answers, preflight(context, answers), { yes: true }, 'sk-fixture');
  assert.equal(launchctl.loaded.has('com.second-brain.watch'), true, 'the fixture leaves it running');

  let output = '';
  assert.equal(recoverInstall({ ...context, stdout: text => { output += text; } }), EXIT.RECOVERY);
  assert.match(output, /unload {3}com\.second-brain\.watch/, 'the running service is named');
  assert.match(output, /launchctl bootout/, 'with the command that stops it');
});

test('recover: a file the install only observed is not reported as replaced', () => {
  // An idempotent shim is already exactly what the installer would write, so it
  // is recorded with post:null and no backup -- nothing was changed and there is
  // nothing to copy back. Reporting it as replaced sent the user looking for a
  // backup that does not exist.
  const { home, context, answers, shimPath } = shimVerdictFixture('idempotent-exact');
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const manifest = readManifest(home, readInstallState(home).last_txn);
  const observed = manifest.operations.find(entry => entry.path === shimPath);
  assert.ok(observed, 'the shim is in the record');
  assert.equal(observed.post, null, 'recorded as observed rather than written');
  assert.equal(observed.backup, null, 'and with no backup, which is the point');

  let output = '';
  assert.equal(recoverInstall({ ...context, stdout: text => { output += text; } }), EXIT.RECOVERY);
  assert.doesNotMatch(output, new RegExp(`restore.*${basename(shimPath)}`),
    'a file that was never changed is not something to put back');
});

test('rollback: a service that was already running comes back from its own plist', () => {
  // The other half of the bracket. The rollback unloads what it found running,
  // restores the plist that was there before, and puts the job back from that
  // plist. It is not part of the removed recover capability -- executeRollback
  // does it, and applyPlan's catch calls executeRollback.
  const launchctl = launchctlMock({ bootstrapFails: 'com.second-brain.clip' });
  const { home, context, answers } = selectionFixture('core,clip,watch', { launchctl });
  const plist = join(home, 'Library', 'LaunchAgents', 'com.second-brain.watch.plist');
  mkdirSync(dirname(plist), { recursive: true });
  // Somebody else's job, running from their own plist, before this install runs.
  const theirs = '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.second-brain.watch</string></dict></plist>\n';
  writeFileSync(plist, theirs, { mode: 0o644 });
  launchctl.loaded.set('com.second-brain.watch', plist);

  try {
    applyPlan(context, answers, preflight(context, answers), { yes: true }, 'sk-fixture');
  } catch { /* the install fails, as the fixture arranges */ }

  assert.equal(readFileSync(plist, 'utf8'), theirs, 'their plist is back');
  assert.equal(launchctl.loaded.get('com.second-brain.watch'), plist,
    'and the old service comes back, loaded from it');
});

test('rollback: a file changed after the install is neither deleted nor overwritten', () => {
  // The user edits something the install wrote, then the install fails. Their
  // edit is not this transaction's to undo -- it is not what the install left
  // there, so the rollback has to leave it alone and say so.
  const routing = { path: null };
  const launchctl = launchctlMock({
    bootstrapFails: 'com.second-brain.watch',
    beforeFailure: () => writeFileSync(routing.path, '{"mine":true}\n', { mode: 0o600 }),
  });
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });
  routing.path = join(home, '.config', 'second-brain', 'vault-routing.json');

  let output = '';
  let code = null;
  try {
    applyPlan({ ...context, stdout: text => { output += text; } }, answers,
      preflight(context, answers), { yes: true }, 'sk-fixture');
  } catch (error) { code = error.exitCode ?? 1; output += error.message; }

  assert.notEqual(code, null, 'the install fails, as the fixture arranges');
  assert.ok(existsSync(routing.path), 'the file the user changed is still there');
  assert.equal(readFileSync(routing.path, 'utf8'), '{"mine":true}\n', 'with their content');
  assert.match(output, /no longer what this install left there/, 'and the rollback says why it stopped');
});

test('rollback: a backup whose bytes no longer match its record is never restored over the original', () => {
  // The copy taken before the install is corrupted by the time the rollback
  // wants it. Writing whatever bytes happen to be at the backup path would put
  // rubbish over the user's original, so it refuses instead.
  const routing = { path: null, backup: null };
  const launchctl = launchctlMock({
    bootstrapFails: 'com.second-brain.watch',
    beforeFailure: () => {
      const dir = join(routing.home, '.config', 'second-brain', 'recovery', readInstallState(routing.home).last_txn);
      const manifest = JSON.parse(readFileSync(join(dir, 'transaction.json'), 'utf8'));
      routing.backup = manifest.operations.find(entry => entry.path === routing.path)?.backup;
      if (routing.backup) writeFileSync(routing.backup, 'truncated', { mode: 0o600 });
    },
  });
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });
  routing.home = home;
  routing.path = join(home, '.config', 'second-brain', 'vault-routing.json');
  // Pre-existing, so the install replaces it and takes a backup of the original.
  writeFileSync(routing.path, '{"schema":"v2","mine":true}\n', { mode: 0o600 });

  let output = '';
  try {
    applyPlan({ ...context, stdout: text => { output += text; } }, answers,
      preflight(context, answers), { yes: true }, 'sk-fixture');
  } catch (error) { output += error.message; }

  assert.notEqual(routing.backup, null, 'the fixture must produce a backup to corrupt');
  assert.match(output, /refusing to restore/, 'the rollback refuses rather than restoring rubbish');
  assert.notEqual(readFileSync(routing.path, 'utf8'), 'truncated',
    'and the corrupted bytes never reach the original');
});

test('rollback: a directory remade at the same path is a different directory', () => {
  // Same path, new directory -- a different inode, or the same one reused. It is
  // not the directory this install created, so removing it is not this
  // transaction's business.
  const vault = { root: null };
  const launchctl = launchctlMock({
    bootstrapFails: 'com.second-brain.watch',
    beforeFailure: () => {
      // Replace a directory the install created with a fresh one at the same path.
      // Empty on purpose: a non-empty replacement survives anyway because rmdir
      // refuses it, so it would pass whether the identity check works or not.
      rmSync(join(vault.root, '09-周报'), { recursive: true, force: true });
      mkdirSync(join(vault.root, '09-周报'));
    },
  });
  const { home, context, answers, vault: vaultPath } = selectionFixture('core,watch', { launchctl });
  vault.root = realpathSync(dirname(vaultPath)) === vaultPath ? vaultPath : vaultPath;

  let output = '';
  try {
    applyPlan({ ...context, stdout: text => { output += text; } }, answers,
      preflight(context, answers), { yes: true }, 'sk-fixture');
  } catch (error) { output += error.message; }

  assert.ok(existsSync(join(vault.root, '09-周报')),
    'a directory this install did not create is not removed by its rollback');
});

test('rollback: two different files under the two record names is a conflict', () => {
  // Something already occupies the name the record is about to take. It is not
  // this transaction's, so the consumption refuses rather than linking over it
  // or adopting it. The grid plants foreign objects at that name too, but only
  // one at a time -- this is the state where both names are occupied by
  // different files, which the protocol cannot produce and must not accept.
  const sentinel = { path: null };
  const launchctl = launchctlMock({
    bootstrapFails: 'com.second-brain.watch',
    beforeFailure: () => {
      const dir = join(sentinel.home, '.config', 'second-brain', 'recovery', readInstallState(sentinel.home).last_txn);
      sentinel.path = join(dir, 'transaction.spent.json');
      writeFileSync(sentinel.path, 'FOREIGN\n', { mode: 0o600 });
    },
  });
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });
  sentinel.home = home;

  let output = '';
  try {
    applyPlan({ ...context, stdout: text => { output += text; } }, answers,
      preflight(context, answers), { yes: true }, 'sk-fixture');
  } catch (error) { output += error.message; }

  assert.notEqual(sentinel.path, null, 'the fixture must reach the closeout');
  assert.ok(existsSync(sentinel.path), 'the file already at that name is still there');
  assert.equal(readFileSync(sentinel.path, 'utf8'), 'FOREIGN\n', 'and untouched');
});

test('rollback: an unknown leaf under the adopted originals is not a clean terminal', () => {
  // The adopted-shims directory holds the only copy of a third-party file this
  // install replaced. Losing it loses the user's own script, so it is the
  // highest-stakes data in the design -- and it was the one part with no gate on
  // the path that still repairs.
  const nested = { path: null };
  const launchctl = launchctlMock({
    bootstrapFails: 'com.second-brain.watch',
    beforeFailure: () => {
      const dir = join(nested.home, '.config', 'second-brain', 'recovery', readInstallState(nested.home).last_txn);
      nested.path = join(dir, ADOPTED_DIR, 'not-an-original');
      if (existsSync(join(dir, ADOPTED_DIR))) writeFileSync(nested.path, 'nor mine\n', { mode: 0o600 });
    },
  });
  const { home, context, answers, shimPath } = selectionFixture('core,watch', {
    launchctl,
    answers: { adoptShims: true },
  });
  nested.home = home;
  // A third-party shim already at the path, so the install adopts it and keeps
  // the original in adopted-shims.
  writeFileSync(shimPath ?? join(home, '.local', 'bin', 'brain-node'), THIRD_PARTY_SHIM, { mode: 0o755 });
  chmodSync(join(home, '.local', 'bin', 'brain-node'), 0o755);

  let output = '';
  try {
    applyPlan({ ...context, stdout: text => { output += text; } }, answers,
      preflight(context, answers), { yes: true }, 'sk-fixture');
  } catch (error) { output += error.message; }

  assert.notEqual(nested.path, null, 'the fixture must reach the closeout');
  // The unknown file makes the closeout impossible, so it is refused before the
  // rollback starts and nothing is touched at all. What must survive that is the
  // only copy of the user's own script.
  assert.ok(existsSync(nested.path), 'the unknown file is left alone');
  assert.equal(readFileSync(nested.path, 'utf8'), 'nor mine\n', 'and unchanged');
  const adopted = join(dirname(nested.path));
  const originals = readdirSync(adopted).filter(entry => entry !== 'not-an-original');
  assert.equal(originals.length, 1, 'the adopted original is still in the directory');
  assert.equal(readFileSync(join(adopted, originals[0]), 'utf8'), THIRD_PARTY_SHIM,
    'byte for byte -- it is the only copy of the file this install replaced');
});

test('rollback: an immutable target is caught before anything is deleted', () => {
  // A file the rollback cannot remove is found while checking, not halfway
  // through. Everything else stays put so the situation is still recoverable
  // by hand.
  const target = { path: null };
  const launchctl = launchctlMock({
    bootstrapFails: 'com.second-brain.watch',
    beforeFailure: () => { chflags('uchg', target.path); },
  });
  const { home, context, answers } = selectionFixture('core,watch', { launchctl });
  target.path = join(home, '.config', 'second-brain', 'vault-routing.json');

  let output = '';
  try {
    applyPlan({ ...context, stdout: text => { output += text; } }, answers,
      preflight(context, answers), { yes: true }, 'sk-fixture');
  } catch (error) { output += error.message; }
  const stillThere = existsSync(target.path);
  chflags('nouchg', target.path);

  if (!stillThere) return; // chflags unavailable here; nothing to assert
  assert.match(output, /immutable flag set|cannot be/, 'the rollback names the obstacle');
  assert.ok(existsSync(join(home, '.local', 'bin', 'brain-node')),
    'and stops before deleting anything else');
});

test('rollback: a service that will not unload stops the file rollback instead of hiding it', () => {
  // The plist stays on disk while its job is still loaded. Taking the file away
  // from a running service would leave launchd pointing at nothing.
  const launchctl = launchctlMock({
    // clip mounts first and succeeds; watch fails, so the rollback has to take
    // clip back down -- and clip is the one that refuses to unload.
    bootstrapFails: 'com.second-brain.watch',
    bootoutFails: 'com.second-brain.clip',
  });
  const { home, context, answers } = selectionFixture('core,clip,watch', { launchctl });

  let output = '';
  try {
    applyPlan({ ...context, stdout: text => { output += text; } }, answers,
      preflight(context, answers), { yes: true }, 'sk-fixture');
  } catch (error) { output += error.message; }

  assert.match(output, /still loaded after|could not be unloaded|Operation not permitted/,
    'the failure to unload is reported, not swallowed');
  assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'com.second-brain.clip.plist')),
    'and the plist a loaded job points at is not taken away underneath it');
});

test('r7 BLOCKER-1: the closeout removes only backups the manifest names', () => {
  // The review's counterexample. An unrelated regular file in the transaction
  // directory is not this transaction's to delete, however ordinary it looks.
  // Enumerating the directory instead of the manifest deleted it and exited 0.
  let stray = null;
  const fixture = failingInstall({
    failpoint: name => {
      // Present before the cleanup starts, which is what the old gate missed by
      // only adding one after the deletions had already run.
      // Before the closeout starts, so the stray is already there when the
      // backup loop runs. Planting it later means a cleanup that enumerates the
      // directory never sees it, and the gate proves nothing.
      if (name !== 'before-phase' || stray) return;
      const dir = join(fixture.home, '.config', 'second-brain', 'recovery', readInstallState(fixture.home).last_txn);
      stray = join(dir, 'unrelated-regular-file');
      writeFileSync(stray, 'not mine\n', { mode: 0o600 });
    },
  });
  const { output } = rollbackOf(fixture);
  assert.notEqual(stray, null, 'the fixture must reach the cleanup');

  assert.ok(existsSync(stray), 'a file no authority names is never deleted');
  assert.equal(readFileSync(stray, 'utf8'), 'not mine\n', 'nor rewritten');
  assert.match(output, /unrelated-regular-file/, 'and it is named in the outcome');
  // Exit 0 has to mean the directory holds exactly what this transaction owns.
  // "The business data came back" is not enough: the transaction did not reach
  // its terminal inventory, so this is a failure with the evidence kept.
  // The install failed, so it exits non-zero either way; what matters is that
  // the leftover is named rather than swept, and the record explaining it stays.
  // Present before the closeout starts, so it is caught in the preflight and
  // nothing is consumed at all -- the record is still under its live name.
  assert.ok(existsSync(join(dirname(stray), 'transaction.json')),
    'and the record explaining the leftover is still there, unconsumed');
});

test('r11-1: a state file belonging to another install is never deleted', () => {
  // The path the review described, played out rather than asserted about.
  // An install crashes; its lock is reclaimed; a second install runs to
  // completion and writes its own state; someone then runs recover for the
  // first transaction. The first transaction's rollback must not take the
  // second install's state file with it -- that file is in use.
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const statePath = join(home, '.config', 'second-brain', 'install-state.json');
  const first = readInstallState(home);
  const txnDir = join(home, '.config', 'second-brain', 'recovery', first.last_txn);

  // Load the abandoned transaction while its own state still names it, the way
  // recover would, then let a different install take the state file over.
  const stranded = loadTransaction(home, first.last_txn, first.vault_root, first.components, first.plan_digest);
  const other = { ...first, last_txn: 'a1b2c3d4e5f60718' };
  writeFileSync(statePath, `${JSON.stringify(other, null, 2)}\n`, { mode: 0o600 });
  const identity = statSync(statePath).ino;

  const settled = settleTransaction(stranded, () => [], {});

  assert.ok(existsSync(statePath), 'the other install still has its state file');
  assert.equal(statSync(statePath).ino, identity, 'and it is the same file, not a rewrite');
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), other, 'with its contents intact');
  assert.equal(settled.tag, 'blocked', 'the closeout refuses rather than proceeding');
  assert.match(settled.problems.join(' '), /names transaction a1b2c3d4e5f60718/);
  assert.deepEqual(settled.done, [], 'and refuses before undoing anything');
  assert.ok(existsSync(join(txnDir, 'transaction.json')), 'the stranded record is kept');
});

test('r11-1: a foreign state file is drift, asked directly', () => {
  // The rule itself, without the closeout precondition in front of it. That
  // precondition refuses this scenario first, so it would mask a regression
  // here -- and this is the layer with the data consequence: the state
  // operation has no pre-image, so anything judged `installed` gets unlinked.
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const state = readInstallState(home);
  const statePath = join(home, '.config', 'second-brain', 'install-state.json');
  const stateOp = readManifest(home, state.last_txn).operations.find(entry => entry.path === statePath);
  // Rewritten since this transaction wrote it -- which is the only time the
  // rule is consulted at all, since an untouched file matches its post-image
  // and is recognised long before. A second install taking the state over is
  // exactly that: same path, still a valid state, different transaction.
  writeFileSync(statePath, `${JSON.stringify({ ...state, last_txn: 'a1b2c3d4e5f60718' }, null, 2)}\n`, { mode: 0o600 });

  assert.equal(operationState(stateOp, { id: 'a1b2c3d4e5f60718', home }), 'installed',
    'the transaction it names recognises it');
  assert.equal(operationState(stateOp, { id: state.last_txn, home }), 'drifted',
    'the same file, asked on behalf of the transaction it no longer names, is not that one to touch');
});

test('r11-3: the install state is written before the vault root', () => {
  // Operations are appended in the order they are applied, so the record shows
  // the order directly. With the vault root created first there was a window
  // where the manifest declared it, the directory could already exist, and
  // nothing on disk pointed at the transaction at all.
  const { home, context, answers, vault } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const state = readInstallState(home);
  const manifest = readManifest(home, state.last_txn);
  const paths = manifest.operations.map(entry => entry.path);
  const stateAt = paths.indexOf(join(home, '.config', 'second-brain', 'install-state.json'));
  const vaultAt = paths.indexOf(realpathSync(vault));
  assert.ok(stateAt >= 0, 'the state file is a managed operation');
  assert.ok(vaultAt >= 0, 'and so is the vault root');
  assert.ok(stateAt < vaultAt,
    `the state is declared first (state at ${stateAt}, vault root at ${vaultAt})`);
});

test('r11-4: recover reports stranded transactions when there is no state', () => {
  // recover is where someone goes when they think something is wrong. With no
  // install state it used to say "nothing to recover" and stop, even with
  // unfinished transactions sitting in the recovery directory.
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const orphan = readInstallState(home).last_txn;
  unlinkSync(join(home, '.config', 'second-brain', 'install-state.json'));

  let output = '';
  assert.equal(recoverInstall({ ...context, stdout: text => { output += text; } }), EXIT.OK,
    'still not an error -- this is a notice');
  assert.match(output, /no half-finished install to undo/);
  assert.match(output, new RegExp(orphan), 'the stranded transaction is named');
  assert.match(output, /remove them by hand/, 'and it says what to do about it');
  assert.ok(existsSync(join(home, '.config', 'second-brain', 'recovery', orphan)),
    'while leaving it exactly where it is');
});

test('r12: a state owned by somebody else is refused, at the one place that decides it', () => {
  // The owner column of the matrix. It cannot be driven from recoverInstall the
  // way the other four are: making a file owned by a different uid needs root,
  // and this suite must never need root. What makes a single assertion enough
  // is the change that came with it -- all five edges now ask the same
  // function, so there is one place where owner is decided rather than three
  // that disagreed.
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const statePath = join(home, '.config', 'second-brain', 'install-state.json');
  const real = readFileSync(statePath);
  const facts = uid => ({
    symlink: false,
    stat: { isFile: () => true, uid, mode: 0o600 },
    content: real,
  });

  assert.equal(installStateFrom(facts(process.getuid()), statePath).reject, undefined,
    'our own state passes');
  assert.match(installStateFrom(facts(process.getuid() + 1), statePath).reject ?? '', /owner mismatch/,
    'somebody else\'s does not');

  // And that this is genuinely the only gate: every reader goes through it.
  assert.equal(installSource.match(/installStateFrom\(/g).length, 4,
    'one definition and three callers -- if this changes, the owner check has grown a bypass');
});

test('r12: the layer that decides deletion applies the full state check', () => {
  // operationState is what decides whether the state file counts as this
  // install's own, and that operation has no pre-image -- so "yes" means
  // unlink. It used to answer yes for any file that parsed and carried the
  // right id, ignoring mode and owner, which is how a state chmodded out from
  // under a run still got deleted.
  //
  // Asked directly, because from the entry point the anchor-release drift check
  // now refuses first. That check is the outer of two guards; this is the inner
  // one, and a mutation of it is invisible from outside while the outer holds.
  // Both are wanted: the outer one is about the file changing mid-run, this one
  // is about the file not being a state this install may touch at all.
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const state = readInstallState(home);
  const statePath = join(home, '.config', 'second-brain', 'install-state.json');
  const stateOp = readManifest(home, state.last_txn).operations.find(entry => entry.path === statePath);
  const txn = { id: state.last_txn, home };

  assert.equal(operationState(stateOp, txn), 'installed', 'its own state, untouched');
  chmodSync(statePath, 0o644);
  assert.equal(operationState(stateOp, txn), 'drifted',
    'the same bytes at a mode this installer never writes are not ours to delete');
  chmodSync(statePath, 0o600);
  assert.equal(operationState(stateOp, txn), 'installed', 'and back again when the mode is put right');
});

test('r12: the failed-install rollback refuses a drifted state too', () => {
  // This path reaches settleTransaction from applyPlan's catch, which never
  // sets txn.stateSnapshot -- so releaseAnchor's drift check is skipped and
  // operationState's full validation is the only thing guarding here. The path
  // with no redundancy is the one most worth a gate.
  const launchctl = launchctlMock({ bootstrapFails: 'com.second-brain.watch' });
  const statePath = {};
  const { home, context, answers } = selectionFixture('core,watch', {
    launchctl,
    context: {
      failpoint: name => {
        if (name !== 'after-backups') return;
        chmodSync(statePath.path, 0o644);
        drifted = readFileSync(statePath.path);
      },
    },
  });
  statePath.path = installStatePath(home);

  let drifted = null;
  let code = null;
  try {
    applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  } catch (error) { code = error.exitCode ?? 'threw'; }

  assert.notEqual(code, null, 'the install fails, as the fixture arranges');
  assert.ok(existsSync(statePath.path),
    'a state this run cannot vouch for is not deleted');
  // Not just present -- unchanged. A run that cannot vouch for this file must
  // not put its own older copy back over it either, which is a separate failure
  // from deleting it and needs its own assertion.
  assert.deepEqual(readFileSync(statePath.path), drifted,
    'a state this run cannot vouch for is not rewritten from its own snapshot');
  assert.ok(existsSync(statePath.path),
    `a state this run can no longer vouch for is not deleted (code=${code})`);
});

test('r12: recover stands aside while an install is running', () => {
  // A live installer holding the lock used to be invisible: recover read the
  // state first, found none, and told the user their recovery directory held
  // orphans to delete -- while an install was busy creating them.
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const orphan = readInstallState(home).last_txn;
  unlinkSync(join(home, '.config', 'second-brain', 'install-state.json'));
  // A lock held by this very process: acquireLock counts its own pid as live on
  // purpose, since two overlapping transactions in one process is a bug.
  writeFileSync(join(home, '.config', 'second-brain', 'install.lock'), `${process.pid}\n`, { mode: 0o600 });

  let output = '';
  const code = recoverInstall({ ...context, stdout: text => { output += text; } });

  assert.equal(code, EXIT.ACTIONABLE, 'a busy machine is not "nothing to recover"');
  assert.match(output, /An install is running now \(pid \d+\)/);
  assert.doesNotMatch(output, /remove them by hand/,
    'and it must not invite the user to delete a running install\'s material');
  assert.ok(existsSync(join(home, '.config', 'second-brain', 'recovery', orphan)),
    'which is still exactly where it was');
});

// Every seam the closeout can be interrupted at, crossed with every shape
// something foreign can take, crossed with both names the record uses. The
// first two dimensions were enumerated in earlier rounds; timing was not, and
// every defect since has been the same shape -- the named cell fixed, the next
// moment in time still open. So it is a dimension here rather than a series of
// one-off cases.
const CLOSEOUT_SEAMS = [
  'during-backups', 'after-backups', 'during-mark', 'before-rebuild',
  'after-manifest', 'after-anchors', 'before-rmdir', 'after-state',
];
const FOREIGN_SHAPES = {
  // Not a foreign arrival but the other half of the same axis: the name is
  // emptied instead of occupied. A record that vanishes is as much a state the
  // closeout has to survive as a record that is impersonated.
  absent: path => { try { rmSync(path, { recursive: true, force: true }); } catch { /* already gone */ } },
  regular: path => writeFileSync(path, 'FOREIGN\n', { mode: 0o600 }),
  symlink: (path, home) => symlinkSync(join(home, 'elsewhere.txt'), path),
  directory: path => mkdirSync(path),
  fifo: path => spawnSync('/usr/bin/mkfifo', [path]),
};
const MARKER_NAMES = ['transaction.json', 'transaction.spent.json'];

// What every cell has to satisfy, whatever the outcome. Deliberately about the
// two things that cannot be traded away -- nothing foreign is destroyed, and a
// clean exit means a clean directory -- rather than about a specific exit code,
// because the right code genuinely differs between cells. Whether a failure
// leaves a usable record is not asserted here: these fixtures displace the
// record themselves to make room for the foreign object, so the answer would be
// about the fixture. The r8 and r9 gates cover it against the real thing.
function closeoutCellInvariants(cell) {
  const problems = [];
  // `absent` plants nothing, so there is nothing of anyone else's to preserve;
  // for that shape the question is only whether the outcome is honest.
  if (cell.shape !== 'absent' && cell.foreignSurvived === false) problems.push('destroyed something it did not own');
  // Not conditioned on exit 0 any more. Every cell runs through a failing
  // install, so the exit code is always non-zero and 'exit 0 implies clean' was
  // vacuous -- it could not fail, which a mutation turning a leftover into a
  // silent success proved by staying green. What has to hold instead: either the
  // directory reached its terminal shape, or the run said what it left behind.
  if (!cell.terminalClean && !cell.named) problems.push('left something behind without saying so');
  return problems;
}

test('r10: seam x shape x name -- the closeout holds at every cell', () => {
  const rows = [];
  for (const seam of CLOSEOUT_SEAMS) {
    for (const [shape, make] of Object.entries(FOREIGN_SHAPES)) {
      for (const name of MARKER_NAMES) {
        const home = makeHome();
        const conf = join(home, '.config', 'second-brain', 'brainkit.conf');
        writeFileSync(conf, 'vault="/previous"\n', { mode: 0o600 });
        writeFileSync(join(home, 'elsewhere.txt'), 'outside\n', { mode: 0o600 });
        // A file that already exists and is NOT an anchor, so the backup loop
        // has something of its own to walk. The anchors' copies are spent by
        // their own release later, so a fixture with only those never enters
        // the loop at all and during-backups would never fire.
        writeFileSync(join(home, '.config', 'second-brain', 'vault-routing.json'), '{"schema":"v2"}\n', { mode: 0o600 });

        let planted = false;
        let txnDir = null;
        let target = null;
        const fixture = failingInstall({
          home,
          failpoint: hit => {
            // Worked out once and kept: by the last seam the state file has been
            // released, so asking it again would throw inside the callback and
            // abort the closeout before the cell under test is reached.
            if (txnDir === null) {
              txnDir = join(home, '.config', 'second-brain', 'recovery', readInstallState(home).last_txn);
              target = join(txnDir, name);
            }
              // before-rebuild is only reached once the record has gone missing,
              // so getting there means removing it first. Without this the seam
              // never fires and the whole column would quietly be empty.
            if (seam === 'before-rebuild' && hit === 'after-backups') {
              rmSync(join(txnDir, 'transaction.json'), { force: true });
              return;
            }
            if (hit !== seam || planted) return;
            // Whatever is at that name right now is this transaction's own
            // record; move it aside rather than destroying it, so the cell
            // tests a foreign arrival and not a corrupted record.
            if (shape !== 'absent' && existsSync(target)) renameSync(target, join(txnDir, 'displaced-record'));
            make(target, home);
            planted = shape === 'absent' ? !existsSync(target) : (existsSync(target) || shape === 'fifo');
          },
        });
        const { code, output } = rollbackOf(fixture);

        // Not every combination is constructible: mkfifo may be unavailable,
        // and a name that is already empty cannot be emptied again. Those are
        // recorded as skipped rather than silently dropped.
        if (!planted) { rows.push({ seam, shape, name, code: null, skipped: true, left: '' }); continue; }

        const left = existsSync(txnDir) ? readdirSync(txnDir) : [];
        const cell = {
          seam, shape, name, code,
          // The foreign object is still there, and still what it was.
          foreignSurvived: existsSync(target),
          // A clean exit means the directory is gone or holds only the record --
          // and "the record" by what it is, not by what it is called. Accepting
          // any name beginning with `transaction` is the same name-trust this
          // whole grid exists to catch, and it hid four cells where a foreign
          // empty directory called transaction.json was reported as clean.
          terminalClean: !existsSync(txnDir) || left.every(entry => MARKER_NAMES.includes(entry)
            && lstatSync(join(txnDir, entry)).isFile() && entry !== name),
          left: left.sort().join(','),
          // Did the run name what it left? A leftover that is reported is a
          // different outcome from one that is swallowed.
          named: left.some(entry => output.includes(entry)),
        };
        cell.problems = closeoutCellInvariants(cell);
        rows.push(cell);
        assert.deepEqual(cell.problems, [],
          `${seam} / ${shape} / ${name}: ${cell.problems.join('; ')} (exit ${code}, left [${cell.left}])`);
        // Nothing outside the transaction directory is ever collateral.
        assert.equal(readFileSync(join(home, 'elsewhere.txt'), 'utf8'), 'outside\n',
          `${seam} / ${shape} / ${name}: touched something outside the transaction`);
      }
    }
  }
  if (process.env.BRAINKIT_GRID === '1') {
    for (const row of rows) {
      process.stderr.write(`${row.seam}\t${row.shape}\t${row.name}\texit=${row.skipped ? 'skipped' : row.code}\tleft=[${row.left}]\n`);
    }
  }
  // Coverage per cell, not a row count. Counting rows lets an entire column be
  // skipped and still pass, which is exactly how during-backups was missing
  // while the grid reported itself full.
  const skipped = rows.filter(row => row.skipped)
    .map(row => `${row.seam}/${row.shape}/${row.name}`);
  assert.deepEqual(skipped, [], `every cell has to run; skipped: ${skipped.join(', ')}`);
  assert.equal(rows.length, CLOSEOUT_SEAMS.length * Object.keys(FOREIGN_SHAPES).length * MARKER_NAMES.length,
    'and the grid is the full product of its axes');
});

test('r9 MAJOR-1: a marker name that is not a regular file is refused before anything is touched', () => {
  // A symlink, a directory or a FIFO at either marker name is not "no record
  // there". Reading it as absent let the transaction run its whole rollback and
  // only stop at the link, so the refusal has to land in the preflight with the
  // install still standing.
  //
  // Three shapes, both names, so the enumeration is type x name rather than one
  // example of one type at one name.
  const shapes = [
    ['symlink', (path, home) => symlinkSync(join(home, 'elsewhere.txt'), path)],
    ['directory', path => mkdirSync(path)],
    ['not-a-regular-file', path => spawnSync('/usr/bin/mkfifo', [path])],
  ];
  for (const [label, make] of shapes) {
    for (const name of ['transaction.json', 'transaction.spent.json']) {
      const { home, vault, context, answers } = installFixture();
      writeFileSync(join(home, 'elsewhere.txt'), 'not part of this install\n', { mode: 0o600 });
      applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
      const txnDir = join(home, '.config', 'second-brain', 'recovery', readInstallState(home).last_txn);
      const target = join(txnDir, name);
      // The live name is occupied, so move the real record aside first.
      if (name === 'transaction.json') renameSync(target, join(txnDir, 'transaction.spent.json'));
      make(target, home);
      if (!existsSync(target) && label === 'not-a-regular-file') continue; // no mkfifo here

      const before = managedSnapshot(home, realpathSync(vault));
      let code = null;
      let output = '';
      try { code = recoverInstall({ ...context, stdout: text => { output += text; } }); }
      catch (error) { code = error.exitCode; output += error.message; }

      const where = `${label} at ${name}`;
      assert.notEqual(code, EXIT.OK, `${where}: refused`);
      assert.match(output, new RegExp(`is a ${label}, not this transaction's record`), `${where}: and says why`);
      assert.deepEqual(managedSnapshot(home, realpathSync(vault)), before,
        `${where}: with nothing on disk touched`);
      assert.equal(readFileSync(join(home, 'elsewhere.txt'), 'utf8'), 'not part of this install\n',
        `${where}: and whatever it pointed at left alone`);
    }
  }
});

test('r8 BLOCKER-1: the marker is placed by a primitive that cannot overwrite', () => {
  // Nearest neighbour to "an unrelated regular file": the same thing, but named
  // exactly what the marker is about to be called. A rename would clobber it
  // without a word -- and did. link(2) refuses when the target exists, so the
  // sentinel's bytes and its inode both have to come through untouched, and the
  // refusal has to land before any business mutation.
  const { home, context, answers, vault } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const txnDir = join(home, '.config', 'second-brain', 'recovery', readInstallState(home).last_txn);
  const sentinel = join(txnDir, 'transaction.spent.json');
  writeFileSync(sentinel, 'UNRELATED SENTINEL\n', { mode: 0o600 });
  const identity = statSync(sentinel).ino;
  const before = managedSnapshot(home, realpathSync(vault));

  let output = '';
  let code = null;
  try { code = recoverInstall({ ...context, stdout: text => { output += text; } }); }
  catch (error) { code = error.exitCode; output += error.message; }

  assert.equal(readFileSync(sentinel, 'utf8'), 'UNRELATED SENTINEL\n', 'the sentinel is byte for byte what it was');
  assert.equal(statSync(sentinel).ino, identity, 'and the same file, not a replacement at the same path');
  assert.notEqual(code, EXIT.OK, 'the run refuses');
  assert.deepEqual(managedSnapshot(home, realpathSync(vault)), before,
    'and refuses before touching anything, not partway through');
  assert.ok(existsSync(join(txnDir, 'transaction.json')), 'the real record is untouched too');
});

test('r8 BLOCKER-2: an anchor that changed after the interruption is refused, not overwritten', () => {
  // The three-value truth table: still what the installer put there, already
  // back, or something else entirely. Only the first may be acted on.
  //
  // Interrupted at after-manifest rather than after-anchors on purpose. At
  // after-anchors the release has already happened and the backup is gone, so
  // removing the drift guard leaves the third value standing anyway and the
  // gate goes red only on the wording -- green for the wrong reason. Here the
  // backup is still on disk and the release has not run, so the guard is the
  // only thing standing between the user's edit and an overwrite.
  const third = 'vault="/user-after-crash"\n';

  // Restore form: the conf existed before the install, so the release is a
  // restore, and the user's own edit must survive it.
  {
    const { home, context, answers } = installFixture();
    const conf = join(home, '.config', 'second-brain', 'brainkit.conf');
    writeFileSync(conf, 'vault="/previous"\n', { mode: 0o600 });
    applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
    const txnDir = join(home, '.config', 'second-brain', 'recovery', readInstallState(home).last_txn);

    let code = null;
    try {
      code = recoverInstall({
        ...context,
        stdout: () => {},
        failpoint: name => { if (name === 'after-manifest') throw new Error('interrupted'); },
      });
    } catch (error) { code = error.exitCode; }
    assert.notEqual(code, EXIT.OK);
    const backups = readdirSync(txnDir).filter(name => !name.startsWith('transaction'));
    assert.ok(backups.length > 0, 'the backup the guard protects against is still on disk');

    writeFileSync(conf, third, { mode: 0o600 });
    let output = '';
    let retry = null;
    try { retry = recoverInstall({ ...context, stdout: text => { output += text; } }); }
    catch (error) { retry = error.exitCode; output += error.message; }

    assert.equal(readFileSync(conf, 'utf8'), third, 'the third value is left exactly as it was');
    assert.notEqual(retry, EXIT.OK, 'and the run refuses rather than reporting success');
  }

  // Delete form: no conf before the install, so the release is a deletion, and
  // a conf the user creates afterwards must not be deleted by the retry.
  {
    const { home, context, answers } = installFixture();
    const conf = join(home, '.config', 'second-brain', 'brainkit.conf');
    applyPlan(context, answers, preflight(context, answers), { yes: true }, null);

    let code = null;
    try {
      code = recoverInstall({
        ...context,
        stdout: () => {},
        failpoint: name => { if (name === 'after-manifest') throw new Error('interrupted'); },
      });
    } catch (error) { code = error.exitCode; }
    assert.notEqual(code, EXIT.OK);

    writeFileSync(conf, third, { mode: 0o600 });
    let retry = null;
    try { retry = recoverInstall({ ...context, stdout: () => {} }); }
    catch (error) { retry = error.exitCode; }

    assert.ok(existsSync(conf), 'the file the user made is still there');
    assert.equal(readFileSync(conf, 'utf8'), third, 'with their content');
    assert.notEqual(retry, EXIT.OK);
  }
});

test('r7 BLOCKER-2: a record marked spent must record a finished rollback', () => {
  // The marker's meaning is load-bearing: it says the rollback finished and the
  // anchors were released. A record carrying that name while still claiming an
  // unfinished rollback is a contradiction, and taking it at face value would
  // skip the rollback entirely.
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const txnDir = join(home, '.config', 'second-brain', 'recovery', readInstallState(home).last_txn);
  const manifest = JSON.parse(readFileSync(join(txnDir, 'transaction.json'), 'utf8'));
  assert.equal(manifest.phase, 'active', 'the fixture is mid-install');

  renameSync(join(txnDir, 'transaction.json'), join(txnDir, 'transaction.spent.json'));
  assert.throws(() => recoverInstall({ ...context, stdout: () => {} }),
    error => error.exitCode === EXIT.UNSAFE && /marked spent but does not record a finished rollback/.test(error.message));
  assert.ok(existsSync(join(txnDir, 'transaction.spent.json')), 'and the material is kept');
});

test('r7 MAJOR-1: with no install state the closeout refuses to consume anything', () => {
  // The state is what makes this transaction findable again. Consuming
  // anything without it would leave work no later run could discover, so the
  // closeout stops with every scrap intact.
  const { home, context, answers } = installFixture();
  writeFileSync(join(home, '.config', 'second-brain', 'brainkit.conf'), 'vault="/previous"\n', { mode: 0o600 });
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const txnDir = join(home, '.config', 'second-brain', 'recovery', readInstallState(home).last_txn);
  const conf = join(home, '.config', 'second-brain', 'brainkit.conf');
  const loaded = loadTransaction(home, basename(txnDir), realpathSync(join(home, 'vault')), 'core',
    readInstallState(home).plan_digest);
  const before = readFileSync(conf, 'utf8');
  const inside = readdirSync(txnDir).sort();
  unlinkSync(join(home, '.config', 'second-brain', 'install-state.json'));

  const settled = settleTransaction(loaded, () => [], {});
  assert.equal(settled.tag, 'blocked', 'nothing is consumed');
  assert.match(settled.problems.join(' '), /nothing would be able to find this transaction again/);
  assert.deepEqual(settled.done, [], 'not one change was made');
  // The refusal lands before the rollback, so the install is left exactly as it
  // was rather than half undone with nothing pointing at the rest.
  assert.equal(readFileSync(conf, 'utf8'), before, 'the conf is untouched');
  assert.deepEqual(readdirSync(txnDir).sort(), inside, 'and the material is all still there');
});

test('r3 MAJOR-1: the manifest carries no field that nothing reads', () => {
  const { home, context, answers } = installFixture();
  applyPlan(context, answers, preflight(context, answers), { yes: true }, null);
  const manifest = readManifest(home, readInstallState(home).last_txn);
  // `id` was written and never read, so a mismatched one was accepted in
  // silence. Every remaining key drives something the other tests here pin.
  assert.deepEqual(Object.keys(manifest).sort(),
    ['operations', 'phase', 'plan', 'planDigest', 'schema', 'services']);
});

test('slice 4: plists are rendered from the repo templates with the TCC argv rules', () => {
  const { home, vault, context, answers, launchctl } = selectionFixture('all');
  applyPlan(context, answers, preflight(context, answers), { yes: true }, 'sk-fixture');
  const agents = join(home, 'Library', 'LaunchAgents');
  // renderPlist canonicalises every variable, and macOS resolves the temp
  // directory through /private, so the expected argv is the realpath.
  const local = join(realpathSync(join(home, '.local', 'bin')));
  const nodeShim = join(local, 'brain-node');
  const state = readInstallState(home);

  for (const service of ['clip', 'observe', 'sunday', 'watch']) {
    const path = join(agents, `com.second-brain.${service}.plist`);
    // Path AND content hash: uninstall's authority to delete a plist is the
    // recorded hash, so a record without one is a plist nobody can remove.
    assert.equal(state.plists[service].path, path, `${service} is recorded in the state`);
    assert.equal(state.plists[service].sha256, createHash('sha256').update(readFileSync(path)).digest('hex'),
      `${service} is recorded with the bytes that were written`);
    assert.equal(statSync(path).mode & 0o777, 0o600, `${service} plist is private`);
    const text = readFileSync(path, 'utf8');
    assert.match(text, new RegExp(`<string>com\\.second-brain\\.${service}</string>`));
    assert.doesNotMatch(text, /EnvironmentVariables/, `${service} must not carry an env block`);
    assert.doesNotMatch(text, /\{\{/, 'no unresolved placeholder');
    assert.ok(text.includes(nodeShim), `${service} must run through the node shim`);
    assert.equal(launchctl.loaded.get(`com.second-brain.${service}`), path, `${service} is mounted from the file just written`);
  }

  // §5.4: /bin/sh stays argv[0] and the script it reads is the local wrapper,
  // never the vault copy.
  const watch = readFileSync(join(agents, 'com.second-brain.watch.plist'), 'utf8');
  const argv = [...watch.matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1]).slice(1);
  assert.equal(argv[0], '/bin/sh');
  assert.equal(argv[1], join(local, 'brain-watch-wrapper.sh'));
  assert.equal(argv[3], realpathSync(join(home, 'watched')), 'N1: the watch root is a data argument and may be anywhere');
  assert.equal(argv[4], nodeShim);
  assert.equal(argv[5], join(realpathSync(vault), '00-系统', 'scripts', 'daemon', 'brain-watch-handler.mjs'));
  // plutil accepted every one of them, which is what renderPlist lints for.
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', join(agents, 'com.second-brain.watch.plist')]).status, 0);
});

test('slice 4: the node shim is executed for real, and a dead frozen target is caught', () => {
  // The mock answers --version everywhere else; here the shim is really run, so
  // "the installer verifies the shim" is checked against an actual exec.
  const realRun = launchctl => makeRun((command, args) => (String(command).endsWith(`${sep}brain-node`)
    ? spawnSync(command, args, { encoding: 'utf8' })
    : undefined), launchctl);

  const good = installFixture();
  const goodContext = makeContext(good.home, {
    run: (command, args, options) => (String(args?.[0] || '').endsWith('publish.mjs')
      ? good.publisher.run(command, args, options)
      : realRun(good.launchctl)(command, args, options)),
    nodeTarget: realpathSync(process.execPath),
    env: good.context.env,
  });
  applyPlan(goodContext, good.answers, preflight(goodContext, good.answers), { yes: true }, null);
  const shim = join(good.home, '.local', 'bin', 'brain-node');
  const ran = spawnSync(shim, ['--version'], { encoding: 'utf8' });
  assert.equal(ran.status, 0, 'the installed shim really runs');
  assert.equal(ran.stdout.trim(), process.version);

  const dead = installFixture();
  const deadContext = makeContext(dead.home, {
    run: (command, args, options) => (String(args?.[0] || '').endsWith('publish.mjs')
      ? dead.publisher.run(command, args, options)
      : realRun(dead.launchctl)(command, args, options)),
    nodeTarget: '/opt/brainkit-test/gone/bin/node',
    env: dead.context.env,
  });
  // Exit 2, not 3: the rollback succeeded, so the original refusal is what
  // reaches the user rather than a recovery-required verdict.
  assert.throws(() => applyPlan(deadContext, dead.answers, preflight(deadContext, dead.answers), { yes: true }, null),
    error => error.exitCode === EXIT.UNSAFE && /did not run/.test(error.message) && /frozen node target missing/.test(error.message),
    'a frozen target that is not there must fail loudly at install time, not at 3am');
  assert.equal(existsSync(join(dead.home, '.local', 'bin', 'brain-node')), false, 'and the failed shim is rolled back');
});

test('slice 4: preflight refuses a service install it could not finish', () => {
  const { home, context, answers } = selectionFixture('core,watch', { context: { launchctlPath: '/opt/brainkit-test/no-launchctl' } });
  const report = preflight(context, answers);
  assert.equal(check(report, 'launch-agents').level, 'error');
  assert.match(check(report, 'launch-agents').message, /not executable/);
  assert.equal(report.exitCode, EXIT.ACTIONABLE);
  assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false, 'preflight writes nothing');

  const core = selectionFixture('core');
  assert.equal(check(preflight(core.context, core.answers), 'launch-agents').level, 'ok');
});

test('every declared command is implemented, so the not-implemented message has nobody left to name', () => {
  // This used to assert that uninstall was refused as unimplemented. It is
  // implemented now, and the message it produced named the commands that were
  // available -- so the useful thing left to check is that the list is
  // complete. A command declared in COMMANDS but missing from
  // IMPLEMENTED_COMMANDS would be one nobody can run and nobody is told about.
  assert.deepEqual([...COMMANDS].sort(), [...IMPLEMENTED_COMMANDS].sort());

  // The refusal itself still has to work, so it is exercised with a name that
  // is not a command at all.
  const home = makeHome();
  const { result: code, text } = capturingStderr(
    () => main(['nonsense'], { home, repoRoot: REPO_ROOT, stdout: () => {} }),
  );
  assert.equal(code, EXIT.ACTIONABLE);
  assert.match(text, /unknown command: nonsense/);
});

// --- three refusals no test was reaching ------------------------------------

// Every regular file under `root` whose bytes contain `needle`. Asks "did this
// value reach the disk anywhere", which is a wider question than naming the one
// file it would have been written to.
function filesHolding(root, needle) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesHolding(path, needle));
    else if (entry.isFile() && readFileSync(path).includes(needle)) found.push(path);
  }
  return found;
}

test('managed root: a path that resolves above its anchor is refused by name, not walked', () => {
  // Direct rather than entry-level, and it has to be. Every production call
  // derives the managed path by joining onto its own anchor --
  // assertManagedRoot(configDir(home), ..., home), mkdirTracked(txn,
  // join(root, inner), { anchor: root }) -- and join() never yields a path above
  // what it started from, so no CLI input can make relative(anchor, path) leave
  // the anchor. The single caller whose anchor is derived from the path instead
  // is the vault root, anchored at its own dirname; that one escapes only for a
  // vault root whose last component is '..', which canonicalPath cannot return
  // because it normalizes. So the escaping root is handed to applyPlan directly.
  const fixture = installFixture();
  const report = preflight(fixture.context, fixture.answers);
  const escaping = `${fixture.vault}${sep}..`;
  let thrown = null;
  try {
    applyPlan(fixture.context, fixture.answers, { ...report, vaultCanonical: escaping }, { yes: true }, null);
  } catch (error) {
    thrown = error;
  }
  assert.match(String(thrown?.message), /vault root is outside the home directory/,
    'a managed path above its anchor must be refused where it is named, not handed to the component walk below it');
  assert.equal(thrown?.exitCode, EXIT.UNSAFE);
  assert.equal(existsSync(fixture.vault), false, 'and nothing may be created for a root that was refused');
});

// One non-interactive `install` carrying a --deepseek-key-file, driven far
// enough to reach the read in readPrivateText. `onOutput` is the seam for
// the window both key-file gates below live in: installFlow prints nothing
// until preflight has returned, and reads the key file a few statements after
// the plan is printed, so anything done from the first write lands after the
// key file was validated and before it is read.
function keyFileInstall(onOutput) {
  const home = makeHome();
  const vault = makeVault(home);
  const keyFile = join(home, 'key.txt');
  writeFileSync(keyFile, 'sk-the-file-preflight-approved\n', { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const publisher = publisherMock();
  const call = () => main([
    'install', '--vault', vault, '--vault-mode', 'existing', '--components', 'observe',
    '--deepseek-key-file', keyFile, '--non-interactive', '--yes',
  ], {
    home, repoRoot: REPO_ROOT, platform: 'darwin', arch: 'arm64', nodeTarget: NODE_TARGET,
    pathEnv: '', env: {}, interactive: false, run: publisher.run, launchctlPath: FAKE_LAUNCHCTL,
    stdout: text => onOutput(text, keyFile),
  });
  return { home, vault, keyFile, publisher, call };
}

const LINKED_KEY = 'sk-LINKED-TARGET-MUST-NOT-BE-READ';

test('key file: a symlink swapped in after preflight is refused, and the linked-to bytes go nowhere', () => {
  // What this gate actually holds: the swap comes back as a typed refusal with
  // an exit code. It is NOT what keeps the linked-to bytes unread -- readNoFollow
  // opens O_NOFOLLOW, so a symlink here yields ELOOP and a null stat, and with
  // readPrivateText's regular-file check removed the run dies on that null stat
  // instead of reading anything. The last assertion is a separate claim, about
  // the end to end result rather than about that check.
  const outside = mkdtempSync(join(tmpdir(), 'brainkit-linked-key-'));
  const linked = join(outside, 'linked-key.txt');
  writeFileSync(linked, `${LINKED_KEY}\n`, { mode: 0o600 });
  chmodSync(linked, 0o600);

  let swapped = false;
  const fixture = keyFileInstall((text, keyFile) => {
    if (swapped) return;
    swapped = true;
    unlinkSync(keyFile);
    symlinkSync(linked, keyFile);
  });
  let code = null;
  let thrown = null;
  try {
    code = fixture.call();
  } catch (error) {
    thrown = error;
  }

  assert.equal(swapped, true, 'the swap never happened, so this case watched nothing');
  assert.equal(thrown, null, 'a key file that is not a regular non-symlink file must come back as a refusal, not as an exception out of main()');
  assert.equal(code, EXIT.UNSAFE);
  assert.equal(fixture.publisher.calls.length, 0, 'and nothing may be applied');
  assert.deepEqual(filesHolding(fixture.home, LINKED_KEY), [],
    'the file the swapped symlink pointed at must not have been read through it');
});

test('key file: one whose owner does not match this process is refused before its bytes are used', () => {
  // Not an entry-level construction of the fact being checked, and it cannot be
  // one: a non-root process cannot chown a file to another uid, so the file side
  // of `found.stat.uid !== process.getuid()` is not buildable here. What is faked
  // is the other side of that comparison, and only for the window between
  // preflight -- which has already validated the real key file, and is over
  // before installFlow prints anything -- and the read. The window is closed
  // again on '\nApplying:\n', the last line printed before applyPlan, so that
  // with the check removed the rest of the install runs under the real uid and
  // succeeds; otherwise the shim owner check further down would refuse for its
  // own reasons and this case would look green while watching nothing.
  //
  // So this does not show that a file genuinely owned by someone else is
  // refused. It shows that readPrivateText's owner comparison is the thing that
  // stops the read.
  const realGetuid = process.getuid;
  const realUid = process.getuid();
  let stubbed = false;
  const fixture = keyFileInstall(text => {
    if (text === '\nApplying:\n') {
      process.getuid = realGetuid;
      return;
    }
    if (stubbed) return;
    stubbed = true;
    process.getuid = () => realUid + 1;
  });
  let code = null;
  try {
    code = fixture.call();
  } finally {
    process.getuid = realGetuid;
  }

  assert.equal(stubbed, true, 'the uid was never made to disagree, so this case watched nothing');
  assert.equal(code, EXIT.UNSAFE, 'a key file this process does not own must be refused');
  assert.equal(fixture.publisher.calls.length, 0, 'and the refusal must come before anything is applied');
  assert.equal(existsSync(join(fixture.home, '.config', 'second-brain', 'observe.env')), false,
    'no key may have been read into the env file');
});

// --- the manifest validator: one case per refusal ---------------------------

// validateRecord is what stands between a damaged recovery manifest and a
// rollback acting on what it says. The guard census -- which disables each
// refusal in install.mjs one at a time and reruns this suite -- found that 25
// of its refusals made no difference to any test: delete the check, everything
// still passed.
//
// Each row below damages a real manifest the way one of those refusals exists
// to catch, and reaches it the way a user does -- install, damage the file on
// disk, run recover -- rather than by calling the validator directly. Which
// matters here specifically: several of these rules are only reachable in a
// particular order (the digest checks run last within their scope, the
// authorisation check runs before the containment one), and a direct call
// chooses that order for itself.
//
// recover is read-only, so every row asserts both halves: the refusal names
// that rule, and the managed roots are byte-identical afterwards.
const firstFileOp = manifest => manifest.operations.find(entry => entry.kind === 'file' && entry.post !== null);
const firstDirOp = manifest => manifest.operations.find(entry => entry.kind === 'dir' && entry.post !== null);

const MANIFEST_DAMAGE = [
  { rule: 'a phase that is neither of the two',
    refuses: /declares an unknown phase "half-done"/,
    damage: manifest => { manifest.phase = 'half-done'; } },

  // The four fields of a file image, and the two of a directory's. `image` and
  // `dirState` are each one function called for both the pre- and the post-
  // side, so damaging the post side is what exercises the rule. These rows do
  // not separately assert that a damaged pre-image is refused.
  { rule: 'a post-image with no digest',
    refuses: /operation post-image has no sha256 digest/,
    damage: manifest => { firstFileOp(manifest).post.sha256 = 'not-a-digest'; } },
  { rule: 'a post-image with a negative size',
    refuses: /operation post-image has no valid size/,
    damage: manifest => { firstFileOp(manifest).post.size = -1; } },
  { rule: 'a post-image with a mode outside the permission bits',
    refuses: /operation post-image has no valid mode/,
    damage: manifest => { firstFileOp(manifest).post.mode = 0o7777; } },
  { rule: 'a post-image with a negative uid',
    refuses: /operation post-image has no valid uid/,
    damage: manifest => { firstFileOp(manifest).post.uid = -1; } },
  { rule: 'a directory post-state with a mode outside the permission bits',
    refuses: /directory post-state has no valid mode/,
    damage: manifest => { firstDirOp(manifest).post.mode = 0o7777; } },
  { rule: 'a directory post-state with no device number',
    refuses: /directory post-state has no valid dev/,
    damage: manifest => { firstDirOp(manifest).post.identity.dev = 'x'; } },

  // The plan: its shape, each entry, and the digest over the whole of it.
  { rule: 'a plan that is not an array',
    refuses: /field plan is not an array/,
    damage: manifest => { manifest.plan = { nope: true }; } },
  { rule: 'a plan entry of unknown kind',
    refuses: /plan has an entry of unknown kind/,
    damage: manifest => { manifest.plan[0].kind = 'link'; } },
  { rule: 'a plan entry with a relative path',
    refuses: /plan has a non-absolute path/,
    damage: manifest => { manifest.plan[0].path = 'relative/path'; } },
  { rule: 'a plan entry with a non-boolean existed flag',
    refuses: /plan has no existed flag for /,
    damage: manifest => { manifest.plan[0].existed = 'no'; } },
  // Flipped rather than mistyped: it stays a legal boolean, so the entry
  // checks above pass and the digest is the only thing that can notice.
  { rule: 'a plan entry flipped on its own',
    refuses: /plan does not match its own digest/,
    damage: manifest => { manifest.plan[0].existed = !manifest.plan[0].existed; } },

  // The operations, in the order the validator applies them.
  { rule: 'an operation of unknown kind',
    refuses: /operation of unknown kind "socket"/,
    damage: manifest => { firstFileOp(manifest).kind = 'socket'; } },
  { rule: 'the same path listed twice',
    refuses: /lists the same path more than once/,
    damage: manifest => { manifest.operations.push({ ...firstFileOp(manifest) }); } },
  { rule: 'an operation naming the transaction\'s own material',
    // A path inside the transaction directory is stopped by the authorisation
    // check above this one -- unless it is also a path this installer creates,
    // and the only way both can be true is for the vault root to have been
    // moved into the transaction directory. So the row moves it, in the state
    // and in the conf that has to corroborate the state, and then names a
    // vault directory that now resolves inside the record's own material.
    // A realpath'd HOME because a vault root is stored resolved while the
    // config paths keep the spelling they were built from. Under /var/folders
    // those are two different strings for one directory, and the containment
    // check would then be comparing /private/var/... against /var/....
    home: () => realpathSync(makeHome()),
    refuses: /points at its own transaction material/,
    damage: (manifest, at) => {
      const vault = at.state.vault_root;
      const repoint = path => (path === vault ? at.dir
        : path.startsWith(vault + sep) ? at.dir + path.slice(vault.length) : path);
      manifest.plan = manifest.plan.map(entry => ({ ...entry, path: repoint(entry.path) }));
      manifest.planDigest = planDigest(manifest.plan);
      manifest.operations = [operation({ kind: 'dir', path: join(at.dir, '00-系统') })];
      writeInstallState(at.home, { ...at.state, vault_root: at.dir, plan_digest: manifest.planDigest });
      const conf = join(at.home, '.config', 'second-brain', 'brainkit.conf');
      writeFileSync(conf, readFileSync(conf, 'utf8').replace(/^vault=.*$/m, `vault="${at.dir}"`), { mode: 0o600 });
    } },
  { rule: 'a file operation that neither creates nor observes anything',
    refuses: /neither creates nor observes anything/,
    damage: manifest => { const entry = firstFileOp(manifest); entry.pre = null; entry.post = null; } },
  { rule: 'an operation with a non-boolean retain flag',
    refuses: /without a boolean retain flag/,
    damage: manifest => { firstFileOp(manifest).retain = 'no'; } },
  // The manifest is a real file inside the transaction directory, so it passes
  // the containment check on the backup path and leaves the rule under test --
  // a backup kept for a file that was created, not replaced -- as the one that
  // can fire.
  { rule: 'a backup kept for something that was never replaced',
    refuses: /keeps a backup for something it did not replace/,
    damage: (manifest, at) => { firstFileOp(manifest).backup = join(at.dir, 'transaction.json'); } },
  { rule: 'a retain flag with no adopted backup behind it',
    refuses: /disagrees with itself about where a retained backup lives/,
    damage: manifest => { firstFileOp(manifest).retain = true; } },

  // The service set. `watch` is the smallest selection that installs a plist,
  // so these rows have a real label to damage.
  { rule: 'services that are not an array', fixture: 'watch',
    refuses: /field services is not an array/,
    damage: manifest => { manifest.services = { nope: true }; } },
  { rule: 'a label this installer does not manage', fixture: 'watch',
    refuses: /names a service this installer does not manage: "com\.somebody-else\.agent"/,
    damage: manifest => { manifest.services[0].label = 'com.somebody-else.agent'; } },
  { rule: 'the same label listed twice', fixture: 'watch',
    refuses: /lists com\.second-brain\.watch more than once/,
    damage: manifest => { manifest.services.push({ ...manifest.services[0] }); } },
  { rule: 'a non-boolean loaded flag', fixture: 'watch',
    refuses: /non-boolean loaded flag for com\.second-brain\.watch/,
    damage: manifest => { manifest.services[0].loaded = 'yes'; } },
  // loaded false has to mean plist null: a service that was not running before
  // the install has no earlier plist, and naming one would give the rollback a
  // file to bootstrap from that this transaction has no record of.
  { rule: 'a plist recorded against a label that was not running', fixture: 'watch',
    refuses: /against a plist this installer does not manage/,
    damage: (manifest, at) => {
      manifest.services[0].plist = join(at.home, 'Library', 'LaunchAgents', 'com.second-brain.watch.plist');
    } },
  { rule: 'a label whose plist this transaction never wrote', fixture: 'watch',
    refuses: /names com\.second-brain\.observe, whose plist this transaction never wrote/,
    damage: manifest => { manifest.services.push({ label: 'com.second-brain.observe', loaded: false, plist: null }); } },
];

test('r13: every rule the manifest validator enforces refuses a record damaged that way', () => {
  for (const row of MANIFEST_DAMAGE) {
    const overrides = row.home ? { home: row.home() } : {};
    const fixture = row.fixture === 'watch' ? selectionFixture('watch', overrides) : installFixture(overrides);
    applyPlan(fixture.context, fixture.answers, preflight(fixture.context, fixture.answers), { yes: true }, null);
    const state = readInstallState(fixture.home);
    const file = join(fixture.home, '.config', 'second-brain', 'recovery', state.last_txn, 'transaction.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    row.damage(manifest, { home: fixture.home, dir: dirname(file), state });
    writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });

    // Taken after the damage, so the damaged manifest is part of what must not
    // move. A read-only command that rewrites the record it just refused would
    // pass an assertion made before the edit.
    const before = managedSnapshot(fixture.home, fixture.vault);
    assert.throws(() => recoverInstall({ ...fixture.context, stdout: () => {} }),
      error => error.exitCode === EXIT.UNSAFE && row.refuses.test(error.message),
      `${row.rule}: recover must refuse, naming that rule`);
    assert.deepEqual(managedSnapshot(fixture.home, fixture.vault), before,
      `${row.rule}: a refused recover may not touch anything`);
  }
});

// --- slice 5: installing into a vault that already has a life ---------------

// Every entry under the vault, by identity rather than by content alone.
//
// managedSnapshot already proves bytes are equal; this proves it is the same
// object. A note deleted and rewritten byte-for-byte passes the first and fails
// this one, and for "the installer did not touch the user's notes" the second
// is the claim worth making. inode is what carries it.
//
// No mtime: adding a directory changes its parent's mtime, so a tree keyed on
// mtime would report every ancestor of every new directory as modified. Where
// mtime is part of the contract -- the project map, which must not be rewritten
// at all -- the case asserts it directly.
function vaultTree(root) {
  const tree = new Map();
  const walk = path => {
    const stat = lstatSafe(path);
    if (!stat) return;
    const common = `mode=${(stat.mode & 0o7777).toString(8)} ino=${stat.ino}`;
    if (stat.isSymbolicLink()) { tree.set(path, `symlink ${common} -> ${readlinkSync(path)}`); return; }
    if (stat.isFile()) { tree.set(path, `file ${common} sha256=${createHash('sha256').update(readFileSync(path)).digest('hex')}`); return; }
    if (!stat.isDirectory()) { tree.set(path, `other ${common}`); return; }
    tree.set(path, `dir ${common}`);
    for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return tree;
}

function treeDiff(before, after) {
  const added = [...after.keys()].filter(path => !before.has(path)).sort();
  const removed = [...before.keys()].filter(path => !after.has(path)).sort();
  const changed = [...after.keys()]
    .filter(path => before.has(path) && before.get(path) !== after.get(path))
    .sort()
    .map(path => `${path}\n  was ${before.get(path)}\n  now ${after.get(path)}`);
  return { added, removed, changed };
}

// Every vault path the registry says this installer creates, including the
// ancestors mkdirTracked makes on the way. Derived from ARTIFACTS rather than
// listed here, so a new row cannot make the diff assertion below pass by being
// forgotten in two places at once.
function managedVaultPaths(vault) {
  const paths = new Set();
  for (const entry of ARTIFACTS.filter(row => row.root === 'vault' && row.path !== '')) {
    const parts = entry.path.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) paths.add(join(vault, ...parts.slice(0, depth)));
  }
  return paths;
}

// The six situations from the slice-5 matrix, each a real tree on disk before
// the installer is told the vault exists. `notes` is the part every situation
// except `empty` carries: files and a directory of the user's own, at the top
// level and nested, so a run that reorganises anything shows up.
function existingVault(situation, overrides = {}) {
  const fixture = installFixture({ ...overrides, answers: { vaultMode: 'existing', ...overrides.answers } });
  const vault = fixture.vault;
  mkdirSync(vault, { recursive: true });
  if (situation !== 'empty') {
    mkdirSync(join(vault, '我的笔记', '2019'), { recursive: true });
    writeFileSync(join(vault, '我的笔记', '2019', 'old.md'), '# five years of this\n');
    writeFileSync(join(vault, '我的笔记', 'index.md'), '- [[old]]\n');
    writeFileSync(join(vault, 'top level note.md'), '# top\n');
    // A vault that has been used already has one of these. Carrying it in every
    // non-empty situation is what puts the map inside the whole-tree assertions
    // on the refusal and rollback paths too -- without it those cases could
    // only say the map was not touched because there was no map.
    mkdirSync(join(vault, '00-系统'), { recursive: true });
    const map = join(vault, '00-系统', '.project-map.json');
    writeFileSync(map, `${JSON.stringify({ mappings: [{ name: 'theirs', path: '01-项目/theirs' }] }, null, 4)}\n`, { mode: 0o644 });
    // Backdated, so "the map was not touched" cannot be satisfied by a rewrite
    // that lands in the same second as the fixture.
    const stamp = new Date('2020-03-01T00:00:00Z');
    utimesSync(map, stamp, stamp);
  }
  if (situation === 'partial') {
    // Two managed directories already present, one of them a parent whose child
    // is still missing: the run has to add the child without redoing the parent.
    //
    // 0700 on purpose. The installer would create these at 0755, so at 0755 a
    // run that rewrites the mode of an existing directory is indistinguishable
    // from one that leaves it alone -- and a mutation that made the skeleton
    // chmod what it finds went unnoticed until these were made to differ.
    for (const inner of ['00-系统', '03-经验']) {
      mkdirSync(join(vault, inner), { recursive: true });
      chmodSync(join(vault, inner), 0o700);
    }
  }
  if (situation === 'symlink') {
    mkdirSync(join(fixture.home, 'elsewhere'), { recursive: true });
    symlinkSync(join(fixture.home, 'elsewhere'), join(vault, '03-经验'));
  }
  if (situation === 'wrongtype') {
    writeFileSync(join(vault, '03-经验'), 'a note the user named after a directory\n');
  }
  if (situation === 'conflict') {
    // A real iCloud duplicate, inside a directory the publisher scans. The
    // detection is the publisher's (tests/test-publish.mjs gates the rule
    // itself); what this fixture is for is what the installer does around it,
    // and that the duplicate is still there afterwards.
    mkdirSync(join(vault, '00-系统', 'scripts', 'cli'), { recursive: true });
    writeFileSync(join(vault, '00-系统', 'scripts', 'cli', 'brain-write 2.mjs'), '// an iCloud duplicate\n');
  }
  return fixture;
}

function installExisting(fixture, extra = [], components = 'core') {
  let output = '';
  const code = main(['install', '--vault', fixture.vault, '--vault-mode', 'existing',
    '--components', components, '--non-interactive', '--yes', ...extra],
  { ...fixture.context, stdout: text => { output += text; } });
  return { code, output };
}

const UNCHANGED = { added: [], removed: [], changed: [] };

// vaultTree deliberately leaves mtime out -- adding a directory changes its
// parent's, which would report every ancestor as modified. The project map is
// the one path where mtime is part of the contract (spec 4.3: content and mtime
// both unchanged), so it gets a snapshot of its own.
//
// Without this, "the map is covered by the whole-tree assertion" held for
// content, mode and inode but not for mtime: touching it left every refusal and
// rollback case still passing.
function mapFacts(vault) {
  const path = join(vault, '00-系统', '.project-map.json');
  const stat = lstatSafe(path);
  if (!stat) return 'absent';
  const common = `mtime=${stat.mtimeMs} ino=${stat.ino} mode=${(stat.mode & 0o7777).toString(8)}`;
  if (!stat.isFile()) return `${common} type=${stat.isSymbolicLink() ? 'symlink' : 'other'}`;
  return `${common} sha256=${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

test('slice 5: an existing vault gains the directories it was missing and nothing else changes', () => {
  for (const situation of ['empty', 'notes', 'partial']) {
    const fixture = existingVault(situation);
    const before = vaultTree(fixture.vault);
    const { code } = installExisting(fixture);
    assert.equal(code, EXIT.OK, `${situation}: the install must succeed`);

    const { added, removed, changed } = treeDiff(before, vaultTree(fixture.vault));
    assert.deepEqual(removed, [], `${situation}: nothing under the vault may disappear`);
    assert.deepEqual(changed, [], `${situation}: nothing that was already there may change`);
    // The whole point of the matrix row: what appeared is exactly the managed
    // surface that was missing. Anything else -- a reorganised note, a stray
    // temp file, a directory the registry does not declare -- fails here.
    const expected = [...managedVaultPaths(fixture.vault)].filter(path => !before.has(path)).sort();
    assert.deepEqual(added, expected, `${situation}: only the missing managed paths may appear`);
  }
});

test('slice 5: a project map that is already there is read, not rewritten', () => {
  // Both situations that can carry one. The map's handling does not depend on
  // what else is in the vault, but asserting it in only one of them would leave
  // that as a claim rather than a result.
  for (const situation of ['notes', 'partial']) {
    const fixture = existingVault(situation);
    mkdirSync(join(fixture.vault, '00-系统'), { recursive: true });
    const map = join(fixture.vault, '00-系统', '.project-map.json');
    // Four-space indent and an entry of the user's own: a rewrite would come
    // back with this installer's two-space empty template.
    const content = `${JSON.stringify({ mappings: [{ name: 'mine', path: '01-项目/mine' }] }, null, 4)}\n`;
    writeFileSync(map, content, { mode: 0o644 });
    // Backdated so "left alone" cannot be satisfied by a rewrite that happens
    // to land in the same second.
    const stamp = new Date('2020-03-01T00:00:00Z');
    utimesSync(map, stamp, stamp);
    const was = statSync(map);

    assert.equal(installExisting(fixture).code, EXIT.OK, situation);

    const now = statSync(map);
    assert.equal(readFileSync(map, 'utf8'), content, `${situation}: the map keeps its own formatting and entries`);
    assert.equal(now.mtimeMs, was.mtimeMs, `${situation}: and is not rewritten with identical bytes either`);
    assert.equal(now.ino, was.ino, `${situation}: nor replaced by a new file at the same path`);
  }
});

test('slice 5: a managed vault path that is not a plain directory stops the install with nothing written', () => {
  // Three shapes, one property: the refusal happens in the preflight, so the
  // config, the state and the vault are all still exactly as they were. Caught
  // where the skeleton is built instead, each of these would be a rollback --
  // correct, but only after step 2 had written config, env and state.
  const cases = [
    { situation: 'symlink', refuses: /vault path 03-经验 escapes its literal path via a symlinked component/ },
    { situation: 'wrongtype', refuses: /vault path 03-经验 has a non-directory component/ },
    { situation: 'notes', refuses: /is not valid JSON/, damage: vault => {
      mkdirSync(join(vault, '00-系统'), { recursive: true });
      writeFileSync(join(vault, '00-系统', '.project-map.json'), '{ this is not json', { mode: 0o644 });
    } },
    { situation: 'notes', refuses: /has no mappings array/, damage: vault => {
      mkdirSync(join(vault, '00-系统'), { recursive: true });
      writeFileSync(join(vault, '00-系统', '.project-map.json'), '{"mappings":"not an array"}', { mode: 0o644 });
    } },
    { situation: 'notes', refuses: /project map must be a regular non-symlink file/, damage: (vault, home) => {
      mkdirSync(join(vault, '00-系统'), { recursive: true });
      writeFileSync(join(home, 'somebody-elses-map.json'), '{"mappings":[]}', { mode: 0o644 });
      // The fixture already put a real map here; this case replaces it with a
      // link to one outside the vault.
      rmSync(join(vault, '00-系统', '.project-map.json'), { force: true });
      symlinkSync(join(home, 'somebody-elses-map.json'), join(vault, '00-系统', '.project-map.json'));
    } },
  ];

  for (const row of cases) {
    const fixture = existingVault(row.situation);
    row.damage?.(fixture.vault, fixture.home);
    const beforeVault = vaultTree(fixture.vault);
    const beforeMap = mapFacts(fixture.vault);
    const beforeHome = managedSnapshot(fixture.home, null);

    const { code, output } = installExisting(fixture);
    assert.equal(code, EXIT.UNSAFE, `${row.refuses}: an unusable managed path must exit 2`);
    assert.match(output, row.refuses);
    assert.deepEqual(treeDiff(beforeVault, vaultTree(fixture.vault)), UNCHANGED,
      `${row.refuses}: the vault must be untouched`);
    assert.equal(mapFacts(fixture.vault), beforeMap,
      `${row.refuses}: the project map keeps its mtime as well as its bytes`);
    assert.deepEqual(managedSnapshot(fixture.home, null), beforeHome,
      `${row.refuses}: no config, state or shim may have been written`);
    assert.equal(fixture.publisher.calls.length, 0, `${row.refuses}: the publisher must not have been run`);
  }
});

// main() writes InstallError messages straight to process.stderr, which is not
// injectable, so a case that needs to see which rule refused captures it there.
function capturingStderr(body) {
  const real = process.stderr.write;
  let text = '';
  process.stderr.write = chunk => { text += chunk; return true; };
  try {
    return { result: body(), text };
  } finally {
    process.stderr.write = real;
  }
}

test('slice 5: --watch-root without the watch component is refused', () => {
  // issue #11. The guard was there; nothing was watching it, and with it
  // disabled a stray --watch-root goes through into a plan that has no watch
  // service to use it. Driven through main() so the refusal is the one a user
  // would actually hit.
  const fixture = existingVault('notes');
  const beforeVault = vaultTree(fixture.vault);
  const { result: code, text } = capturingStderr(() => main(
    ['install', '--vault', fixture.vault, '--vault-mode', 'existing', '--components', 'core',
      '--watch-root', join(fixture.home, 'watched'), '--non-interactive', '--yes'],
    { ...fixture.context, stdout: () => {} },
  ));

  assert.equal(code, EXIT.ACTIONABLE);
  assert.match(text, /--watch-root is only valid with the watch component/);
  assert.deepEqual(treeDiff(beforeVault, vaultTree(fixture.vault)), UNCHANGED,
    'a rejected flag combination writes nothing');
  assert.equal(fixture.publisher.calls.length, 0);
});

test('slice 5: a failure after the skeleton is built puts the vault back exactly as it was found', () => {
  // The cell the whole slice is really about. These failures land *after* step 3
  // has created directories inside the user's vault, so unlike the preflight
  // refusals there is something to undo, and the undo has to be exact: remove
  // what this run made, keep what it found, touch nothing else.
  const cases = [
    // The degenerate case is worth a row of its own: with no user files to
    // preserve, "the vault is unchanged" means the whole skeleton came back
    // out, leaving an empty directory rather than a half-built one.
    { situation: 'empty', publisher: { checkState: 'conflict' }, fails: 'publish --check reports conflict' },
    { situation: 'notes', publisher: { checkState: 'conflict' }, fails: 'publish --check reports conflict' },
    { situation: 'partial', publisher: { checkState: 'conflict' }, fails: 'publish --check reports conflict' },
    // The publisher is the authority on iCloud duplicates (spec 5.3), and it
    // refuses during --bootstrap, which is where branch B calls it. The mock
    // stands in for that refusal; the rule itself is gated in test-publish.mjs.
    { situation: 'conflict', publisher: { bootstrapStatus: 2 }, fails: 'publish --bootstrap exited 2' },
  ];

  for (const row of cases) {
    const fixture = existingVault(row.situation, { publisher: row.publisher });
    const before = vaultTree(fixture.vault);
    const beforeMap = mapFacts(fixture.vault);
    const { result: code, text } = capturingStderr(() => installExisting(fixture).code);

    assert.equal(code, EXIT.UNSAFE, `${row.situation}: the run must stop`);
    assert.ok(text.includes(row.fails), `${row.situation}: expected ${row.fails}, got ${text.trim()}`);
    // Not "no user files were lost" -- the whole tree, by identity. A skeleton
    // directory left behind, a note rewritten with the same bytes under a new
    // inode, a mode changed on the way past: each one shows up here.
    assert.deepEqual(treeDiff(before, vaultTree(fixture.vault)), UNCHANGED,
      `${row.situation}: the vault must be back to exactly what it was`);
    assert.equal(mapFacts(fixture.vault), beforeMap,
      `${row.situation}: the project map keeps its mtime through the rollback as well`);
    assert.equal(existsSync(installStatePath(fixture.home)), false,
      `${row.situation}: a rolled-back install leaves no state behind`);
    assert.deepEqual(readdirSync(join(fixture.home, '.config', 'second-brain', 'recovery')), [],
      `${row.situation}: and no orphan transaction`);
  }
});

test('slice 5: what the run creates is recorded as created, what was already there is recorded as found', () => {
  // Spec 5.1 step 3 asks for each addition to be recorded, and the rollback
  // above is only exact because of it: `pre === null` is what tells the undo
  // "this one is mine to remove". Recording a directory that was already there
  // as created is how a rollback deletes a user's directory.
  const fixture = existingVault('partial');
  // The manifest records the canonical vault root (spec 9.3), which under
  // /var/folders is spelled differently from the path the fixture handed in.
  // Comparing against the un-resolved spelling matched nothing and the loop
  // below then had no rows to disagree with.
  const root = realpathSync(fixture.vault);
  const before = vaultTree(root);
  assert.equal(installExisting(fixture).code, EXIT.OK);

  const manifest = readManifest(fixture.home, readInstallState(fixture.home).last_txn);
  const vaultOps = manifest.operations.filter(entry => entry.kind === 'dir' && entry.path.startsWith(root + sep));
  assert.ok(vaultOps.length > 0, 'the run must record the directories it touched inside the vault');

  for (const operation of vaultOps) {
    const existedBefore = before.has(operation.path);
    assert.equal(operation.pre === null, !existedBefore,
      `${operation.path}: recorded as ${operation.pre === null ? 'created' : 'found'} but it was ${existedBefore ? 'already there' : 'absent'}`);
    if (existedBefore) {
      assert.equal(operation.post, null,
        `${operation.path}: a directory that was already there must be recorded as observed, not changed`);
    }
  }
  // 03-经验 is a registry row that the fixture pre-creates, so at least one
  // operation has to be on the "found" side. Without this the loop above is
  // satisfied by a manifest in which everything happens to be new.
  assert.ok(vaultOps.some(operation => operation.pre !== null && operation.post === null),
    'the pre-existing directories must actually appear as observed operations');
});

test('slice 5: the target list names paths and states, never contents', () => {
  // Spec 5.2 branch B: list what will be replaced, do not show what is in it.
  // The bytes below are what a real target holds -- notes, and in a shared
  // vault possibly worse -- so the assertion is that they never reach the
  // terminal, not merely that the output looks tidy.
  const contents = 'CONTENTS-OF-THE-TARGET-THAT-MUST-NOT-BE-PRINTED';
  const fixture = existingVault('notes', { publisher: { checkState: 'repo-ahead' } });
  mkdirSync(join(fixture.vault, '00-系统', 'scripts', 'cli'), { recursive: true });
  writeFileSync(join(fixture.vault, '00-系统', 'scripts', 'cli', 'brain-write.mjs'), `${contents}\n`);

  const { code, output } = installExisting(fixture);
  assert.equal(code, EXIT.OK);
  assert.match(output, /publisher will change 1 vault target\(s\) \(repo-ahead\)/);
  assert.match(output, /repo-ahead\s+00-系统\/scripts\/cli\/brain-write\.mjs/, 'the path and its state are shown');
  assert.equal(output.includes(contents), false, 'the contents of a target are never printed');
});

// --- slice 6: upgrade, batch 1 (steps 1-4) ----------------------------------

// A machine that finished installing: config and state written by the real
// installer, then moved to the terminal status upgrade insists on.
// `components` exists for the step-8 cases: only a machine with a service has a
// loaded set to preserve, and watch is the one that needs a real fswatch on
// PATH and a directory to watch.
function installedMachine({ components = 'core', ...overrides } = {}) {
  const fixture = existingVault('notes', {
    ...overrides,
    context: { pathEnv: fakeToolsDir(), ...overrides.context },
  });
  const extra = [];
  if (components.includes('watch')) {
    const watched = join(fixture.home, 'watched');
    mkdirSync(watched, { recursive: true });
    extra.push('--watch-root', watched);
  }
  assert.equal(installExisting(fixture, extra, components).code, EXIT.OK, 'the fixture install must succeed');
  const state = readInstallState(fixture.home);
  writeInstallState(fixture.home, { ...state, status: 'installed' });
  return fixture;
}

function runUpgradeCli(fixture, args = [], contextOverrides = {}) {
  let output = '';
  const { result: code, text } = capturingStderr(() => main(['upgrade', ...args], {
    ...fixture.context, ...contextOverrides, stdout: chunk => { output += chunk; },
  }));
  return { code, output, stderr: text };
}

// The write half of upgrade is disabled at the CLI after the slice-6 stop-loss,
// so the tests that guard the code still in the tree call it directly. Same
// arguments the disabled line passed, so what is exercised is the real path and
// not a test-shaped imitation of it.
function runUpgradeApply(fixture, args = [], contextOverrides = {}) {
  let output = '';
  const context = createContext({
    ...fixture.context, ...contextOverrides, stdout: chunk => { output += chunk; },
  });
  const { result: code, text } = capturingStderr(() => {
    try {
      const answers = doctorAnswers(context, { adoptShims: args.includes('--adopt-shims') });
      return upgradeApply(context, answers, readInstallState(fixture.home));
    } catch (error) {
      if (error.name !== 'InstallError') throw error;
      process.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
  });
  return { code, output, stderr: text };
}

// The sentence batch 1 stops on. One constant, asserted present on the healthy
// path and absent on every refusal: a drift in the wording reddens the positive
// assertion rather than quietly turning the negative ones into no-ops.
// The sentence a finished upgrade ends on. One constant, asserted present on
// the healthy path and absent on every refusal: a drift in the wording reddens
// the positive assertion rather than quietly turning the negative ones into
// no-ops.
const UPGRADE_DONE = 'Upgrade complete';

// The label the watch component's service is mounted under, spelled once.
const WATCH_LABEL = 'com.second-brain.watch';

function lockFacts(home) {
  const path = join(home, '.config', 'second-brain', 'install.lock');
  const stat = lstatSafe(path);
  if (!stat) return 'absent';
  return `ino=${stat.ino} mode=${(stat.mode & 0o7777).toString(8)} body=${readFileSync(path, 'utf8')}`;
}

// worktree-intact. Named as what git is allowed to be asked, not as a list of
// the verbs that would be damage: a denylist of stash/reset/checkout passes any
// verb nobody thought of, and this invariant exists because of the ones nobody
// thought of. `pull` is off the list by default and only ever in its
// fast-forward form, which refuses rather than rewriting local history.
const GIT_READS = new Set(['--version', 'rev-parse', 'status']);

function assertWorktreeUntouched(calls, rule, { pull = false } = {}) {
  for (const call of calls) {
    const words = call.split(' ');
    if (words[0] !== 'git') continue;
    let at = 1;
    while (words[at] === '-C') at += 2;
    if (GIT_READS.has(words[at])) continue;
    assert.ok(pull && words[at] === 'pull' && words.includes('--ff-only'), `${rule}: unexpected git command: ${call}`);
  }
}

// services-as-found in its degenerate form. Reading which services are loaded
// is not moving them, so `print` is allowed; bootout and bootstrap are the two
// verbs that change what is running.
function assertNoServiceMoved(launchctl, rule) {
  assert.deepEqual(launchctl.calls.filter(call => !call.startsWith('print ')), [],
    `${rule}: no service may be started or stopped`);
}

test('slice 6: upgrade refuses on every step 1-2 condition, with nothing changed', () => {
  const cases = [
    { rule: 'no install state at all', refuses: /no install state at/,
      damage: fixture => rmSync(installStatePath(fixture.home), { force: true }) },
    { rule: 'the last run never finished', refuses: /status=installing/,
      damage: fixture => writeInstallState(fixture.home, { ...readInstallState(fixture.home), status: 'installing' }) },
    // A real directory, not a made-up path: the row is about running from the
    // wrong clone, and a recorded path that cannot be resolved at all is a
    // different refusal, exercised by the row below it.
    { rule: 'a different clone than the one that installed', refuses: /run upgrade from the clone that installed it/,
      damage: fixture => writeInstallState(fixture.home, {
        ...readInstallState(fixture.home),
        repo_root: realpathSync(mkdtempSync(join(tmpdir(), 'brainkit-other-clone-'))),
      }) },
    { rule: 'a recorded root that cannot be resolved at all', refuses: /cannot be resolved any more/,
      damage: fixture => writeInstallState(fixture.home, { ...readInstallState(fixture.home), repo_root: '/somewhere/else' }) },
    // The conf is the second record the vault root has to appear in. Editing
    // only the state is exactly the single-file edit that agreement defends.
    { rule: 'state and conf disagree about the vault', refuses: /does not agree/,
      damage: fixture => {
        const conf = join(fixture.home, '.config', 'second-brain', 'brainkit.conf');
        writeFileSync(conf, readFileSync(conf, 'utf8').replace(/^vault=.*$/m, 'vault="/elsewhere/vault"'), { mode: 0o600 });
      } },
    { rule: 'a dirty worktree', refuses: null, dirty: true },
    { rule: 'another installer holds the lock', refuses: /another installer holds/,
      damage: fixture => writeFileSync(join(fixture.home, '.config', 'second-brain', 'install.lock'), `${process.pid}\n`, { mode: 0o600 }) },
    // The two rows above about paths edit the RECORDED strings. These two keep
    // every recorded string byte-identical and move the disk instead: rename
    // the root away, leave a symlink at the old path. Both records still agree
    // with each other and with the literal path, and only re-resolving notices.
    // `damage` returns the real location so the vault assertions below watch
    // the tree rather than the one-entry symlink standing in front of it.
    { rule: 'the vault moved out from under its recorded path',
      refuses: /the vault has moved from its recorded location/,
      damage: fixture => {
        const moved = `${fixture.vault}-moved`;
        renameSync(fixture.vault, moved);
        symlinkSync(moved, fixture.vault);
        return moved;
      } },
    { rule: 'the repo moved out from under its recorded path',
      refuses: /the repo has moved from its recorded location/,
      damage: fixture => {
        // Not the real clone: a stand-in recorded as the install's repo, so it
        // can be moved without touching the checkout the suite is running from.
        const repo = realpathSync(mkdtempSync(join(tmpdir(), 'brainkit-moved-repo-')));
        writeInstallState(fixture.home, { ...readInstallState(fixture.home), repo_root: repo });
        renameSync(repo, `${repo}-moved`);
        symlinkSync(`${repo}-moved`, repo);
      } },
  ];

  for (const row of cases) {
    const fixture = installedMachine();
    const watchVault = row.damage?.(fixture) ?? fixture.vault;
    const beforeHome = managedSnapshot(fixture.home, null);
    const beforeVault = vaultTree(watchVault);
    const beforeLock = lockFacts(fixture.home);
    const publisherCalls = fixture.publisher.calls.length;
    fixture.launchctl.calls.length = 0;

    const calls = [];
    const run = (command, args = [], options) => {
      calls.push([command, ...args].join(' '));
      // A dirty worktree is a fact about git, so it is produced at the git seam
      // rather than by damaging a file the installer wrote.
      if (row.dirty && command === 'git' && args.includes('--porcelain')) return { status: 0, stdout: ' M install.mjs\n', stderr: '' };
      return fixture.context.run(command, args, options);
    };
    const { code, output, stderr } = runUpgradeCli(fixture, [], { run });

    assert.notEqual(code, EXIT.OK, `${row.rule}: upgrade must not report success`);
    if (row.refuses) assert.match(stderr, row.refuses, `${row.rule}: ${stderr || output}`);
    else assert.match(output, /worktree is not clean/, `${row.rule}: ${output}`);

    assert.deepEqual(managedSnapshot(fixture.home, null), beforeHome, `${row.rule}: config, state and shims are untouched`);
    assert.deepEqual(treeDiff(beforeVault, vaultTree(watchVault)), UNCHANGED, `${row.rule}: the vault is untouched`);
    assert.equal(fixture.publisher.calls.length, publisherCalls, `${row.rule}: the publisher is never reached`);
    // A refusal that tidies up somebody else's lock is the kind of thing tests
    // miss and a real machine hits: two installers, one of them helpful.
    assert.equal(lockFacts(fixture.home), beforeLock, `${row.rule}: the lock file is left exactly as found`);
    assertWorktreeUntouched(calls, row.rule);
    assertNoServiceMoved(fixture.launchctl, row.rule);
    // Every row here exits non-zero, so an exit code on its own proves nothing:
    // batch 1 also exits non-zero when everything is healthy. What separates a
    // refusal from the batch stop is that the stop was never printed. The test
    // below is what keeps this from being vacuous -- it asserts the same string
    // appears on a healthy machine, so a wording drift reddens there first.
    assert.equal(output.includes(UPGRADE_DONE), false, `${row.rule}: a refusal must never claim the upgrade finished`);
  }
});

// The healthy default path, and the anchor for the assertion above. Adopted
// from the lead's LEAD-P6-3 probe, widened: the probe asserted only "no pull,
// no child", but nothing anywhere asserted that a machine with nothing wrong
// reaches the batch stop at all.
test('slice 6: with nothing wrong and no --pull, upgrade checks, stops, and pulls nothing', () => {
  const fixture = installedMachine();
  const beforeVault = vaultTree(fixture.vault);
  const publisherCalls = fixture.publisher.calls.length;
  fixture.launchctl.calls.length = 0;

  const calls = [];
  const run = (command, args = [], options) => {
    calls.push([command, ...args].join(' '));
    return fixture.context.run(command, args, options);
  };
  const beforeHome = managedSnapshot(fixture.home, null);
  const { code, output } = runUpgradeCli(fixture, [], { run });

  // The stop-loss shape: checks run, a plan is printed, and the disk is not
  // touched. Exit 1 because the user asked for an upgrade and did not get one.
  assert.equal(code, EXIT.ACTIONABLE, `the CLI checks and stops: ${output}`);
  assert.match(output, /does NOT upgrade anything/, output);
  assert.match(output, /To do it by hand, from this clone, in this order:/, output);
  assert.deepEqual(managedSnapshot(fixture.home, null), beforeHome, 'and writes nothing');
  assert.deepEqual(treeDiff(beforeVault, vaultTree(fixture.vault)), UNCHANGED, 'including the vault');
  assert.equal(readInstallState(fixture.home).status, 'installed', 'the state is not claimed');
  assert.equal(calls.some(call => call.includes('install.mjs')), false,
    `no child installer without --pull: ${calls.filter(call => call.includes('install.mjs')).join(' | ')}`);
  assert.equal(calls.some(call => call.startsWith('git') && call.includes('pull')), false,
    `no pull without --pull: ${calls.join(' | ')}`);
  assertWorktreeUntouched(calls, 'healthy default');
  assertNoServiceMoved(fixture.launchctl, 'healthy default');
  // The plan is allowed to ask the publisher what it would do; it may not let
  // it do anything.
  const during = fixture.publisher.calls.slice(publisherCalls).map(call => call.sub);
  assert.deepEqual(during, ['--check'], `read-only publisher use only: ${during}`);
});

// --- slice 6, batch 2: steps 5-8 --------------------------------------------

// §8.1 step 5, §2.3. The branch this gets wrong overwrites a script the user
// wrote, and the backup is its only copy -- so the third-party rows check the
// bytes of the original, not just the exit code.
test('slice 6: upgrade takes over a shim only on the terms install would have', () => {
  const shimPath = fixture => join(fixture.home, '.local', 'bin', 'brain-node');
  const THEIRS = '#!/bin/sh\n# a script the user wrote themselves\nexec /opt/their/node "$@"\n';

  const cases = [
    { rule: 'the brainkit shim is already current', flags: [], refuses: null,
      damage: () => {} },
    { rule: 'an older brainkit-marked shim', flags: [], refuses: null,
      damage: fixture => writeFileSync(shimPath(fixture),
        '#!/bin/sh\n# brainkit-node-shim v1\nexec /old/node "$@"\n', { mode: 0o755 }) },
    // Refused by step 5 itself. preflight refuses it earlier still, which is
    // why this row drives the apply path directly -- the CLI never gets there
    // now, and what has to stay true is that the writer refuses on its own and
    // does not rely on a check that ran before it.
    { rule: 'an unmarked file, without --adopt-shims',
      refuses: /existing file carries no brainkit marker/, flags: [],
      damage: fixture => writeFileSync(shimPath(fixture), THEIRS, { mode: 0o755 }) },
    { rule: 'an unmarked file, with --adopt-shims', flags: ['--adopt-shims'], refuses: null,
      damage: fixture => writeFileSync(shimPath(fixture), THEIRS, { mode: 0o755 }) },
  ];

  for (const row of cases) {
    const fixture = installedMachine();
    row.damage(fixture);
    const beforeVault = vaultTree(fixture.vault);
    const { code, output, stderr } = runUpgradeApply(fixture, row.flags);

    if (row.refuses) {
      assert.notEqual(code, EXIT.OK, `${row.rule}: must refuse`);
      assert.match(stderr, row.refuses, `${row.rule}: ${stderr || output}`);
      assert.equal(output.includes(UPGRADE_DONE), false, `${row.rule}: and must not claim the upgrade finished`);
      // The whole point of refusing: their file is still their file.
      assert.equal(readFileSync(shimPath(fixture), 'utf8'), THEIRS,
        `${row.rule}: the file the installer would not take over is left alone`);
      assert.deepEqual(treeDiff(beforeVault, vaultTree(fixture.vault)), UNCHANGED,
        `${row.rule}: and nothing was published`);
      continue;
    }

    assert.equal(code, EXIT.OK, `${row.rule}: ${stderr || output}`);
    assert.match(readFileSync(shimPath(fixture), 'utf8'), /brainkit/,
      `${row.rule}: the shim is the current brainkit one afterwards`);

    if (!row.flags.includes('--adopt-shims')) continue;
    // §4.4: an adopted third-party file's original is the only copy there is.
    // Finding it by content rather than by path, because where it is kept is
    // the recovery layer's business and naming the path here would pin it.
    const kept = filesHolding(join(fixture.home, '.config', 'second-brain'), Buffer.from(THEIRS));
    assert.ok(kept.length > 0, `${row.rule}: the only copy of their script must be kept somewhere`);
    assert.match(output, /adopt|backed up|recovery/i, `${row.rule}: and the summary must say so: ${output}`);
  }
});

// §8.1 step 6, and the requirement the matrix derived that the spec does not
// state: step 5 runs BEFORE the check, so a hard stop here happens with the
// shims already rebuilt. They have to go back.
test('slice 6: a publish --check hard stop puts the rebuilt shims back and says publishing never started', () => {
  // The four states the spec names. retirement-pending is included even though
  // the manifest cannot currently produce it: "does not happen today" is a fact
  // about the manifest, not an invariant of this command.
  for (const state of ['vault-ahead', 'conflict', 'repo-removed', 'retirement-pending']) {
    const fixture = installedMachine();
    // An older brainkit shim, so step 5 has something real to rewrite and
    // therefore something real to put back.
    const shim = join(fixture.home, '.local', 'bin', 'brain-node');
    const theirs = `#!/bin/sh\n# brainkit-node-shim v1\nexec /old/node "$@" # ${state}\n`;
    writeFileSync(shim, theirs, { mode: 0o755 });
    const beforeShim = fileFacts(shim);
    const beforeVault = vaultTree(fixture.vault);
    const publisherCalls = fixture.publisher.calls.length;

    const run = (command, args = [], options) => {
      if (args.includes('--check')) {
        return { status: 2, stdout: `${JSON.stringify({ type: 'summary', state, exitCode: 2 })}\n`, stderr: '' };
      }
      return fixture.context.run(command, args, options);
    };
    const { code, output, stderr } = runUpgradeApply(fixture, [], { run });

    assert.notEqual(code, EXIT.OK, `${state}: must not report success`);
    assert.match(stderr, new RegExp(`publish --check reports ${state}`), `${state}: ${stderr || output}`);
    // Vacuity guard, and it is not hypothetical: if step 5 ran after the check
    // instead of before it, the shim would never have been rebuilt and the
    // restore assertion below would pass without a restore ever happening.
    assert.match(output, /shims rebuilt: node/, `${state}: step 5 must have run before the check: ${output}`);
    // The derived requirement.
    assert.deepEqual(fileFacts(shim), beforeShim, `${state}: the shim step 5 rebuilt must be back byte for byte\n${output}`);
    assert.deepEqual(treeDiff(beforeVault, vaultTree(fixture.vault)), UNCHANGED, `${state}: the vault is untouched`);
    assert.equal(fixture.publisher.calls.slice(publisherCalls).some(call => call.sub === 'publish'), false,
      `${state}: publishing must never have started`);
    // The wording, which must not be step 9's. Batch 3 owns "changed and put
    // back"; this one is "never started", and the two are not interchangeable.
    assert.match(output, /never reported changing the vault/, `${state}: ${output}`);
    assert.equal(/rolled back|--recover/.test(output), false,
      `${state}: must not claim a rollback of production that never happened: ${output}`);
  }
});

// §8.1 step 9, and the matrix's three cross-products, which only exist at this
// one intersection: adopted third-party shim x rollback, loaded service set x
// rollback, and repo-at-new-HEAD x rollback.
test('slice 6: a failure after the publisher has run rolls production back and says so', () => {
  for (const recoverWorks of [true, false]) {
    const label = `publisher recovery ${recoverWorks ? 'succeeds' : 'fails'}`;
    const fixture = installedMachine({ components: 'core,watch' });
    // Parameter b of the matrix: a third-party file adopted by this very run,
    // whose original is the only copy in existence.
    const shim = join(fixture.home, '.local', 'bin', 'brain-node');
    const THEIRS = '#!/bin/sh\n# their own launcher\nexec /opt/theirs/node "$@"\n';
    writeFileSync(shim, THEIRS, { mode: 0o755 });
    // The service was running when the upgrade started; it must be running
    // after the rollback too.
    assert.equal(fixture.launchctl.loaded.has(WATCH_LABEL), true);
    const beforeVault = vaultTree(fixture.vault);

    const backupDir = mkdtempSync(join(tmpdir(), 'brainkit-fake-backup-'));
    const seen = [];
    let publishedYet = false;
    const run = (command, args = [], options) => {
      seen.push(args.join(' '));
      // The publisher committed something, so there is a backup to recover
      // from -- this is what puts the run on the "vault was changed" branch.
      if (String(args[0] ?? '').endsWith('publish.mjs') && args.length === 1) {
        publishedYet = true;
        return {
          status: 0,
          stdout: `${JSON.stringify({ type: 'summary', state: 'clean', exitCode: 0 })}\n`
            + `${JSON.stringify({ type: 'transaction', status: 'committed', backupDir })}\n`,
          stderr: '',
        };
      }
      if (args.includes('--recover')) {
        return recoverWorks
          ? { status: 0, stdout: '', stderr: '' }
          : { status: 2, stdout: '', stderr: 'recovery ledger unavailable\n' };
      }
      // Step 9 is what fails, and only step 9: the same check that passed in
      // step 2 stops passing once the publisher has run. Injected at the git
      // seam so nothing on disk has to be sabotaged.
      if (publishedYet && command === 'git' && args.includes('--is-inside-work-tree')) {
        return { status: 0, stdout: 'false\n', stderr: '' };
      }
      return fixture.context.run(command, args, options);
    };

    const { code, output, stderr } = runUpgradeApply(fixture, ['--adopt-shims'], { run });

    assert.notEqual(code, EXIT.OK, `${label}: a failed step 9 is not a success: ${output}`);
    // Vacuity guard: the failure has to be step 9, not something earlier --
    // otherwise the publisher never ran and none of this is being tested.
    assert.ok(seen.some(call => call.includes('--recover')) === true,
      `${label}: the publisher's own recovery must have been attempted: ${seen.join(' | ')}`);

    // Cross-product 1: the only copy of their script came back.
    assert.equal(readFileSync(shim, 'utf8'), THEIRS, `${label}: the adopted original must be restored`);
    // Cross-product 2: the service that was running is running again.
    assert.equal(fixture.launchctl.loaded.has(WATCH_LABEL), true, `${label}: a service that was up must be up again`);
    assert.deepEqual(treeDiff(beforeVault, vaultTree(fixture.vault)), UNCHANGED, `${label}: the user's notes are untouched`);

    // Cross-product 3, and the wording ruling: rolled back is not the same
    // sentence as never started, and a failed publisher recovery is neither.
    if (recoverWorks) {
      assert.match(output, /production has been rolled back/, `${label}: ${output}`);
      assert.equal(/never reported changing the vault/.test(output), false, `${label}: wrong fork state: ${output}`);
    } else {
      assert.match(output, /its own recovery did not complete/, `${label}: ${output}`);
      assert.match(output, /recovery ledger unavailable/, `${label}: must name why: ${output}`);
      assert.equal(/rolled back/.test(output), false, `${label}: must not claim a rollback that failed: ${output}`);
    }
    assert.equal(output.includes(UPGRADE_DONE), false, `${label}: must not claim the upgrade finished`);
    assert.equal(readInstallState(fixture.home).status, 'installed',
      `${label}: the rollback puts the pre-upgrade state back, not a half-upgraded one`);
    assert.ok(stderr.length > 0, `${label}: the failure is reported on stderr too`);
  }
});

// The matrix row neither of us thought of, and the one a real upgrade hits
// every time: spec 8.1 rebuilds the node shim even when its target has not
// moved, and a plist normally re-renders byte for byte. Writing a file with
// exactly what is in it leaves pre and post the same image, and the rollback
// then cannot prove itself -- the file satisfies "installed" and "undone" at
// once, and a clean rollback was reported as an unknown state.
test('slice 6: an upgrade that rewrites files with identical bytes still rolls back cleanly', () => {
  const fixture = installedMachine({ components: 'core,watch' });
  const plist = join(fixture.home, 'Library', 'LaunchAgents', 'com.second-brain.watch.plist');
  const shim = join(fixture.home, '.local', 'bin', 'brain-node');
  // Nothing is changed between the install and the upgrade, so every managed
  // write this run makes is a write of the bytes already there.
  const recoveryDir = join(fixture.home, '.config', 'second-brain', 'recovery');
  const before = {
    plist: fileFacts(plist),
    shim: fileFacts(shim),
    // The fixture's own install transaction is already in here and stays; what
    // must not survive is the one this upgrade opens.
    recovery: readdirSync(recoveryDir).sort(),
  };

  let publishedYet = false;
  const run = (command, args = [], options) => {
    if (String(args[0] ?? '').endsWith('publish.mjs') && args.length === 1) {
      publishedYet = true;
      return { status: 0, stdout: `${JSON.stringify({ type: 'summary', state: 'clean', exitCode: 0 })}\n`, stderr: '' };
    }
    if (publishedYet && command === 'git' && args.includes('--is-inside-work-tree')) {
      return { status: 0, stdout: 'false\n', stderr: '' };
    }
    return fixture.context.run(command, args, options);
  };
  const { code, output } = runUpgradeApply(fixture, [], { run });

  assert.notEqual(code, EXIT.OK, `step 9 failed, so this is not a success: ${output}`);
  // The whole point: a rollback with nothing to undo is still a clean rollback.
  assert.equal(/unknown state/.test(output), false, `a clean rollback must not be reported as unknown: ${output}`);
  assert.match(output, /never reported changing the vault/, output);
  assert.deepEqual(fileFacts(plist), before.plist, 'the plist is what it always was');
  assert.deepEqual(fileFacts(shim), before.shim, 'and so is the shim');
  // Terminal, not stranded mid-upgrade.
  assert.equal(readInstallState(fixture.home).status, 'installed');
  assert.deepEqual(readdirSync(recoveryDir).sort(), before.recovery,
    'this upgrade\'s transaction was consumed rather than left for a human');
});

// The blocking item from batch 2: recover used to describe every interrupted
// run as an install, and told the user to delete install-state and start over.
// On an upgrade that is the record of a working installation.
// The four findings the review reproduced with its own probes, each pinned by
// the scenario it used. All of them turn on the same mistake in different
// clothes: reading a nearby signal instead of the authority.
test('slice 6: review findings F1, F2, F6 and F7', () => {
  const backupOf = () => realpathSync(mkdtempSync(join(tmpdir(), 'brainkit-pub-backup-')));

  // F1: publish.mjs writes the manifest, prints its committed receipt, and only
  // then decides its exit code. Judging the code first read a publisher that had
  // already changed the vault as one that never published.
  {
    const fixture = installedMachine();
    const backupDir = backupOf();
    const seen = [];
    const run = (command, args = [], options) => {
      seen.push(args.join(' '));
      if (String(args[0] ?? '').endsWith('publish.mjs') && args.length === 1) {
        return {
          status: 2,
          stdout: `${JSON.stringify({ type: 'summary', state: 'clean', exitCode: 0 })}\n`
            + `${JSON.stringify({ type: 'transaction', status: 'committed', backupDir })}\n`,
          stderr: '',
        };
      }
      if (args.includes('--recover')) return { status: 0, stdout: '', stderr: '' };
      return fixture.context.run(command, args, options);
    };
    const { code, output } = runUpgradeApply(fixture, [], { run });

    assert.notEqual(code, EXIT.OK, `a publisher that exits 2 is not a success: ${output}`);
    assert.ok(seen.some(call => call.includes('--recover')),
      `a committed publisher must be recovered even when it then failed: ${seen.join(' | ')}`);
    assert.equal(/never reported changing the vault/.test(output), false,
      `a vault that was changed must not be reported as untouched: ${output}`);
  }

  // F2: 14 A1 keeps a transaction while the status is non-terminal and consumes
  // it at `installed`. The success path reached installed and walked away.
  {
    const fixture = installedMachine();
    const recoveryDir = join(fixture.home, '.config', 'second-brain', 'recovery');
    const before = readdirSync(recoveryDir).sort();
    const { code, output } = runUpgradeApply(fixture);

    assert.equal(code, EXIT.OK, output);
    assert.deepEqual(readdirSync(recoveryDir).sort(), before,
      `a successful upgrade must consume its own transaction: ${output}`);
  }

  // F2, second form: an adopted third-party original is the one thing the
  // closeout keeps, and consuming the transaction must not take it with it.
  {
    const fixture = installedMachine();
    const shim = join(fixture.home, '.local', 'bin', 'brain-node');
    const THEIRS = '#!/bin/sh\n# theirs\nexec /opt/theirs/node "$@"\n';
    writeFileSync(shim, THEIRS, { mode: 0o755 });
    const { code, output } = runUpgradeApply(fixture, ['--adopt-shims']);

    assert.equal(code, EXIT.OK, output);
    assert.ok(filesHolding(join(fixture.home, '.config', 'second-brain'), Buffer.from(THEIRS)).length > 0,
      `consuming the transaction must not take the only copy of their file with it: ${output}`);
  }

  // F2, third form: the review asked for closeout failure to be a real
  // terminal, not best-effort cleanup. guard-census found this refusal watched
  // by nothing. Interrupted at the seam closeOut has for exactly this.
  {
    const fixture = installedMachine();
    const { code, output, stderr } = runUpgradeApply(fixture, [], {
      failpoint: point => { if (point === 'during-backups') throw new Error('disk gave up'); },
    });

    assert.equal(code, EXIT.RECOVERY, `a transaction that could not be consumed is not a clean finish: ${output}`);
    assert.match(stderr, /transaction could not be consumed/, stderr);
    assert.equal(output.includes(UPGRADE_DONE), false, `and must not claim the upgrade finished: ${output}`);
  }

  // F6: a commit that could not be read is a failed step 10. Writing null and
  // exiting 0 records less than the state claims to carry.
  {
    const fixture = installedMachine();
    const before = readInstallState(fixture.home);
    const run = (command, args = [], options) => (command === 'git' && args.includes('HEAD')
      ? { status: 2, stdout: '', stderr: 'fatal: ambiguous argument\n' }
      : fixture.context.run(command, args, options));
    const { code, output, stderr } = runUpgradeApply(fixture, [], { run });

    assert.notEqual(code, EXIT.OK, `an unreadable HEAD is not a successful upgrade: ${output}`);
    assert.match(stderr, /did not return a commit/, stderr);
    // It failed, so it rolled back: the state is the pre-upgrade record, not a
    // half-written one claiming this run installed a version it cannot name.
    // (before.installed_commit is the install fixture's own null -- an install
    // -side gap, out of scope here; what matters is that this run wrote none.)
    assert.deepEqual(readInstallState(fixture.home), before,
      `a failed step 10 leaves the previous record, not a new one: ${output}`);
  }

  // F7: changing the publisher's layer while the local one is known unfinished
  // turns one stopped rollback into two half-restored layers.
  {
    const fixture = installedMachine();
    const bin = join(fixture.home, '.local', 'bin');
    writeFileSync(join(bin, 'brain-node'), '#!/bin/sh\n# brainkit-node-shim v1\nexec /old/node "$@"\n', { mode: 0o755 });
    const backupDir = backupOf();
    const seen = [];
    let publishedYet = false;
    const run = (command, args = [], options) => {
      seen.push(args.join(' '));
      if (String(args[0] ?? '').endsWith('publish.mjs') && args.length === 1) {
        publishedYet = true;
        chmodSync(bin, 0o500); // the local rollback cannot finish from here
        return {
          status: 0,
          stdout: `${JSON.stringify({ type: 'summary', state: 'clean', exitCode: 0 })}\n`
            + `${JSON.stringify({ type: 'transaction', status: 'committed', backupDir })}\n`,
          stderr: '',
        };
      }
      if (publishedYet && command === 'git' && args.includes('--is-inside-work-tree')) {
        return { status: 0, stdout: 'false\n', stderr: '' };
      }
      return fixture.context.run(command, args, options);
    };
    const { code, output } = runUpgradeApply(fixture, [], { run });
    chmodSync(bin, 0o755);

    // First, because it is the finding: an exit code mismatch would otherwise
    // mask which rule was broken.
    assert.equal(seen.some(call => call.includes('--recover')), false,
      `the publisher must not be unwound while the local layer is unfinished: ${seen.join(' | ')}`);
    assert.equal(code, EXIT.RECOVERY, output);
    // And the backup has to be named, or the user cannot do it by hand either.
    assert.match(output, /deliberately not run/, output);
    assert.ok(output.includes(backupDir), `the kept backup must be named: ${output}`);
  }
});

// F4, the half that is in scope: step 9 has to check what this run produced,
// not just what preflight checks. Both of these leave every preflight check
// green -- if the only verification is preflight, both ship as "Upgrade
// complete" with production broken.
test('slice 6: step 9 checks what the upgrade produced, not only what preflight checks', () => {
  // The publisher's own verdict on the vault it just wrote.
  {
    const fixture = installedMachine();
    let checks = 0;
    const run = (command, args = [], options) => {
      if (args.includes('--check')) {
        checks += 1;
        // Clean for step 6, drifted by step 9: what a publish that did not
        // land looks like from the outside.
        const state = checks === 1 ? 'clean' : 'repo-ahead';
        return { status: 0, stdout: `${JSON.stringify({ type: 'summary', state, exitCode: 0 })}\n`, stderr: '' };
      }
      return fixture.context.run(command, args, options);
    };
    const { code, output, stderr } = runUpgradeApply(fixture, [], { run });

    assert.notEqual(code, EXIT.OK, `deployed code that does not match the repo is not a finished upgrade: ${output}`);
    assert.match(stderr, /did not pass its own checks: published-code/, stderr);
    assert.equal(output.includes(UPGRADE_DONE), false, output);
  }

  // A service that was running before and is not running after. Step 8 claims
  // it restarted them; step 9 is where that claim gets checked.
  {
    const fixture = installedMachine({ components: 'core,watch' });
    assert.equal(fixture.launchctl.loaded.has(WATCH_LABEL), true);
    let checks = 0;
    const run = (command, args = [], options) => {
      // On step 9's own --check, so step 8 has already bootstrapped and
      // verified it: the job dies afterwards, which launchd does not announce.
      // Killing it any earlier is caught by mountServices instead, which is a
      // different guard and already has its own test.
      if (args.includes('--check')) {
        checks += 1;
        if (checks === 2) fixture.launchctl.loaded.delete(WATCH_LABEL);
      }
      return fixture.context.run(command, args, options);
    };
    const { code, output, stderr } = runUpgradeApply(fixture, [], { run });

    assert.notEqual(code, EXIT.OK, `a service that did not come back is not a finished upgrade: ${output}`);
    assert.match(stderr, new RegExp(`did not pass its own checks: service-${WATCH_LABEL}`), stderr);
  }
});

// --- the three windows the second review left open ---------------------------
//
// The write half is disabled at the CLI because of these. They are kept as the
// review wrote them, marked todo rather than deleted or bent green: each one is
// the acceptance criterion for turning its part back on. A todo that starts
// passing is the signal, and node's runner reports it without failing the run.
//
// Reinstating the write half needs all three green AND an independent review
// pass -- a green todo on its own is not the gate.
test('KNOWN-FAIL F2: a success closeout must not delete a backup its live manifest still names', { todo: 'slice 6 stop-loss window' }, () => {
  const fixture = installedMachine();
  const { code } = runUpgradeApply(fixture, [], {
    failpoint: point => { if (point === 'during-backups') throw new Error('interrupted'); },
  });
  assert.equal(code, EXIT.RECOVERY);
  // The defect: releaseState:false deletes the state anchor's pre-image before
  // the manifest is marked spent, so an interruption here leaves a live
  // manifest naming a backup that is gone -- and status=installed, which makes
  // recover refuse to look.
  const dir = join(fixture.home, '.config', 'second-brain', 'recovery', readInstallState(fixture.home).last_txn);
  const manifest = JSON.parse(readFileSync(join(dir, 'transaction.json'), 'utf8'));
  for (const operation of manifest.operations ?? []) {
    if (!operation.backup) continue;
    assert.ok(existsSync(operation.backup), `a live manifest may not name a deleted backup: ${operation.backup}`);
  }
});

// F3 is fixed rather than deferred: it lives in recover, which is not on the
// disabled path, and its defect loses the record of an installed machine.
test('slice 6: recover never offers to delete the install state of an upgrading machine', () => {
  // The reviewer's first-round probe, replayed as written: an install
  // transaction whose state was moved to `upgrading` by hand. The record says
  // it created install-state.json; the status says this machine was already
  // installed. They cannot both be true, and the safe reading keeps the file.
  const fixture = installedMachine();
  writeInstallState(fixture.home, { ...readInstallState(fixture.home), status: 'upgrading' });
  let output = '';
  recoverInstall({ ...fixture.context, stdout: text => { output += text; } });

  assert.equal(/delete\s+.*install-state\.json/i.test(output), false, output);
  assert.match(output, /which an upgrade cannot have/, `and it must say why it is ignoring the record: ${output}`);

  // The other half of the same finding: with no manifest at all, the advice
  // used to be "set the status back and re-run". The claim rewrote last_txn
  // and plan_digest too, so that would dress an unprovable half-upgrade up as
  // a machine ready to upgrade again.
  const gone = installedMachine();
  const claimed = { ...readInstallState(gone.home), status: 'upgrading', last_txn: 'a'.repeat(16) };
  writeInstallState(gone.home, claimed);
  let missing = '';
  recoverInstall({ ...gone.context, stdout: text => { missing += text; } });

  assert.equal(/delete\s+.*install-state\.json/i.test(missing), false, missing);
  assert.match(missing, /not automatically recoverable/, missing);
  assert.match(missing, /Do NOT just set the status back and re-run/, missing);
});

test('KNOWN-FAIL F4: step 9 must judge the publisher, the plist hash and the plist a service loads from', { todo: 'slice 6 stop-loss window' }, () => {
  // 4a only, and it is enough to keep the window open: a publish --check that
  // failed as a process but left a clean-looking summary on stdout.
  const fixture = installedMachine();
  let checks = 0;
  const run = (command, args = [], options) => {
    if (args.includes('--check')) {
      checks += 1;
      if (checks > 1) {
        return { status: 2, stdout: `${JSON.stringify({ type: 'summary', state: 'clean', exitCode: 0 })}\n`, stderr: 'publisher blew up\n' };
      }
    }
    return fixture.context.run(command, args, options);
  };
  const { code, output } = runUpgradeApply(fixture, [], { run });
  assert.notEqual(code, EXIT.OK, `a publisher that failed as a process is not a verified upgrade: ${output}`);
});

// A real interrupted upgrade, not an install transaction with its status
// rewritten. The difference is the whole finding: the install transaction
// CREATED install-state.json, so recover correctly offers to delete it, and a
// fixture that borrows that transaction produces "delete the record of this
// machine" while claiming to prove the opposite.
function interruptedUpgrade(fixture) {
  // Interrupted where a killed process would leave it: the transaction claimed,
  // the rollback run, and the phase never recorded. The state file is an anchor
  // and is released in the closeout, so it still holds the upgrading record --
  // which is exactly the thing recover has to tell the user to put back.
  //
  // Through the apply path directly: the CLI no longer reaches it, and the
  // state recover has to diagnose is one only that path can produce.
  const context = createContext({
    ...fixture.context,
    stdout: () => {},
    failpoint: point => { if (point === 'before-phase') throw new Error('killed mid-rollback'); },
    run: (command, args = [], options) => (args.includes('--check')
      ? { status: 2, stdout: `${JSON.stringify({ type: 'summary', state: 'conflict', exitCode: 2 })}\n`, stderr: '' }
      : fixture.context.run(command, args, options)),
  });
  assert.throws(
    () => upgradeApply(context, doctorAnswers(context), readInstallState(fixture.home)),
    /killed mid-rollback/,
  );
  const state = readInstallState(fixture.home);
  assert.equal(state.status, 'upgrading', 'the fixture must really be mid-upgrade');
  return state;
}

test('slice 6: recover diagnoses a real interrupted upgrade without telling anyone to delete the install state', () => {
  const fixture = installedMachine();
  const state = interruptedUpgrade(fixture);

  let output = '';
  const code = recoverInstall({ ...fixture.context, stdout: text => { output += text; } });

  assert.equal(code, EXIT.RECOVERY, output);
  // F5: the transaction the upgrade claimed must be loadable at all. Without
  // plan_digest written alongside last_txn this refuses before printing
  // anything useful, and every real interrupted upgrade is undiagnosable.
  assert.equal(/manifest and install state disagree/.test(output), false,
    `recover must be able to load the transaction it exists to diagnose: ${output}`);
  assert.match(output, /An upgrade stopped partway \(status=upgrading\)/, output);
  // The blocking rule, asserted over the WHOLE report rather than one sentence:
  // no path through it may suggest removing the record of this installation.
  assert.equal(/(delete|remove|unlink)\s+\S*install-state\.json/i.test(output), false,
    `no line may offer to delete the install state: ${output}`);
  assert.equal(/run  node install\.mjs install  again/.test(output), false, output);
  // And it has to leave a way out: the status has to be got back to a terminal
  // one, or upgrade will refuse and send the user straight back here.
  // The way out has to be spelled out, and it has to be the whole record --
  // the claim rewrote last_txn and plan_digest along with the status, so
  // "just set the status back" would leave the file naming another transaction.
  assert.match(output, /that copy IS the record, including the/, `the way out of upgrading must be spelled out: ${output}`);
  assert.match(output, /last_txn and plan_digest/, output);
  assert.match(output, /recover and upgrade send you to each other/, output);
  assert.match(output, /node install\.mjs upgrade  again/, output);
  assert.equal(readInstallState(fixture.home).status, 'upgrading', 'recover changes nothing');
  assert.equal(readInstallState(fixture.home).last_txn, state.last_txn);
});

// The other end of the same catch: the rollback itself could not run. Flagged
// by tools/guard-census.mjs as a refusal nothing was watching -- the census
// cannot switch it off (its `if` is not unique in the file), so it gets a test
// rather than a verdict.
test('slice 6: an upgrade whose own rollback is blocked says so, and names what blocked it', () => {
  const fixture = installedMachine();
  const bin = join(fixture.home, '.local', 'bin');
  writeFileSync(join(bin, 'brain-node'), '#!/bin/sh\n# brainkit-node-shim v1\nexec /old/node "$@"\n', { mode: 0o755 });

  // Locked between step 5 and the rollback, through the seam the check already
  // goes through: the shim is written, and then the directory it lives in stops
  // being writable -- which is what a real machine looks like when something
  // else has taken the directory over.
  const run = (command, args = [], options) => {
    if (args.includes('--check')) {
      chmodSync(bin, 0o500);
      return { status: 2, stdout: `${JSON.stringify({ type: 'summary', state: 'conflict', exitCode: 2 })}\n`, stderr: '' };
    }
    return fixture.context.run(command, args, options);
  };
  const { code, output, stderr } = runUpgradeApply(fixture, [], { run });
  chmodSync(bin, 0o755);

  assert.equal(code, EXIT.RECOVERY, `a blocked rollback is its own exit code: ${stderr || output}`);
  assert.match(stderr, /the restore could not be started safely/, stderr);
  // Being told the state is unknown with no detail leaves nothing to act on.
  assert.match(output, /could not put the local layer back, so production is in an unknown/, output);
  assert.match(output, new RegExp(bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `and must name what blocked it: ${output}`);
});

// §8.1 step 8, the invariant that only shows up with a service: an upgrade
// restarts what it found running, and starts nothing that was not.
test('slice 6: upgrade restarts the services that were running and leaves the rest alone', () => {
  for (const running of [true, false]) {
    const label = `was ${running ? 'loaded' : 'not loaded'}`;
    const fixture = installedMachine({ components: 'core,watch' });
    // The install mounted it; parameter b is the machine where the user has
    // since stopped it.
    assert.equal(fixture.launchctl.loaded.has(WATCH_LABEL), true, `${label}: the fixture must start mounted`);
    if (!running) fixture.launchctl.loaded.delete(WATCH_LABEL);
    fixture.launchctl.calls.length = 0;

    const { code, output } = runUpgradeApply(fixture);

    assert.equal(code, EXIT.OK, `${label}: ${output}`);
    assert.equal(fixture.launchctl.loaded.has(WATCH_LABEL), running,
      `${label}: launchd must end up exactly as it was found`);
    const moved = fixture.launchctl.calls.filter(call => !call.startsWith('print '));
    if (running) {
      assert.ok(moved.some(call => call.startsWith('bootstrap ')), `${label}: a running service is restarted: ${moved}`);
    } else {
      assert.deepEqual(moved, [], `${label}: a stopped service is not started by an upgrade`);
    }
  }
});

test('slice 6: after --pull the work continues in the installer that was just pulled', () => {
  // The version marker the plan asks for. The "new" installer is a stub that
  // announces itself and exits with a code nothing else uses, so "the child
  // that ran was the file at the new HEAD" is observable rather than assumed.
  const MARKER = 'STUB-INSTALLER-c0ffee';
  const repo = mkdtempSync(join(tmpdir(), 'brainkit-pulled-repo-'));
  writeFileSync(join(repo, 'install.mjs'),
    `process.stdout.write('${MARKER} ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(7);\n`);
  const repoRoot = realpathSync(repo);

  const fixture = installedMachine();
  writeInstallState(fixture.home, { ...readInstallState(fixture.home), repo_root: repoRoot });
  // The fixture install already called the publisher; what matters is that
  // upgrade adds none of its own.
  const publisherCalls = fixture.publisher.calls.length;
  const beforeHome = managedSnapshot(fixture.home, null);
  const beforeVault = vaultTree(fixture.vault);
  fixture.launchctl.calls.length = 0;

  const calls = [];
  const run = (command, args = [], options) => {
    calls.push([command, ...args].join(' '));
    if (command === 'git' && args.includes('pull')) return { status: 0, stdout: '', stderr: '' };
    // The handoff itself is executed for real. Faking it would leave the stub
    // unexecuted and the marker absent, and the assertion below would then be
    // checking the mock rather than the handoff.
    if (String(args[0] ?? '').endsWith('install.mjs')) return spawnSync(command, args, { encoding: 'utf8' });
    return fixture.context.run(command, args, options);
  };

  const { code, output } = runUpgradeCli(fixture, ['--pull'], { repoRoot, run });

  assert.ok(output.includes(MARKER), `the pulled installer must be the one that continued: ${output}`);
  assert.match(output, new RegExp(`${MARKER} upgrade --no-pull --resumed-after-pull`),
    'it is told not to pull again, and gets the original request');
  assert.equal(code, 7, 'the parent reports whatever the pulled installer decided');
  // The point of the handoff: the parent stops orchestrating. Step 4 is the
  // next thing it would have done, so its absence is what proves it returned.
  assert.equal(calls.some(call => call.includes('run-all.mjs')), false,
    `the parent must not keep going after handing off: ${calls.join(' | ')}`);
  assert.equal(fixture.publisher.calls.length, publisherCalls, 'and must not have reached the publisher');
  assert.equal(existsSync(join(fixture.home, '.config', 'second-brain', 'install.lock')), false,
    'the lock is handed over, not held through the child');
  // The stub child changes nothing, so everything below is the parent's own
  // record: up to the handoff it read, pulled, and wrote nothing.
  assert.deepEqual(managedSnapshot(fixture.home, null), beforeHome, 'the parent changes nothing on its way to handing off');
  assert.deepEqual(treeDiff(beforeVault, vaultTree(fixture.vault)), UNCHANGED, 'the vault is untouched');
  assertWorktreeUntouched(calls, 'handoff', { pull: true });
  assertNoServiceMoved(fixture.launchctl, 'handoff');
});

// Both of these were MISSED by tools/guard-census.mjs on the first run: the
// refusals existed and no test switched off would have noticed.
test('slice 6: a --pull that fails, and a handoff that will not start, both stop the upgrade', () => {
  const cases = [
    {
      rule: 'the pull fails',
      refuses: /git pull --ff-only failed: fatal: refusing to merge unrelated histories/,
      answer: (command, args) => (command === 'git' && args.includes('pull')
        ? { status: 1, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' }
        : null),
    },
    {
      rule: 'the pulled installer will not start',
      refuses: /could not hand off to the updated installer: spawn ENOENT/,
      answer: (command, args) => {
        if (command === 'git' && args.includes('pull')) return { status: 0, stdout: '', stderr: '' };
        return String(args[0] ?? '').endsWith('install.mjs') ? { error: new Error('spawn ENOENT') } : null;
      },
    },
  ];

  for (const row of cases) {
    const fixture = installedMachine();
    const beforeHome = managedSnapshot(fixture.home, null);
    const beforeVault = vaultTree(fixture.vault);
    const publisherCalls = fixture.publisher.calls.length;
    fixture.launchctl.calls.length = 0;

    const calls = [];
    const run = (command, args = [], options) => {
      calls.push([command, ...args].join(' '));
      return row.answer(command, args) ?? fixture.context.run(command, args, options);
    };
    const { code, stderr } = runUpgradeCli(fixture, ['--pull'], { run });

    assert.notEqual(code, EXIT.OK, `${row.rule}: upgrade must not report success`);
    assert.match(stderr, row.refuses, `${row.rule}: ${stderr}`);
    // Step 4 is not reached either way: a failed pull leaves a HEAD nobody has
    // vouched for, and a failed handoff means this process is the wrong
    // installer to be carrying on with.
    assert.equal(calls.some(call => call.includes('run-all.mjs')), false, `${row.rule}: ${calls.join(' | ')}`);
    assert.equal(fixture.publisher.calls.length, publisherCalls, `${row.rule}: the publisher is never reached`);
    assert.deepEqual(managedSnapshot(fixture.home, null), beforeHome, `${row.rule}: nothing on this machine changed`);
    assert.deepEqual(treeDiff(beforeVault, vaultTree(fixture.vault)), UNCHANGED, `${row.rule}: the vault is untouched`);
    assertWorktreeUntouched(calls, row.rule, { pull: true });
    assertNoServiceMoved(fixture.launchctl, row.rule);
    // The handoff case releases the lock before it spawns, so on that path the
    // throw happens with the lock already gone -- neither route may leave one.
    assert.equal(existsSync(join(fixture.home, '.config', 'second-brain', 'install.lock')), false,
      `${row.rule}: no lock is left behind`);
  }
});

test('slice 6: a red test suite stops the upgrade before anything is touched', () => {
  // Spec 8.1 step 4. upgrade runs the suite and honours the result; whether the
  // suite is green is the suite's business, so it is injected here. What this
  // pins is the ordering -- a non-zero result stops the run while the machine
  // is still exactly as it was.
  const fixture = installedMachine();
  const beforeHome = managedSnapshot(fixture.home, null);
  const beforeVault = vaultTree(fixture.vault);
  const publisherCalls = fixture.publisher.calls.length;
  fixture.launchctl.calls.length = 0;

  const calls = [];
  const run = (command, args = [], options) => {
    calls.push([command, ...args].join(' '));
    if (String(args[0] ?? '').endsWith('run-all.mjs')) return { status: 1, stdout: '', stderr: 'SUMMARY 9/10 PASS\n' };
    return fixture.context.run(command, args, options);
  };

  const { code, stderr } = runUpgradeCli(fixture, [], { run });

  assert.ok(calls.some(call => call.includes('run-all.mjs')), `the suite must actually be run: ${calls.join(' | ')}`);
  assert.equal(code, EXIT.UNSAFE);
  assert.match(stderr, /run-all\.mjs did not pass/);
  assert.deepEqual(managedSnapshot(fixture.home, null), beforeHome, 'nothing was changed on the way to finding out');
  assert.deepEqual(treeDiff(beforeVault, vaultTree(fixture.vault)), UNCHANGED);
  assert.equal(fixture.publisher.calls.length, publisherCalls);
  assertWorktreeUntouched(calls, 'red suite');
  assertNoServiceMoved(fixture.launchctl, 'red suite');
});

test('issue #18: nothing tells the user that recover will undo the install', () => {
  // recover stopped repairing in slice 4 (A2), but two messages still offered
  // it as the way out: the success summary pointed at it for "what to do about
  // it", and the recovery-required path said it "picks up from where this one
  // stopped". Users follow instructions -- that one would have them read a
  // list and believe the machine had been put back.
  const fixture = existingVault('notes');
  const { code, output } = installExisting(fixture);
  assert.equal(code, EXIT.OK);

  // The replacement wording is asserted first. Checking only for the absence of
  // the old phrasing would pass just as happily against a summary that had
  // stopped mentioning recover at all, or against a typo in the new text.
  assert.match(output, /node install\.mjs recover {2}will list it -- it only reports and changes nothing/,
    'the summary offers recover as a listing, and says so');
  assert.doesNotMatch(output, /what to do about it: {2}node install\.mjs recover/,
    'and does not offer it as the way to deal with anything');

  // The other site is on the recovery-required path, which this fixture does
  // not reach. The claim it used to make was a literal, so its absence from the
  // file is the check -- paired with the presence of what replaced it.
  assert.ok(installSource.includes('it will not put anything back, and running it changes nothing'),
    'the recovery-required path says recover does not repair');
  assert.equal(installSource.includes('it picks up from where this one stopped'), false,
    'and no longer claims it resumes the install');
});

test('slice 5: a vault the installer cannot read is refused by name, not by a raw filesystem error', () => {
  // The refusal was already correct -- exit 2, nothing written. What reached
  // the user was `EACCES: permission denied, lstat '...'`, which names a syscall
  // and leaves them to work out which of their directories it means and what to
  // do about it. Same cost as the recovery message that blamed a schema version
  // for a file that was simply unreadable.
  const fixture = existingVault('notes');
  const before = vaultTree(fixture.vault);
  // Put back exactly what was there, not a plausible mode: restoring to 0700
  // when the fixture made it 0755 shows up as the test changing the vault.
  const mode = statSync(fixture.vault).mode & 0o7777;
  chmodSync(fixture.vault, 0o000);
  let output = '';
  let code;
  try {
    code = main(['install', '--vault', fixture.vault, '--vault-mode', 'existing', '--components', 'core',
      '--non-interactive', '--yes'], { ...fixture.context, stdout: text => { output += text; } });
  } finally {
    chmodSync(fixture.vault, mode);
  }

  assert.equal(code, EXIT.UNSAFE, 'a vault that cannot be inspected is still exit 2');
  assert.match(output, /vault path 00-系统\/\.index-cache cannot be inspected/, 'the message names the managed path');
  assert.match(output, /could not be read \(EACCES\)/, 'and says what went wrong');
  assert.match(output, /readable by this user/, 'and what to check');
  // Not `doesNotMatch(/lstat '/)`. That named the one syscall that had been
  // wrapped rather than the property being claimed, and the open() on the
  // project map went on leaking its raw error straight past it. The claim is
  // that no raw filesystem error reaches the user, so the check is against the
  // shape they all share.
  assert.doesNotMatch(output, /\b[A-Z]{4,}: [^\n]*, (open|lstat|stat|read|scandir) '/,
    'no raw filesystem error reaches the user, whichever syscall produced it');
  // One unreadable directory is one finding, not one per managed path.
  assert.equal(output.match(/cannot be inspected/g).length, 1,
    'the same cause is reported once, not once per row');
  assert.deepEqual(treeDiff(before, vaultTree(fixture.vault)), UNCHANGED);
  assert.equal(existsSync(installStatePath(fixture.home)), false);
});

test('slice 5: a project map the installer cannot open is refused by name too', () => {
  // The directory walk succeeds here and the open() fails, which is the only
  // shape that reaches readManagedFile's own read. It needs its own case: once
  // the walk comes back blind the map is not read at all, so the unreadable
  // vault above stopped exercising this path the moment that flood was fixed --
  // two fixes masking each other, and the assertion looked satisfied either way.
  const fixture = existingVault('notes');
  const map = join(fixture.vault, '00-系统', '.project-map.json');
  const before = vaultTree(fixture.vault);
  const mode = statSync(map).mode & 0o7777;
  chmodSync(map, 0o000);
  let output = '';
  let code;
  try {
    code = main(['install', '--vault', fixture.vault, '--vault-mode', 'existing', '--components', 'core',
      '--non-interactive', '--yes'], { ...fixture.context, stdout: text => { output += text; } });
  } finally {
    chmodSync(map, mode);
  }

  assert.equal(code, EXIT.UNSAFE);
  assert.match(output, /project map cannot be read/, 'the message names what could not be read');
  assert.match(output, /\(EACCES\)/);
  assert.match(output, /readable by this user/);
  assert.doesNotMatch(output, /\b[A-Z]{4,}: [^\n]*, (open|lstat|stat|read|scandir) '/,
    'no raw filesystem error reaches the user, whichever syscall produced it');
  assert.deepEqual(treeDiff(before, vaultTree(fixture.vault)), UNCHANGED);
  assert.equal(existsSync(installStatePath(fixture.home)), false);
});

test('slice 5: an interactive install is asked about the target changes rather than sent away for a flag', () => {
  // Branch B's ordinary case: an existing vault whose targets differ reports
  // repo-ahead. The confirmation used to be `options.yes`, which the wizard
  // never sets, so an interactive user answered the whole wizard, waited
  // through bootstrap and check, and was then told to re-run with --yes --
  // with everything rolled back. Safe, and unusable.
  for (const [reply, expected] of [['yes', EXIT.OK], ['no', EXIT.ACTIONABLE]]) {
    const fixture = existingVault('notes', { publisher: { checkState: 'repo-ahead' } });
    const before = vaultTree(fixture.vault);
    const driver = scriptedTty(['existing', fixture.vault, 'core', 'yes', reply]);
    let output = '';
    const { result: code } = capturingStderr(() => main(['install'], {
      ...fixture.context, interactive: true, tty: driver.tty, stdout: text => { output += text; },
    }));

    assert.equal(code, expected, `answering ${reply} to the target question`);
    // Asked with the list already on screen, not before it is known.
    assert.match(output, /publisher will change 1 vault target\(s\) \(repo-ahead\)/);
    assert.ok(driver.asked.some(entry => /replace the vault targets/.test(entry.question)),
      'the user is asked about the targets');

    const published = fixture.publisher.calls.some(call => call.sub === 'publish');
    assert.equal(published, reply === 'yes', `publish must run only on yes (${reply})`);
    if (reply === 'no') {
      assert.deepEqual(treeDiff(before, vaultTree(fixture.vault)), UNCHANGED,
        'declining leaves the vault as it was');
      assert.equal(existsSync(installStatePath(fixture.home)), false);
    }
  }
});

test('slice 5: --non-interactive without --yes writes nothing and never reaches the publisher', () => {
  // Spec 5.2 wants exit 1 rather than a silent replacement when there is nobody
  // to ask. Asserted for clean as well as the two states that would replace
  // targets: the point is that no state gets through unconfirmed, not that one
  // particular state is caught.
  for (const checkState of ['repo-ahead', 'repo-new', 'clean']) {
    const fixture = existingVault('notes', { publisher: { checkState } });
    const before = vaultTree(fixture.vault);
    let output = '';
    const code = main(['install', '--vault', fixture.vault, '--vault-mode', 'existing',
      '--components', 'core', '--non-interactive'], { ...fixture.context, stdout: text => { output += text; } });

    assert.equal(code, EXIT.ACTIONABLE, `${checkState}: an unconfirmed plan exits 1`);
    assert.match(output, /Re-run with --yes to confirm this plan/);
    assert.equal(fixture.publisher.calls.length, 0, `${checkState}: the publisher is never reached`);
    assert.deepEqual(treeDiff(before, vaultTree(fixture.vault)), UNCHANGED,
      `${checkState}: nothing may be written before the plan is confirmed`);
  }
});

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateExitCode,
  aggregateState,
  classifyFileState,
  validateBackupDirectory,
} from '../scripts/publish.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const PUBLISHER = join(PROJECT_ROOT, 'scripts', 'publish.mjs');
const SYSTEM_TEST_ROOT = realpathSync('/tmp');
const TMP_PARENT = resolve(process.env.BRAIN_TEST_TMP_ROOT || SYSTEM_TEST_ROOT);
const canonicalPath = path => existsSync(path) ? realpathSync(path) : resolve(path);
const forbiddenFixtureRoots = [PROJECT_ROOT, process.env.BRAIN_VAULT_ROOT].filter(Boolean).map(canonicalPath);
if (forbiddenFixtureRoots.includes(canonicalPath(TMP_PARENT))) {
  throw new Error('BRAIN_TEST_TMP_ROOT must not equal the real repo or vault root');
}
const tmpRelative = relative(SYSTEM_TEST_ROOT, canonicalPath(TMP_PARENT));
if (tmpRelative === '..' || tmpRelative.startsWith(`..${sep}`) || isAbsolute(tmpRelative)) {
  throw new Error('BRAIN_TEST_TMP_ROOT must stay inside the fixed system temp root');
}
mkdirSync(TMP_PARENT, { recursive: true });
const TEST_ROOT = mkdtempSync(join(TMP_PARENT, 'publish-tests-'));
const capabilityPath = join(TEST_ROOT, '.publisher-test-capability');
writeFileSync(capabilityPath, '', { mode: 0o600 });
const TEST_CAPABILITY_FD = openSync(capabilityPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
unlinkSync(capabilityPath);

after(() => {
  closeSync(TEST_CAPABILITY_FD);
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function write(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, mode === undefined ? undefined : { mode });
}

function snapshotFiles(root) {
  const output = {};
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else output[relative(root, path).split(sep).join('/')] = sha(readFileSync(path));
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (options.expectSuccess && (result.error || result.status !== 0)) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result;
}

function git(repo, args) {
  return run('git', ['-C', repo, ...args], { expectSuccess: true });
}

function commitAll(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
}

function manifestPath(vault) {
  return join(vault, '00-系统', '.index-cache', 'publish-manifest.json');
}

function writeWhitelist(repo, entries) {
  write(join(repo, 'publish-whitelist.json'), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

function writeManifest(vault, entries) {
  write(manifestPath(vault), `${JSON.stringify({ version: 1, generatedAt: '2026-08-21T00:00:00.000Z', entries }, null, 2)}\n`, 0o600);
}

function makeLaunchctlMock(root, services = {}, failures = {}) {
  const launchAgents = join(root, 'LaunchAgents');
  mkdirSync(launchAgents, { recursive: true });
  const labels = [
    'com.second-brain.clip',
    'com.second-brain.observe',
    'com.second-brain.sunday',
    'com.second-brain.watch',
  ];
  const statePath = join(root, 'launchctl-state.json');
  const initial = {
    calls: [],
    failures: { ...failures },
    services: Object.fromEntries(labels.map(label => [label, {
      loaded: services[label]?.loaded || false,
      state: services[label]?.state || (services[label]?.loaded ? 'running' : 'unloaded'),
      path: join(launchAgents, `${label}.plist`),
    }])),
  };
  write(statePath, JSON.stringify(initial));
  const mockPath = join(root, 'launchctl-mock.mjs');
  write(mockPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const statePath = process.env.BRAIN_PUBLISH_MOCK_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const [command, ...args] = process.argv.slice(2);
state.calls.push({ command, args });
const save = () => writeFileSync(statePath, JSON.stringify(state));
const failure = state.failures?.[command];
if (failure?.times > 0) {
  failure.times -= 1;
  save();
  process.stderr.write(failure.stderr + '\\n');
  process.exit(failure.status);
}
if (command === 'print') {
  const label = args[0].split('/').at(-1);
  const service = state.services[label];
  save();
  if (!service?.loaded) process.exit(113);
  process.stdout.write('path = ' + service.path + '\\nstate = ' + service.state + '\\nEnvironmentVariables = { DEEPSEEK_API_KEY = MUST_NOT_LEAK }\\n');
} else if (command === 'bootout') {
  const label = args[0].split('/').at(-1);
  state.services[label].loaded = false;
  state.services[label].state = 'unloaded';
  save();
} else if (command === 'bootstrap') {
  const path = args[1];
  const label = basename(path, '.plist');
  state.services[label].loaded = true;
  state.services[label].state = 'running';
  state.services[label].path = path;
  save();
} else {
  save();
  process.exit(2);
}
`, 0o700);
  chmodSync(mockPath, 0o700);
  return { launchAgents, mockPath, statePath };
}

function makeFixture(name, { files = { 'scripts/a.txt': 'base' }, withManifest = true, services = {}, launchctlFailures = {} } = {}) {
  const root = mkdtempSync(join(TEST_ROOT, `${name}-`));
  const repo = join(root, 'repo');
  const vault = join(root, 'vault');
  const backupRoot = join(root, 'backups');
  mkdirSync(repo);
  mkdirSync(join(vault, '00-系统', 'scripts'), { recursive: true });
  mkdirSync(join(vault, '00-系统', '.index-cache'), { recursive: true });
  mkdirSync(backupRoot, { mode: 0o700 });
  const entries = [];
  for (const [source, content] of Object.entries(files)) {
    const target = `00-系统/${source}`;
    write(join(repo, source), content);
    write(join(vault, target), content);
    entries.push({ source, target });
  }
  writeWhitelist(repo, entries);
  if (withManifest) writeManifest(vault, entries.map(entry => ({ ...entry, sha256: sha(files[entry.source]) })));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'brainkit-tests@example.invalid']);
  git(repo, ['config', 'user.name', 'brainkit tests']);
  commitAll(repo, 'test fixture baseline');
  const launchctl = makeLaunchctlMock(root, services, launchctlFailures);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    BRAIN_PUBLISH_REPO_ROOT: repo,
    BRAIN_VAULT_ROOT: vault,
    BRAIN_PUBLISH_BACKUP_ROOT: backupRoot,
    BRAIN_PUBLISH_LAUNCHAGENT_DIR: launchctl.launchAgents,
    BRAIN_PUBLISH_LAUNCHCTL: launchctl.mockPath,
    BRAIN_PUBLISH_MOCK_STATE: launchctl.statePath,
    TMPDIR: root,
  };
  return { root, repo, vault, backupRoot, entries, launchctl, env };
}

function runPublisher(fixture, args = [], env = {}) {
  return run(process.execPath, [PUBLISHER, ...args], {
    env: { ...fixture.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', TEST_CAPABILITY_FD],
  });
}

function runPublisherAsync(fixture, args = [], env = {}) {
  const child = spawn(process.execPath, [PUBLISHER, ...args], {
    env: { ...fixture.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', TEST_CAPABILITY_FD],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    child,
    done: new Promise(resolveDone => child.on('close', (status, signal) => resolveDone({ status, signal, stdout, stderr }))),
  };
}

function jsonLines(text) {
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function fileRecord(result, source) {
  return jsonLines(result.stdout).find(item => item.type === 'file' && item.path === source);
}

function onlyBackupDir(fixture) {
  const dirs = readdirSync(fixture.backupRoot).map(name => join(fixture.backupRoot, name));
  assert.equal(dirs.length, 1);
  return dirs[0];
}

function changeRepoFile(fixture, source, content, message = 'change source') {
  write(join(fixture.repo, source), content);
  commitAll(fixture.repo, message);
}

function createHook(root, body) {
  const path = join(root, `hook-${Math.random().toString(16).slice(2)}.mjs`);
  write(path, `#!/usr/bin/env node\n${body}\n`, 0o700);
  chmodSync(path, 0o700);
  return path;
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  return predicate();
}

function crashRepoNew(name = 'crash') {
  const fixture = makeFixture(name);
  const newEntries = [
    { source: 'scripts/new-1.txt', target: '00-系统/scripts/new-1.txt' },
    { source: 'scripts/new-2.txt', target: '00-系统/scripts/new-2.txt' },
  ];
  write(join(fixture.repo, newEntries[0].source), 'new one');
  write(join(fixture.repo, newEntries[1].source), 'new two');
  writeWhitelist(fixture.repo, [...fixture.entries, ...newEntries]);
  commitAll(fixture.repo, 'add repo-new files');
  const result = runPublisher(fixture, [], { BRAIN_PUBLISH_TEST_CRASH_AFTER: '1' });
  assert.equal(result.signal, 'SIGKILL');
  return { fixture, backupDir: onlyBackupDir(fixture), newEntries };
}

function crashRepoAhead(name, files = { 'scripts/a.txt': 'base' }) {
  const fixture = makeFixture(name, { files });
  for (const source of Object.keys(files)) write(join(fixture.repo, source), `changed ${source}`);
  commitAll(fixture.repo, 'change existing files');
  const result = runPublisher(fixture, [], { BRAIN_PUBLISH_TEST_CRASH_AFTER: '1' });
  assert.equal(result.signal, 'SIGKILL');
  return { fixture, backupDir: onlyBackupDir(fixture) };
}

test('1 state machine: 13 states, priority, exit codes, and JSON schema', () => {
  const baseline = { sha256: 'b' };
  const cases = [
    ['clean', { whitelisted: true, manifestEntry: baseline, repoHash: 'b', vaultHash: 'b' }],
    ['repo-ahead', { whitelisted: true, manifestEntry: baseline, repoHash: 'r', vaultHash: 'b' }],
    ['vault-ahead', { whitelisted: true, manifestEntry: baseline, repoHash: 'b', vaultHash: 'v' }],
    ['same-change', { whitelisted: true, manifestEntry: baseline, repoHash: 'r', vaultHash: 'r' }],
    ['conflict', { whitelisted: true, manifestEntry: baseline, repoHash: 'r', vaultHash: 'v' }],
    ['repo-new', { whitelisted: true, manifestEntry: null, repoHash: 'r', vaultHash: null }],
    ['vault-missing', { whitelisted: true, manifestEntry: baseline, repoHash: 'b', vaultHash: null }],
    ['repo-removed', { whitelisted: true, manifestEntry: baseline, repoHash: null, vaultHash: 'b' }],
    ['retirement-pending', { whitelisted: false, manifestEntry: baseline, repoHash: null, vaultHash: 'b' }],
    ['untracked-vault', { whitelisted: true, manifestEntry: null, repoHash: 'r', vaultHash: 'v' }],
  ];
  for (const [expected, input] of cases) assert.equal(classifyFileState(input), expected);
  assert.equal(aggregateExitCode([{ state: 'clean' }]), 0);
  assert.equal(aggregateExitCode([{ state: 'clean' }, { state: 'repo-ahead' }]), 1);
  assert.equal(aggregateExitCode([{ state: 'repo-ahead' }, { state: 'conflict' }]), 2);
  assert.equal(aggregateState(['clean', 'same-change', 'repo-new'].map(state => ({ state }))), 'repo-new');
  assert.equal(aggregateState(['repo-new', 'repo-ahead', 'uninitialized'].map(state => ({ state }))), 'uninitialized');
  assert.equal(aggregateState(['vault-ahead', 'conflict', 'entry-corrupt'].map(state => ({ state }))), 'entry-corrupt');

  const uninitialized = makeFixture('uninitialized', { withManifest: false });
  const missingResult = runPublisher(uninitialized, ['--check']);
  assert.equal(missingResult.status, 2);
  assert.equal(jsonLines(missingResult.stdout)[0].state, 'uninitialized');

  const corrupt = makeFixture('manifest-corrupt');
  write(manifestPath(corrupt.vault), '{not json');
  const corruptResult = runPublisher(corrupt, ['--check']);
  assert.equal(corruptResult.status, 2);
  assert.equal(jsonLines(corruptResult.stdout)[0].state, 'manifest-corrupt');

  const entryCorrupt = makeFixture('entry-corrupt');
  writeManifest(entryCorrupt.vault, [{ source: 'scripts/orphan.txt', target: '00-系统/scripts/orphan.txt' }]);
  const entryResult = runPublisher(entryCorrupt, ['--check']);
  assert.equal(entryResult.status, 2);
  assert.equal(jsonLines(entryResult.stdout)[0].state, 'entry-corrupt');

  const priority = makeFixture('priority', { files: { 'scripts/a.txt': 'base', 'scripts/b.txt': 'base' } });
  changeRepoFile(priority, 'scripts/a.txt', 'repo a');
  write(join(priority.vault, '00-系统', 'scripts', 'b.txt'), 'vault b');
  const priorityResult = runPublisher(priority, ['--check']);
  assert.equal(priorityResult.status, 2);
  const output = jsonLines(priorityResult.stdout);
  const summary = output.at(-1);
  assert.equal(summary.type, 'summary');
  assert.equal(summary.state, 'vault-ahead');
  for (const record of output.filter(item => item.type === 'file')) {
    assert.deepEqual(Object.keys(record).sort(), [
      'baselineHash', 'message', 'path', 'repoHash', 'state', 'target', 'type', 'vaultHash',
    ]);
  }
});

test('2 static checks reject undeclared scripts and scoped conflict copies while missing sources reach repo-removed', () => {
  const extra = makeFixture('extra-script');
  write(join(extra.repo, 'scripts', 'extra.txt'), 'undeclared');
  commitAll(extra.repo, 'add undeclared script');
  const extraResult = runPublisher(extra, ['--check']);
  assert.equal(extraResult.status, 2);
  assert.equal(jsonLines(extraResult.stderr)[0].code, 'undeclared-script');

  const repoOnly = makeFixture('repo-only-scripts');
  write(join(repoOnly.repo, 'scripts', 'publish.mjs'), '// repo-only publisher\n');
  write(join(repoOnly.repo, 'scripts', 'lib', 'launchctl.mjs'), '// repo-only shared launchctl primitive\n');
  commitAll(repoOnly.repo, 'add repo-only scripts');
  assert.equal(runPublisher(repoOnly, ['--check']).status, 0);
  assert.equal(runPublisher(repoOnly).status, 0);
  const shippedWhitelist = JSON.parse(readFileSync(join(PROJECT_ROOT, 'publish-whitelist.json'), 'utf8')).entries;
  // 21 since #12 added scripts/lib/brainkit-conf.mjs. The same lock exists in
  // test-plist-render.mjs; both are here so the publish face cannot grow
  // without it showing up in a diff.
  assert.equal(shippedWhitelist.length, 21);
  assert.equal(shippedWhitelist.some(entry => entry.source === 'scripts/lib/launchctl.mjs'), false);

  const normalNames = makeFixture('normal-numbered-names');
  write(join(normalNames.vault, '01-项目', 'note 2.1.md'), 'unrelated');
  write(join(normalNames.vault, '00-系统', 'scripts', 'report 2.1.md'), 'published directory');
  const normalNamesResult = runPublisher(normalNames, ['--check']);
  assert.equal(normalNamesResult.status, 0);

  for (const name of ['handler 2.mjs', 'handler 3.mjs', 'handler 4.mjs', 'x conflicted copy.mjs']) {
    const conflictCopy = makeFixture(`conflict-copy-${name.replaceAll(' ', '-')}`);
    write(join(conflictCopy.vault, '00-系统', 'scripts', name), 'conflict');
    const conflictCopyResult = runPublisher(conflictCopy, ['--check']);
    assert.equal(conflictCopyResult.status, 2);
    assert.equal(jsonLines(conflictCopyResult.stderr)[0].code, 'conflict-copy');
  }

  const runtimeConflict = makeFixture('runtime-conflict-copy');
  write(join(runtimeConflict.vault, '00-系统', '.index-cache', 'observe 2.lock'), 'conflict');
  const runtimeConflictResult = runPublisher(runtimeConflict, ['--check']);
  assert.equal(runtimeConflictResult.status, 2);
  assert.equal(jsonLines(runtimeConflictResult.stderr)[0].code, 'conflict-copy');

  const removed = makeFixture('repo-removed');
  unlinkSync(join(removed.repo, 'scripts', 'a.txt'));
  commitAll(removed.repo, 'remove source but retain whitelist');
  const removedResult = runPublisher(removed, ['--check']);
  assert.equal(removedResult.status, 2);
  assert.equal(fileRecord(removedResult, 'scripts/a.txt').state, 'repo-removed');
});

test('3 retirement requires committed source/whitelist removal and manual vault removal', () => {
  const fixture = makeFixture('retire');
  unlinkSync(join(fixture.repo, 'scripts', 'a.txt'));
  writeWhitelist(fixture.repo, []);
  commitAll(fixture.repo, 'retire source and whitelist entry');
  const check = runPublisher(fixture, ['--check']);
  assert.equal(check.status, 2);
  assert.equal(fileRecord(check, 'scripts/a.txt').state, 'retirement-pending');
  const refused = runPublisher(fixture, ['--retire', 'scripts/a.txt']);
  assert.equal(refused.status, 2);
  assert.equal(jsonLines(refused.stderr)[0].code, 'retire-refused');
  unlinkSync(join(fixture.vault, '00-系统', 'scripts', 'a.txt'));
  const retired = runPublisher(fixture, ['--retire', 'scripts/a.txt']);
  assert.equal(retired.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath(fixture.vault), 'utf8')).entries, []);
});

test('4 bootstrap uses vault baselines for clean, drifted, and missing targets without writing scripts', () => {
  const fixture = makeFixture('bootstrap', { withManifest: false });
  const scriptsRoot = join(fixture.vault, '00-系统', 'scripts');
  const before = snapshotFiles(scriptsRoot);
  const bootstrapped = runPublisher(fixture, ['--bootstrap']);
  assert.equal(bootstrapped.status, 0);
  assert.deepEqual(snapshotFiles(scriptsRoot), before);
  assert.ok(existsSync(manifestPath(fixture.vault)));
  const clean = runPublisher(fixture, ['--check']);
  assert.equal(clean.status, 0);
  assert.equal(fileRecord(clean, 'scripts/a.txt').state, 'clean');

  const next = { source: 'scripts/new.txt', target: '00-系统/scripts/new.txt' };
  write(join(fixture.repo, next.source), 'new');
  writeWhitelist(fixture.repo, [...fixture.entries, next]);
  commitAll(fixture.repo, 'add new source');
  const repoNew = runPublisher(fixture, ['--check']);
  assert.equal(repoNew.status, 1);
  assert.equal(fileRecord(repoNew, next.source).state, 'repo-new');

  const drifted = makeFixture('bootstrap-drifted', { withManifest: false });
  changeRepoFile(drifted, 'scripts/a.txt', 'repo changed');
  const driftedScriptsRoot = join(drifted.vault, '00-系统', 'scripts');
  const driftedBefore = snapshotFiles(driftedScriptsRoot);
  const driftedBootstrap = runPublisher(drifted, ['--bootstrap']);
  assert.equal(driftedBootstrap.status, 1);
  assert.deepEqual(snapshotFiles(driftedScriptsRoot), driftedBefore);
  assert.equal(JSON.parse(readFileSync(manifestPath(drifted.vault), 'utf8')).entries[0].sha256, sha('base'));
  assert.deepEqual(
    jsonLines(driftedBootstrap.stdout).find(item => item.type === 'warning'),
    {
      type: 'warning',
      code: 'bootstrap-drift',
      target: '00-系统/scripts/a.txt',
      message: 'repo differs from vault; baseline uses vault content, file will show repo-ahead',
    },
  );
  assert.equal(fileRecord(runPublisher(drifted, ['--check']), 'scripts/a.txt').state, 'repo-ahead');

  const missing = makeFixture('bootstrap-missing', { withManifest: false });
  unlinkSync(join(missing.vault, '00-系统', 'scripts', 'a.txt'));
  const missingBootstrap = runPublisher(missing, ['--bootstrap']);
  assert.equal(missingBootstrap.status, 1);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath(missing.vault), 'utf8')).entries, []);
  assert.deepEqual(
    jsonLines(missingBootstrap.stdout).find(item => item.type === 'warning'),
    {
      type: 'warning',
      code: 'bootstrap-vault-missing',
      target: '00-系统/scripts/a.txt',
      message: 'vault target is missing; baseline entry skipped, file will show repo-new',
    },
  );
  assert.equal(fileRecord(runPublisher(missing, ['--check']), 'scripts/a.txt').state, 'repo-new');

  const sourceMissing = makeFixture('bootstrap-source-missing', { withManifest: false });
  unlinkSync(join(sourceMissing.repo, 'scripts', 'a.txt'));
  commitAll(sourceMissing.repo, 'remove source');
  const sourceMissingBootstrap = runPublisher(sourceMissing, ['--bootstrap']);
  assert.equal(sourceMissingBootstrap.status, 2);
  assert.deepEqual(
    jsonLines(sourceMissingBootstrap.stdout).find(item => item.type === 'warning'),
    {
      type: 'warning',
      code: 'bootstrap-drift',
      target: '00-系统/scripts/a.txt',
      message: 'repo source is missing; baseline uses vault content, file will show repo-removed',
    },
  );
  assert.equal(fileRecord(runPublisher(sourceMissing, ['--check']), 'scripts/a.txt').state, 'repo-removed');

  const bothMissing = makeFixture('bootstrap-both-missing', { withManifest: false });
  unlinkSync(join(bothMissing.repo, 'scripts', 'a.txt'));
  unlinkSync(join(bothMissing.vault, '00-系统', 'scripts', 'a.txt'));
  commitAll(bothMissing.repo, 'remove source');
  const bothMissingBootstrap = runPublisher(bothMissing, ['--bootstrap']);
  assert.equal(bothMissingBootstrap.status, 2);
  assert.deepEqual(
    jsonLines(bothMissingBootstrap.stdout).find(item => item.type === 'warning'),
    {
      type: 'warning',
      code: 'bootstrap-vault-missing',
      target: '00-系统/scripts/a.txt',
      message: 'repo source and vault target are missing; baseline entry skipped, file will show repo-removed',
    },
  );
  assert.equal(fileRecord(runPublisher(bothMissing, ['--check']), 'scripts/a.txt').state, 'repo-removed');
});

test('5 repo-new crash leaves old manifest and recover applies tombstones', () => {
  const { fixture, backupDir, newEntries } = crashRepoNew('repo-new-crash');
  const manifest = JSON.parse(readFileSync(manifestPath(fixture.vault), 'utf8'));
  assert.equal(manifest.entries.length, 1);
  assert.ok(existsSync(join(fixture.vault, newEntries[0].target)));
  assert.ok(!existsSync(join(fixture.vault, newEntries[1].target)));
  const recovery = JSON.parse(readFileSync(join(backupDir, 'recovery.json'), 'utf8'));
  assert.ok(recovery.entries.every(entry => entry.tombstone));
  const recovered = runPublisher(fixture, ['--recover', backupDir]);
  assert.equal(recovered.status, 0);
  assert.ok(!existsSync(join(fixture.vault, newEntries[0].target)));
  assert.ok(!existsSync(join(fixture.vault, newEntries[1].target)));
  assert.equal(JSON.parse(readFileSync(manifestPath(fixture.vault), 'utf8')).entries.length, 1);
  const repeated = runPublisher(fixture, ['--recover', backupDir]);
  assert.equal(repeated.status, 0);
  assert.ok(!existsSync(join(fixture.vault, newEntries[0].target)));
});

test('6 recover rejects tampering, symlinks, wrong owner/mode, escapes, and third values', () => {
  {
    const { fixture, backupDir } = crashRepoNew('attack-hash');
    const recovery = JSON.parse(readFileSync(join(backupDir, 'recovery.json'), 'utf8'));
    write(join(backupDir, recovery.manifest.backupFile), 'tampered');
    const result = runPublisher(fixture, ['--recover', backupDir]);
    assert.equal(result.status, 2);
    assert.equal(jsonLines(result.stderr)[0].code, 'backup-hash-mismatch');
  }
  {
    const { fixture, backupDir } = crashRepoNew('attack-symlink');
    const link = join(fixture.root, 'backup-link');
    symlinkSync(backupDir, link);
    const result = runPublisher(fixture, ['--recover', link]);
    assert.equal(result.status, 2);
    assert.equal(jsonLines(result.stderr)[0].code, 'invalid-backup');
  }
  {
    const { fixture, backupDir } = crashRepoNew('attack-owner-mode');
    assert.throws(
      () => validateBackupDirectory(backupDir, {
        repoRoot: fixture.repo,
        vaultRoot: fixture.vault,
        expectedUid: (process.getuid?.() ?? 0) + 1,
      }),
      /owner mismatch/,
    );
    chmodSync(backupDir, 0o755);
    const result = runPublisher(fixture, ['--recover', backupDir]);
    assert.equal(result.status, 2);
    assert.equal(jsonLines(result.stderr)[0].code, 'invalid-backup');
  }
  {
    const { fixture, backupDir } = crashRepoNew('attack-escape');
    const path = join(backupDir, 'recovery.json');
    const recovery = JSON.parse(readFileSync(path, 'utf8'));
    recovery.entries[0].target = '../escape';
    write(path, `${JSON.stringify(recovery, null, 2)}\n`, 0o600);
    const result = runPublisher(fixture, ['--recover', backupDir]);
    assert.equal(result.status, 2);
    assert.equal(jsonLines(result.stderr)[0].code, 'invalid-path');
  }
  {
    const { fixture, backupDir, newEntries } = crashRepoNew('attack-third');
    write(join(fixture.vault, newEntries[0].target), 'third value');
    const result = runPublisher(fixture, ['--recover', backupDir]);
    assert.equal(result.status, 2);
    assert.equal(jsonLines(result.stderr)[0].code, 'third-value');
  }
});

test('7 pre-commit revalidation rolls back target drift and source-parent symlink swaps', () => {
  {
    const fixture = makeFixture('target-drift');
    changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
    const target = join(fixture.vault, '00-系统', 'scripts', 'a.txt');
    const hook = createHook(fixture.root, `
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'before-commit') writeFileSync(process.env.TEST_MUTATE_TARGET, 'external drift');
`);
    const result = runPublisher(fixture, [], {
      BRAIN_PUBLISH_TEST_HOOK: hook,
      TEST_MUTATE_TARGET: target,
    });
    assert.equal(result.status, 2);
    assert.equal(readFileSync(target, 'utf8'), 'base');
    assert.equal(JSON.parse(readFileSync(manifestPath(fixture.vault), 'utf8')).entries[0].sha256, sha('base'));
  }
  {
    const fixture = makeFixture('source-symlink', { files: { 'scripts/group/a.txt': 'base' } });
    changeRepoFile(fixture, 'scripts/group/a.txt', 'repo changed');
    const group = join(fixture.repo, 'scripts', 'group');
    const moved = join(fixture.repo, 'scripts', 'group-real');
    const hook = createHook(fixture.root, `
import { renameSync, symlinkSync } from 'node:fs';
if (process.argv[2] === 'before-commit') {
  renameSync(process.env.TEST_SOURCE_GROUP, process.env.TEST_SOURCE_MOVED);
  symlinkSync(process.env.TEST_SOURCE_MOVED, process.env.TEST_SOURCE_GROUP);
}
`);
    const result = runPublisher(fixture, [], {
      BRAIN_PUBLISH_TEST_HOOK: hook,
      TEST_SOURCE_GROUP: group,
      TEST_SOURCE_MOVED: moved,
    });
    assert.equal(result.status, 2);
    assert.equal(readFileSync(join(fixture.vault, '00-系统', 'scripts', 'group', 'a.txt'), 'utf8'), 'base');
    assert.equal(JSON.parse(readFileSync(manifestPath(fixture.vault), 'utf8')).entries[0].sha256, sha('base'));
  }
});

test('8 service restore excludes disabled agents and never persists raw environment output', () => {
  const fixture = makeFixture('services', {
    services: {
      'com.second-brain.clip': { loaded: true },
      'com.second-brain.sunday': { loaded: true },
    },
  });
  changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
  const result = runPublisher(fixture);
  assert.equal(result.status, 0);
  const state = JSON.parse(readFileSync(fixture.launchctl.statePath, 'utf8'));
  const bootstrapped = state.calls
    .filter(call => call.command === 'bootstrap')
    .map(call => call.args[1]);
  assert.deepEqual(bootstrapped.sort(), [
    join(fixture.launchctl.launchAgents, 'com.second-brain.clip.plist'),
    join(fixture.launchctl.launchAgents, 'com.second-brain.sunday.plist'),
  ].sort());
  const backupDir = onlyBackupDir(fixture);
  const persisted = `${result.stdout}\n${result.stderr}\n${readFileSync(join(backupDir, 'recovery.json'), 'utf8')}`;
  assert.doesNotMatch(persisted, /EnvironmentVariables|MUST_NOT_LEAK/);
});

test('9 publish.lock permits one publisher and rejects the contender', async () => {
  const fixture = makeFixture('lock');
  changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
  const release = join(fixture.root, 'release-lock-hook');
  const hook = createHook(fixture.root, `
import { existsSync } from 'node:fs';
if (process.argv[2] === 'after-lock') {
  const until = Date.now() + 5000;
  while (!existsSync(process.env.TEST_LOCK_RELEASE) && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
`);
  const first = runPublisherAsync(fixture, [], {
    BRAIN_PUBLISH_TEST_HOOK: hook,
    TEST_LOCK_RELEASE: release,
  });
  const lock = join(fixture.vault, '00-系统', '.index-cache', 'publish.lock');
  const deadline = Date.now() + 3000;
  while (!existsSync(lock) && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.ok(existsSync(lock));
  const second = runPublisher(fixture);
  assert.equal(second.status, 2);
  assert.equal(jsonLines(second.stderr)[0].code, 'lock-contended');
  write(release, 'release');
  const firstResult = await first.done;
  assert.equal(firstResult.status, 0, firstResult.stderr);
});

test('10 stale publish.lock takeover admits only one contender', async () => {
  const fixture = makeFixture('stale-lock');
  changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
  const barrier = join(fixture.root, 'stale-barrier');
  const release = join(barrier, 'release');
  mkdirSync(barrier);
  const hook = createHook(fixture.root, `
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const stage = process.argv[2];
const role = process.env.BRAIN_PUBLISH_TEST_STALE_ROLE;
const barrier = process.env.BRAIN_PUBLISH_TEST_STALE_BARRIER;
const waitFor = path => {
  const until = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
};
if (stage === 'after-lock') {
  mkdirSync(join(barrier, 'locked-' + role));
  waitFor(join(barrier, 'release'));
}
`);
  write(join(fixture.vault, '00-系统', '.index-cache', 'publish.lock'), `${JSON.stringify({ pid: 2147483647 })}\n`, 0o600);

  const b = runPublisherAsync(fixture, [], {
    BRAIN_PUBLISH_TEST_HOOK: hook,
    BRAIN_PUBLISH_TEST_STALE_BARRIER: barrier,
    BRAIN_PUBLISH_TEST_STALE_ROLE: 'b',
  });
  assert.ok(await waitUntil(() => existsSync(join(barrier, 'b-read-stale'))));
  const a = runPublisherAsync(fixture, [], {
    BRAIN_PUBLISH_TEST_HOOK: hook,
    BRAIN_PUBLISH_TEST_STALE_BARRIER: barrier,
    BRAIN_PUBLISH_TEST_STALE_ROLE: 'a',
  });
  await waitUntil(() => readdirSync(barrier).filter(name => name.startsWith('locked-')).length >= 2, 1500);
  const lockedCount = readdirSync(barrier).filter(name => name.startsWith('locked-')).length;
  write(release, 'release');
  const results = await Promise.all([a.done, b.done]);

  assert.equal(lockedCount, 1, 'only one stale-lock contender may cross after-lock');
  assert.deepEqual(results.map(result => result.status).sort(), [0, 2]);
});

test('11 recover binds ordinary backup content to beforeHash', () => {
  const { fixture, backupDir } = crashRepoAhead('forged-backup');
  const recoveryPath = join(backupDir, 'recovery.json');
  const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'));
  const entry = recovery.entries[0];
  write(join(backupDir, entry.backupFile), 'forged payload', 0o600);
  entry.backupSha256 = sha('forged payload');
  write(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, 0o600);

  const result = runPublisher(fixture, ['--recover', backupDir]);
  assert.equal(result.status, 2);
  assert.equal(jsonLines(result.stderr)[0].code, 'invalid-recovery');
});

test('12 recover binds manifest backup content to beforeHash', () => {
  const { fixture, backupDir } = crashRepoNew('forged-manifest');
  const recoveryPath = join(backupDir, 'recovery.json');
  const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'));
  write(join(backupDir, recovery.manifest.backupFile), '{"version":1,"entries":[]}\n', 0o600);
  recovery.manifest.backupSha256 = sha('{"version":1,"entries":[]}\n');
  write(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, 0o600);

  const result = runPublisher(fixture, ['--recover', backupDir]);
  assert.equal(result.status, 2);
  assert.equal(jsonLines(result.stderr)[0].code, 'invalid-recovery');
});

test('13 recover binds repoRoot and vaultRoot to current realpaths', () => {
  for (const field of ['repoRoot', 'vaultRoot']) {
    const { fixture, backupDir } = crashRepoNew(`forged-${field}`);
    const recoveryPath = join(backupDir, 'recovery.json');
    const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'));
    recovery[field] = fixture.root;
    write(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, 0o600);

    const result = runPublisher(fixture, ['--recover', backupDir]);
    assert.equal(result.status, 2);
    assert.equal(jsonLines(result.stderr)[0].code, 'invalid-recovery');
  }
});

test('14 recover requires exact source-target mappings', () => {
  const { fixture, backupDir } = crashRepoAhead('forged-mapping', {
    'scripts/a.txt': 'base a',
    'scripts/b.txt': 'base b',
  });
  const recoveryPath = join(backupDir, 'recovery.json');
  const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'));
  [recovery.entries[0].source, recovery.entries[1].source] = [recovery.entries[1].source, recovery.entries[0].source];
  write(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, 0o600);

  const result = runPublisher(fixture, ['--recover', backupDir]);
  assert.equal(result.status, 2);
  assert.equal(jsonLines(result.stderr)[0].code, 'invalid-recovery');
});

test('15 recover requires transactionId and createdAt metadata', () => {
  for (const field of ['transactionId', 'createdAt']) {
    const { fixture, backupDir } = crashRepoNew(`missing-${field}`);
    const recoveryPath = join(backupDir, 'recovery.json');
    const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'));
    delete recovery[field];
    write(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, 0o600);

    const result = runPublisher(fixture, ['--recover', backupDir]);
    assert.equal(result.status, 2);
    assert.equal(jsonLines(result.stderr)[0].code, 'invalid-recovery');
  }
});

test('16 recover rejects a symlink in a backup path component', () => {
  const { fixture, backupDir } = crashRepoNew('backup-component-symlink');
  const files = join(backupDir, 'files');
  const outside = join(fixture.root, 'outside-backup-files');
  renameSync(files, outside);
  symlinkSync(outside, files);

  const result = runPublisher(fixture, ['--recover', backupDir]);
  assert.equal(result.status, 2);
  assert.equal(jsonLines(result.stderr)[0].code, 'invalid-backup');
});

test('17 production mode rejects launchctl path injection', () => {
  const fixture = makeFixture('production-launchctl-injection');
  changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
  const result = runPublisher(fixture, [], { NODE_ENV: 'production' });
  assert.equal(result.status, 2);
  assert.equal(jsonLines(result.stderr)[0].code, 'unsafe-test-override');

  const widened = runPublisher(fixture, ['--check'], {
    TMPDIR: '/',
    BRAIN_PUBLISH_LAUNCHCTL: '/bin/true',
  });
  assert.equal(widened.status, 2);
  assert.equal(jsonLines(widened.stderr)[0].code, 'unsafe-test-override');
});

test('18 backup creation rejects repo, vault, and symlink roots', () => {
  for (const field of ['repo', 'vault']) {
    const fixture = makeFixture(`backup-root-${field}`);
    changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
    const result = runPublisher(fixture, [], { BRAIN_PUBLISH_BACKUP_ROOT: fixture[field] });
    assert.equal(result.status, 2);
    assert.equal(jsonLines(result.stderr)[0].code, 'invalid-backup');
  }

  const fixture = makeFixture('backup-root-symlink');
  changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
  const realRoot = join(fixture.root, 'safe-backup-root');
  const linkRoot = join(fixture.root, 'backup-root-link');
  mkdirSync(realRoot, { mode: 0o700 });
  symlinkSync(realRoot, linkRoot);
  const result = runPublisher(fixture, [], { BRAIN_PUBLISH_BACKUP_ROOT: linkRoot });
  assert.equal(result.status, 2);
  assert.equal(jsonLines(result.stderr)[0].code, 'invalid-backup');
});

test('19 every mutating and check command acquires publish.lock first', () => {
  for (const args of [[], ['--check'], ['--bootstrap'], ['--retire', 'scripts/a.txt'], ['--recover', '/invalid']]) {
    const fixture = makeFixture(`lock-first-${args[0] || 'publish'}`);
    write(
      join(fixture.vault, '00-系统', '.index-cache', 'publish.lock'),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      0o600,
    );
    const result = runPublisher(fixture, args);
    assert.equal(result.status, 2);
    assert.equal(jsonLines(result.stderr)[0].code, 'lock-contended');
  }
});

test('20 failed atomic rename removes its temporary file', () => {
  const fixture = makeFixture('atomic-temp-cleanup');
  changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
  const target = join(fixture.vault, '00-系统', 'scripts', 'a.txt');
  const hook = createHook(fixture.root, `
import { mkdirSync, rmSync } from 'node:fs';
if (process.argv[2] === 'before-write') {
  rmSync(process.env.TEST_ATOMIC_TARGET);
  mkdirSync(process.env.TEST_ATOMIC_TARGET);
}
`);
  const result = runPublisher(fixture, [], {
    BRAIN_PUBLISH_TEST_HOOK: hook,
    TEST_ATOMIC_TARGET: target,
  });
  assert.equal(result.status, 2);
  assert.deepEqual(readdirSync(dirname(target)).filter(name => name.endsWith('.tmp')), []);
});

test('21 failed backup creation reports and removes the partial directory', () => {
  const fixture = makeFixture('partial-backup-cleanup');
  changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
  const hook = createHook(fixture.root, `
if (process.argv[2] === 'after-backup-dir') process.exit(2);
`);
  const result = runPublisher(fixture, [], { BRAIN_PUBLISH_TEST_HOOK: hook });
  const error = jsonLines(result.stderr)[0];
  assert.equal(result.status, 2);
  assert.equal(error.code, 'test-hook-error');
  assert.ok(error.backupDir);
  assert.equal(existsSync(error.backupDir), false);
});

test('22 test hooks require the inherited capability before execution', () => {
  const fixture = makeFixture('test-hook-capability');
  const marker = join(fixture.root, 'hook-executed');
  const hook = createHook(fixture.root, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'executed');
`);
  const result = run(process.execPath, [PUBLISHER, '--check'], {
    env: { ...fixture.env, BRAIN_PUBLISH_TEST_HOOK: hook },
    stdio: ['ignore', 'pipe', 'pipe', 'ignore'],
  });
  assert.equal(result.status, 2);
  assert.equal(jsonLines(result.stderr)[0].code, 'unsafe-test-override');
  assert.equal(existsSync(marker), false);
});

test('23 recover rejects content that no longer matches the authorization ledger', () => {
  const { fixture, backupDir } = crashRepoAhead('altered-recovery');
  const recoveryPath = join(backupDir, 'recovery.json');
  const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'));
  const payload = 'altered recovery payload';
  const entry = recovery.entries[0];
  write(join(backupDir, entry.backupFile), payload, 0o600);
  entry.beforeHash = sha(payload);
  entry.backupSha256 = entry.beforeHash;
  write(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, 0o600);

  const result = runPublisher(fixture, ['--recover', backupDir]);
  assert.equal(result.status, 2);
  assert.equal(jsonLines(result.stderr)[0].code, 'invalid-recovery');
});

test('24 vault pointer supplies the root and rejects missing or unsafe files', () => {
  const fixture = makeFixture('vault pointer');
  const runWithPointer = pointer => {
    const env = { ...fixture.env, BRAIN_PUBLISH_CONF: pointer };
    delete env.BRAIN_VAULT_ROOT;
    return run(process.execPath, [PUBLISHER, '--check'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', TEST_CAPABILITY_FD],
    });
  };

  const pointer = join(fixture.root, 'brainkit.conf');
  write(pointer, `vault=${JSON.stringify(fixture.vault)}\n`, 0o600);
  assert.equal(runWithPointer(pointer).status, 0);

  const shared = join(fixture.root, 'brainkit-shared.conf');
  write(shared, [
    'schema=1',
    `vault=${JSON.stringify(fixture.vault)}`,
    `routing_json=${JSON.stringify(join(fixture.root, 'vault-routing.json'))}`,
    `memory_dir=${JSON.stringify(join(fixture.root, 'memory'))}`,
    '',
  ].join('\n'), 0o600);
  assert.equal(runWithPointer(shared).status, 0);

  const unknownKey = join(fixture.root, 'brainkit-unknown.conf');
  write(unknownKey, `vault=${JSON.stringify(fixture.vault)}\nclip_env=/tmp/clip.env\n`, 0o600);
  const unknown = jsonLines(runWithPointer(unknownKey).stderr)[0];
  assert.equal(unknown.code, 'invalid-vault-pointer');
  assert.match(unknown.message, /not allowlisted.*clip_env/);

  assert.equal(runPublisher(fixture, ['--check'], { BRAIN_PUBLISH_CONF: join(fixture.root, 'ignored.conf') }).status, 0);

  const missingPointer = join(fixture.root, 'missing.conf');
  const missing = runWithPointer(missingPointer);
  assert.equal(missing.status, 2);
  assert.equal(jsonLines(missing.stderr)[0].code, 'missing-vault-root');
  assert.equal(jsonLines(missing.stderr)[0].message, `BRAIN_VAULT_ROOT unset and no vault pointer at ${missingPointer}`);

  chmodSync(pointer, 0o644);
  const wrongMode = jsonLines(runWithPointer(pointer).stderr)[0];
  assert.equal(wrongMode.code, 'invalid-vault-pointer');
  assert.match(wrongMode.message, /mode must be 0600/);
  chmodSync(pointer, 0o600);

  const link = join(fixture.root, 'brainkit-link.conf');
  symlinkSync(pointer, link);
  const symlink = jsonLines(runWithPointer(link).stderr)[0];
  assert.equal(symlink.code, 'invalid-vault-pointer');
  assert.match(symlink.message, /regular non-symlink file/);

  write(pointer, 'vault=relative/path\n', 0o600);
  assert.equal(jsonLines(runWithPointer(pointer).stderr)[0].code, 'invalid-vault-pointer');
});

test('25 bootout and bootstrap retry launchctl error 5 but surface permission failures immediately', () => {
  const eio = { times: 1, status: 5, stderr: 'failed: 5: Input/output error' };
  const fixture = makeFixture('launchctl-retry', {
    services: { 'com.second-brain.clip': { loaded: true } },
    launchctlFailures: { bootout: { ...eio }, bootstrap: { ...eio } },
  });
  changeRepoFile(fixture, 'scripts/a.txt', 'repo changed');
  assert.equal(runPublisher(fixture).status, 0);
  const calls = JSON.parse(readFileSync(fixture.launchctl.statePath, 'utf8')).calls;
  assert.equal(calls.filter(call => call.command === 'bootout').length, 2);
  assert.equal(calls.filter(call => call.command === 'bootstrap').length, 2);

  const denied = makeFixture('launchctl-denied', {
    services: { 'com.second-brain.clip': { loaded: true } },
    launchctlFailures: { bootout: { times: 99, status: 1, stderr: 'Boot-out failed: 1: Operation not permitted' } },
  });
  changeRepoFile(denied, 'scripts/a.txt', 'repo changed');
  const refused = runPublisher(denied);
  assert.equal(refused.status, 2);
  const error = jsonLines(refused.stderr)[0];
  assert.equal(error.code, 'launchctl-error');
  assert.match(error.message, /bootout failed for com\.second-brain\.clip.*Operation not permitted/);
  const deniedCalls = JSON.parse(readFileSync(denied.launchctl.statePath, 'utf8')).calls;
  assert.equal(deniedCalls.filter(call => call.command === 'bootout').length, 1);
});

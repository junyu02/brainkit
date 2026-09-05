#!/usr/bin/env node
// Black-box regression suite for the brain-write CLI.
// Fixtures are intentionally retained under os.tmpdir(); no test deletes files.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER = resolve(HERE, '..', 'scripts', 'cli', 'brain-write.mjs');
const HOT_HEADER = '## 🔥 热记忆（容量 40，按 type 配额+FIFO）';
const DOMAIN_INDEXES = [
  'MEMORY-experience.md',
  'MEMORY-knowledge.md',
  'MEMORY-project.md',
  'MEMORY-persona.md',
  'MEMORY-archive.md',
  'MEMORY-notes.md',
];

const ROUTING_FIXTURE = {
  schema: 'vault-routing-v2',
  routes: [
    { type: 'experience', path: '03-经验/', scope: 'global' },
    { type: 'project', path: '01-项目/{project-name}/', scope: 'project' },
    { type: 'reference', path: '02-知识/', scope: 'global' },
    { type: 'user-profile', path: '05-persona/', scope: 'global' },
    { type: 'note', path: '07-随笔/', scope: 'global' },
    { type: 'observation', path: '08-观察/', scope: 'global' },
    { type: 'weekly', path: '09-周报/', scope: 'global' },
  ],
  inbox_root: '99-inbox/',
  inbox_subfolders: {
    '01-项目/': '99-inbox/projects/',
    '02-知识/': '99-inbox/knowledge/',
    '03-经验/': '99-inbox/experience/',
    '05-persona/': '99-inbox/persona/',
    '07-随笔/': '99-inbox/notes/',
    '08-观察/': '99-inbox/observations/',
    '09-周报/': '99-inbox/weekly/',
  },
  section_policies: {
    '01-项目/': {
      policy: 'bind_to_project',
      requires_subfolder: true,
      subfolder_source: '00-系统/.project-map.json',
    },
    '02-知识/': {
      policy: 'propose',
      requires_subfolder: true,
      allow_existing_subfolders: true,
      new_subfolder_policy: 'propose',
    },
    '03-经验/': {
      policy: 'deny_new_subfolder',
      requires_subfolder: true,
      allowed_subfolders: ['AI工具'],
      new_subfolder_policy: 'deny',
    },
    '05-persona/': { policy: 'allow_root', requires_subfolder: false },
    '07-随笔/': { policy: 'allow_root', requires_subfolder: false },
    '08-观察/': {
      policy: 'allow_month',
      requires_subfolder: true,
      subfolder_pattern: '^(chronicle-)?\\d{4}-\\d{2}$',
    },
    '09-周报/': { policy: 'allow_root', requires_subfolder: false },
  },
};

function makeFixtureVault() {
  const root = mkdtempSync(join(tmpdir(), 'brain-write-suite-'));
  const vault = join(root, 'vault');
  const memory = join(root, 'memory');
  const routing = join(root, 'routing.json');
  const directories = [
    join(vault, '00-系统', '.index-cache'),
    join(vault, '00-系统', 'logs'),
    join(vault, '01-项目', 'test-project'),
    join(vault, '02-知识', '测试知识'),
    join(vault, '03-经验', 'AI工具'),
    join(vault, '04-对话'),
    join(vault, '05-persona'),
    join(vault, '06-归档'),
    join(vault, '07-随笔'),
    join(vault, '08-观察', '2026-08'),
    join(vault, '09-周报'),
    join(vault, '99-inbox', 'projects'),
    join(vault, '99-inbox', 'knowledge'),
    join(vault, '99-inbox', 'experience'),
    join(vault, '99-inbox', 'sessions'),
    join(vault, '99-inbox', 'persona'),
    join(vault, '99-inbox', 'notes'),
    join(vault, '99-inbox', 'observations'),
    join(vault, '99-inbox', 'weekly'),
    memory,
  ];
  for (const path of directories) mkdirSync(path, { recursive: true });

  writeFileSync(join(vault, '00-系统', '.project-map.json'), JSON.stringify({
    mappings: [{
      localPath: join(root, 'test-project'),
      vaultDir: '01-项目/test-project',
    }],
  }, null, 2) + '\n');
  writeFileSync(routing, JSON.stringify(ROUTING_FIXTURE, null, 2) + '\n');
  writeFileSync(join(memory, 'MEMORY.md'),
    '# Memory Index\n\n' + HOT_HEADER + '\n\n<auto-maintained>\n\n## 📚 领域索引（按需读取）\n');
  for (const name of DOMAIN_INDEXES) {
    writeFileSync(join(memory, name), '# ' + name + '\n');
  }

  return {
    root,
    vault,
    memory,
    routing,
    ledger: join(vault, '00-系统', 'logs', 'brain-write-ledger.jsonl'),
    lock: join(vault, '00-系统', '.index-cache', 'brain-write.lock'),
    env: {
      BRAIN_VAULT_ROOT: vault,
      BRAIN_ROUTING_JSON: routing,
      BRAIN_MEMORY_DIR: memory,
      BRAIN_LOCK_WAIT_MS: '150',
    },
  };
}

function runCli(fixture, args, options = {}) {
  assert.ok(fixture.root.startsWith(tmpdir() + sep), 'fixture must live under os.tmpdir()');
  assert.deepEqual(
    [fixture.env.BRAIN_VAULT_ROOT, fixture.env.BRAIN_ROUTING_JSON, fixture.env.BRAIN_MEMORY_DIR],
    [fixture.vault, fixture.routing, fixture.memory],
  );
  const argv = args.includes('--source') ? [...args] : [...args, '--source', 'codex'];
  const result = spawnSync(process.execPath, [WRITER, ...argv], {
    input: options.body === undefined ? 'fixture body' : options.body,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}), ...fixture.env },
    timeout: 5_000,
  });
  assert.equal(result.error, undefined, result.error && result.error.message);
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    signal: result.signal,
  };
}

function parseJson(text, channel) {
  assert.notEqual(text.trim(), '', channel + ' must contain JSON');
  return JSON.parse(text);
}

function assertReceipt(result, fixture, redirected = false) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const receipt = parseJson(result.stdout, 'stdout');
  for (const field of ['status', 'path', 'inbox_redirect']) {
    assert.ok(Object.hasOwn(receipt, field), 'missing receipt field: ' + field);
  }
  assert.equal(receipt.status, 'ok');
  assert.equal(typeof receipt.path, 'string');
  assert.ok(resolve(receipt.path).startsWith(resolve(fixture.vault) + sep), receipt.path);
  if (redirected) {
    assert.equal(typeof receipt.inbox_redirect, 'object');
    assert.equal(typeof receipt.inbox_redirect.from, 'string');
    assert.equal(typeof receipt.inbox_redirect.to, 'string');
    assert.equal(typeof receipt.inbox_redirect.reason, 'string');
  } else {
    assert.equal(receipt.inbox_redirect, null);
  }
  return receipt;
}

function ledgerEntries(fixture) {
  if (!existsSync(fixture.ledger)) return [];
  return readFileSync(fixture.ledger, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function hotLines(fixture) {
  const lines = readFileSync(join(fixture.memory, 'MEMORY.md'), 'utf8').split('\n');
  const start = lines.indexOf(HOT_HEADER);
  assert.notEqual(start, -1);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, next === -1 ? lines.length : next)
    .filter(line => line.startsWith('- ['));
}

function seedFullHotSection(fixture) {
  const entries = [];
  for (let index = 0; index < 40; index++) {
    const title = 'capacity-seed-' + index;
    const note = join(fixture.vault, '07-随笔', 'seed-' + index + '.md');
    writeFileSync(note, '---\nname: ' + title + '\n---\n\nseed\n');
    entries.push('- [' + title + '](' + relative(fixture.memory, note) + ') — seed');
  }
  writeFileSync(join(fixture.memory, 'MEMORY.md'),
    '# Memory Index\n\n' + HOT_HEADER + '\n\n' + entries.join('\n')
      + '\n\n## 📚 领域索引（按需读取）\n');
}

describe('brain-write CLI regression suite', { concurrency: false }, () => {
  test('00 isolation probe writes only to the three-variable temp fixture', () => {
    const fixture = makeFixtureVault();
    const result = runCli(fixture, [
      '--type', 'note',
      '--title', 'isolation-probe',
      '--description', 'isolation',
    ]);
    const receipt = assertReceipt(result, fixture);
    assert.equal(receipt.path, join(fixture.vault, '07-随笔', 'isolation-probe.md'));
    assert.ok(existsSync(receipt.path));
  });

  const routeCases = [
    {
      type: 'experience',
      args: ['--type', 'experience', '--subfolder', 'AI工具'],
      directory: ['03-经验', 'AI工具'],
    },
    {
      type: 'project',
      args: ['--type', 'project', '--project', 'test-project'],
      directory: ['01-项目', 'test-project'],
    },
    {
      type: 'reference',
      args: ['--type', 'reference', '--subfolder', '测试知识'],
      directory: ['02-知识', '测试知识'],
    },
    {
      type: 'user-profile',
      args: ['--type', 'user-profile'],
      directory: ['05-persona'],
    },
    {
      type: 'note',
      args: ['--type', 'note'],
      directory: ['07-随笔'],
    },
    {
      type: 'weekly',
      args: ['--type', 'weekly'],
      directory: ['09-周报'],
    },
    {
      type: 'observation',
      args: ['--type', 'observation', '--subfolder', '2026-08'],
      directory: ['08-观察', '2026-08'],
    },
  ];

  for (const scenario of routeCases) {
    test('A route ' + scenario.type + ' to its current section', () => {
      const fixture = makeFixtureVault();
      const title = 'route-' + scenario.type;
      const result = runCli(fixture, [
        ...scenario.args,
        '--title', title,
        '--description', 'route fixture',
      ]);
      const receipt = assertReceipt(result, fixture);
      assert.equal(receipt.path, join(fixture.vault, ...scenario.directory, title + '.md'));
      assert.ok(existsSync(receipt.path));

      if (scenario.type === 'observation') {
        assert.match(readFileSync(receipt.path, 'utf8'), /^durability: ephemeral$/m);
        assert.equal(hotLines(fixture).some(line => line.includes(title)), false);
        for (const name of DOMAIN_INDEXES) {
          assert.doesNotMatch(readFileSync(join(fixture.memory, name), 'utf8'), new RegExp(title));
        }
        assert.equal(existsSync(join(fixture.vault, '00-系统', '.index-cache', 'intent-map.json')), false);
      }
    });
  }

  const redirectCases = [
    {
      name: 'unregistered project',
      args: ['--type', 'project', '--project', 'missing-project'],
      inbox: ['99-inbox', 'projects'],
    },
    {
      name: 'non-whitelisted experience subfolder',
      args: ['--type', 'experience', '--subfolder', '未批准分类'],
      inbox: ['99-inbox', 'experience'],
    },
    {
      name: 'missing knowledge subfolder',
      args: ['--type', 'reference', '--subfolder', '不存在知识类'],
      inbox: ['99-inbox', 'knowledge'],
    },
  ];

  for (const scenario of redirectCases) {
    test('B redirect ' + scenario.name + ' with receipt shape', () => {
      const fixture = makeFixtureVault();
      const title = 'redirect-' + scenario.inbox.at(-1);
      const result = runCli(fixture, [
        ...scenario.args,
        '--title', title,
        '--description', 'redirect fixture',
      ]);
      const receipt = assertReceipt(result, fixture, true);
      const inbox = join(fixture.vault, ...scenario.inbox);
      assert.equal(dirname(receipt.path), inbox);
      assert.equal(resolve(receipt.inbox_redirect.to), inbox);
      const [warningLine, ...supplementalWarnings] = result.stderr.trimEnd().split('\n');
      const warning = parseJson(warningLine, 'stderr first line');
      assert.equal(warning.status, 'warn');
      assert.equal(warning.kind, 'section_policy_redirect');
      assert.match(supplementalWarnings.join('\n'), /Could not infer domain index for path:/);
    });
  }

  test('C exact duplicate exits 2 with JSON only on stderr', () => {
    const fixture = makeFixtureVault();
    const args = [
      '--type', 'experience',
      '--subfolder', 'AI工具',
      '--title', 'dedup-exact-snapshot',
      '--description', 'dedup',
    ];
    assertReceipt(runCli(fixture, args), fixture);

    // Probed 2026-08-15: exact hit exits 2, stdout is empty, stderr is the JSON error receipt.
    const duplicate = runCli(fixture, args);
    assert.equal(duplicate.code, 2);
    assert.equal(duplicate.stdout, '');
    const error = parseJson(duplicate.stderr, 'stderr');
    assert.equal(error.status, 'error');
    assert.match(error.message, /Dedup: exact match found/);
    assert.ok(Array.isArray(error.exact_matches) && error.exact_matches.length > 0);
    assert.deepEqual(error.dedup_warnings, []);
  });

  test('C --force-new bypasses an exact hit and creates a suffixed note', () => {
    const fixture = makeFixtureVault();
    const args = [
      '--type', 'experience',
      '--subfolder', 'AI工具',
      '--title', 'force-new-snapshot',
      '--description', 'dedup',
    ];
    const first = assertReceipt(runCli(fixture, args), fixture);
    const second = assertReceipt(runCli(fixture, [...args, '--force-new']), fixture);
    assert.notEqual(second.path, first.path);
    assert.match(second.path, /force-new-snapshot-1\.md$/);
    assert.equal(ledgerEntries(fixture).at(-1).dedup_result, 'exact-bypassed');
  });

  test('D write prepends the hot entry and appends the domain index', () => {
    const fixture = makeFixtureVault();
    const title = 'index-contract-entry';
    assertReceipt(runCli(fixture, [
      '--type', 'experience',
      '--subfolder', 'AI工具',
      '--title', title,
      '--description', 'index fixture',
    ]), fixture);
    assert.match(hotLines(fixture)[0], new RegExp('^\\- \\[' + title + '\\]'));
    assert.match(readFileSync(join(fixture.memory, 'MEMORY-experience.md'), 'utf8'), new RegExp(title));
  });

  test('D expired hot entry is swept on the next write', () => {
    const fixture = makeFixtureVault();
    const expired = 'expired-hot-entry';
    assertReceipt(runCli(fixture, [
      '--type', 'experience',
      '--subfolder', 'AI工具',
      '--title', expired,
      '--description', 'expired',
      '--durability', 'durable',
      '--expires', '2000-01-01',
    ]), fixture);
    assert.ok(hotLines(fixture).some(line => line.includes(expired)));

    const current = 'expiry-sweep-trigger';
    assertReceipt(runCli(fixture, [
      '--type', 'note',
      '--title', current,
      '--description', 'trigger',
    ]), fixture);
    const hot = hotLines(fixture);
    assert.equal(hot.some(line => line.includes(expired)), false);
    assert.ok(hot[0].includes(current));
  });

  test('D FIFO keeps the hot section at capacity and evicts the oldest entry', () => {
    const fixture = makeFixtureVault();
    seedFullHotSection(fixture);
    const receipt = assertReceipt(runCli(fixture, [
      '--type', 'note',
      '--title', 'capacity-trigger-zeta',
      '--description', 'capacity',
    ]), fixture);
    const hot = hotLines(fixture);
    assert.equal(hot.length, 40);
    assert.ok(hot[0].includes('capacity-trigger-zeta'));
    assert.equal(hot.some(line => line.includes('capacity-seed-39')), false);
    assert.equal(receipt.evicted.title, 'capacity-seed-39');
  });

  test('E0 credential values are redacted before landing, references exempt', () => {
    const fixture = makeFixtureVault();
    const fakeKey = 'sk-' + 'a'.repeat(24);
    const result = runCli(fixture, [
      '--type', 'note',
      '--title', 'redact-probe',
      '--description', 'redaction gate probe',
    ], { body: 'password: hunter22secret\nkey line ' + fakeKey + '\nref line process.env.OPENAI_API_KEY stays' });
    assertReceipt(result, fixture);
    const receipt = parseJson(result.stdout, 'stdout');
    assert.ok(receipt.redactions >= 2, 'expected redactions counter, got ' + receipt.redactions);
    const landed = readFileSync(receipt.path, 'utf8');
    assert.ok(!landed.includes('hunter22secret'), 'password value must not land');
    assert.ok(!landed.includes(fakeKey), 'api key must not land');
    assert.ok(landed.includes('[REDACTED]'), 'placeholder expected');
    assert.ok(landed.includes('process.env.OPENAI_API_KEY'), 'env reference must survive');
  });

  test('E successful write appends actor/action/status to the ledger', () => {
    const fixture = makeFixtureVault();
    assertReceipt(runCli(fixture, [
      '--type', 'note',
      '--title', 'ledger-success',
      '--description', 'ledger',
    ]), fixture);
    const entries = ledgerEntries(fixture);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actor, 'codex');
    assert.equal(entries[0].action, 'write');
    assert.equal(entries[0].status, 'ok');
  });

  test('E2 hardened contract: an unwritable ledger target rolls back the write', () => {
    const fixture = makeFixtureVault();
    mkdirSync(fixture.ledger);
    const title = 'ledger-required-contract';
    const tracked = [
      join(fixture.memory, 'MEMORY.md'),
      join(fixture.memory, 'MEMORY-notes.md'),
    ];
    const before = tracked.map(path => readFileSync(path, 'utf8'));

    // 2026-08-15 hardening contract: a write is committed only after its ledger append.
    const result = runCli(fixture, [
      '--type', 'note',
      '--title', title,
      '--description', 'required ledger',
    ]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    const error = parseJson(result.stderr.trim().split('\n').at(-1), 'stderr final line');
    assert.equal(error.status, 'error');
    assert.match(error.message, /ledger append failed:/);
    assert.equal(error.rollback, 'rolled-back');
    assert.deepEqual(error.restore_failures, []);
    assert.equal(existsSync(join(fixture.vault, '07-随笔', title + '.md')), false);
    assert.equal(existsSync(join(fixture.vault, '00-系统', '.index-cache', 'intent-map.json')), false);
    tracked.forEach((path, index) => assert.equal(readFileSync(path, 'utf8'), before[index]));
  });

  test('F path traversal is rejected before anything lands outside the fixture vault', () => {
    const fixture = makeFixtureVault();
    const escapedName = 'escape-' + basename(fixture.root);
    const escapedPath = join(fixture.root, escapedName);
    const result = runCli(fixture, [
      '--type', 'experience',
      '--subfolder', '../../' + escapedName,
      '--title', '../escape-title',
      '--description', 'escape',
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    const error = parseJson(result.stderr, 'stderr');
    assert.equal(error.status, 'error');
    assert.match(error.message, /Path escape rejected/);
    assert.equal(existsSync(escapedPath), false);
  });

  test('F2 live PID lock waits for the configured bound then exits 6', () => {
    const fixture = makeFixtureVault();
    writeFileSync(fixture.lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');

    const started = Date.now();
    const result = runCli(fixture, [
      '--type', 'note',
      '--title', 'live-lock-contract',
      '--description', 'lock',
    ]);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 6);
    assert.equal(result.stdout, '');
    const error = parseJson(result.stderr, 'stderr');
    assert.equal(error.status, 'error');
    assert.match(error.message, /Lock busy: another writer holds/);
    assert.ok(elapsed >= 100 && elapsed < 2_000, String(elapsed));
    assert.ok(existsSync(fixture.lock));
  });

  test('F3 dead PID lock is reclaimed, race-safe, and cleaned after success', async () => {
    const fixture = makeFixtureVault();
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(exited.status, 0, exited.error && exited.error.message);
    assert.ok(Number.isInteger(exited.pid) && exited.pid > 0, 'dead child pid required');
    assert.throws(() => process.kill(exited.pid, 0), error => error.code === 'ESRCH');
    writeFileSync(fixture.lock, JSON.stringify({ pid: exited.pid, startedAt: new Date().toISOString() }) + '\n');

    const receipt = assertReceipt(runCli(fixture, [
      '--type', 'note',
      '--title', 'dead-lock-contract',
      '--description', 'lock',
    ]), fixture);
    assert.ok(existsSync(receipt.path));
    assert.equal(existsSync(fixture.lock), false);



    const linked = makeFixtureVault();
    const linkedOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(linkedOwner.status, 0, linkedOwner.error && linkedOwner.error.message);
    assert.throws(() => process.kill(linkedOwner.pid, 0), error => error.code === 'ESRCH');
    writeFileSync(linked.lock, JSON.stringify({
      pid: linkedOwner.pid,
      startedAt: new Date().toISOString(),
    }) + '\n');
    const sentinel = join(linked.root, 'takeover-sentinel');
    const sentinelBytes = 'must-not-change\n';
    writeFileSync(sentinel, sentinelBytes);
    symlinkSync(sentinel, linked.lock + '.takeover');

    const linkedResult = runCli(linked, [
      '--type', 'note',
      '--title', 'symlink-takeover-gate-contract',
      '--description', 'lock',
    ]);
    assert.equal(linkedResult.code, 6);
    assert.equal(linkedResult.stdout, '');
    const linkedError = parseJson(linkedResult.stderr, 'symlink gate stderr');
    assert.equal(linkedError.status, 'error');
    assert.match(linkedError.message, /Lock corrupt:/);
    assert.equal(readFileSync(sentinel, 'utf8'), sentinelBytes);
    assert.ok(existsSync(linked.lock));
    assert.ok(existsSync(linked.lock + '.takeover'));


    const hardlinked = makeFixtureVault();
    const hardlinkedOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(hardlinkedOwner.status, 0, hardlinkedOwner.error && hardlinkedOwner.error.message);
    assert.throws(() => process.kill(hardlinkedOwner.pid, 0), error => error.code === 'ESRCH');
    writeFileSync(hardlinked.lock, JSON.stringify({
      pid: hardlinkedOwner.pid,
      startedAt: new Date().toISOString(),
    }) + '\n');
    const hardlinkSentinel = join(hardlinked.root, 'takeover-hardlink-sentinel');
    const hardlinkBytes = 'must-also-not-change\n';
    writeFileSync(hardlinkSentinel, hardlinkBytes);
    linkSync(hardlinkSentinel, hardlinked.lock + '.takeover');

    const hardlinkedResult = runCli(hardlinked, [
      '--type', 'note',
      '--title', 'hardlink-takeover-gate-contract',
      '--description', 'lock',
    ]);
    assert.equal(hardlinkedResult.code, 6);
    assert.equal(hardlinkedResult.stdout, '');
    const hardlinkedError = parseJson(hardlinkedResult.stderr, 'hardlink gate stderr');
    assert.equal(hardlinkedError.status, 'error');
    assert.match(hardlinkedError.message, /Lock corrupt:/);
    assert.equal(readFileSync(hardlinkSentinel, 'utf8'), hardlinkBytes);
    assert.ok(existsSync(hardlinked.lock));
    assert.ok(existsSync(hardlinked.lock + '.takeover'));

    const crashed = makeFixtureVault();
    const crashedOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(crashedOwner.status, 0, crashedOwner.error && crashedOwner.error.message);
    assert.throws(() => process.kill(crashedOwner.pid, 0), error => error.code === 'ESRCH');
    writeFileSync(crashed.lock, JSON.stringify({
      pid: crashedOwner.pid,
      startedAt: new Date().toISOString(),
    }) + '\n');

    const claimHolderScript = [
      'import { acquireTakeoverClaim } from ' + JSON.stringify(pathToFileURL(WRITER).href) + ';',
      'acquireTakeoverClaim();',
      "process.stdout.write('claimed\\n');",
      'setInterval(() => {}, 1_000);',
    ].join('\n');
    let claimStdout = '';
    let claimStderr = '';
    let resolveClaimed;
    let rejectClaimed;
    const claimed = new Promise((resolve, reject) => {
      resolveClaimed = resolve;
      rejectClaimed = reject;
    });
    const claimHolder = spawn(process.execPath, ['--input-type=module', '-e', claimHolderScript], {
      env: { ...process.env, ...crashed.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2_000,
    });
    claimHolder.stdout.setEncoding('utf8');
    claimHolder.stderr.setEncoding('utf8');
    claimHolder.stdout.on('data', chunk => {
      claimStdout += chunk;
      if (claimStdout.includes('claimed\n')) resolveClaimed();
    });
    claimHolder.stderr.on('data', chunk => { claimStderr += chunk; });
    const claimHolderDone = new Promise((resolve, reject) => {
      claimHolder.on('error', reject);
      claimHolder.on('close', (code, signal) => {
        if (!claimStdout.includes('claimed\n')) {
          rejectClaimed(new Error(claimStderr || 'claim holder exited before ready'));
        }
        resolve({ code, signal });
      });
    });

    await claimed;
    const blockedByClaim = runCli(crashed, [
      '--type', 'note',
      '--title', 'active-takeover-claim-contract',
      '--description', 'lock',
    ]);
    assert.equal(blockedByClaim.code, 6);
    assert.equal(blockedByClaim.stdout, '');
    assert.match(parseJson(blockedByClaim.stderr, 'active claim stderr').message, /Lock busy:/);
    assert.ok(existsSync(crashed.lock));
    assert.ok(existsSync(crashed.lock + '.takeover'));

    assert.equal(claimHolder.kill('SIGKILL'), true);
    const killed = await claimHolderDone;
    assert.equal(killed.code, null);
    assert.equal(killed.signal, 'SIGKILL');
    assert.ok(existsSync(crashed.lock + '.takeover'), 'SIGKILL must leave the gate path behind');

    const crashReceipt = assertReceipt(runCli(crashed, [
      '--type', 'note',
      '--title', 'orphan-takeover-claim-contract',
      '--description', 'lock',
    ]), crashed);
    assert.ok(existsSync(crashReceipt.path));
    assert.equal(existsSync(crashed.lock), false);
    assert.equal(existsSync(crashed.lock + '.takeover'), false);

    const contended = makeFixtureVault();
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(dead.status, 0, dead.error && dead.error.message);
    assert.throws(() => process.kill(dead.pid, 0), error => error.code === 'ESRCH');
    writeFileSync(contended.lock, JSON.stringify({ pid: dead.pid, startedAt: new Date().toISOString() }) + '\n');
    const contenderScript = [
      'import { acquireLock } from ' + JSON.stringify(pathToFileURL(WRITER).href) + ';',
      "process.stdout.write('ready\\n');",
      "process.stdin.once('data', () => {",
      '  const release = acquireLock();',
      '  setTimeout(release, 250);',
      '});',
    ].join('\n');

    const startContender = () => {
      let stdout = '';
      let stderr = '';
      let readySeen = false;
      let resolveReady;
      let rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const child = spawn(process.execPath, ['--input-type=module', '-e', contenderScript], {
        env: { ...process.env, ...contended.env, BRAIN_LOCK_WAIT_MS: '50' },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 2_000,
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (!readySeen && stdout.includes('ready\n')) { readySeen = true; resolveReady(); }
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const done = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => {
          if (!readySeen) rejectReady(new Error(stderr || 'contender exited before ready'));
          resolve({ code, signal, stdout, stderr });
        });
      });
      return { child, ready, done };
    };

    const contenders = [startContender(), startContender()];
    await Promise.all(contenders.map(contender => contender.ready));
    contenders.forEach(contender => contender.child.stdin.end('go'));
    const outcomes = await Promise.all(contenders.map(contender => contender.done));
    assert.deepEqual(outcomes.map(outcome => outcome.code).sort((a, b) => a - b), [0, 6]);
    const loser = outcomes.find(outcome => outcome.code === 6);
    assert.match(parseJson(loser.stderr, 'contender stderr').message, /Lock busy:/);
    assert.equal(existsSync(contended.lock), false);
    assert.equal(existsSync(contended.lock + '.takeover'), false);
  });

  test('F4 stale legacy non-JSON lock is reclaimed for migration', () => {
    const fixture = makeFixtureVault();
    writeFileSync(fixture.lock, 'legacy-lock\n');
    const old = Date.now() / 1000 - 60;
    utimesSync(fixture.lock, old, old);

    const receipt = assertReceipt(runCli(fixture, [
      '--type', 'note',
      '--title', 'legacy-stale-lock-contract',
      '--description', 'lock',
    ]), fixture);
    assert.ok(existsSync(receipt.path));
    assert.equal(existsSync(fixture.lock), false);
  });

  test('F5 fresh legacy non-JSON lock is preserved and exits 6', () => {
    const fixture = makeFixtureVault();
    writeFileSync(fixture.lock, 'legacy-lock\n');

    const result = runCli(fixture, [
      '--type', 'note',
      '--title', 'legacy-fresh-lock-contract',
      '--description', 'lock',
    ]);
    assert.equal(result.code, 6);
    assert.equal(result.stdout, '');
    const error = parseJson(result.stderr, 'stderr');
    assert.equal(error.status, 'error');
    assert.match(error.message, /Lock corrupt:/);
    assert.ok(existsSync(fixture.lock));

    const corrupt = makeFixtureVault();
    writeFileSync(corrupt.lock, 'null\n');
    const old = Date.now() / 1000 - 60;
    utimesSync(corrupt.lock, old, old);
    const corruptResult = runCli(corrupt, [
      '--type', 'note',
      '--title', 'json-corrupt-lock-contract',
      '--description', 'lock',
    ]);
    assert.equal(corruptResult.code, 6);
    assert.equal(corruptResult.stdout, '');
    assert.match(parseJson(corruptResult.stderr, 'corrupt stderr').message, /Lock corrupt:/);
    assert.ok(existsSync(corrupt.lock));
  });

  test('G success, redirect, and validation failure keep their channel contracts', () => {
    const successFixture = makeFixtureVault();
    const success = runCli(successFixture, [
      '--type', 'note',
      '--title', 'receipt-success',
      '--description', 'receipt',
    ]);
    const successReceipt = assertReceipt(success, successFixture);
    assert.equal(success.stderr, '');
    assert.equal(successReceipt.inbox_redirect, null);

    const redirectFixture = makeFixtureVault();
    const redirect = runCli(redirectFixture, [
      '--type', 'reference',
      '--subfolder', '未建知识类',
      '--title', 'receipt-redirect',
      '--description', 'receipt',
    ]);
    const redirectReceipt = assertReceipt(redirect, redirectFixture, true);
    const [warningLine, ...supplementalWarnings] = redirect.stderr.trimEnd().split('\n');
    const warning = parseJson(warningLine, 'stderr first line');
    assert.deepEqual(
      [warning.status, warning.kind],
      ['warn', 'section_policy_redirect'],
    );
    assert.equal(resolve(redirectReceipt.inbox_redirect.to), resolve(warning.redirected_to));
    assert.match(supplementalWarnings.join('\n'), /Could not infer domain index for path:/);

    const invalidFixture = makeFixtureVault();
    const invalid = runCli(invalidFixture, [
      '--type', 'note',
      '--description', 'missing title',
    ]);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stdout, '');
    const error = parseJson(invalid.stderr, 'stderr');
    assert.deepEqual(Object.keys(error).sort(), ['message', 'status']);
    assert.equal(error.status, 'error');
    assert.match(error.message, /Missing required field: title/);
    assert.equal(existsSync(invalidFixture.ledger), false);
  });
});

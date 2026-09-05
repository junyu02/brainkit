#!/usr/bin/env node

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  assertInsideVault,
  callDeepSeek,
  contentSignature,
  createExclusiveLock,
  htmlToMarkdown,
  isValidLayer,
  isValidTimestamp,
  makeTimestamp,
  stripHtml,
} from '../scripts/lib/clip-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const TMP_PARENT = resolve(process.env.BRAIN_TEST_TMP_ROOT || join(PROJECT_ROOT, '.migration-state'));
mkdirSync(TMP_PARENT, { recursive: true });
const ROOT = mkdtempSync(join(TMP_PARENT, 'brain-clip-tests-'));
const PENDING = join(ROOT, 'raw', 'pending');
const CLIP = join(PROJECT_ROOT, 'scripts', 'cli', 'brain-clip.mjs');
mkdirSync(PENDING, { recursive: true });

after(() => rmSync(ROOT, { recursive: true, force: true }));

function runClip(...args) {
  return spawnSync(process.execPath, [CLIP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_VAULT_ROOT: ROOT },
  });
}

test('timestamp matches the clip filename contract', () => {
  assert.match(makeTimestamp(), /^\d{4}-\d{2}-\d{2}-\d{9}$/);
});

test('HTML helpers remove executable markup and preserve useful structure', () => {
  const html = '<script>bad()</script><h2>A &amp; B</h2><p><strong>bold</strong> <a href="https://example.test">link</a></p>![[img.png]]';
  assert.equal(stripHtml(html), 'A & B bold link ![[img.png]]');
  const markdown = htmlToMarkdown(html);
  assert.doesNotMatch(markdown, /bad\(\)|script/);
  assert.match(markdown, /## A & B/);
  assert.match(markdown, /\*\*bold\*\* \[link\]\(https:\/\/example\.test\)/);
  assert.match(markdown, /!\[\[img\.png\]\]/);
});

test('content signatures are stable and content-sensitive', () => {
  assert.equal(contentSignature('same'), contentSignature('same'));
  assert.notEqual(contentSignature('aaaa'), contentSignature('bbbb'));
  assert.match(contentSignature('same'), /^txt:[a-f0-9]{16}$/);
});

test('timestamp and layer allowlists reject traversal and unknown values', () => {
  assert.ok(isValidTimestamp('2026-04-06-143022'));
  assert.ok(isValidTimestamp('2026-04-06-143022789'));
  assert.ok(!isValidTimestamp('../../etc/passwd'));
  assert.ok(isValidLayer('03-经验'));
  assert.ok(!isValidLayer('../'));
});

test('vault boundary accepts descendants and rejects escapes', () => {
  assert.doesNotThrow(() => assertInsideVault(join(ROOT, '02-知识', 'note.md'), ROOT));
  assert.throws(() => assertInsideVault(resolve(ROOT, '..', 'escape.md'), ROOT), /outside vault/);
});

test('exclusive lock skips overlap and unlocks afterward', async () => {
  const lock = createExclusiveLock();
  let release;
  const first = lock.runExclusive(() => new Promise(resolveRelease => { release = resolveRelease; }));
  assert.equal(await lock.runExclusive(async () => 'overlap'), 'skipped');
  release('done');
  assert.equal(await first, 'done');
  assert.equal(lock.isLocked(), false);
});

test('exclusive lock unlocks after rejection', async () => {
  const lock = createExclusiveLock();
  await assert.rejects(lock.runExclusive(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await lock.runExclusive(async () => 'next'), 'next');
});

test('DeepSeek client uses the OpenAI-compatible response contract without network', async () => {
  let requestBody;
  const requestImpl = (_url, _options, onResponse) => {
    const request = new EventEmitter();
    request.write = body => { requestBody = JSON.parse(body); };
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      onResponse(response);
      queueMicrotask(() => {
        response.emit('data', '{"choices":[{"message":{"content":"  ok  "}}]}');
        response.emit('end');
      });
    };
    request.destroy = error => queueMicrotask(() => request.emit('error', error));
    return request;
  };
  const content = await callDeepSeek({
    apiKey: 'test-only',
    model: 'deepseek-test',
    messages: [{ role: 'user', content: 'test' }],
    requestImpl,
  });
  assert.equal(content, 'ok');
  assert.equal(requestBody.model, 'deepseek-test');
  assert.equal(requestBody.max_tokens, 8192);
});

test('approve reports missing classification without writing', () => {
  const timestamp = '2026-04-06-130000000';
  writeFileSync(join(PENDING, `${timestamp}.json`), JSON.stringify({
    timestamp: '2026-04-06T13:00:00',
    filename: timestamp,
    llm: null,
    reason: 'api_failure',
  }));
  const result = runClip('approve', timestamp);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no classification data/);
  assert.ok(existsSync(join(PENDING, `${timestamp}.json`)));
});

test('approve rejects traversal before reading pending data', () => {
  const result = runClip('approve', '../../etc/passwd');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid timestamp/);
});

// --- black-box audit findings F1-F5 -----------------------------------------

// F1. The restructure reply replaces the whole body, so sending a truncated
// article silently deleted everything past the cut -- and the pending JSON, the
// only other copy, is removed straight after.
test('approving an article past the restructure limit keeps every character', async () => {
  const { createServer } = await import('node:http');
  let sentChars = null;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const article = JSON.parse(raw).messages[0].content.split('文章内容：\n---\n')[1];
      sentChars = article.length;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: article } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const home = mkdtempSync(join(TMP_PARENT, 'restructure-'));
  const vault = join(home, 'vault');
  mkdirSync(join(vault, 'raw', 'pending'), { recursive: true });
  mkdirSync(join(vault, '07-随笔'), { recursive: true });
  mkdirSync(join(vault, '00-系统'), { recursive: true });
  writeFileSync(join(vault, '00-系统', '.project-map.json'), '{"mappings":[]}');
  const memory = join(home, 'memory');
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, 'MEMORY.md'),
    '# Memory Index\n\n## 🔥 热记忆（容量 40，按 type 配额+FIFO）\n\n<auto-maintained>\n\n## 📚 领域索引（按需读取）\n');
  for (const name of ['experience', 'knowledge', 'project', 'persona', 'archive', 'notes']) {
    writeFileSync(join(memory, `MEMORY-${name}.md`), '# Index\n');
  }
  const routing = join(home, 'routing.json');
  writeFileSync(routing, JSON.stringify({
    schema: 'vault-routing-v2',
    routes: [{ type: 'note', path: '07-随笔/', scope: 'global' }],
    section_policies: { '07-随笔/': { policy: 'allow_root', requires_subfolder: false } },
    inbox_root: '99-inbox/', inbox_subfolders: { '07-随笔/': '99-inbox/notes/' },
  }));
  const clipEnv = join(home, 'clip.env');
  writeFileSync(clipEnv, `DEEPSEEK_API_KEY=test-only-value\nCLIP_API_BASE=http://127.0.0.1:${server.address().port}\n`, { mode: 0o600 });
  chmodSync(clipEnv, 0o600);

  const original = 'Synthetic article line.\n'.repeat(900) + 'FINAL_ORIGINAL_SENTINEL';
  const stamp = '2026-09-05-120000000';
  writeFileSync(join(vault, 'raw', 'pending', `${stamp}.json`), JSON.stringify({
    timestamp: '2026-09-05T12:00:00', filename: stamp, text: original,
    llm: { vault_layer: '07-随笔', title: '长文保留', summary: '合成文章' },
  }));

  // spawn, not spawnSync: the echo server lives in this process, and a
  // synchronous child blocks the event loop that would have to answer it --
  // the request then sits until the client's own 30s timeout.
  // NODE_ENV=test is what lets CLIP_API_BASE be loopback http; without it the
  // run stops at config validation and this gate would go red for that instead
  // of for the dropped tail it exists to catch.
  let result;
  try {
    result = await new Promise(done => {
      const child = spawn(process.execPath, [CLIP, 'approve', stamp], {
        env: { ...process.env, NODE_ENV: 'test', HOME: home, BRAIN_VAULT_ROOT: vault,
          BRAIN_ROUTING_JSON: routing, BRAIN_MEMORY_DIR: memory, BRAIN_CLIP_ENV_PATH: clipEnv },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', status => done({ status, stdout, stderr }));
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const notes = readdirSync(join(vault, '07-随笔')).filter(f => f.endsWith('.md'));
  assert.equal(notes.length, 1, notes.join(', '));
  const saved = readFileSync(join(vault, '07-随笔', notes[0]), 'utf8');
  assert.ok(saved.includes('FINAL_ORIGINAL_SENTINEL'),
    `the tail past the limit was dropped; note is ${saved.length} chars of ${original.length}`);
  assert.equal(sentChars, null, 'an article over the limit must not be sent at all');
  rmSync(home, { recursive: true, force: true });
});

// F2. The project name becomes a directory under 01-项目/, so join() resolved
// '../../outside-vault' and mkdir landed outside the vault.
test('a project name that escapes the vault is refused', () => {
  const home = mkdtempSync(join(TMP_PARENT, 'init-escape-'));
  const vault = join(home, 'vault');
  mkdirSync(join(vault, '00-系统'), { recursive: true });
  mkdirSync(join(vault, '01-项目'), { recursive: true });
  const map = join(vault, '00-系统', '.project-map.json');
  writeFileSync(map, '{"mappings":[]}');
  const init = join(PROJECT_ROOT, 'scripts', 'cli', 'brain-init.mjs');
  const env = { ...process.env, HOME: home, BRAIN_VAULT_ROOT: vault };

  assert.equal(spawnSync(process.execPath, [init, 'normal-project'], { encoding: 'utf8', env }).status, 0);

  const result = spawnSync(process.execPath, [init, '../../outside-vault'], { encoding: 'utf8', env });
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(existsSync(join(home, 'outside-vault')), false, 'created a directory outside the vault');
  assert.equal(JSON.parse(readFileSync(map, 'utf8')).mappings.length, 1, 'the refused name reached the map');
  rmSync(home, { recursive: true, force: true });
});

// F2, second round. resolve() only rewrites the string, so a symlinked 01-项目
// -- or an existing 01-项目/<name> pointing out of the vault -- passed the
// comparison and mkdir followed the link out.
test('a symlinked project directory cannot write outside the vault', () => {
  const init = join(PROJECT_ROOT, 'scripts', 'cli', 'brain-init.mjs');

  for (const linkWhat of ['projects-root', 'project-dir']) {
    const home = mkdtempSync(join(TMP_PARENT, `init-link-${linkWhat}-`));
    const vault = join(home, 'vault');
    const outside = join(home, 'outside');
    mkdirSync(join(vault, '00-系统'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    const map = join(vault, '00-系统', '.project-map.json');
    writeFileSync(map, '{"mappings":[]}');

    let name;
    if (linkWhat === 'projects-root') {
      symlinkSync(outside, join(vault, '01-项目'));
      name = 'normal-project';
    } else {
      mkdirSync(join(vault, '01-项目'), { recursive: true });
      symlinkSync(outside, join(vault, '01-项目', 'linked-project'));
      name = 'linked-project';
    }

    const result = spawnSync(process.execPath, [init, name],
      { encoding: 'utf8', env: { ...process.env, HOME: home, BRAIN_VAULT_ROOT: vault } });
    assert.notEqual(result.status, 0, `${linkWhat}: ${result.stdout}`);
    assert.equal(readdirSync(outside).length, 0, `${linkWhat}: wrote through the symlink`);
    assert.equal(JSON.parse(readFileSync(map, 'utf8')).mappings.length, 0, `${linkWhat}: reached the map`);
    rmSync(home, { recursive: true, force: true });
  }
});

// The positive half: Oscar's real vault is reached through a symlink
// (~/Desktop/second-brain -> iCloud), so an alias must still work normally.
test('a vault reached through a symlink still creates projects normally', () => {
  const home = mkdtempSync(join(TMP_PARENT, 'init-alias-'));
  const vault = join(home, 'vault');
  mkdirSync(join(vault, '00-系统'), { recursive: true });
  writeFileSync(join(vault, '00-系统', '.project-map.json'), '{"mappings":[]}');
  const alias = join(home, 'vault-alias');
  symlinkSync(vault, alias);

  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts', 'cli', 'brain-init.mjs'), 'normal-project'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, BRAIN_VAULT_ROOT: alias } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(vault, '01-项目', 'normal-project', '_index.md')), result.stdout);
  rmSync(home, { recursive: true, force: true });
});

// Same shape as F2, in the other boundary check: brain-clip runs
// assertInsideVault over paths built from the pending JSON's imagePath and over
// the attachments directory, then renames into one and unlinks the other.
test('assertInsideVault follows symlinks, not just the string', () => {
  const home = mkdtempSync(join(TMP_PARENT, 'inside-vault-'));
  const vault = join(home, 'vault');
  const outside = join(home, 'outside');
  mkdirSync(join(vault, '00-系统'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(vault, '00-系统', 'attachments'));

  // Inside by string, outside once the link is followed.
  assert.throws(() => assertInsideVault(join(vault, '00-系统', 'attachments', 'x.png'), vault), /outside vault/);
  // A vault reached through an alias still accepts its own descendants.
  const alias = join(home, 'vault-alias');
  symlinkSync(vault, alias);
  assert.doesNotThrow(() => assertInsideVault(join(alias, '02-知识', 'note.md'), alias));
  rmSync(home, { recursive: true, force: true });
});

// F3. resolve() on both sides answers "not main" whenever either spelling goes
// through a symlink, so the entry block silently did nothing and the CLI exited
// 0 having printed nothing.
test('every entry point still runs when reached through a symlink', () => {
  const scripts = [
    'scripts/cli/brain-init.mjs', 'scripts/cli/brain-archive.mjs', 'scripts/cli/brain-clip.mjs',
    'scripts/daemon/brain-watch.mjs', 'scripts/publish.mjs', 'scripts/lib/plist-render.mjs',
  ];
  const home = mkdtempSync(join(TMP_PARENT, 'symlink-main-'));
  const linkedRepo = join(home, 'linked-repo');
  symlinkSync(PROJECT_ROOT, linkedRepo);
  const env = { ...process.env, HOME: home, BRAIN_VAULT_ROOT: ROOT };
  const run = path => spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8', env });

  for (const script of scripts) {
    const direct = run(join(PROJECT_ROOT, script));
    assert.equal(direct.status, 0, `${script}: ${direct.stderr}`);
    assert.ok(direct.stdout.trim(), `${script} printed nothing when run directly`);

    const fileLink = join(home, basename(script));
    symlinkSync(join(PROJECT_ROOT, script), fileLink);
    const viaFile = run(fileLink);
    assert.equal(viaFile.stdout, direct.stdout, `${script} via file symlink`);
    assert.equal(viaFile.status, direct.status, `${script} via file symlink exit code`);

    const viaDirectory = run(join(linkedRepo, script));
    assert.equal(viaDirectory.stdout, direct.stdout, `${script} via directory symlink`);
    assert.equal(viaDirectory.status, direct.status, `${script} via directory symlink exit code`);
  }
  rmSync(home, { recursive: true, force: true });
});

// F4/F5. A fake launchctl on PATH, so both the argv shape and the exit
// handling are observable. HOME has a space in it on purpose: the old string
// concatenation split the path there.
function withFakeLaunchctl(stdout, exitCode) {
  const home = mkdtempSync(join(TMP_PARENT, 'launchctl fake-'));
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  // /bin/sh, not node: the repo is "type": "module", so a node shim under the
  // repo tree is loaded as ESM and `require` is not defined there. One argument
  // per line also makes "exactly two arguments" a line count.
  const argsFile = join(home, 'args.json');
  writeFileSync(join(bin, 'launchctl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
    `cat <<'LAUNCHCTL_STUB_EOF'\n${stdout}\nLAUNCHCTL_STUB_EOF`,
    `exit ${exitCode}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { home, argsFile, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BRAIN_VAULT_ROOT: ROOT } };
}

test('a failing launchctl unload is a failure, not a Daemon stopped', () => {
  const watch = join(PROJECT_ROOT, 'scripts', 'daemon', 'brain-watch.mjs');
  for (const [service, script] of [['watch', watch], ['clip', CLIP]]) {
    const { home, argsFile, env } = withFakeLaunchctl('unload denied by test stub', 5);
    const plist = join(home, 'Library', 'LaunchAgents', `com.second-brain.${service}.plist`);
    writeFileSync(plist, 'fixture');

    const result = spawnSync(process.execPath, [script, 'stop'], { encoding: 'utf8', env });
    assert.notEqual(result.status, 0, `${service}: ${result.stdout}`);
    assert.equal(result.stdout.includes('Daemon stopped.'), false, `${service}: ${result.stdout}`);
    // Exactly two arguments: the space in HOME must not split the path.
    const passed = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(passed, ['unload', plist]);
    rmSync(home, { recursive: true, force: true });
  }
});

test('status reads the PID entry, so a loaded-but-idle job is STOPPED', () => {
  const watch = join(PROJECT_ROOT, 'scripts', 'daemon', 'brain-watch.mjs');
  const idle = '{\n\t"LimitLoadToSessionType" = "Aqua";\n\t"Label" = "test";\n\t"OnDemand" = true;\n\t"LastExitStatus" = 0;\n};';
  const running = '{\n\t"Label" = "test";\n\t"PID" = 47998;\n\t"LastExitStatus" = 0;\n};';
  for (const script of [watch, CLIP]) {
    for (const [output, expected] of [[idle, 'Status: STOPPED'], [running, 'Status: RUNNING']]) {
      const { home, env } = withFakeLaunchctl(output, 0);
      const result = spawnSync(process.execPath, [script, 'status'], { encoding: 'utf8', env });
      assert.ok(result.stdout.includes(expected), `${script}: expected ${expected}, got:\n${result.stdout}`);
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// Slice 8: both daemon scripts stopped being a second installer. The gate is
// on the real entry point in a child process with its own HOME, because what
// has to be true is that nothing gets written -- the old install wrote a plist
// into ~/Library/LaunchAgents carrying process.execPath.
test('the daemon scripts install/start refuse and write nothing', () => {
  const watch = join(PROJECT_ROOT, 'scripts', 'daemon', 'brain-watch.mjs');
  for (const script of [CLIP, watch]) {
    for (const command of ['install', 'start']) {
      const home = mkdtempSync(join(TMP_PARENT, 'second-installer-'));
      const result = spawnSync(process.execPath, [script, command], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, BRAIN_VAULT_ROOT: ROOT },
      });
      const where = `${script} ${command}`;

      assert.notEqual(result.status, 0, `${where} must refuse: ${result.stdout}`);
      assert.match(result.stderr, /node install\.mjs install/, `${where}: ${result.stderr}`);
      assert.match(result.stderr, /第二套安装器/, `${where}: ${result.stderr}`);

      const agents = join(home, 'Library', 'LaunchAgents');
      assert.ok(!existsSync(agents) || readdirSync(agents).length === 0,
        `${where} must not write a plist`);
      assert.deepEqual(readdirSync(home), [], `${where} must not write anything under HOME`);
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('package.json no longer exposes watch:start', () => {
  const scripts = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(Object.hasOwn(scripts, 'watch:start'), false, Object.keys(scripts).join(', '));
  // The two that stay: no-arg usage, and the idempotent stop.
  assert.ok(Object.hasOwn(scripts, 'watch') && Object.hasOwn(scripts, 'watch:stop'));
});

test('retired reject command fails without deleting pending data', () => {
  const timestamp = '2026-04-06-140000000';
  const path = join(PENDING, `${timestamp}.json`);
  writeFileSync(path, '{}');
  const result = runClip('reject', timestamp);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /已退役/);
  assert.ok(existsSync(path));
});

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { callDeepSeekVision, createExclusiveLock } from '../scripts/lib/clip-utils.mjs';
import {
  loadClipEnv,
  loadObserveEnv,
  parseEnvFile,
  renderPlist,
  validatePrivateFile,
  xmlEscape,
} from '../scripts/lib/plist-render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const TMP_PARENT = resolve(process.env.BRAIN_TEST_TMP_ROOT || join(PROJECT_ROOT, '.migration-state'));
mkdirSync(TMP_PARENT, { recursive: true });
const ROOT = mkdtempSync(join(TMP_PARENT, 'plist-render-tests-'));
const SPECIAL = join(ROOT, 'space 中文 & < > " \'');
mkdirSync(SPECIAL);

after(() => rmSync(ROOT, { recursive: true, force: true }));

function template(name) {
  return join(PROJECT_ROOT, 'templates', name);
}

function lint(path) {
  const result = spawnSync('/usr/bin/plutil', ['-lint', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function makeExecutable(name) {
  const path = join(SPECIAL, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

const fakeFswatch = makeExecutable('fake fswatch');

const cases = [
  {
    template: 'com.second-brain.clip.plist.template',
    variables: {
      NODE_PATH: process.execPath,
      CLIP_HANDLER_PATH: join(PROJECT_ROOT, 'scripts', 'daemon', 'brain-clip-handler.mjs'),
      LOG_PATH: join(SPECIAL, 'clip & < > " \'.log'),
    },
  },
  {
    template: 'com.second-brain.observe.plist.template',
    variables: {
      NODE_PATH: process.execPath,
      OBSERVE_PATH: join(PROJECT_ROOT, 'scripts', 'cli', 'observe.mjs'),
      LOG_PATH: join(SPECIAL, 'observe.log'),
    },
  },
  {
    template: 'com.second-brain.sunday.plist.template',
    variables: {
      NODE_PATH: process.execPath,
      SUNDAY_PATH: join(PROJECT_ROOT, 'scripts', 'cli', 'brain-sunday.mjs'),
      LOG_PATH: join(SPECIAL, 'sunday.log'),
    },
  },
  {
    template: 'com.second-brain.watch.plist.template',
    variables: {
      WATCH_WRAPPER_PATH: join(PROJECT_ROOT, 'templates', 'watch-wrapper.sh'),
      FSWATCH_PATH: fakeFswatch,
      WATCH_ROOT: SPECIAL,
      NODE_PATH: process.execPath,
      WATCH_HANDLER_PATH: join(PROJECT_ROOT, 'scripts', 'daemon', 'brain-watch-handler.mjs'),
      LOG_PATH: join(SPECIAL, 'watch.log'),
    },
  },
];

test('plist templates render paths with spaces, Chinese, and XML metacharacters', () => {
  for (const item of cases) {
    const output = join(SPECIAL, item.template.replace('.template', ''));
    renderPlist({ templatePath: template(item.template), outputPath: output, variables: item.variables });
    lint(output);
    assert.equal(lstatSync(output).mode & 0o777, 0o600);
    const text = readFileSync(output, 'utf8');
    assert.doesNotMatch(text, /\{\{[A-Z0-9_]+\}\}/);
    assert.match(text, /<key>ProgramArguments<\/key>\s*<array>/);
    assert.doesNotMatch(text, /<string>-c<\/string>|sh -c/);
  }
  const clip = readFileSync(join(SPECIAL, 'com.second-brain.clip.plist'), 'utf8');
  assert.ok(clip.includes(xmlEscape(join(SPECIAL, 'clip & < > " \'.log'))));
  assert.doesNotMatch(clip, /EnvironmentVariables|DEEPSEEK_API_KEY/);
  assert.match(readFileSync(join(SPECIAL, 'com.second-brain.observe.plist'), 'utf8'), /<string>--all<\/string>/);
  // Regression locks for two template drifts that were only caught by manual inventory:
  // watch argv[0] must stay /bin/sh (TCC: launchd cannot exec iCloud-resident scripts),
  // and sunday must stay Sunday 21:30 (Oscar's ruling; template once drifted to 10:00).
  const watch = readFileSync(join(SPECIAL, 'com.second-brain.watch.plist'), 'utf8');
  assert.match(watch, /<array>\s*<string>\/bin\/sh<\/string>/);
  const sunday = readFileSync(join(SPECIAL, 'com.second-brain.sunday.plist'), 'utf8');
  assert.match(sunday, /<key>Hour<\/key>\s*<integer>21<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
});

test('renderer lints before a 0600 atomic replacement', () => {
  const output = join(SPECIAL, 'atomic.plist');
  const first = cases[0];
  renderPlist({ templatePath: template(first.template), outputPath: output, variables: first.variables });
  const firstInode = lstatSync(output).ino;
  const variables = { ...first.variables, LOG_PATH: join(SPECIAL, 'replacement.log') };
  renderPlist({ templatePath: template(first.template), outputPath: output, variables });
  lint(output);
  assert.notEqual(lstatSync(output).ino, firstInode);
  assert.equal(lstatSync(output).mode & 0o777, 0o600);
  assert.equal(readdirSync(SPECIAL).filter(name => name.endsWith('.tmp')).length, 0);
  const link = join(SPECIAL, 'output-link.plist');
  symlinkSync(output, link);
  assert.throws(
    () => renderPlist({ templatePath: template(first.template), outputPath: link, variables }),
    /must not be a symlink/,
  );
});

test('10 clip.env parser enforces allowlist, owner, 0600, and non-symlink input', () => {
  const valid = join(SPECIAL, 'clip.env');
  writeFileSync(valid, [
    'DEEPSEEK_API_KEY=test-only-value',
    'CLIP_VISION_MODEL=vision-test',
    'CLIP_TEXT_MODEL=text-test',
    'CLIP_API_BASE=https://api.example.test',
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(valid, 0o600);
  assert.deepEqual(loadClipEnv(valid), {
    DEEPSEEK_API_KEY: 'test-only-value',
    CLIP_VISION_MODEL: 'vision-test',
    CLIP_TEXT_MODEL: 'text-test',
    CLIP_API_BASE: 'https://api.example.test',
  });
  const previousClipEnvPath = process.env.BRAIN_CLIP_ENV_PATH;
  process.env.BRAIN_CLIP_ENV_PATH = valid;
  try { assert.equal(loadClipEnv().DEEPSEEK_API_KEY, 'test-only-value'); }
  finally {
    if (previousClipEnvPath === undefined) delete process.env.BRAIN_CLIP_ENV_PATH;
    else process.env.BRAIN_CLIP_ENV_PATH = previousClipEnvPath;
  }
  assert.deepEqual(
    parseEnvFile(valid, {
      allowedKeys: ['DEEPSEEK_API_KEY', 'CLIP_VISION_MODEL', 'CLIP_TEXT_MODEL', 'CLIP_API_BASE'],
      requiredKeys: ['DEEPSEEK_API_KEY'],
    }),
    {
      DEEPSEEK_API_KEY: 'test-only-value',
      CLIP_VISION_MODEL: 'vision-test',
      CLIP_TEXT_MODEL: 'text-test',
      CLIP_API_BASE: 'https://api.example.test',
    },
  );
  const missingRequired = join(SPECIAL, 'missing-required.env');
  writeFileSync(missingRequired, 'CLIP_TEXT_MODEL=text-test\n', { mode: 0o600 });
  chmodSync(missingRequired, 0o600);
  assert.throws(() => loadClipEnv(missingRequired), /must define DEEPSEEK_API_KEY/);
  assert.throws(
    () => validatePrivateFile(valid, { expectedUid: (process.getuid?.() ?? 0) + 1 }),
    /owner mismatch/,
  );

  chmodSync(valid, 0o644);
  assert.throws(() => loadClipEnv(valid), /mode must be 0600/);
  chmodSync(valid, 0o600);
  const link = join(SPECIAL, 'clip-link.env');
  symlinkSync(valid, link);
  assert.throws(() => loadClipEnv(link), /non-symlink/);

  const unknown = join(SPECIAL, 'unknown.env');
  writeFileSync(unknown, 'OTHER_KEY=test-only-value\n', { mode: 0o600 });
  chmodSync(unknown, 0o600);
  assert.throws(() => loadClipEnv(unknown), /not allowlisted/);
  const sourceSyntax = join(SPECIAL, 'source.env');
  writeFileSync(sourceSyntax, 'source ./other.env\n', { mode: 0o600 });
  chmodSync(sourceSyntax, 0o600);
  assert.throws(() => loadClipEnv(sourceSyntax), /invalid env assignment/);
});

test('CLIP_API_BASE requires HTTPS except loopback HTTP in test mode', () => {
  const externalHttp = join(SPECIAL, 'external-http.env');
  writeFileSync(externalHttp, 'DEEPSEEK_API_KEY=test-only-value\nCLIP_API_BASE=http://api.example.test\n', { mode: 0o600 });
  chmodSync(externalHttp, 0o600);
  const loopbackHttp = join(SPECIAL, 'loopback-http.env');
  writeFileSync(loopbackHttp, 'DEEPSEEK_API_KEY=test-only-value\nCLIP_API_BASE=http://127.0.0.1:12345\n', { mode: 0o600 });
  chmodSync(loopbackHttp, 0o600);
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.NODE_ENV;
    assert.throws(() => loadClipEnv(externalHttp), /CLIP_API_BASE.*https/i);
    assert.throws(() => loadClipEnv(loopbackHttp), /CLIP_API_BASE.*NODE_ENV=test/);
    process.env.NODE_ENV = 'test';
    assert.throws(() => loadClipEnv(externalHttp), /CLIP_API_BASE.*https/i);
    assert.equal(loadClipEnv(loopbackHttp).CLIP_API_BASE, 'http://127.0.0.1:12345');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('observe.env shares the private-file parser and rejects unlisted keys and plain http', () => {
  const writeEnv = (name, body) => {
    const path = join(SPECIAL, name);
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  };

  const valid = writeEnv('observe.env', [
    'OPENAI_API_KEY=test-only-value',
    'OPENAI_BASE_URL=https://api.example.test',
    'HARVEST_JUDGE_MODEL=judge-test',
    '',
  ].join('\n'));
  assert.deepEqual(loadObserveEnv(valid), {
    OPENAI_API_KEY: 'test-only-value',
    OPENAI_BASE_URL: 'https://api.example.test',
    HARVEST_JUDGE_MODEL: 'judge-test',
    OBSERVE_MODEL: 'deepseek-v4-flash',
  });
  assert.equal(loadObserveEnv(writeEnv('observe-model.env', [
    'OPENAI_API_KEY=test-only-value',
    'OPENAI_BASE_URL=https://api.example.test',
    'OBSERVE_MODEL=explicit-model',
    '',
  ].join('\n'))).OBSERVE_MODEL, 'explicit-model');

  const unknown = writeEnv('observe-unknown.env', [
    'OPENAI_API_KEY=test-only-value',
    'OPENAI_BASE_URL=https://api.example.test',
    'OPENAI_ORG=test-only-value',
    '',
  ].join('\n'));
  assert.throws(() => loadObserveEnv(unknown), /not allowlisted.*OPENAI_ORG/);

  const missingBase = writeEnv('observe-missing.env', 'OPENAI_API_KEY=test-only-value\n');
  assert.throws(() => loadObserveEnv(missingBase), /must define OPENAI_BASE_URL/);

  const externalHttp = writeEnv('observe-http.env', [
    'OPENAI_API_KEY=test-only-value',
    'OPENAI_BASE_URL=http://api.example.test',
    '',
  ].join('\n'));
  assert.throws(() => loadObserveEnv(externalHttp), /OPENAI_BASE_URL must use https/);

  chmodSync(valid, 0o644);
  assert.throws(() => loadObserveEnv(valid), /mode must be 0600/);
  chmodSync(valid, 0o600);
});

test('a FIFO private config is refused in bounded time instead of blocking the open', () => {
  const fifo = join(ROOT, 'observe-fifo.env');
  assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', fifo]).status, 0, 'mkfifo must succeed');

  // Run in a child with a hard timeout: without O_NONBLOCK the read-only open
  // of a writer-less FIFO never returns, so an in-process assert would hang the
  // whole suite rather than fail it.
  const child = spawnSync(process.execPath, [
    '-e',
    'import("./scripts/lib/plist-render.mjs").then(m => {'
    + ' try { m.loadObserveEnv(process.argv[1]); process.stdout.write("ACCEPTED"); }'
    + ' catch (error) { process.stdout.write("REFUSED:" + error.message); } })',
    fifo,
  ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000 });

  assert.notEqual(child.signal, 'SIGTERM', 'the open blocked past the timeout instead of being refused');
  assert.match(child.stdout, /^REFUSED:.*must be a regular non-symlink file/);
});

test('vision timeout rejects within its bound and releases the exclusive lock', async () => {
  const server = createServer(request => request.resume());
  let apiBase;
  let requestImpl;
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    apiBase = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    apiBase = 'http://127.0.0.1:12345';
    requestImpl = () => {
      const request = new EventEmitter();
      request.write = () => true;
      request.end = () => request;
      request.destroy = destroyError => queueMicrotask(() => request.emit('error', destroyError));
      return request;
    };
  }
  const lock = createExclusiveLock();
  const startedAt = Date.now();
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    await assert.rejects(
      lock.runExclusive(() => callDeepSeekVision({
        apiBase,
        apiKey: 'test-only-value',
        model: 'vision-test',
        prompt: 'Return strict json',
        imageBase64: 'aGVybWV0aWM=',
        requestImpl,
        timeoutMs: 100,
      })),
      /DeepSeek timeout/,
    );
    assert.ok(Date.now() - startedAt < 2000, 'vision request exceeded timeout bound');
    assert.equal(lock.isLocked(), false);
    assert.equal(await lock.runExclusive(async () => 'next-task'), 'next-task');
    await assert.rejects(callDeepSeekVision({
      apiBase,
      apiKey: 'test-only-value',
      model: 'vision-test',
      prompt: 'Return strict json',
      imageBase64: 'aGVybWV0aWM=',
      requestImpl,
      timeoutMs: 0,
    }), /timeoutMs must be a positive finite number/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
  }
});

test('clip and watch CLIs render no plist at all and contain no embedded plist or settings key path', () => {
  const paths = [
    join(PROJECT_ROOT, 'scripts', 'cli', 'brain-clip.mjs'),
    join(PROJECT_ROOT, 'scripts', 'daemon', 'brain-watch.mjs'),
  ];
  for (const path of paths) {
    const source = readFileSync(path, 'utf8');
    // This used to require renderPlist: the rule was "share the renderer rather
    // than embed XML". Slice 8 closed the second installer, so the stronger
    // property holds -- neither script writes a plist by any route, shared
    // renderer included. Not asserted here: the absence of process.execPath.
    // brain-clip still spawns brain-write.mjs with it, which is legitimate; what
    // was dangerous was writing it INTO a plist, and no-renderPlist plus no
    // embedded XML already covers that.
    assert.doesNotMatch(source, /renderPlist/);
    assert.doesNotMatch(source, /<\?xml|settings\.json|EnvironmentVariables/);
  }
  const handler = readFileSync(join(PROJECT_ROOT, 'scripts', 'daemon', 'brain-clip-handler.mjs'), 'utf8');
  assert.match(handler, /loadClipEnv/);
  assert.doesNotMatch(handler, /process\.env\.DEEPSEEK_API_KEY|settings\.json/);
});

test('clip LLM calls use the DeepSeek OpenAI-compatible contract', () => {
  const handler = readFileSync(join(PROJECT_ROOT, 'scripts', 'daemon', 'brain-clip-handler.mjs'), 'utf8');
  const cli = readFileSync(join(PROJECT_ROOT, 'scripts', 'cli', 'brain-clip.mjs'), 'utf8');
  const client = readFileSync(join(PROJECT_ROOT, 'scripts', 'lib', 'clip-utils.mjs'), 'utf8');
  for (const source of [handler, cli, client]) {
    assert.doesNotMatch(source, new RegExp(['GEM', 'INI'].join(''), 'i'));
  }
  for (const source of [handler, cli]) {
    assert.match(source, /callDeepSeek/);
  }
  assert.match(client, /chat\/completions/);
  assert.match(client, /max_tokens:\s*8192/);
  assert.match(client, /Authorization.*Bearer/);
  assert.match(client, /finish_reason=length/);
  assert.match(client, /DEFAULT_DEEPSEEK_TIMEOUT_MS = 60_000/);
  assert.match(client, /timeoutMs = DEFAULT_DEEPSEEK_TIMEOUT_MS/);
  assert.match(client, /type:\s*'image_url'/);
  assert.match(client, /data:image\/png;base64/);
  assert.match(handler, /callDeepSeekVision\(\{/);
  assert.match(handler, /timeoutMs:\s*60_000/);
  assert.equal(handler.match(/strict json/g)?.length, 2);
});

test('published CLI tree fails install clearly without repo-only templates while help still works', () => {
  const deployedRoot = join(ROOT, 'deployed-vault');
  const whitelist = JSON.parse(readFileSync(join(PROJECT_ROOT, 'publish-whitelist.json'), 'utf8')).entries;
  // 21 since #12 added scripts/lib/brainkit-conf.mjs. This number is a
  // deliberate lock: the publish face is not allowed to grow without the change
  // being visible in a diff.
  assert.equal(whitelist.length, 21);
  for (const entry of whitelist) {
    const target = join(deployedRoot, entry.target);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(PROJECT_ROOT, entry.source), target);
  }
  assert.equal(existsSync(join(deployedRoot, '00-系统', 'templates')), false);

  const testHome = join(ROOT, 'home');
  const clipEnv = join(ROOT, 'clip.env');
  mkdirSync(testHome);
  writeFileSync(clipEnv, 'DEEPSEEK_API_KEY=test-only-value\n', { mode: 0o600 });
  chmodSync(clipEnv, 0o600);
  const env = {
    ...process.env,
    HOME: testHome,
    BRAIN_VAULT_ROOT: deployedRoot,
    BRAIN_WATCH_ROOT: ROOT,
    BRAIN_FSWATCH_PATH: fakeFswatch,
    BRAIN_CLIP_ENV_PATH: clipEnv,
  };
  const cliPaths = [
    join(deployedRoot, '00-系统', 'scripts', 'cli', 'brain-clip.mjs'),
    join(deployedRoot, '00-系统', 'scripts', 'daemon', 'brain-watch.mjs'),
  ];
  for (const cliPath of cliPaths) {
    const help = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8', env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);

    // Used to check the message named the brainkit repo, because install only
    // worked from a clone. It no longer exists anywhere, so the message has to
    // point at the one installer that does.
    const install = spawnSync(process.execPath, [cliPath, 'install'], { encoding: 'utf8', env });
    assert.notEqual(install.status, 0);
    assert.match(install.stderr, /node install\.mjs install/);
    assert.doesNotMatch(install.stderr, /ENOENT/);
  }
});

test('example configs are parseable and env examples contain comments only', () => {
  for (const name of [
    'vault-routing.example.json',
    'project-map.example.json',
    'tool-registry.example.json',
  ]) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(PROJECT_ROOT, 'templates', name), 'utf8')));
  }
  for (const name of ['observe.env.example', 'clip.env.example']) {
    const lines = readFileSync(join(PROJECT_ROOT, 'templates', name), 'utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length > 0);
    assert.ok(lines.every(line => /^# [A-Z][A-Z0-9_]*=$/.test(line)));
  }
  const wrapper = spawnSync('/bin/sh', ['-n', join(PROJECT_ROOT, 'templates', 'watch-wrapper.sh')]);
  assert.equal(wrapper.status, 0);
});

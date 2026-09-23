#!/usr/bin/env node

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
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
  clipDisposition,
  classifyClipImage,
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

function reviewed(text, overrides = {}) {
  return { curator_version: 1, curator_sha256: createHash('sha256').update(text).digest('hex'), content_kind: 'reference', vault_layer: '02-知识', confidence: 0.95, title: 'fixture', summary: String(text), reasoning: '明确可复用的参考说明', ...overrides };
}

test('clip admission never treats copied text, low confidence or failed classification as approval', () => {
  const text = 'UTF-8 读取必须固定子进程语言环境，原始载荷先保存再处理。';
  const valid = { curator_version: 1, curator_sha256: createHash('sha256').update(text).digest('hex'), content_kind: 'reference', vault_layer: '02-知识', confidence: 0.95, title: 'UTF-8', summary: text, reasoning: '明确的可复用技术说明' };
  assert.equal(clipDisposition(valid, text).action, 'accept');
  assert.equal(clipDisposition({ ...valid, content_kind: 'handoff' }, text).action, 'reject');
  assert.equal(clipDisposition({ ...valid, confidence: 0.3 }, text).action, 'review');
  assert.equal(clipDisposition({ ...valid, confidence: NaN }, text).action, 'review');
  assert.equal(clipDisposition({ confidence: 1, vault_layer: '02-知识' }, text).action, 'review');
  assert.equal(clipDisposition(null, text).action, 'review');
  assert.equal(clipDisposition(valid, text + '后来又追加了别的内容').action, 'review');
  assert.equal(clipDisposition(valid, '中文已经变成????????????????????????').action, 'reject');
  const image = Buffer.from('image bytes, not the OCR text');
  const imageReview = reviewed(image);
  assert.equal(clipDisposition(imageReview, image).action, 'accept');
  assert.equal(clipDisposition(imageReview, Buffer.from('different image')).action, 'review');
  assert.equal(clipDisposition(valid, image).action, 'review');
});

test('image admission binds original bytes and incomplete vision output stays pending', async () => {
  const bytes = Buffer.from('original image');
  let requestBody;
  const requestImpl = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.write = body => { requestBody = JSON.parse(body); };
    request.end = () => {
      const response = new EventEmitter(); response.statusCode = 200;
      callback(response);
      response.emit('data', JSON.stringify({ choices: [{ message: { content: JSON.stringify({ confidence: 1, vault_layer: '02-知识', ocr_text: '交接闲聊' }) } }] }));
      response.emit('end');
    };
    request.destroy = error => request.emit('error', error);
    return request;
  };
  const llm = await classifyClipImage(bytes, { DEEPSEEK_API_KEY: 'test-only' }, requestImpl);
  assert.equal(llm.curator_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(clipDisposition(llm, bytes).action, 'review');
  assert.match(JSON.stringify(requestBody), /复制不代表收藏意图/);
  assert.match(JSON.stringify(requestBody), new RegExp(bytes.toString('base64')));
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

function runClip(...args) {
  return spawnSync(process.execPath, [CLIP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_VAULT_ROOT: ROOT },
  });
}

test('managed rejection retains bytes and images, is repeatable, and blocks consumption', () => {
  const stamp = '2026-09-06-110000000';
  const pending = join(PENDING, `${stamp}.json`);
  const image = join(ROOT, 'raw', `${stamp}.png`);
  writeFileSync(image, 'original image');
  const original = JSON.stringify({ filename: stamp, imagePath: `raw/${stamp}.png`, text: 'mis-capture' });
  writeFileSync(pending, original);
  const rejected = runClip('reject', stamp, '--source', 'codex', '--reason', 'mis-capture');
  assert.equal(rejected.status, 0, rejected.stderr);
  const receipt = JSON.parse(rejected.stdout);
  const saved = JSON.parse(readFileSync(receipt.backup_path, 'utf8'));
  assert.equal(Buffer.from(saved.pending_base64, 'base64').toString(), original);
  assert.equal(readFileSync(image, 'utf8'), 'original image');
  assert.equal(existsSync(pending), false);
  assert.equal(runClip('reject', stamp, '--source', 'codex', '--reason', 'mis-capture').status, 0);
  // A replayed pending file must not override the retained rejection.
  writeFileSync(pending, original);
  assert.notEqual(runClip('approve', stamp).status, 0);
  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts/cli/observe.mjs'), '--clips', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, BRAIN_VAULT_ROOT: ROOT },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!JSON.parse(result.stdout).parsed.some(item => item.file === pending));
});

test('managed rejection rejects traversal and a linked pending directory', () => {
  assert.notEqual(runClip('reject', '../escape', '--source', 'codex', '--reason', 'test').status, 0);
  const root = mkdtempSync(join(TMP_PARENT, 'reject-boundary-'));
  const outside = join(root, 'outside');
  const vault = join(root, 'vault');
  mkdirSync(outside); mkdirSync(join(vault, 'raw'), { recursive: true });
  symlinkSync(outside, join(vault, 'raw/pending'));
  const stamp = '2026-09-06-120000000';
  writeFileSync(join(outside, `${stamp}.json`), '{}');
  const result = spawnSync(process.execPath, [CLIP, 'reject', stamp, '--source', 'codex', '--reason', 'test'], {
    encoding: 'utf8', env: { ...process.env, BRAIN_VAULT_ROOT: vault },
  });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(outside, `${stamp}.json`), 'utf8'), '{}');
  rmSync(root, { recursive: true, force: true });
});

test('HTML capture never fetches remote images, including short discarded HTML', () => {
  const fixture = join(ROOT, 'html-capture');
  mkdirSync(fixture);
  const envPath = join(fixture, 'clip.env');
  writeFileSync(envPath, 'DEEPSEEK_API_KEY=test-only\n', { mode: 0o600 });
  const handler = join(PROJECT_ROOT, 'scripts/daemon/brain-clip-handler.mjs');
  const code = `
    import http from 'node:http'; import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    let imageRequests = 0;
    const request = (url, options) => {
      if ((options?.method || url.method || 'GET') === 'GET') imageRequests++;
      throw new Error('test transport: no network');
    };
    http.request = https.request = request; syncBuiltinESMExports();
    const { processHtml } = await import(${JSON.stringify(handler)});
    for (const body of ['short', 'article '.repeat(40)]) {
      const input = join(process.env.HOME, 'input.html');
      writeFileSync(input, '<p>' + body + '</p><img src="https://example.test/image.png">');
      await processHtml(input);
    }
    const pending = join(process.env.BRAIN_VAULT_ROOT, 'raw/pending');
    const notes = readdirSync(pending).map(name => JSON.parse(readFileSync(join(pending, name))));
    console.log(JSON.stringify({ imageRequests, notes }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, HOME: fixture, BRAIN_VAULT_ROOT: fixture, BRAIN_CLIP_ENV_PATH: envPath },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(output.imageRequests, 0);
  assert.equal(output.notes.length, 1);
  assert.match(output.notes[0].markdown, /https:\/\/example.test\/image.png/);
  assert.equal(existsSync(join(fixture, '00-系统/attachments')), false);
});

test('image handler holds incomplete reviews and retries an event when pending storage fails', () => {
  const fixture = join(ROOT, 'image-review-retry');
  mkdirSync(join(fixture, 'raw'), { recursive: true });
  const envPath = join(fixture, 'clip.env');
  writeFileSync(envPath, 'DEEPSEEK_API_KEY=test-only\n', { mode: 0o600 });
  const code = `
    import fs from 'node:fs'; import cp from 'node:child_process'; import https from 'node:https';
    import { EventEmitter } from 'node:events'; import { syncBuiltinESMExports } from 'node:module'; import { join } from 'node:path';
    let count = 1, fail = false, writes = 0;
    cp.execFileSync = (_cmd, args) => { fs.writeFileSync(args[0], 'image bytes ' + count); return 'OK:' + count; };
    cp.spawnSync = () => { writes++; throw new Error('unexpected writer'); };
    https.request = (_url, _options, callback) => {
      if (fail) throw new Error('test API outage');
      const req = new EventEmitter(); req.write = () => {};
      req.end = () => { const response = new EventEmitter(); callback(response);
        response.emit('data', JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '未审阅', summary: '交接', vault_layer: '02-知识', confidence: 1, ocr_text: '交接闲聊' }) } }] })); response.emit('end'); };
      req.destroy = err => req.emit('error', err); return req;
    };
    syncBuiltinESMExports();
    const { pollClipboard } = await import(${JSON.stringify(join(PROJECT_ROOT, 'scripts/daemon/brain-clip-handler.mjs'))});
    const pending = join(process.env.HOME, 'raw/pending');
    const state = () => JSON.parse(fs.readFileSync(join(process.env.HOME, '.second-brain-clip-state.json'))).lastChangeCount;
    await pollClipboard();
    const held = fs.readdirSync(pending).length;
    fs.rmSync(pending, { recursive: true }); fs.writeFileSync(pending, 'temporary obstacle');
    fail = true; count = 2;
    await pollClipboard(); const blockedState = state();
    fs.unlinkSync(pending);
    await pollClipboard();
    console.log(JSON.stringify({ writes, held, blockedState, finalState: state(), retried: fs.readdirSync(pending).length }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, HOME: fixture, BRAIN_VAULT_ROOT: fixture, BRAIN_CLIP_ENV_PATH: envPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { writes: 0, held: 1, blockedState: 1, finalState: 2, retried: 1 });
});

test('clipboard UTF-8 capture survives C locale and quarantines undecodable bytes', () => {
  const fixture = join(ROOT, 'clipboard-encoding');
  mkdirSync(fixture);
  const envPath = join(fixture, 'clip.env');
  writeFileSync(envPath, 'DEEPSEEK_API_KEY=test-only\n', { mode: 0o600 });
  const original = ' 中文 𠮷 😀 normal?\n'.repeat(30);
  const code = `
    import cp from 'node:child_process'; import https from 'node:https'; import { syncBuiltinESMExports } from 'node:module';
    https.request = () => { throw new Error('test transport: no network'); };
    import { readFileSync, readdirSync, existsSync } from 'node:fs'; import { join } from 'node:path';
    let bad = false;
    cp.execFileSync = (command, args, options) => {
      if (command !== '/usr/bin/pbpaste') throw new Error('unexpected command');
      if (bad) return Buffer.from([0xff, 0xfe, 0x80]);
      return Buffer.from(options?.env?.LC_ALL === 'en_US.UTF-8' ? ${JSON.stringify(original)} : '???');
    }; syncBuiltinESMExports();
    const { readClipboardText, processText } = await import(${JSON.stringify(join(PROJECT_ROOT, 'scripts/daemon/brain-clip-handler.mjs'))});
    const text = readClipboardText(); await processText(text);
    bad = true; let refused = false;
    try { readClipboardText(); } catch { refused = true; }
    const root = process.env.BRAIN_VAULT_ROOT;
    const notes = readdirSync(join(root, 'raw/pending')).map(n => JSON.parse(readFileSync(join(root, 'raw/pending', n))));
    const errors = readdirSync(join(root, 'raw/processed/clip-encoding-errors')).map(n => JSON.parse(readFileSync(join(root, 'raw/processed/clip-encoding-errors', n))));
    console.log(JSON.stringify({text, refused, notes, original: readFileSync(join(root, notes[0].originalPath), 'utf8'), bad: [...readFileSync(join(root, errors[0].originalPath))]}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, HOME: fixture, BRAIN_VAULT_ROOT: fixture, BRAIN_CLIP_ENV_PATH: envPath, LC_ALL: 'C', LANG: 'C' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.text, original);
  assert.equal(output.original, original);
  assert.equal(output.notes[0].text, original);
  assert.equal(output.notes.length, 1);
  assert.equal(output.refused, true);
  assert.deepEqual(output.bad, [255, 254, 128]);
});

test('invalid or declared legacy HTML retains bytes and uses only a verified text companion', () => {
  const fixture = join(ROOT, 'html-encoding');
  mkdirSync(fixture);
  const envPath = join(fixture, 'clip.env'); writeFileSync(envPath, 'DEEPSEEK_API_KEY=test-only\n', { mode: 0o600 });
  const original = '原始中文 😀 𠮷 ?\n'.repeat(30);
  const code = `
    import { readFileSync, writeFileSync, readdirSync } from 'node:fs'; import { join } from 'node:path';
    import https from 'node:https'; import { syncBuiltinESMExports } from 'node:module';
    https.request = () => { throw new Error('test transport: no network'); }; syncBuiltinESMExports();
    const { processHtml } = await import(${JSON.stringify(join(PROJECT_ROOT, 'scripts/daemon/brain-clip-handler.mjs'))});
    const path = join(process.env.HOME, 'input.html');
    const invalid = Buffer.concat([Buffer.from('<p>'), Buffer.from([0xff]), Buffer.from('x'.repeat(250) + '</p>')]);
    writeFileSync(path, invalid); await processHtml(path);
    writeFileSync(path, '<meta charset="gbk"><p>' + 'legacy '.repeat(50) + '</p>');
    await processHtml(path, ${JSON.stringify(original)});
    const root = process.env.HOME;
    const errors = readdirSync(join(root, 'raw/processed/clip-encoding-errors')).map(n => JSON.parse(readFileSync(join(root, 'raw/processed/clip-encoding-errors', n))));
    const notes = readdirSync(join(root, 'raw/pending')).map(n => JSON.parse(readFileSync(join(root, 'raw/pending', n))));
    console.log(JSON.stringify({notes, saved: errors.map(e => [...readFileSync(join(root, e.originalPath))]), invalid: [...invalid]}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',
    env: { ...process.env, HOME: fixture, BRAIN_VAULT_ROOT: fixture, BRAIN_CLIP_ENV_PATH: envPath } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.notes.length, 1);
  assert.equal(output.notes[0].text, original);
  assert.equal(output.saved.length, 2);
  assert.ok(output.saved.some(bytes => JSON.stringify(bytes) === JSON.stringify(output.invalid)));
});

test('HTML companion refuses a newer clipboard entry and non-text pbpaste fallback', () => {
  const fixture = join(ROOT, 'html-companion'); mkdirSync(join(fixture, 'raw'), { recursive: true });
  const envPath = join(fixture, 'clip.env'); writeFileSync(envPath, 'DEEPSEEK_API_KEY=test-only\n', { mode: 0o600 });
  const code = `
    import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    let count = 4, text = '正常中文?';
    cp.execFileSync = command => command === '/usr/bin/pbpaste' ? Buffer.from(text) : 'HTML:20:' + count;
    syncBuiltinESMExports();
    const { readHtmlCompanion } = await import(${JSON.stringify(join(PROJECT_ROOT, 'scripts/daemon/brain-clip-handler.mjs'))});
    const same = readHtmlCompanion(4); count = 5;
    const newer = readHtmlCompanion(4); text = '{\\\\rtf1 data}';
    const rtf = readHtmlCompanion(5);
    console.log(JSON.stringify({same, newer: newer ?? null, rtf: rtf ?? null}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',
    env: { ...process.env, HOME: fixture, BRAIN_VAULT_ROOT: fixture, BRAIN_CLIP_ENV_PATH: envPath } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { same: '正常中文?', newer: null, rtf: null });
});

test('poll preserves equal-sized HTML and retries after original storage failure', () => {
  const fixture = join(ROOT, 'poll-retention'); mkdirSync(join(fixture, 'raw'), { recursive: true });
  const envPath = join(fixture, 'clip.env'); writeFileSync(envPath, 'DEEPSEEK_API_KEY=test-only\n', { mode: 0o600 });
  const code = `
    import cp from 'node:child_process'; import https from 'node:https'; import fs from 'node:fs';
    import { join } from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
    https.request = () => { throw new Error('test transport: no network'); };
    let count = 1, html = '<p>' + '甲'.repeat(230) + '</p>', text = '重试中文'.repeat(80);
    cp.execFileSync = (cmd, args) => {
      if (cmd === '/usr/bin/pbpaste') return Buffer.from(text);
      if (html) { fs.writeFileSync(args[0], html); return 'HTML:' + Buffer.byteLength(html) + ':' + count; }
      return 'NO_IMAGE:' + count;
    }; syncBuiltinESMExports();
    const { pollClipboard } = await import(${JSON.stringify(join(PROJECT_ROOT, 'scripts/daemon/brain-clip-handler.mjs'))});
    await pollClipboard(); count++; html = html.replaceAll('甲', '乙'); await pollClipboard();
    const root = process.env.HOME, originals = join(root, 'raw/processed/clip-originals');
    if (!fs.existsSync(originals)) throw new Error(fs.readFileSync(join(root, 'Library/Logs/second-brain/clip-daemon.log'), 'utf8'));
    const htmlCount = fs.readdirSync(originals).filter(n => n.endsWith('.html')).length;
    const failedCounts = [];
    for (const mode of ['html', 'text']) {
      fs.renameSync(originals, originals + '.saved'); fs.writeFileSync(originals, 'temporary obstruction');
      html = mode === 'html' ? '<p>' + '丙'.repeat(230) + '</p>' : ''; count++; await pollClipboard();
      failedCounts.push(JSON.parse(fs.readFileSync(join(root, '.second-brain-clip-state.json'))).lastChangeCount);
      fs.renameSync(originals, originals + '.obstruction-' + mode); fs.renameSync(originals + '.saved', originals);
      await pollClipboard();
    }
    const notes = fs.readdirSync(join(root, 'raw/pending')).map(n => JSON.parse(fs.readFileSync(join(root, 'raw/pending', n))));
    console.log(JSON.stringify({htmlCount, failedCounts, finalCount: JSON.parse(fs.readFileSync(join(root, '.second-brain-clip-state.json'))).lastChangeCount,
      savedText: fs.readdirSync(originals).some(n => n.endsWith('.txt') && fs.readFileSync(join(originals,n),'utf8') === text), notes: notes.length}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',
    env: { ...process.env, HOME: fixture, BRAIN_VAULT_ROOT: fixture, BRAIN_CLIP_ENV_PATH: envPath } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { htmlCount: 2, failedCounts: [2, 3], finalCount: 4, savedText: true, notes: 4 });
});

test('project archive refuses a linked project index without changing the map', () => {
  const fixture = join(ROOT, 'archive-project');
  const outside = join(fixture, 'outside');
  const vault = join(fixture, 'vault');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(vault, '01-项目'), { recursive: true });
  mkdirSync(join(vault, '00-系统'));
  const mapPath = join(vault, '00-系统/.project-map.json');
  const map = JSON.stringify({ mappings: [{ vaultDir: '01-项目/linked' }] });
  writeFileSync(mapPath, map);
  symlinkSync(outside, join(vault, '01-项目/linked'));
  const original = '---\nname: sentinel\n---\nKeep me\n';
  writeFileSync(join(outside, '_index.md'), original);
  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts/cli/brain-archive.mjs'), 'linked'], {
    encoding: 'utf8', env: { ...process.env, BRAIN_VAULT_ROOT: vault },
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(readFileSync(join(outside, '_index.md'), 'utf8'), original);
  assert.equal(readFileSync(mapPath, 'utf8'), map);
});

test('clip transaction retains image on failure, resumes partial writes, and does not duplicate on replay', () => {
  const fixture = join(ROOT, 'clip-transaction');
  const vault = join(fixture, 'vault');
  const memory = join(fixture, 'memory');
  mkdirSync(join(vault, 'raw/pending'), { recursive: true });
  mkdirSync(join(vault, '00-系统/.index-cache'), { recursive: true });
  mkdirSync(memory);
  const routing = join(fixture, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'vault-routing-v2',
    routes: [{ type: 'note', path: '07-随笔/', scope: 'global' }],
    section_policies: { '07-随笔/': { policy: 'allow_root', requires_subfolder: false } } }));
  writeFileSync(join(vault, '00-系统/.project-map.json'), '{"mappings":[]}');
  writeFileSync(join(memory, 'MEMORY.md'), '# Memory Index\n');
  const stamp = '2026-09-06-130000000';
  const pending = join(vault, 'raw/pending', `${stamp}.json`);
  const original = JSON.stringify({ filename: stamp, imagePath: `raw/${stamp}.png`,
    timestamp: '2026-09-06T13:00:00', llm: { vault_layer: '07-随笔', title: '事务测试', summary: 'fixture', ocr_text: 'original OCR' } });
  writeFileSync(pending, original);
  const raw = join(vault, 'raw', `${stamp}.png`);
  writeFileSync(raw, 'complete original image');
  const env = { ...process.env, HOME: fixture, BRAIN_VAULT_ROOT: vault, BRAIN_MEMORY_DIR: memory, BRAIN_ROUTING_JSON: routing };
  const writer = join(PROJECT_ROOT, 'scripts/cli/brain-write.mjs');
  const invoke = (code = null) => spawnSync(process.execPath, code ? ['--input-type=module', '-e', code] : [CLIP, 'approve', stamp], { env, encoding: 'utf8' });
  // Fail after the note is written but before its memory indexes. No real I/O outside this fixture.
  const fault = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === ${JSON.stringify(join(memory, 'MEMORY.md'))}) throw new Error('injected index failure'); return rename(from, to); };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(writer)}, '--type', 'note', '--title', '事务测试', '--description', 'fixture', '--source', 'clip',
      '--body', 'original OCR', '--files', '00-系统/attachments/${stamp}.png', '--clip-id', '${stamp}',
      '--clip-sha256', '${createHash('sha256').update(original).digest('hex')}'];
    await import(${JSON.stringify(writer)});
  `;
  const failed = invoke(fault);
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.match(failed.stderr, /injected index failure/);
  assert.equal(readFileSync(raw, 'utf8'), 'complete original image');
  assert.equal(readFileSync(pending, 'utf8'), original);
  const attachment = join(vault, '00-系统/attachments', `${stamp}.png`);
  assert.equal(readFileSync(attachment, 'utf8'), 'complete original image');
  const commitPath = join(vault, 'raw/processed/brain-write/clip-commits', `${stamp}.json`);
  const plan = JSON.parse(readFileSync(commitPath));
  assert.equal(readFileSync(plan.receipt.path, 'utf8').includes('original OCR'), true);
  writeFileSync(join(memory, 'MEMORY.md'), 'unrelated third value');
  const conflict = invoke();
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /clip commit conflict/);
  assert.equal(readFileSync(join(memory, 'MEMORY.md'), 'utf8'), 'unrelated third value');
  assert.ok(existsSync(pending));
  writeFileSync(join(memory, 'MEMORY.md'), '# Memory Index\n');
  const resumed = invoke();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(existsSync(pending), false);
  assert.equal(readdirSync(join(vault, '07-随笔')).filter(name => name.endsWith('.md')).length, 1);
  const indexBefore = readFileSync(join(memory, 'MEMORY.md'), 'utf8');
  // Simulate a producer replay after the original successful response was lost.
  writeFileSync(pending, original);
  assert.equal(invoke().status, 0);
  assert.equal(readFileSync(join(memory, 'MEMORY.md'), 'utf8'), indexBefore);
  assert.equal(readFileSync(raw, 'utf8'), 'complete original image');
  assert.equal(existsSync(pending), false);
});

test('observe refuses external image and attachment parents without consuming pending', () => {
  for (const link of ['raw-image', 'attachments']) {
    const fixture = join(ROOT, `observe-${link}`);
    const vault = join(fixture, 'vault');
    const outside = join(fixture, 'outside');
    mkdirSync(join(vault, 'raw/pending'), { recursive: true });
    mkdirSync(join(vault, '00-系统'), { recursive: true });
    mkdirSync(outside);
    const stamp = '2026-09-06-140000000';
    const source = link === 'raw-image' ? join(outside, 'image.png') : join(vault, 'raw/image.png');
    writeFileSync(source, 'outside sentinel');
    if (link === 'raw-image') symlinkSync(outside, join(vault, 'raw/linked'));
    else symlinkSync(outside, join(vault, '00-系统/attachments'));
    const pending = join(vault, 'raw/pending', `${stamp}.json`);
    const text = 'retained evidence';
    const original = JSON.stringify({ text, llm: reviewed('outside sentinel'), imagePath: link === 'raw-image' ? 'raw/linked/image.png' : 'raw/image.png' });
    writeFileSync(pending, original);
    const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts/cli/observe.mjs'), '--clips'], {
      encoding: 'utf8', env: { ...process.env, BRAIN_VAULT_ROOT: vault },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /outside vault/);
    assert.equal(readFileSync(source, 'utf8'), 'outside sentinel');
    assert.equal(readFileSync(pending, 'utf8'), original);
    assert.deepEqual(readdirSync(outside), link === 'raw-image' ? ['image.png'] : []);
  }
});

test('observe continues after an invalid pending filename and consumes the valid clip', () => {
  const vault = join(ROOT, 'observe-invalid-name');
  const pending = join(vault, 'raw/pending');
  mkdirSync(pending, { recursive: true });
  const routing = join(vault, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'vault-routing-v2',
    routes: [{ type: 'observation', path: '08-观察/', scope: 'global' }],
    section_policies: { '08-观察/': { policy: 'allow_root', requires_subfolder: false } } }));
  const invalid = join(pending, '000-invalid.json');
  const valid = join(pending, '2026-09-06-140001000.json');
  writeFileSync(invalid, '{}');
  writeFileSync(valid, JSON.stringify({ title: 'valid clip', text: 'retained evidence', llm: reviewed('retained evidence'), timestamp: '2026-09-06T14:00:01Z' }));
  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts/cli/observe.mjs'), '--clips'], {
    encoding: 'utf8', env: { ...process.env, HOME: vault, BRAIN_VAULT_ROOT: vault,
      BRAIN_MEMORY_DIR: join(vault, 'memory'), BRAIN_ROUTING_JSON: routing },
  });
  assert.equal(result.status, 1, result.stderr);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.observations, 1, result.stdout);
  assert.deepEqual(Object.keys(stats.errors), [invalid]);
  assert.match(stats.errors[invalid], /Invalid timestamp/);
  assert.equal(readFileSync(invalid, 'utf8'), '{}');
  assert.equal(existsSync(valid), false);
});

test('observe admits reviewed evidence, rejects handoffs, and retains unreviewed candidates during outage', () => {
  const vault = join(ROOT, 'observe-admission');
  const pending = join(vault, 'raw/pending');
  mkdirSync(pending, { recursive: true });
  const routing = join(vault, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'vault-routing-v2',
    routes: [{ type: 'observation', path: '08-观察/', scope: 'global' }],
    section_policies: { '08-观察/': { policy: 'allow_root', requires_subfolder: false } } }));
  const cases = [
    { text: 'pbpaste 必须固定 UTF-8', llm: reviewed('pbpaste 必须固定 UTF-8') },
    { text: '复制给 Claude 的交接进度', llm: reviewed('复制给 Claude 的交接进度', { content_kind: 'handoff' }) },
    { text: '还需要核实的候选', llm: reviewed('还需要核实的候选', { confidence: 0.4 }) },
    { text: '旧格式不能伪装审批', llm: { confidence: 1, vault_layer: '03-经验' } },
  ];
  const paths = cases.map((data, index) => {
    const file = join(pending, `2026-09-06-15000000${index}.json`);
    writeFileSync(file, JSON.stringify(data));
    return file;
  });
  const before = paths.map(file => readFileSync(file, 'utf8'));
  const env = { ...process.env, HOME: vault, BRAIN_VAULT_ROOT: vault, BRAIN_MEMORY_DIR: join(vault, 'memory'),
    BRAIN_ROUTING_JSON: routing, BRAIN_CLIP_ENV_PATH: join(vault, 'missing.env') };
  const command = [join(PROJECT_ROOT, 'scripts/cli/observe.mjs'), '--clips'];
  const dry = spawnSync(process.execPath, [...command, '--dry-run'], { encoding: 'utf8', env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(paths.map(file => readFileSync(file, 'utf8')), before);
  const result = spawnSync(process.execPath, command, { encoding: 'utf8', env });
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.observations, 1, result.stdout);
  assert.equal(stats.rejected, 1, result.stdout);
  assert.equal(Object.keys(stats.errors).length, 2, result.stdout);
  assert.equal(result.status, 1);
  assert.equal(existsSync(paths[0]), false);
  assert.equal(existsSync(paths[1]), false);
  assert.equal(readFileSync(paths[2], 'utf8'), before[2]);
  assert.equal(readFileSync(paths[3], 'utf8'), before[3]);
});

test('writer compares staged image bytes with review before admission or automatic rejection', () => {
  const vault = join(ROOT, 'image-sink-cas');
  const pendingDir = join(vault, 'raw/pending');
  mkdirSync(pendingDir, { recursive: true });
  const routing = join(vault, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'vault-routing-v2', routes: [{ type: 'observation', path: '08-观察/', scope: 'global' }],
    section_policies: { '08-观察/': { policy: 'allow_root', requires_subfolder: false } } }));
  const stamp = '2026-09-06-170000000';
  const pending = join(pendingDir, stamp + '.json');
  const image = join(vault, 'raw', stamp + '.png');
  const hashA = createHash('sha256').update('reviewed A').digest('hex');
  const hashB = createHash('sha256').update('replacement B').digest('hex');
  const original = JSON.stringify({ imagePath: 'raw/' + stamp + '.png', llm: reviewed('reviewed A') });
  writeFileSync(pending, original); writeFileSync(image, 'replacement B');
  const env = { ...process.env, HOME: vault, BRAIN_VAULT_ROOT: vault, BRAIN_MEMORY_DIR: join(vault, 'memory'), BRAIN_ROUTING_JSON: routing };
  const writer = join(PROJECT_ROOT, 'scripts/cli/brain-write.mjs');
  const args = ['--type', 'observation', '--subfolder', '2026-09', '--title', 'image CAS', '--description', 'reviewed source', '--body', 'current evidence', '--source', 'observe',
    '--files', '00-系统/attachments/' + stamp + '.png', '--clip-id', stamp, '--clip-sha256', createHash('sha256').update(original).digest('hex')];
  const run = values => spawnSync(process.execPath, [writer, ...values], { encoding: 'utf8', env });
  const denied = run(args);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /clip image changed since review/);
  const rejected = run(['--reject-clip', stamp, '--clip-image-sha256', hashA, '--source', 'observe', '--reason', 'stale image review']);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /clip image changed since review/);
  assert.equal(readFileSync(pending, 'utf8'), original);
  assert.equal(existsSync(join(vault, '00-系统/attachments', stamp + '.png')), false);
  // observe can re-review B without overwriting the original pending JSON.
  const accepted = run([...args, '--clip-image-sha256', hashB]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(readFileSync(join(vault, '00-系统/attachments', stamp + '.png'), 'utf8'), 'replacement B');
  assert.equal(existsSync(pending), false);
});

test('observe rotates retained candidates instead of starving later arrivals', () => {
  const vault = join(ROOT, 'observe-rotation');
  const pending = join(vault, 'raw/pending');
  mkdirSync(pending, { recursive: true });
  for (const stamp of ['2026-09-06-160000000', '2026-09-06-160001000', '2026-09-06-160002000']) {
    writeFileSync(join(pending, stamp + '.json'), JSON.stringify({ text: '未审阅候选，不允许默认入库' }));
  }
  const command = [join(PROJECT_ROOT, 'scripts/cli/observe.mjs'), '--clips', '--limit', '2'];
  const env = { ...process.env, HOME: vault, BRAIN_VAULT_ROOT: vault, BRAIN_CLIP_ENV_PATH: join(vault, 'missing.env') };
  const first = spawnSync(process.execPath, command, { encoding: 'utf8', env });
  const second = spawnSync(process.execPath, command, { encoding: 'utf8', env });
  assert.equal(first.status, 1);
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(first.stdout).parsed.length, 2);
  assert.match(JSON.parse(second.stdout).parsed[0].file, /160002000.json$/);
  assert.equal(readdirSync(pending).length, 3);
});

test('observe confines every lock and checkpoint mutation including linked leaves', () => {
  for (const shape of ['system', 'cache', 'lock-symlink', 'lock-hardlink', 'checkpoint-symlink', 'checkpoint-hardlink', 'checkpoint-cache']) {
    const base = join(ROOT, 'observe-state-' + shape);
    const vault = join(base, 'vault');
    const external = join(base, 'outside');
    const cache = join(vault, '00-系统/.index-cache');
    mkdirSync(join(vault, 'raw/pending'), { recursive: true });
    mkdirSync(external);
    const checkpoint = shape.startsWith('checkpoint');
    const filename = checkpoint ? 'observe-checkpoint.json' : 'observe.lock';
    const sentinel = join(external, filename);
    const before = JSON.stringify(checkpoint ? { processed: {}, errors: {}, marker: 'external' } : { pid: 2147483647, marker: 'external' });
    writeFileSync(sentinel, before);
    if (shape === 'system') {
      mkdirSync(join(external, '.index-cache'));
      writeFileSync(join(external, '.index-cache/observe.lock'), before);
      symlinkSync(external, join(vault, '00-系统'));
    } else if (shape === 'cache' || shape === 'checkpoint-cache') {
      mkdirSync(join(vault, '00-系统'));
      symlinkSync(external, cache);
    } else {
      mkdirSync(cache, { recursive: true });
      (shape.endsWith('hardlink') ? linkSync : symlinkSync)(sentinel, join(cache, filename));
    }
    const observe = join(PROJECT_ROOT, 'scripts/cli/observe.mjs');
    const args = checkpoint ? ['--input-type=module', '-e',
      `const { saveCheckpoint } = await import(${JSON.stringify(observe)}); saveCheckpoint({ processed: {}, errors: {} });`]
      : [observe, '--clips'];
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8', env: { ...process.env, HOME: vault, BRAIN_VAULT_ROOT: vault },
    });
    assert.notEqual(result.status, 0, shape);
    assert.match(result.stderr, /outside vault|single-link regular file/, shape);
    assert.equal(readFileSync(sentinel, 'utf8'), before, shape);
    if (shape === 'system') assert.equal(readFileSync(join(external, '.index-cache/observe.lock'), 'utf8'), before);
  }
});

test('watch handler refuses a linked project card through the real stdin entry', async () => {
  const fixture = join(ROOT, 'watch-boundary');
  const vault = join(fixture, 'vault');
  const outside = join(fixture, 'outside');
  const project = join(fixture, 'project');
  for (const path of [outside, project, join(vault, '00-系统'), join(vault, '01-项目')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(outside, '_index.md'), 'external project sentinel');
  symlinkSync(outside, join(vault, '01-项目/linked'));
  writeFileSync(join(vault, '00-系统/.project-map.json'), JSON.stringify({ mappings: [{ localPath: project, vaultDir: '01-项目/linked' }] }));
  const child = spawn(process.execPath, [join(PROJECT_ROOT, 'scripts/daemon/brain-watch-handler.mjs')], {
    env: { ...process.env, HOME: fixture, BRAIN_VAULT_ROOT: vault }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const closed = new Promise(done => child.on('close', done));
  child.stdin.write(project + '\n');
  const log = join(fixture, 'Library/Logs/second-brain/daemon.log');
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !(existsSync(log) && /\[ERROR\]|\[UPDATED\]/.test(readFileSync(log, 'utf8')))) {
      await new Promise(done => setTimeout(done, 100));
    }
    assert.match(readFileSync(log, 'utf8'), /outside vault/);
    assert.equal(readFileSync(join(outside, '_index.md'), 'utf8'), 'external project sentinel');
    writeFileSync(join(vault, '_index.md'), 'vault root sentinel');
    writeFileSync(join(vault, '00-系统/.project-map.json'), JSON.stringify({ mappings: [{ localPath: project, vaultDir: '01-项目/..' }] }));
    child.stdin.write(project + '\n');
    const secondDeadline = Date.now() + 20000;
    while (Date.now() < secondDeadline && !readFileSync(log, 'utf8').includes('Invalid project vault directory')) {
      await new Promise(done => setTimeout(done, 100));
    }
    assert.match(readFileSync(log, 'utf8'), /Invalid project vault directory/);
    assert.equal(readFileSync(join(vault, '_index.md'), 'utf8'), 'vault root sentinel');
  } finally { child.kill(); await closed; }
});

test('timestamp matches the clip filename contract', () => {
  assert.match(makeTimestamp(), /^\d{4}-\d{2}-\d{2}-\d{9}$/);
  // Pending filenames are keyed on this alone and the writer renames over an
  // existing name, so a repeat within one millisecond loses a capture.
  const stamps = Array.from({ length: 2000 }, makeTimestamp);
  assert.equal(new Set(stamps).size, stamps.length);
  assert.deepEqual(stamps, [...stamps].sort());
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

test('reject without an actor and reason fails without deleting pending data', () => {
  const timestamp = '2026-04-06-140000000';
  const path = join(PENDING, `${timestamp}.json`);
  writeFileSync(path, '{}');
  const result = runClip('reject', timestamp);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: reject/);
  assert.ok(existsSync(path));
});

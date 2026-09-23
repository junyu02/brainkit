#!/usr/bin/env node
// Black-box regression suite for the brain-write CLI.
// Fixtures are intentionally retained under os.tmpdir(); no test deletes files.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER = resolve(HERE, '..', 'scripts', 'cli', 'brain-write.mjs');
const digest = value => createHash('sha256').update(value).digest('hex');
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
    { type: 'session', path: '04-对话/', scope: 'project' },
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

test('subfolder cannot escape its routed section into another vault section', () => {
  const f = makeFixtureVault();
  const result = runCli(f, ['--type', 'experience', '--subfolder', '../00-系统/logs', '--title', 'section-escape', '--description', 'fixture', '--body', 'fixture']);
  assert.notEqual(result.code, 0, 'section traversal must be rejected before policy lookup');
  assert.equal(existsSync(join(f.vault, '00-系统/logs/section-escape.md')), false);
});

test('project names cannot escape the project route before section validation', () => {
  const f = makeFixtureVault();
  const result = runCli(f, ['--type', 'project', '--project', '../00-系统/logs', '--title', 'project-escape', '--description', 'fixture', '--body', 'fixture']);
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(join(f.vault, '00-系统/logs/project-escape.md')), false);
});

test('managed rename previews, updates exact references, and restores every original byte', () => {
  const fixture = makeFixtureVault();
  const made = runCli(fixture, ['--type', 'experience', '--subfolder', 'AI工具', '--title', '旧标题', '--description', '说明', '--body', '原始正文\n## 段落\n原始附件 ![[00-系统/attachments/shared.png]]']);
  assert.equal(made.code, 0, made.stderr);
  const from = realpathSync(JSON.parse(made.stdout).path);
  const to = join(dirname(from), '新的 中文标题.md');
  const peer = join(dirname(from), '引用.md');
  const body = '---\nname: 引用\n---\n[[旧标题#段落|显示名]]\n![[03-经验/AI工具/旧标题^block]]\n[标签](旧标题.md#段落)\n[带标题](<旧标题.md> "说明")\n旧标题是文字\n`[[旧标题]]`\n```md\n[[旧标题]]\n```\n';
  writeFileSync(peer, body);
  const before = readFileSync(from, 'utf8');
  const alias = join(fixture.root, 'vault-alias'); symlinkSync(realpathSync(fixture.vault), alias);
  const argv = ['--rename', join(alias, relative(realpathSync(fixture.vault), from)), '--new-title', '新的 中文标题', '--expected-sha256', digest(before), '--reason', '标题更准确'];
  const internalAlias = join(fixture.vault, 'root-alias'); symlinkSync(realpathSync(fixture.vault), internalAlias);
  for (const root of [internalAlias, join(alias, 'root-alias')]) {
    const refused = runCli(fixture, ['--rename', join(root, relative(realpathSync(fixture.vault), from)), ...argv.slice(2)]);
    assert.notEqual(refused.code, 0);
  }
  assert.equal(readFileSync(from, 'utf8'), before);
  assert.equal(existsSync(to), false);
  const preview = runCli(fixture, [...argv, '--dry-run']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).status, 'preview');
  assert.equal(existsSync(to), false);
  assert.equal(readFileSync(peer, 'utf8'), body);
  const renamed = runCli(fixture, argv);
  assert.equal(renamed.code, 0, renamed.stderr);
  const receipt = JSON.parse(renamed.stdout);
  assert.equal(receipt.action, 'rename');
  assert.equal(existsSync(from), false);
  assert.match(readFileSync(to, 'utf8'), /^name: 新的 中文标题$/m);
  assert.match(readFileSync(to, 'utf8'), /原始附件 !\[\[00-系统\/attachments\/shared.png\]\]/);
  const linked = readFileSync(peer, 'utf8');
  assert.ok(linked.includes('[[新的 中文标题#段落|显示名]]'));
  assert.ok(linked.includes('![[03-经验/AI工具/新的 中文标题^block]]'));
  assert.ok(linked.includes('旧标题是文字\n`[[旧标题]]`\n```md\n[[旧标题]]\n```'));
  assert.ok(decodeURI(linked).includes('[标签](新的 中文标题.md#段落)'));
  const saved = JSON.parse(readFileSync(receipt.backup_path));
  assert.ok(saved.writes.some(w => w.path === from && w.before === before && w.after === null));
  assert.ok(readFileSync(join(fixture.memory, 'MEMORY.md'), 'utf8').includes('新的 中文标题'));
  const restored = runCli(fixture, ['--restore', receipt.operation_id, '--reason', '撤销改名']);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(readFileSync(from, 'utf8'), before);
  assert.equal(readFileSync(peer, 'utf8'), body);
  assert.equal(existsSync(to), false);
  assert.equal(existsSync(receipt.backup_path), true);
});

test('managed rename refuses collisions, escapes, ambiguous links and stale content before changing notes', () => {
  const fixture = makeFixtureVault();
  const result = runCli(fixture, ['--type', 'experience', '--subfolder', 'AI工具', '--title', '旧名', '--description', '说明', '--body', '原文']);
  const from = JSON.parse(result.stdout).path, before = readFileSync(from, 'utf8');
  const run = (title, hash = digest(before)) => runCli(fixture, ['--rename', from, '--new-title', title, '--expected-sha256', hash, '--reason', '测试']);
  for (const title of ['../出界', '旧名', '.hidden', '坏#标题']) assert.notEqual(run(title).code, 0, title);
  writeFileSync(join(dirname(from), '已有.md'), '已有内容');
  assert.notEqual(run('已有').code, 0);
  assert.notEqual(run('新名', '0'.repeat(64)).code, 0);
  const other = join(fixture.vault, '02-知识/同名'); mkdirSync(other, { recursive: true });
  writeFileSync(join(other, '旧名.md'), '另一个原文');
  writeFileSync(join(dirname(from), '引用.md'), '[[旧名]]');
  assert.notEqual(run('新名').code, 0);
  assert.equal(readFileSync(from, 'utf8'), before);
  assert.equal(readFileSync(join(dirname(from), '已有.md'), 'utf8'), '已有内容');
  assert.equal(existsSync(join(dirname(from), '新名.md')), false);
});

test('managed rename resumes interrupted writes and preserves third-party changes and recovery records', () => {
  // Exercise both sides of every filesystem stage, including a retired reference
  // whose replacement has not yet been published.
  for (const cut of [0, 1, 2, 3, 4]) {
    const fixture = makeFixtureVault();
    const from = realpathSync(join(fixture.vault, '03-经验/AI工具')) + '/旧名.md';
    const to = join(dirname(from), '新名.md'), peer = join(dirname(from), '引用.md');
    const before = '---\nname: 旧名\n---\n原始正文\n', linked = '[[旧名]]\n';
    writeFileSync(from, before); writeFileSync(peer, linked);
    const argv = [WRITER, '--rename', from, '--new-title', '新名', '--expected-sha256', digest(before), '--reason', '测试', '--source', 'codex'];
    const fault = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const move = fs.renameSync, link = fs.linkSync; let stage = 0;
      const stop = () => { if (stage++ === ${cut}) throw new Error('injected rename interruption'); };
      fs.renameSync = (a,b) => { if ([${JSON.stringify(from)},${JSON.stringify(peer)}].includes(a)) stop(); return move(a,b); };
      fs.linkSync = (a,b) => { if ([${JSON.stringify(to)},${JSON.stringify(peer)}].includes(b)) stop(); return link(a,b); };
      syncBuiltinESMExports(); process.argv = [process.execPath, ...${JSON.stringify(argv)}]; await import(${JSON.stringify(WRITER)});`;
    const failed = spawnSync(process.execPath, ['--input-type=module', '-e', fault], { encoding: 'utf8', env: { ...process.env, ...fixture.env } });
    const recoveryDir = join(fixture.vault, 'raw/processed/brain-write/note-maintenance');
    const file = readdirSync(recoveryDir).find(n => n.endsWith('.json'));
    const id = file.slice(0, -5), recordPath = join(recoveryDir, file);
    const record = readFileSync(recordPath, 'utf8');
    if (cut < 4) { assert.notEqual(failed.status, 0); assert.match(failed.stderr, /injected rename interruption/); }
    if (cut === 1) {
      writeFileSync(peer, 'third-party content');
      assert.notEqual(runCli(fixture, ['--resume-maintenance', id, '--reason', '继续']).code, 0);
      assert.equal(readFileSync(peer, 'utf8'), 'third-party content');
      writeFileSync(peer, linked);
      const tampered = JSON.parse(record), w = tampered.writes.find(w => w.path === peer);
      w.after = 'arbitrary edit'; w.after_sha256 = digest(w.after);
      writeFileSync(recordPath, JSON.stringify(tampered));
      assert.notEqual(runCli(fixture, ['--resume-maintenance', id, '--reason', '继续']).code, 0);
      assert.equal(readFileSync(peer, 'utf8'), linked);
      writeFileSync(recordPath, record);
    }
    const resumed = runCli(fixture, ['--resume-maintenance', id, '--reason', '继续']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(existsSync(from), false); assert.equal(readFileSync(peer, 'utf8'), '[[新名]]\n');
    const after = readFileSync(to, 'utf8');
    writeFileSync(to, after + '独立修改');
    assert.notEqual(runCli(fixture, ['--restore', id, '--reason', '撤销']).code, 0);
    assert.equal(readFileSync(to, 'utf8'), after + '独立修改');
    writeFileSync(to, after);
    const restored = runCli(fixture, ['--restore', id, '--reason', '撤销']);
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(readFileSync(from, 'utf8'), before); assert.equal(readFileSync(peer, 'utf8'), linked);
    assert.equal(readFileSync(recordPath, 'utf8'), record);
    assert.ok(readdirSync(recoveryDir).some(n => n.endsWith('.retired')));
  }
});

test('managed rename rejects linked paths and unsupported references before changes', () => {
  for (const kind of ['file-link', 'directory-link', 'hardlink', 'reference-definition']) {
    const fixture = makeFixtureVault(), dir = join(fixture.vault, '03-经验/AI工具');
    const from = join(dir, '旧名.md'), before = '---\nname: 旧名\n---\n正文\n';
    writeFileSync(from, before);
    const outside = join(fixture.root, 'outside.md'); writeFileSync(outside, 'external sentinel');
    if (kind === 'file-link') symlinkSync(outside, join(dir, '引用.md'));
    if (kind === 'directory-link') symlinkSync(fixture.root, join(dir, 'linked'));
    if (kind === 'hardlink') linkSync(outside, join(dir, '引用.md'));
    if (kind === 'reference-definition') writeFileSync(join(dir, '引用.md'), '[ref]: 旧名.md\n[text][ref]');
    const result = runCli(fixture, ['--rename', from, '--new-title', '新名', '--expected-sha256', digest(before), '--reason', '测试']);
    assert.notEqual(result.code, 0, kind);
    assert.equal(readFileSync(from, 'utf8'), before); assert.equal(readFileSync(outside, 'utf8'), 'external sentinel');
    assert.equal(existsSync(join(dir, '新名.md')), false);
  }
});

test('managed rename preserves escaped prose and rewrites table aliases and escaped path punctuation', () => {
  for (const title of ['旧名', '旧(版)', '100% 完成', '100%20完成']) {
    const fixture = makeFixtureVault(), dir = join(fixture.vault, '03-经验/AI工具');
    const from = join(dir, title + '.md'), peer = join(dir, '引用.md');
    const before = `---\nname: ${title}\n---\n正文\n`;
    const path = title.includes('%') ? encodeURI(title) : title.replace(/[()]/g, c => '\\' + c);
    const prose = `\\[[${title}]]\n\\[示例\\](${path}.md)\n`;
    writeFileSync(from, before);
    writeFileSync(peer, `| [[${title}\\|别名]] |\n[关联](${path}.md)\n[标题](${path}.md "说明 ) 仍有效")\n` + prose);
    const result = runCli(fixture, ['--rename', from, '--new-title', '新名', '--expected-sha256', digest(before), '--reason', '测试']);
    assert.equal(result.code, 0, result.stderr);
    const next = path.includes('%') ? encodeURI('新名.md') : '新名.md';
    assert.equal(readFileSync(peer, 'utf8'), `| [[新名\\|别名]] |\n[关联](${next})\n[标题](${next} "说明 ) 仍有效")\n` + prose);
  }
});

test('managed rename resumes process death around snapshot and note publication', () => {
  for (const stage of ['snapshot-before', 'snapshot-after', 'note-before', 'note-after', 'reference-after', 'partial-reference', 'already-present']) {
    const fixture = makeFixtureVault(), dir = realpathSync(join(fixture.vault, '03-经验/AI工具'));
    const from = join(dir, '旧名.md'), to = join(dir, '新名.md'), peer = join(dir, '引用.md');
    const before = '---\nname: 旧名\n---\n正文\n';
    writeFileSync(from, before); writeFileSync(peer, '[[旧名]]');
    const argv = [WRITER, '--rename', from, '--new-title', '新名', '--expected-sha256', digest(before), '--reason', '测试', '--source', 'codex'];
    const fault = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const link = fs.linkSync, stage = ${JSON.stringify(stage)};
      fs.linkSync = (a,b) => {
        const match = stage.startsWith('snapshot') ? b.endsWith('.json') : stage.startsWith('note') ? b === ${JSON.stringify(to)} : b === ${JSON.stringify(peer)};
        if (stage === 'already-present' && b === ${JSON.stringify(to)}) process.exit(97);
        if (match && stage.endsWith('before')) process.exit(97);
        if (match && stage === 'partial-reference') { fs.writeFileSync(a, 'interrupted partial bytes'); process.exit(97); }
        const result = link(a,b); if (match) process.exit(97); return result;
      };
      syncBuiltinESMExports(); process.argv = [process.execPath, ...${JSON.stringify(argv)}]; await import(${JSON.stringify(WRITER)});`;
    const died = spawnSync(process.execPath, ['--input-type=module', '-e', fault], { encoding: 'utf8', env: { ...process.env, ...fixture.env } });
    assert.equal(died.status, 97, died.stderr);
    const recovery = join(fixture.vault, 'raw/processed/brain-write/note-maintenance');
    const id = readdirSync(recovery).find(n => n.includes('.json')).slice(0, 36);
    if (stage === 'already-present') writeFileSync(to, JSON.parse(readFileSync(join(recovery, id + '.json'))).writes.find(w => w.path === to).after);
    const resumed = runCli(fixture, ['--resume-maintenance', id, '--reason', '继续']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(readFileSync(peer, 'utf8'), '[[新名]]'); assert.equal(existsSync(from), false);
    assert.equal(readdirSync(dir).some(n => n.endsWith('.tmp')), false);
    if (stage === 'partial-reference') {
      const partial = readdirSync(recovery).find(n => n.endsWith('.incomplete'));
      assert.equal(readFileSync(join(recovery, partial), 'utf8'), 'interrupted partial bytes');
    }
    const restored = runCli(fixture, ['--restore', id, '--reason', '撤销']);
    assert.equal(restored.code, 0, restored.stderr); assert.equal(readFileSync(from, 'utf8'), before);
  }
});

test('managed rename refuses oversized outputs before publishing any file', () => {
  for (const enlarged of ['source', 'reference']) {
    const fixture = makeFixtureVault(), dir = join(fixture.vault, '03-经验/AI工具');
    const from = join(dir, 'a.md'), peer = join(dir, '引用.md');
    const header = '---\nname: a\n---\n';
    const original = enlarged === 'source' ? header + 'x'.repeat(16 * 1024 * 1024 - header.length) : header + '正文';
    writeFileSync(from, original);
    if (enlarged === 'reference') writeFileSync(peer, '[[a]]' + 'x'.repeat(16 * 1024 * 1024 - 5));
    const result = runCli(fixture, ['--rename', from, '--new-title', 'b'.repeat(120), '--expected-sha256', digest(original), '--reason', '测试']);
    assert.notEqual(result.code, 0); assert.match(result.stderr, /size limit/);
    assert.equal(readFileSync(from, 'utf8'), original);
    assert.equal(existsSync(join(dir, 'b'.repeat(120) + '.md')), false);
  }
});

test('managed rename refuses a third link during cleanup and late changes to earlier writes', () => {
  for (const kind of ['third-link', 'late-edit']) {
    const fixture = makeFixtureVault(), dir = realpathSync(join(fixture.vault, '03-经验/AI工具'));
    const from = join(dir, '旧名.md'), to = join(dir, '新名.md'), outside = join(fixture.root, 'third-link.md');
    const before = '---\nname: 旧名\n---\n正文\n'; writeFileSync(from, before);
    const argv = [WRITER, '--rename', from, '--new-title', '新名', '--expected-sha256', digest(before), '--reason', '测试', '--source', 'codex'];
    const fault = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const unlink = fs.unlinkSync, move = fs.renameSync;
      fs.unlinkSync = p => { if (${JSON.stringify(kind)} === 'third-link' && p.startsWith(${JSON.stringify(to)} + '.') && p.endsWith('.tmp')) fs.linkSync(${JSON.stringify(to)}, ${JSON.stringify(outside)}); return unlink(p); };
      fs.renameSync = (a,b) => { const value = move(a,b); if (${JSON.stringify(kind)} === 'late-edit' && a === ${JSON.stringify(from)}) fs.writeFileSync(${JSON.stringify(to)}, 'third-party value'); return value; };
      syncBuiltinESMExports(); process.argv = [process.execPath, ...${JSON.stringify(argv)}]; await import(${JSON.stringify(WRITER)});`;
    const failed = spawnSync(process.execPath, ['--input-type=module', '-e', fault], { encoding: 'utf8', env: { ...process.env, ...fixture.env } });
    assert.notEqual(failed.status, 0, failed.stdout);
    if (kind === 'third-link') assert.equal(readFileSync(outside, 'utf8'), readFileSync(to, 'utf8'));
    else assert.equal(readFileSync(to, 'utf8'), 'third-party value');
    const ledger = join(fixture.vault, '00-系统/logs/brain-write-ledger.jsonl');
    assert.equal(existsSync(ledger) && readFileSync(ledger, 'utf8').includes('"action":"rename"'), false);
  }
});

test('managed maintenance revises, deactivates, restores and preserves intervening edits', () => {
  const fixture = makeFixtureVault();
  const title = '需要纠正的经验';
  const written = runCli(fixture, ['--type', 'experience', '--subfolder', 'AI工具', '--title', title, '--description', '旧摘要', '--body', '旧正文']);
  assert.equal(written.code, 0, written.stderr);
  const note = realpathSync(JSON.parse(written.stdout).path);
  const original = readFileSync(note, 'utf8');
  const intent = join(fixture.vault, '00-系统/.index-cache/intent-map.json');
  const map = JSON.parse(readFileSync(intent, 'utf8'));
  const otherHistory = { title, destination_index: 'MEMORY-knowledge.md', subfolder: 'other' };
  map.eviction_log = [otherHistory, { title, source_path: note }];
  writeFileSync(intent, JSON.stringify(map));
  const revised = runCli(fixture, ['--revise', note, '--expected-sha256', digest(original), '--description', '核验后的摘要', '--body', '已修正正文', '--reason', '核对原始证据']);
  assert.equal(revised.code, 0, revised.stderr);
  const revision = JSON.parse(revised.stdout);
  assert.match(readFileSync(note, 'utf8'), /已修正正文/);
  assert.match(readFileSync(join(fixture.memory, 'MEMORY.md'), 'utf8'), /核验后的摘要/);
  assert.equal(runCli(fixture, ['--revise', note, '--expected-sha256', digest(original), '--body', '过期更新', '--reason', 'stale']).code !== 0, true);
  assert.equal(JSON.parse(readFileSync(revision.backup_path, 'utf8')).writes.find(w => w.path === note).before, original);
  const inactive = runCli(fixture, ['--deactivate', note, '--expected-sha256', digest(readFileSync(note)), '--reason', '重复条目停用']);
  assert.equal(inactive.code, 0, inactive.stderr);
  const operation = JSON.parse(inactive.stdout).operation_id;
  assert.equal(existsSync(note), false);
  assert.deepEqual(JSON.parse(readFileSync(intent, 'utf8')).eviction_log, [otherHistory]);
  for (const name of ['MEMORY.md', ...DOMAIN_INDEXES]) assert.equal(readFileSync(join(fixture.memory, name), 'utf8').includes(title), false);
  const restored = runCli(fixture, ['--restore', operation, '--reason', '撤销停用']);
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(readFileSync(note, 'utf8'), /已修正正文/);
  assert.match(readFileSync(join(fixture.memory, 'MEMORY.md'), 'utf8'), /核验后的摘要/);
  const restoreRevision = runCli(fixture, ['--restore', revision.operation_id, '--reason', '撤销修订']);
  assert.equal(restoreRevision.code, 0, restoreRevision.stderr);
  assert.equal(readFileSync(note, 'utf8'), original);
  writeFileSync(note, '独立更新');
  const conflict = runCli(fixture, ['--restore', revision.operation_id, '--reason', '重放撤销']);
  assert.notEqual(conflict.code, 0);
  assert.equal(readFileSync(note, 'utf8'), '独立更新');
});

test('managed maintenance resumes partial deactivation and refuses linked indexes', () => {
  const fixture = makeFixtureVault();
  const note = join(fixture.vault, '03-经验/AI工具/待停用.md');
  const original = '---\nname: 待停用\ndescription: fixture\n---\noriginal\n';
  writeFileSync(note, original);
  const index = join(fixture.memory, 'MEMORY.md');
  writeFileSync(index, `- [待停用](../vault/03-经验/AI工具/待停用.md) — fixture\n`);
  const beforeIndex = readFileSync(index, 'utf8');
  const argv = [WRITER, '--deactivate', note, '--expected-sha256', digest(original), '--reason', 'duplicate', '--source', 'codex'];
  const fault = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === ${JSON.stringify(index)}) throw new Error('injected index failure'); return rename(from, to); };
    syncBuiltinESMExports(); process.argv = [process.execPath, ...${JSON.stringify(argv)}]; await import(${JSON.stringify(WRITER)});`;
  const failed = spawnSync(process.execPath, ['--input-type=module', '-e', fault], { env: { ...process.env, ...fixture.env }, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /injected index failure/);
  assert.equal(existsSync(note), false);
  const recoveryDir = join(fixture.vault, 'raw/processed/brain-write/note-maintenance');
  const id = readdirSync(recoveryDir).find(name => name.endsWith('.json')).slice(0, -5);
  assert.ok(readFileSync(join(recoveryDir, `${id}.json`), 'utf8').includes('original'));
  writeFileSync(index, 'third value');
  assert.notEqual(runCli(fixture, ['--resume-maintenance', id, '--reason', 'retry']).code, 0);
  assert.equal(readFileSync(index, 'utf8'), 'third value');
  writeFileSync(index, beforeIndex);
  assert.equal(runCli(fixture, ['--resume-maintenance', id, '--reason', 'retry']).code, 0);
  assert.equal(readFileSync(index, 'utf8'), '');

  const linked = makeFixtureVault();
  const otherNote = join(linked.vault, '08-观察/2026-08/误采.md');
  writeFileSync(otherNote, original);
  const outside = join(linked.root, 'outside.md');
  writeFileSync(outside, 'external sentinel');
  // A memory index must be checked before either the note or any other index changes.
  const linkedIndex = join(linked.memory, 'MEMORY-extra.md');
  symlinkSync(outside, linkedIndex);
  const referenceIndex = join(linked.memory, 'MEMORY.md');
  const renameIndex = join(linked.memory, 'MEMORY-saved.md');
  // Use the real declared index name, retaining its previous bytes in the fixture.
  renameSync(referenceIndex, renameIndex);
  renameSync(linkedIndex, referenceIndex);
  const refused = runCli(linked, ['--deactivate', otherNote, '--expected-sha256', digest(original), '--reason', 'duplicate']);
  assert.notEqual(refused.code, 0);
  assert.equal(readFileSync(otherNote, 'utf8'), original);
  assert.equal(readFileSync(outside, 'utf8'), 'external sentinel');
});

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

function runCliConcurrent(fixture, args, body) {
  return new Promise((resolveResult, reject) => {
    const argv = args.includes('--source') ? args : [...args, '--source', 'codex'];
    const child = spawn(process.execPath, [WRITER, ...argv], { input: 'ignore', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...fixture.env, BRAIN_LOCK_WAIT_MS: '1000' } });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, stdout, stderr }));
    child.stdin.end(body);
  });
}

test('request_id resumes SIGKILL around prepared-plan publication and note/index mutations', () => {
  for (const stage of ['plan-before', 'plan-after', 'note-after', 'index-after']) {
    const fixture = makeFixtureVault();
    try {
      const request_id = 'ddf96aab-9213-49b5-8357-72df72f7264a';
      const args = ['--type', 'experience', '--subfolder', 'AI工具', '--title', 'crash-safe-write', '--description', 'synthetic recovery', '--body', 'one persistent body', '--request-id', request_id, '--source', 'codex'];
      const fault = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
        const stage = ${JSON.stringify(stage)}, link = fs.linkSync, rename = fs.renameSync;
        fs.linkSync = (from,to) => {
          const target = String(to).includes('/request-commits/') && String(to).endsWith('.json');
          if (target && stage === 'plan-before') process.kill(process.pid, 'SIGKILL');
          const result = link(from,to);
          if (target && stage === 'plan-after') process.kill(process.pid, 'SIGKILL');
          return result;
        };
        fs.renameSync = (from,to) => {
          const result = rename(from,to);
          if (stage === 'note-after' && String(to).endsWith('/crash-safe-write.md') || stage === 'index-after' && String(to).endsWith('/MEMORY.md')) process.kill(process.pid, 'SIGKILL');
          return result;
        };
        syncBuiltinESMExports(); process.argv = [process.execPath, ${JSON.stringify(WRITER)}, ...${JSON.stringify(args)}]; await import(${JSON.stringify(WRITER)});`;
      const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', fault], { encoding: 'utf8', env: { ...process.env, ...fixture.env } });
      assert.equal(crashed.signal, 'SIGKILL', `${stage}: ${crashed.stderr}`);
      const replay = runCli(fixture, args);
      assert.equal(replay.code, 0, `${stage}: ${replay.stderr}`);
      const receipt = JSON.parse(replay.stdout);
      assert.equal(readFileSync(receipt.path, 'utf8').includes('one persistent body'), true);
      assert.equal(readdirSync(join(fixture.vault, '03-经验/AI工具')).filter(name => name.startsWith('crash-safe-write')).length, 1);
      const committed = readFileSync(fixture.ledger, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.request_id === request_id && row.status === 'ok');
      assert.equal(committed.length, 1);
      assert.equal(runCli(fixture, args).code, 0);
      assert.equal(runCli(fixture, ['--verify']).code, 0);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

function parseJson(text, channel) {
  assert.notEqual(text.trim(), '', channel + ' must contain JSON');
  return JSON.parse(text);
}

function rawFixture() {
  const fixture = makeFixtureVault();
  // Only synthetic Desktop sources are used; the production vault is never used.
  const source = mkdtempSync(join(homedir(), 'Desktop', 'brainkit-raw-test-'));
  after(() => rmSync(source, { recursive: true, force: true }));
  const bytes = Buffer.concat([Buffer.from('\0\0\0\x18ftypM4A '), Buffer.alloc(24, 7)]);
  const audio = join(source, '中文录音.m4a');
  const qma = join(source, '中文录音.qma');
  writeFileSync(audio, bytes);
  mkdirSync(qma);
  writeFileSync(join(qma, 'mic.m4a'), bytes);
  writeFileSync(join(qma, 'sys.m4a'), bytes);
  writeFileSync(join(qma, 'info.json'), '{"duration":42}\n');
  const args = path => ['--import-raw', path, '--project', 'test-project',
    '--raw-subfolder', '面经/公司/原料', '--provenance', 'user-request; session=test'];
  const target = join(fixture.vault, '01-项目', 'test-project', '面经', '公司', '原料');
  return { ...fixture, source, audio, qma, bytes, args, target };
}

function nativeFault(fixture, injection) {
  const backend = join(fixture.root, 'fault.py');
  const actual = readFileSync(join(HERE, '../scripts/lib/raw-import.py'), 'utf8');
  const header = 'def publish(fd, old, new, destination=None):\n';
  assert.ok(actual.includes(header));
  writeFileSync(backend, actual.replace(header,
    header + injection.split('\n').map(line => '    ' + line).join('\n') + '\n'));
  const shim = join(fixture.root, 'fault.mjs');
  writeFileSync(shim, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const run = cp.spawnSync;
cp.spawnSync = (bin, args, options) => run(bin,
  args.map(arg => arg.endsWith('/raw-import.py') ? ${JSON.stringify(backend)} : arg), options);
syncBuiltinESMExports();\n`);
  return { env: { NODE_OPTIONS: '--import=' + shim } };
}

test('folder import preserves mixed original files, hidden metadata and empty directories with replay and recovery', () => {
  const f = rawFixture();
  const name = '字节 2026 5 月 15 实习';
  const args = ['--import-folder', f.source, '--folder-name', name, '--project', 'test-project',
    '--provenance', 'user-request; session=test'];
  mkdirSync(join(f.source, '资料', '空目录'), { recursive: true });
  writeFileSync(join(f.source, '资料', '合同.pdf'), Buffer.from([0, 255, 128, 37, 80, 68, 70]));
  writeFileSync(join(f.source, '.DS_Store'), Buffer.from([0, 1, 2]));
  writeFileSync(join(f.source, '转录.md'), '中文原始转录\n');
  const target = join(f.vault, '01-项目', 'test-project', name);
  const preview = runCli(f, [...args, '--dry-run']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(f.ledger), false);
  const failed = runCli(f, args, nativeFault(f, "if new == '合同.pdf': raise RuntimeError('interrupted folder publication')"));
  assert.notEqual(failed.code, 0);
  const result = runCli(f, args);
  assert.equal(result.code, 0, result.stderr);
  const receipt = parseJson(result.stdout, 'folder receipt');
  assert.equal(receipt.action, 'import-folder');
  assert.equal(receipt.files.length, 7);
  for (const file of receipt.files) assert.deepEqual(readFileSync(file.target_path), readFileSync(file.source_path));
  assert.ok(existsSync(join(target, '资料', '空目录')));
  assert.ok(existsSync(f.source));
  assert.equal(runCli(f, args).code, 0);
  const ledger = readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter(e => e.action === 'import-folder' && e.operation_id === receipt.operation_id).length, 1);
});

test('folder import refuses changed source trees, extra destinations, links and incompatible options', () => {
  const args = f => ['--import-folder', f.source, '--folder-name', 'Archive', '--project', 'test-project',
    '--provenance', 'user-request; session=test'];
  const f = rawFixture();
  const extra = join(f.source, 'added.pdf');
  const changed = runCli(f, args(f), nativeFault(f, `if new == 'manifest.json':
    with open(${JSON.stringify(extra)}, 'w') as added: added.write('added later')`));
  assert.notEqual(changed.code, 0);
  assert.equal(existsSync(join(f.vault, '01-项目', 'test-project', 'Archive')), false);
  const g = rawFixture();
  const target = join(g.vault, '01-项目', 'test-project', 'Archive');
  mkdirSync(target);
  writeFileSync(join(target, 'third-party.pdf'), 'keep');
  assert.notEqual(runCli(g, args(g)).code, 0);
  assert.deepEqual(readdirSync(target), ['third-party.pdf']);
  const h = rawFixture();
  symlinkSync(h.audio, join(h.source, 'alias.m4a'));
  assert.notEqual(runCli(h, args(h)).code, 0);
  const i = rawFixture();
  for (const options of [['--folder-name', '../escape'], ['--folder-name', 'nested/name'],
    ['--project', 'unknown'], ['--raw-subfolder', '原料'], ['--import-raw', i.audio], ['--verify']]) {
    assert.notEqual(runCli(i, [...args(i), ...options]).code, 0);
  }
  writeFileSync(join(i.source, '.env'), 'private');
  assert.notEqual(runCli(i, args(i)).code, 0);
});

test('raw import previews without writes and archives exact bytes with replay and partial recovery', () => {
  const f = rawFixture();
  const dry = runCli(f, [...f.args(f.qma), '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(parseJson(dry.stdout, 'dry run').files.length, 3);
  assert.equal(existsSync(f.target), false);
  assert.equal(existsSync(f.ledger), false);
  assert.equal(existsSync(join(f.vault, 'raw')), false);
  for (const path of [f.audio, f.qma]) {
    const result = runCli(f, f.args(path));
    assert.equal(result.code, 0, result.stderr);
    const receipt = parseJson(result.stdout, 'import');
    assert.equal(receipt.status, 'ok');
    for (const file of receipt.files) {
      assert.equal(digest(readFileSync(file.source_path)), file.sha256);
      assert.equal(digest(readFileSync(file.target_path)), file.sha256);
    }
    assert.equal(runCli(f, f.args(path)).code, 0);
  }
  const interrupted = rawFixture();
  assert.notEqual(runCli(interrupted, interrupted.args(interrupted.qma),
    nativeFault(interrupted, "if new == 'sys.m4a': raise RuntimeError('injected interruption')")).code, 0);
  const mic = join(interrupted.target, basename(interrupted.qma), 'mic.m4a');
  assert.equal(existsSync(mic), true);
  assert.equal(existsSync(join(dirname(mic), 'sys.m4a')), false);
  const resumed = runCli(interrupted, interrupted.args(interrupted.qma));
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(readFileSync(mic), interrupted.bytes);
  const staging = rawFixture();
  assert.notEqual(runCli(staging, staging.args(staging.audio),
    nativeFault(staging, "if new == '0.payload': raise RuntimeError('injected staging interruption')")).code, 0);
  const resumedStage = runCli(staging, staging.args(staging.audio));
  assert.equal(resumedStage.code, 0, resumedStage.stderr);
  const ledger = readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(ledger.some(e => e.action === 'import-raw' && e.status === 'ok' && e.trigger === 'user-request'));
});

test('raw import stays inside descriptor roots when archive and journal parents are replaced', () => {
  for (const stage of [false, true]) {
    const f = rawFixture();
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    const trigger = stage ? 'manifest.json' : basename(f.audio);
    // The journal directory is deterministic from the read-only plan.
    const preview = parseJson(runCli(f, [...f.args(f.audio), '--dry-run']).stdout, 'preview');
    const replaced = stage ? join(f.vault, 'raw/processed/brain-write/raw-import', preview.operation_id) : f.target;
    const fault = nativeFault(f, `if new == ${JSON.stringify(trigger)}:
    parent = ${JSON.stringify(replaced)}
    os.rename(parent, parent + '.saved')
    os.symlink(${JSON.stringify(outside)}, parent)`);
    const result = runCli(f, f.args(f.audio), fault);
    assert.notEqual(result.code, 0);
    assert.deepEqual(readdirSync(outside), []);
    assert.ok(existsSync(join(replaced + '.saved', trigger)));
  }
});

test('raw import rejects conflicts before publishing other QMA files', () => {
  const f = rawFixture();
  const dir = join(f.target, basename(f.qma));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sys.m4a'), 'third party bytes');
  const result = runCli(f, f.args(f.qma));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /conflict/i);
  assert.equal(existsSync(join(dir, 'mic.m4a')), false);
  assert.equal(readFileSync(join(dir, 'sys.m4a'), 'utf8'), 'third party bytes');
});

test('raw import refuses QMA source entries added after the frontend preview', () => {
  const f = rawFixture();
  const extra = join(f.qma, 'extra.json');
  const fault = nativeFault(f, `if new == 'manifest.json':
    with open(${JSON.stringify(extra)}, 'w') as added: added.write('{}')`);
  const result = runCli(f, f.args(f.qma), fault);
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(f.target), false);
  assert.equal(existsSync(extra), true);
  assert.deepEqual(readFileSync(join(f.qma, 'sys.m4a')), f.bytes);
});

test('raw import preserves outside ledger aliases and refuses FIFO locks without hanging', () => {
  const f = rawFixture();
  const outside = join(f.root, 'outside.jsonl');
  const original = '{"existing":true}\n';
  writeFileSync(outside, original);
  linkSync(outside, f.ledger);
  const refused = runCli(f, f.args(f.audio));
  assert.notEqual(refused.code, 0);
  assert.equal(readFileSync(outside, 'utf8'), original);
  assert.equal(existsSync(f.target), false);
  const g = rawFixture();
  assert.equal(spawnSync('mkfifo', [g.lock]).status, 0);
  const fifo = runCli(g, g.args(g.audio));
  assert.notEqual(fifo.code, 0);
  assert.equal(existsSync(g.target), false);
  assert.equal(existsSync(g.lock), true);
});

test('raw import refuses unregistered routes, traversal and incompatible modes', () => {
  const f = rawFixture();
  for (const extra of [['--project', 'unknown'], ['--subfolder', 'unknown'],
    ['--raw-subfolder', '../原料'], ['--raw-subfolder', '/原料'],
    ['--raw-subfolder', '原料/.hidden/原料'], ['--raw-subfolder', 'other'], ['--body', 'ignored'], ['--verify']]) {
    const result = runCli(f, [...f.args(f.audio), ...extra]);
    assert.notEqual(result.code, 0, JSON.stringify(extra));
  }
  assert.equal(existsSync(f.target), false);
  assert.equal(existsSync(f.ledger), false);
});

test('raw import rejects linked sources, linked destinations, malformed QMA and disguised text', () => {
  const f = rawFixture();
  const link = join(f.source, 'link.m4a');
  symlinkSync(f.audio, link);
  assert.notEqual(runCli(f, f.args(link)).code, 0);
  const hard = join(f.source, 'hard.m4a');
  linkSync(f.audio, hard);
  assert.notEqual(runCli(f, f.args(hard)).code, 0);
  const fake = join(f.source, 'fake.m4a');
  writeFileSync(fake, 'credential-like plain text');
  assert.notEqual(runCli(f, f.args(fake)).code, 0);
  writeFileSync(join(f.qma, 'extra.json'), '{}');
  assert.notEqual(runCli(f, f.args(f.qma)).code, 0);
  const g = rawFixture();
  mkdirSync(dirname(g.target), { recursive: true });
  symlinkSync(g.source, g.target);
  assert.notEqual(runCli(g, g.args(g.qma)).code, 0);
  assert.deepEqual(readdirSync(g.qma).sort(), ['info.json', 'mic.m4a', 'sys.m4a']);
});

test('verify reads Markdown destinations when titles and paths contain parentheses or Chinese spaces', () => {
  const fixture = makeFixtureVault();
  const note = join(fixture.vault, '01-项目', 'test-project', '面经', '快手 (用户 增长) 不要信任 "undefined" 任务契约.md');
  mkdirSync(dirname(note), { recursive: true });
  writeFileSync(note, '---\nname: 快手任务契约\n---\n正文\n');
  const rel = relative(fixture.memory, note);
  writeFileSync(join(fixture.memory, 'MEMORY.md'),
    '# Memory Index\n\n' + HOT_HEADER + '\n\n<auto-maintained>\n' +
    `- [快手(用户增长)](${rel} "说明 (保留)") — 热索引\n\n## 📚 领域索引（按需读取）\n`);
  writeFileSync(join(fixture.memory, 'MEMORY-project.md'),
    '# MEMORY-project.md\n\n## test-project\n' +
    `- [快手(用户增长)](<${rel}> "说明 (保留)") — 项目索引\n`);

  const result = runCli(fixture, ['--verify']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(parseJson(result.stdout, 'verify stdout'), {
    dead_links: [],
    duplicates: [],
    inconsistent_group: [],
    intent_map_issues: [],
    overall: 'PASS',
  });
});

test('repair index link previews, restores, and rejects stale targets without changing notes', () => {
  const fixture = makeFixtureVault();
  const old = join(fixture.vault, '01-项目', 'test-project', '面经', '快手 (旧路径).md');
  const current = join(fixture.vault, '01-项目', 'test-project', '面经', '快手 (新路径) 设计稿.md');
  mkdirSync(dirname(current), { recursive: true });
  const currentBody = '---\nname: 快手任务契约\n---\n原文不改\n';
  writeFileSync(current, currentBody);
  const oldRel = relative(fixture.memory, old);
  const hot = `- [快手(用户增长)](${oldRel} "说明") — 热索引\n`;
  const domain = `# MEMORY-project.md\n\n## 旧分组\n- [快手(用户增长)](<${oldRel}> "说明") — 项目索引\n`;
  writeFileSync(join(fixture.memory, 'MEMORY.md'), '# Memory Index\n\n' + HOT_HEADER + '\n\n' + hot);
  writeFileSync(join(fixture.memory, 'MEMORY-project.md'), domain);
  const args = ['--repair-index-link', old, '--to', current, '--expected-sha256', digest(currentBody)];

  const stale = runCli(fixture, [...args.slice(0, -1), '0'.repeat(64)]);
  assert.notEqual(stale.code, 0);
  assert.equal(readFileSync(current, 'utf8'), currentBody);
  assert.equal(readFileSync(join(fixture.memory, 'MEMORY-project.md'), 'utf8'), domain);

  const previewResult = runCli(fixture, [...args, '--dry-run']);
  assert.equal(previewResult.code, 0, previewResult.stderr);
  const preview = parseJson(previewResult.stdout, 'repair preview');
  assert.equal(preview.status, 'preview');
  assert.equal(preview.action, 'repair-index-link');
  assert.equal(preview.target_sha256, digest(currentBody));
  assert.equal(readFileSync(join(fixture.memory, 'MEMORY-project.md'), 'utf8'), domain);

  const repaired = parseJson(runCli(fixture, args).stdout, 'repair receipt');
  assert.equal(repaired.action, 'repair-index-link');
  assert.equal(readFileSync(current, 'utf8'), currentBody);
  for (const name of ['MEMORY.md', 'MEMORY-project.md']) {
    const index = readFileSync(join(fixture.memory, name), 'utf8');
    assert.ok(index.includes(relative(fixture.memory, current)), index);
    assert.equal(index.includes(oldRel), false, index);
  }
  assert.match(readFileSync(join(fixture.memory, 'MEMORY-project.md'), 'utf8'), /## test-project/);

  const restored = runCli(fixture, ['--restore', repaired.operation_id, '--reason', '撤销索引修复']);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(readFileSync(current, 'utf8'), currentBody);
  assert.equal(readFileSync(join(fixture.memory, 'MEMORY-project.md'), 'utf8'), domain);
});

test('repair index link recovery refuses a concurrent index edit', () => {
  const fixture = makeFixtureVault();
  const old = join(fixture.vault, '03-经验', 'AI工具', '快手 (旧).md');
  const current = join(fixture.vault, '03-经验', 'AI工具', '快手 (新).md');
  const currentBody = '---\nname: 快手新\n---\n原文\n';
  writeFileSync(current, currentBody);
  const index = join(fixture.memory, 'MEMORY.md');
  const before = `- [快手(增长)](${relative(fixture.memory, old)}) — 索引\n`;
  writeFileSync(index, before);
  const argv = [WRITER, '--repair-index-link', old, '--to', current, '--expected-sha256', digest(currentBody), '--source', 'codex'];
  const fault = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const move = fs.renameSync; fs.renameSync = (from, to) => { if (to === ${JSON.stringify(index)}) throw new Error('injected index failure'); return move(from, to); };
    syncBuiltinESMExports(); process.argv = [process.execPath, ...${JSON.stringify(argv)}]; await import(${JSON.stringify(WRITER)});`;
  const failed = spawnSync(process.execPath, ['--input-type=module', '-e', fault], { encoding: 'utf8', env: { ...process.env, ...fixture.env } });
  assert.notEqual(failed.status, 0);
  assert.equal(readFileSync(current, 'utf8'), currentBody);
  const recoveryDir = join(fixture.vault, 'raw/processed/brain-write/note-maintenance');
  const id = readdirSync(recoveryDir).find(name => name.endsWith('.json')).slice(0, -5);
  writeFileSync(index, 'third-party index edit\n');
  assert.notEqual(runCli(fixture, ['--resume-maintenance', id, '--reason', '重试']).code, 0);
  assert.equal(readFileSync(index, 'utf8'), 'third-party index edit\n');
});

test('repair index link permits group-only repair but rejects forged writes and changed targets', () => {
  const fixture = makeFixtureVault();
  const note = join(fixture.vault, '03-经验', 'AI工具', '快手 (任务契约).md');
  const body = '---\nname: 快手\n---\n正文\n';
  writeFileSync(note, body);
  const index = join(fixture.memory, 'MEMORY-experience.md');
  const line = `- [快手(增长)](${relative(fixture.memory, note)}) — 索引`;
  writeFileSync(index, `# MEMORY-experience.md\n\n## 错误分组\n${line}\n`);
  const groupOnly = runCli(fixture, ['--repair-index-link', note, '--to', note, '--expected-sha256', digest(body)]);
  assert.equal(groupOnly.code, 0, groupOnly.stderr);
  assert.match(readFileSync(index, 'utf8'), /## AI工具/);
  assert.equal(readFileSync(note, 'utf8'), body);

  const recoveryDir = join(fixture.vault, 'raw/processed/brain-write/note-maintenance');
  mkdirSync(recoveryDir, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  const forged = (writes, targetSha = digest(body)) => ({ version: 3, repair: { from: note }, inverse: false, receipt: {
    status: 'ok', action: 'repair-index-link', operation_id: id, target_path: note, target_sha256: targetSha,
  }, writes: writes.map(write => ({ ...write, before_sha256: digest(write.before), after_sha256: write.after === null ? null : digest(write.after) })) });
  const forgedPath = join(recoveryDir, `${id}.json`);
  const reject = plan => {
    writeFileSync(forgedPath, JSON.stringify(plan) + '\n');
    assert.notEqual(runCli(fixture, ['--resume-maintenance', id, '--reason', '反例']).code, 0);
    assert.equal(readFileSync(note, 'utf8'), body);
  };
  reject(forged([{ path: note, before: body, after: '篡改' }]));
  reject(forged([{ path: index, before: readFileSync(index, 'utf8'), after: null }]));
  const unchangedIndex = readFileSync(index, 'utf8');
  reject(forged([{ path: index, before: unchangedIndex, after: '任意内容替换' }]));
  assert.equal(readFileSync(index, 'utf8'), unchangedIndex);
  reject(forged([{ path: index, before: readFileSync(index, 'utf8'), after: readFileSync(index, 'utf8') + 'x' }], '0'.repeat(64)));
});

test('request_id replays a committed JSON write across processes and rejects a different payload', () => {
  const f = makeFixtureVault();
  const request_id = '11111111-1111-4111-8111-111111111111';
  const request_context_sha256 = 'a'.repeat(64);
  const payload = { type: 'observation', subfolder: '2026-08', title: 'idempotent event', description: 'fixture event', body: 'fixture event body', source: 'codex', request_id, request_context_sha256 };
  const first = runCli(f, ['--json'], { body: JSON.stringify(payload) });
  assert.equal(first.code, 0, first.stderr);
  const firstReceipt = parseJson(first.stdout, 'first receipt');
  const replay = runCli(f, ['--json'], { body: JSON.stringify(payload) });
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(parseJson(replay.stdout, 'replay receipt').path, firstReceipt.path);
  const ledger = readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter(entry => entry.request_id === request_id && entry.status === 'ok').length, 1, JSON.stringify(ledger));
  assert.equal(ledger.find(entry => entry.request_id === request_id).request_context_sha256, request_context_sha256);

  const conflict = runCli(f, ['--json'], { body: JSON.stringify({ ...payload, body: 'different body' }) });
  assert.equal(conflict.code, 1);
  assert.match(parseJson(conflict.stderr, 'conflict stderr').message, /idempotency_conflict/);
});

test('request_context_sha256 requires request_id and never replaces writer payload hashing', () => {
  const f = makeFixtureVault();
  const result = runCli(f, ['--type', 'note', '--title', 'context without id', '--description', 'fixture', '--request-context-sha256', 'b'.repeat(64)]);
  assert.equal(result.code, 1);
  assert.match(parseJson(result.stderr, 'context stderr').message, /requires request_id/);
});

test('concurrent processes with one request_id commit only once and replay the same receipt', async () => {
  const f = makeFixtureVault();
  const request_id = '33333333-3333-4333-8333-333333333333';
  const payload = JSON.stringify({ type: 'observation', subfolder: '2026-08', title: 'concurrent idempotency', description: 'fixture', body: 'fixture body', source: 'codex', request_id });
  const [left, right] = await Promise.all([runCliConcurrent(f, ['--json'], payload), runCliConcurrent(f, ['--json'], payload)]);
  assert.equal(left.code, 0, left.stderr);
  assert.equal(right.code, 0, right.stderr);
  assert.equal(parseJson(left.stdout, 'left').path, parseJson(right.stdout, 'right').path);
  const ledger = readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter(entry => entry.request_id === request_id && entry.status === 'ok').length, 1);
});

test('maintenance request_id replays after a note is deactivated before resolving its target again', () => {
  const f = makeFixtureVault();
  const created = assertReceipt(runCli(f, ['--type', 'experience', '--subfolder', 'AI工具', '--title', 'idempotent maintenance', '--description', 'fixture']), f);
  const before = readFileSync(created.path, 'utf8');
  const request_id = '22222222-2222-4222-8222-222222222222';
  const args = ['--deactivate', created.path, '--expected-sha256', digest(before), '--reason', 'fixture withdrawal', '--request-id', request_id];
  const first = runCli(f, args);
  assert.equal(first.code, 0, first.stderr);
  const receipt = parseJson(first.stdout, 'deactivate receipt');
  assert.equal(existsSync(created.path), false);
  const replay = runCli(f, args);
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(parseJson(replay.stdout, 'deactivate replay').operation_id, receipt.operation_id);
  const ledger = readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter(entry => entry.request_id === request_id && entry.status === 'ok').length, 1);
});

test('idempotent maintenance resumes SIGKILL plans and the restricted bridge reports not_prepared', () => {
  const bridge = makeFixtureVault();
  const request_id = '44444444-4444-4444-8444-444444444444', context = 'c'.repeat(64);
  const absent = runCli(bridge, ['--resume-maintenance', request_id, '--request-id', request_id, '--request-context-sha256', context]);
  assert.equal(absent.code, 0, absent.stderr);
  assert.deepEqual(parseJson(absent.stdout, 'not prepared'), { status: 'not_prepared' });

  for (const stage of ['plan-before', 'plan-after', 'note-after', 'ledger-before']) {
    const f = makeFixtureVault();
    const created = assertReceipt(runCli(f, ['--type', 'experience', '--subfolder', 'AI工具', '--title', `resume ${stage}`, '--description', 'fixture']), f);
    const before = readFileSync(created.path, 'utf8');
    const id = `${stage === 'plan-before' ? '5' : stage === 'plan-after' ? '6' : stage === 'note-after' ? '7' : '8'}5555555-5555-4555-8555-555555555555`;
    const context = ({ 'plan-before': 'a', 'plan-after': 'b', 'note-after': 'c', 'ledger-before': 'd' })[stage].repeat(64);
    const plan = join(f.vault, 'raw/processed/brain-write/note-maintenance', `${id}.json`);
    const argv = [WRITER, '--deactivate', created.path, '--expected-sha256', digest(before), '--reason', 'fixture interruption', '--request-id', id, '--request-context-sha256', context, '--source', 'codex'];
    const fault = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const link = fs.linkSync, unlink = fs.unlinkSync, append = fs.appendFileSync;
      fs.linkSync = (a,b) => { if (${JSON.stringify(stage)} === 'plan-before' && b === ${JSON.stringify(plan)}) process.kill(process.pid, 'SIGKILL'); const r = link(a,b); if (${JSON.stringify(stage)} === 'plan-after' && b === ${JSON.stringify(plan)}) process.kill(process.pid, 'SIGKILL'); return r; };
      fs.unlinkSync = p => { const r = unlink(p); if (${JSON.stringify(stage)} === 'note-after' && String(p).endsWith('.md')) process.kill(process.pid, 'SIGKILL'); return r; };
      fs.appendFileSync = (p,...rest) => { if (${JSON.stringify(stage)} === 'ledger-before') process.kill(process.pid, 'SIGKILL'); return append(p,...rest); };
      syncBuiltinESMExports(); process.argv = [process.execPath, ...${JSON.stringify(argv)}]; await import(${JSON.stringify(WRITER)});`;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', fault], { encoding: 'utf8', env: { ...process.env, ...f.env } });
    assert.equal(crashed.signal, 'SIGKILL', `${stage}: ${crashed.stderr}`);
    const retry = stage === 'plan-before'
      ? runCli(f, ['--resume-maintenance', id, '--request-id', id, '--request-context-sha256', context])
      : runCli(f, argv.slice(1));
    assert.equal(retry.code, 0, `${stage}: ${retry.stderr}`);
    assert.equal(existsSync(created.path), false);
    const ledger = readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(ledger.filter(entry => entry.request_id === id && entry.status === 'ok').length, 1);
  }

  const guarded = makeFixtureVault();
  const created = assertReceipt(runCli(guarded, ['--type', 'experience', '--subfolder', 'AI工具', '--title', 'guarded retry', '--description', 'fixture']), guarded);
  const before = readFileSync(created.path, 'utf8'), id = '99999999-9999-4999-8999-999999999999', guardedContext = 'e'.repeat(64), plan = join(guarded.vault, 'raw/processed/brain-write/note-maintenance', `${id}.json`);
  const argv = [WRITER, '--deactivate', created.path, '--expected-sha256', digest(before), '--reason', 'guarded interruption', '--request-id', id, '--request-context-sha256', guardedContext, '--source', 'codex'];
  const fault = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const link = fs.linkSync; fs.linkSync = (a,b) => { if (b === ${JSON.stringify(plan)}) process.kill(process.pid, 'SIGKILL'); return link(a,b); }; syncBuiltinESMExports(); process.argv = [process.execPath, ...${JSON.stringify(argv)}]; await import(${JSON.stringify(WRITER)});`;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', fault], { encoding: 'utf8', env: { ...process.env, ...guarded.env } });
  assert.equal(crashed.signal, 'SIGKILL');
  writeFileSync(created.path, 'third-party edit');
  const retry = runCli(guarded, argv.slice(1));
  assert.notEqual(retry.code, 0);
  assert.equal(readFileSync(created.path, 'utf8'), 'third-party edit');
});

test('local resume refuses another actor and the bridge refuses a mismatched request id', () => {
  const f = makeFixtureVault();
  const created = assertReceipt(runCli(f, ['--type', 'experience', '--subfolder', 'AI工具', '--title', 'actor guard', '--description', 'fixture']), f);
  const before = readFileSync(created.path, 'utf8'), id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', context = 'a'.repeat(64);
  const plan = join(f.vault, 'raw/processed/brain-write/note-maintenance', `${id}.json`);
  const argv = [WRITER, '--deactivate', created.path, '--expected-sha256', digest(before), '--reason', 'actor guard interruption', '--request-id', id, '--request-context-sha256', context, '--source', 'codex'];
  const fault = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const link = fs.linkSync; fs.linkSync = (a,b) => { const r = link(a,b); if (b === ${JSON.stringify(plan)}) process.kill(process.pid, 'SIGKILL'); return r; }; syncBuiltinESMExports(); process.argv = [process.execPath, ...${JSON.stringify(argv)}]; await import(${JSON.stringify(WRITER)});`;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', fault], { encoding: 'utf8', env: { ...process.env, ...f.env } });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  assert.equal(existsSync(plan), true);

  const foreign = runCli(f, ['--resume-maintenance', id, '--reason', '继续', '--source', 'claude']);
  assert.notEqual(foreign.code, 0);
  assert.match(foreign.stderr, /idempotency_conflict/);
  assert.equal(readFileSync(created.path, 'utf8'), before);

  const mismatched = runCli(f, ['--resume-maintenance', id, '--request-id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '--request-context-sha256', context]);
  assert.notEqual(mismatched.code, 0);
  assert.match(mismatched.stderr, /idempotency_conflict/);
  assert.equal(readFileSync(created.path, 'utf8'), before);

  const resumed = runCli(f, ['--resume-maintenance', id, '--reason', '继续']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(existsSync(created.path), false);
});

function assertReceipt(result, fixture, redirected = false) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const receipt = parseJson(result.stdout, 'stdout');
  for (const field of ['status', 'path', 'inbox_redirect', 'recall_state']) {
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
        assert.equal(receipt.recall_state, 'excluded_default_recall');
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
    test('B redirect ' + scenario.name + ' remains pending classification and out of recall indexes', () => {
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
      assert.equal(receipt.recall_state, 'pending_classification');
      assert.equal(hotLines(fixture).some(line => line.includes(title)), false);
      for (const name of DOMAIN_INDEXES) assert.doesNotMatch(readFileSync(join(fixture.memory, name), 'utf8'), new RegExp(title));
      assert.equal(existsSync(join(fixture.vault, '00-系统', '.index-cache', 'intent-map.json')), false);
      assert.equal(supplementalWarnings.join('\n'), '');
    });
  }

  test('B dry-run reports the same pending classification and no recall indexes as its redirected write', () => {
    const fixture = makeFixtureVault();
    const args = ['--type', 'experience', '--subfolder', '未批准分类', '--title', 'redirect-preview', '--description', 'redirect fixture', '--tags', 'experience,project'];
    const preview = parseJson(runCli(fixture, ['--dry-run', ...args]).stdout, 'dry-run stdout');
    assert.equal(preview.recall_state, 'pending_classification');
    assert.match(preview.would_create_file, /99-inbox\/experience\/redirect-preview\.md$/);
    assert.equal(preview.would_update_hot_section, null);
    assert.equal(preview.would_update_domain_index, null);
    assert.deepEqual(preview.intent_map_new_routes, {});

    const route = parseJson(runCli(fixture, ['--show-route', ...args]).stdout, 'show-route stdout');
    assert.equal(route.recall_state, 'pending_classification');
    assert.match(route.absolute_path, /99-inbox\/experience\/redirect-preview\.md$/);
    assert.equal(route.index_file, null);
    assert.deepEqual(route.cross_refs, []);
  });

  test('B session entries stay out of default recall indexes', () => {
    const fixture = makeFixtureVault();
    const title = 'session-default-recall-exclusion';
    const receipt = assertReceipt(runCli(fixture, [
      '--type', 'session', '--project', 'test-project', '--title', title, '--description', 'session fixture',
    ]), fixture);
    assert.equal(receipt.recall_state, 'excluded_default_recall');
    assert.equal(hotLines(fixture).some(line => line.includes(title)), false);
    for (const name of DOMAIN_INDEXES) assert.doesNotMatch(readFileSync(join(fixture.memory, name), 'utf8'), new RegExp(title));
    assert.equal(existsSync(join(fixture.vault, '00-系统', '.index-cache', 'intent-map.json')), false);
  });

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
      '--provenance', 'agent-checkpoint; key=' + fakeKey,
    ], { body: 'password: hunter22secret\nkey line ' + fakeKey + '\nref line process.env.OPENAI_API_KEY stays' });
    assertReceipt(result, fixture);
    const receipt = parseJson(result.stdout, 'stdout');
    assert.ok(receipt.redactions >= 2, 'expected redactions counter, got ' + receipt.redactions);
    const landed = readFileSync(receipt.path, 'utf8');
    assert.ok(!landed.includes('hunter22secret'), 'password value must not land');
    assert.ok(!landed.includes(fakeKey), 'api key must not land');
    assert.ok(!JSON.stringify(ledgerEntries(fixture)).includes(fakeKey), 'provenance credentials must not enter ledger');
    assert.ok(landed.includes('[REDACTED]'), 'placeholder expected');
    assert.ok(landed.includes('process.env.OPENAI_API_KEY'), 'env reference must survive');
  });

  test('E successful write appends actor/action/status to the ledger', () => {
    const fixture = makeFixtureVault();
    assertReceipt(runCli(fixture, [
      '--type', 'note',
      '--title', 'ledger-success',
      '--description', 'ledger',
      '--provenance', 'agent-checkpoint',
    ]), fixture);
    const entries = ledgerEntries(fixture);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actor, 'codex');
    assert.equal(entries[0].action, 'write');
    assert.equal(entries[0].status, 'ok');
    assert.equal(entries[0].provenance, 'agent-checkpoint');
    assert.equal(entries[0].trigger, 'agent-checkpoint');
  });

  test('JSON writes permit absent provenance but reject non-string provenance', () => {
    const fixture = makeFixtureVault();
    const input = { type: 'note', title: 'json-provenance', description: 'fixture', body: 'fixture body', source: 'codex' };
    const run = value => spawnSync(process.execPath, [WRITER, '--json', '--source', 'codex'], { input: JSON.stringify(value), env: { ...process.env, ...fixture.env }, encoding: 'utf8' });
    const ok = run(input);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ledgerEntries(fixture)[0].trigger, 'unknown');
    const invalid = run({ ...input, title: 'invalid', provenance: { token: 'fixture' } });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /provenance/);
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
    assert.equal(supplementalWarnings.join('\n'), '');

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

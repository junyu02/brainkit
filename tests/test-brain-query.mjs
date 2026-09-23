import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'scripts', 'cli', 'brain-query.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'brain-query-'));
  const vault = join(root, 'vault');
  const memory = join(root, 'memory');
  mkdirSync(join(vault, '00-系统', '.index-cache'), { recursive: true });
  mkdirSync(memory, { recursive: true });
  return { root, vault, memory };
}

function run(fixture, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    env: { ...process.env, BRAIN_VAULT_ROOT: fixture.vault, BRAIN_MEMORY_DIR: fixture.memory },
  });
}

function writeIndex(fixture, name, content) {
  writeFileSync(join(fixture.memory, name), content);
}

test('natural Chinese query finds a bounded verified source through its title phrase', () => {
  const f = fixture();
  const note = join(f.vault, '01-项目', '携程', '用户研究.md');
  mkdirSync(dirname(note), { recursive: true });
  writeFileSync(note, '# source exists\n');
  writeIndex(f, 'MEMORY-project.md', '## 携程\n- [携程用户研究] (../vault/01-项目/携程/用户研究.md) — 招聘流程研究摘要\n');
  writeFileSync(join(f.vault, '00-系统', '.index-cache', 'intent-map.json'), JSON.stringify({ keyword_routes: { '携程': ['MEMORY-project.md#携程'] } }));

  const result = run(f, ['--query', '携程用户研究怎么做', '--limit', '1', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].source_path, realpathSync(note));
  assert.ok(report.entries[0].matched_keywords.includes('用户研究'));
});

test('oversized intent map falls back to fixed memory indexes', () => {
  const f = fixture();
  const note = join(f.vault, '03-经验', '中文', '用户研究.md');
  mkdirSync(dirname(note), { recursive: true });
  writeFileSync(note, '# source exists\n');
  writeIndex(f, 'MEMORY-experience.md', '## 中文\n- [用户研究方法] (../vault/03-经验/中文/用户研究.md) — 访谈记录\n');
  writeFileSync(join(f.vault, '00-系统', '.index-cache', 'intent-map.json'), 'x'.repeat(2 * 1024 * 1024 + 1));

  const result = run(f, ['--query', '用户研究方法有哪些', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).entries[0].source_path, realpathSync(note));
});

test('escapes, symlinks, and internal raw paths never become candidates', () => {
  const f = fixture();
  const outside = join(f.root, 'outside.md');
  const linked = join(f.vault, '01-项目', 'linked.md');
  const hardLinked = join(f.vault, '01-项目', 'hard-linked.md');
  const internal = join(f.vault, '03-经验', 'raw', 'hidden.md');
  writeFileSync(outside, '# outside\n');
  mkdirSync(dirname(linked), { recursive: true });
  symlinkSync(outside, linked);
  linkSync(outside, hardLinked);
  mkdirSync(dirname(internal), { recursive: true });
  writeFileSync(internal, '# hidden\n');
  writeIndex(f, 'MEMORY.md', [
    '## 热记忆',
    '- [外部] (../outside.md) — 携程用户研究',
    '- [软链接] (../vault/01-项目/linked.md) — 携程用户研究',
    '- [硬链接] (../vault/01-项目/hard-linked.md) — 携程用户研究',
    '- [内部目录] (../vault/03-经验/raw/hidden.md) — 携程用户研究',
  ].join('\n'));

  const result = run(f, ['--query', '携程用户研究', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).entries, []);
});

test('enforces query and result limits', () => {
  const f = fixture();
  for (const args of [['--query', '用户研究', '--limit', '0'], ['--query', '用户研究', '--limit', '21'], ['--query', 'x'.repeat(1001)]]) {
    assert.notEqual(run(f, args).status, 0);
  }
  const long = run(f, ['--query', '甲'.repeat(1000), '--json']);
  assert.equal(long.status, 0, long.error?.message || long.stderr);
});

test('a generic intent route cannot inject AI model notes for a design model question', () => {
  const f = fixture();
  const topic = '双钻设计模型怎么用';
  const knowledge = join(f.vault, '02-知识', '设计', '双钻设计模型.md');
  const pending = join(f.vault, '99-inbox', '双钻设计模型.md');
  const unrelated = join(f.vault, '03-经验', 'AI工具', '模型路由.md');
  for (const file of [knowledge, pending, unrelated]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# source\n');
  }
  writeIndex(f, 'MEMORY-knowledge.md', `## 设计\n- [双钻设计模型](${knowledge}) — 发散与收敛\n`);
  writeIndex(f, 'MEMORY-experience.md', `## AI工具\n- [agentctl 模型路由](${unrelated}) — 自动切换模型与统计模型的设计模式\n`);
  writeFileSync(join(f.vault, '00-系统', '.index-cache', 'intent-map.json'), JSON.stringify({ keyword_routes: { 模型: ['MEMORY-experience.md#AI工具'] } }));
  let result = run(f, ['--query', topic, '--limit', '3', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).entries.map(row => row.source_path), [realpathSync(knowledge)]);
  writeIndex(f, 'MEMORY-knowledge.md', `## 设计\n- [双钻设计模型](${pending}) — 发散与收敛\n`);
  result = run(f, ['--query', topic, '--json']);
  assert.deepEqual(JSON.parse(result.stdout).entries, []);
});

test('parent symlinks and non-note directories are excluded even inside the vault', () => {
  const f = fixture();
  const target = join(f.vault, '03-经验', 'allowed');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'note.md'), '# note\n');
  symlinkSync(target, join(f.vault, '03-经验', 'alias'), 'dir');
  const bad = ['alias/note.md', '_index.md', 'node_modules/note.md', 'build/note.md', '拒收/note.md'];
  for (const relativePath of bad.slice(1)) {
    const file = join(f.vault, '03-经验', relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# ignored\n');
  }
  writeIndex(f, 'MEMORY.md', '## 热记忆\n' + bad.map(relativePath => `- [双钻设计模型](../vault/03-经验/${relativePath}) — 双钻设计模型`).join('\n'));
  const result = run(f, ['--query', '双钻设计模型', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).entries, []);
});

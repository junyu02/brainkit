import assert from 'node:assert/strict';
import { chmodSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createMemoryRuntime, rankNotes, noteLoops } from '../scripts/lib/memory-ops.mjs';
import { readActiveNote, listStructuredNotes } from '../scripts/lib/memory-read.mjs';
import { recordId, renderCandidate } from '../scripts/lib/memory-records.mjs';
import { eventId, ingestEvents } from '../scripts/lib/memory-ingestion.mjs';

const WRITER = fileURLToPath(new URL('../scripts/cli/brain-write.mjs', import.meta.url));
const qrels = JSON.parse(readFileSync(new URL('./fixtures/memory-qrels.json', import.meta.url), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => value && typeof value === 'object' && !Array.isArray(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
function eventBody(external_id) {
  const content = { provider: 'gmail', source_updated_at: '2026-09-21T00:00:00.000Z', title: '同步标题', summary: '同步摘要' };
  const event = { schema: 'brainkit-event/v1', event_id: eventId('gmail', external_id), source_ref: external_id, ...content, data_sha256: sha256(stable(content)) };
  return `\`\`\`brainkit-event\n${JSON.stringify(event)}\n\`\`\``;
}
const routing = {
  schema: 'vault-routing-v2',
  routes: [
    { type: 'experience', path: '03-经验/', scope: 'global' },
    { type: 'reference', path: '02-知识/', scope: 'global' },
    { type: 'project', path: '01-项目/{project-name}/', scope: 'project' },
    { type: 'user-profile', path: '05-persona/', scope: 'global' },
    { type: 'note', path: '07-随笔/', scope: 'global' },
    { type: 'weekly', path: '09-周报/', scope: 'global' },
    { type: 'observation', path: '08-观察/', scope: 'global' },
  ],
  inbox_root: '99-inbox/', inbox_subfolders: {},
  section_policies: {
    '01-项目/': { policy: 'bind_to_project', requires_subfolder: true, subfolder_source: '00-系统/.project-map.json' },
    '02-知识/': { policy: 'propose', requires_subfolder: true, allow_existing_subfolders: true, new_subfolder_policy: 'propose' },
    '03-经验/': { policy: 'deny_new_subfolder', requires_subfolder: true, allowed_subfolders: ['AI工具'], new_subfolder_policy: 'deny' },
    '05-persona/': { policy: 'allow_root', requires_subfolder: false },
    '07-随笔/': { policy: 'allow_root', requires_subfolder: false },
    '09-周报/': { policy: 'allow_root', requires_subfolder: false },
    // Same shape as the live vault-routing.json: month subfolder required.
    '08-观察/': { policy: 'allow_month', requires_subfolder: true, subfolder_pattern: '^(chronicle-)?\\d{4}-\\d{2}$' },
  },
};

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'memory-ops-'));
  const vault = join(root, 'vault'), memory = join(root, 'memory'), routingPath = join(root, 'routing.json');
  for (const path of [
    join(vault, '00-系统', '.index-cache'), join(vault, '00-系统', 'logs'),
    join(vault, '01-项目', 'test-project'), join(vault, '02-知识', '研究'), join(vault, '03-经验', 'AI工具'),
    join(vault, '05-persona'), join(vault, '07-随笔'), join(vault, '09-周报'),
    join(vault, '99-inbox'), memory,
  ]) mkdirSync(path, { recursive: true });
  writeFileSync(join(vault, '00-系统', '.project-map.json'), JSON.stringify({ mappings: [{ localPath: join(root, 'project'), vaultDir: '01-项目/test-project' }] }));
  writeFileSync(routingPath, JSON.stringify(routing));
  for (const name of ['MEMORY.md', 'MEMORY-experience.md', 'MEMORY-knowledge.md', 'MEMORY-project.md', 'MEMORY-persona.md', 'MEMORY-archive.md', 'MEMORY-notes.md']) writeFileSync(join(memory, name), '# index\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, vault, memory, routing: routingPath };
}

function writeNote(f, relative, title, description, body, meta = '') {
  const path = join(f.vault, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `---\ntitle: ${title}\ndescription: ${description}${meta}\n---\n${body}\n`);
  return path;
}

function runtime(f) {
  return createMemoryRuntime({ paths: { vault: f.vault, memory: f.memory, routing: f.routing }, allowWrites: true, actor: 'codex', now: () => Date.now() + 1_000 });
}

test('memory runtime writes, revises, deactivates and restores through the governed writer', async t => {
  const f = fixture(t), call = runtime(f);
  const remembered = await call('remember', { title: '编码规则', description: '持久编码约束', fact: '旧编码协议只在原文中出现。', type: 'experience', subfolder: 'AI工具', provenance: 'test fixture' });
  assert.equal(remembered.receipt.status, 'ok');
  let recalled = await call('recall', { query: '旧编码协议', semantic: false });
  assert.equal(recalled.items.length, 1);
  const note = recalled.items[0];
  await call('revise', { id: note.id, expected_sha256: note.source_sha256, reason: '更正内容', body: '新编码协议只在新正文中出现。' });
  const oldQuery = await call('recall', { query: '旧编码协议', semantic: false });
  assert.ok(oldQuery.items.every(item => !item.excerpt.includes('旧编码协议只在原文中出现。')));
  recalled = await call('recall', { query: '新编码协议', semantic: false });
  assert.equal(recalled.items.length, 1);
  const revised = recalled.items[0];
  assert.notEqual(revised.source_sha256, note.source_sha256);
  assert.match(revised.excerpt, /新编码协议只在新正文中出现/);
  const forgotten = await call('forget', { id: revised.id, expected_sha256: revised.source_sha256, reason: '可恢复停用' });
  assert.equal((await call('recall', { query: '新编码协议', semantic: false })).items.length, 0);
  await call('restore', { operation_id: forgotten.receipt.operation_id, reason: '恢复测试资料' });
  assert.equal((await call('recall', { query: '新编码协议', semantic: false })).items.length, 1);
});

test('entity resolution exposes typed wikilinks and refuses misses or ambiguity', async t => {
  const f = fixture(t), call = runtime(f);
  writeNote(f, '03-经验/AI工具/实体甲.md', '实体甲', '实体说明', '正文');
  writeNote(f, '03-经验/AI工具/关联.md', '关联', '关系说明', 'depends_on: [[实体甲]]');
  writeNote(f, '03-经验/AI工具/双冒号.md', '双冒号', '显式关系', 'works_at:: [[实体甲]]');
  writeNote(f, '03-经验/AI工具/重复一.md', '重复', '一', '正文');
  writeNote(f, '03-经验/AI工具/重复二.md', '重复', '二', '正文');
  const entity = await call('entity', { name: '实体甲' });
  assert.equal(entity.found, true);
  assert.deepEqual(new Set(entity.card.edges.map(edge => edge.type)), new Set(['depends_on', 'works_at']));
  assert.equal((await call('entity', { name: '不存在' })).found, false);
  const ambiguous = await call('entity', { name: '重复' });
  assert.equal(ambiguous.found, false);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.suggestions.length, 2);
});

test('only explicit follow-up checkboxes become loops and close with a hash precondition', async t => {
  const f = fixture(t), call = runtime(f);
  writeNote(f, '03-经验/AI工具/承诺.md', '承诺', '显式承诺', '- [ ] 普通检查项\n## 待跟进\n- [ ] 发送材料 [direction:: owed_by_me] [due:: 2026-09-30]');
  const loops = await call('open_loops', {});
  assert.equal(loops.items.length, 1);
  const loop = loops.items[0];
  await assert.rejects(call('loops_close', { id: loop.note_id, expected_sha256: '0'.repeat(64), reason: '过期副本', loop_id: loop.id }), error => error.code === 'conflict');
  await call('loops_close', { id: loop.note_id, expected_sha256: loop.source_sha256, reason: '已发送', loop_id: loop.id });
  assert.equal((await call('open_loops', {})).items.length, 0);
});

test('code examples cannot become actionable commitments', () => {
  for (const body of [
    '## 待跟进\n```js\n~~~\n- [ ] 代码示例\n```\n- [ ] 真实承诺',
    '## 待跟进\n````md\n```\n- [ ] 代码示例\n````\n- [ ] 真实承诺',
    '## 待跟进\n```md\n```not-a-close\n- [ ] 代码示例\n```\n- [ ] 真实承诺',
    '## 待跟进\n    - [ ] 缩进代码\n- [ ] 真实承诺',
  ]) assert.deepEqual(noteLoops({ id: 'fixture.md', meta: {}, body }).map(item => item.summary), ['真实承诺']);
});

test('context packs preserve a UTF-8 JSON budget and lexical qrels rank their actual notes', async t => {
  const f = fixture(t), call = runtime(f);
  const files = [
    writeNote(f, '03-经验/AI工具/编码协议.md', '编码协议', '固定编码协议', '编码协议内容'),
    writeNote(f, '02-知识/研究/产品调研.md', '产品调研', '产品调研结论', '调研原文'),
    writeNote(f, '09-周报/回顾节奏.md', '回顾节奏', '每周回顾节奏', '周报原文'),
  ];
  const notes = files.map(path => ({ id: path.slice(f.vault.length + 1), title: path.includes('编码') ? '编码协议' : path.includes('调研') ? '产品调研' : '回顾节奏', description: path.includes('编码') ? '固定编码协议' : path.includes('调研') ? '产品调研结论' : '每周回顾节奏', body: '资料正文' }));
  for (const { question, expected_id: expected } of qrels) assert.ok(rankNotes(notes, question, 3).some(row => row.note.id === expected), question);
  const packed = await call('context_pack', { entities: ['编码协议'], budget_bytes: 900 });
  assert.ok(Buffer.byteLength(JSON.stringify(packed)) <= 900);
  assert.ok(packed.budget_used <= 900);
});

test('delta paginates notes sharing an mtime without omissions', async t => {
  const f = fixture(t), call = runtime(f), stamp = new Date('2026-09-21T01:02:03.000Z');
  const paths = ['甲', '乙', '丙'].map(name => writeNote(f, `03-经验/AI工具/${name}.md`, `${name}变化`, `${name}说明`, `${name}正文`));
  for (const path of paths) utimesSync(path, stamp, stamp);
  const first = await call('delta', { since: '2026-09-20T00:00:00.000Z', limit: 1, budget_bytes: 1000 });
  assert.equal(first.items.length, 1);
  assert.equal(first.has_more, true);
  const second = await call('delta', { cursor: first.next_cursor, limit: 1, budget_bytes: 1000 });
  const third = await call('delta', { cursor: second.next_cursor, limit: 1, budget_bytes: 1000 });
  assert.deepEqual(new Set([...first.items, ...second.items, ...third.items].map(item => item.id)), new Set(paths.map(path => path.slice(f.vault.length + 1))));
});

test('delta reports a governed deactivate event for a withdrawn note', async t => {
  const f = fixture(t), call = runtime(f);
  const remembered = await call('remember', { title: '撤回资料', fact: '将被撤回的资料。', type: 'experience', subfolder: 'AI工具', provenance: 'test fixture' });
  const recalled = await call('recall', { query: '撤回资料', semantic: false });
  const note = recalled.items[0];
  await call('forget', { id: note.id, expected_sha256: note.source_sha256, reason: '撤回测试' });
  const delta = await call('delta', { since: '2026-09-20T00:00:00.000Z', budget_bytes: 2000 });
  const event = delta.items.find(item => item.id === note.id && item.event === 'deactivate');
  assert.ok(event, 'deactivate must be visible in delta after the active note disappears');
  assert.equal(typeof event.event_id, 'string');
});

test('the memory surface refuses broad maintenance restore and preserves option-shaped text', async t => {
  const f = fixture(t), call = runtime(f);
  writeFileSync(join(f.vault, '00-系统/logs/brain-write-ledger.jsonl'), JSON.stringify({ status: 'ok', ts: new Date().toISOString(), action: 'rename', operation_id: '11111111-1111-4111-8111-111111111111' }) + '\n');
  await assert.rejects(call('restore', { operation_id: '11111111-1111-4111-8111-111111111111', reason: '检查范围' }), error => error.code === 'scope_denied');
  await call('remember', { title: '选项开头正文', fact: '--这是一段正文', type: 'experience', subfolder: 'AI工具', provenance: 'test fixture' });
  const note = (await call('recall', { query: '选项开头正文', semantic: false })).items[0];
  await call('revise', { id: note.id, expected_sha256: note.source_sha256, reason: '--测试', body: '--修订后正文' });
  assert.match((await call('recall', { query: '选项开头正文', semantic: false })).items[0].excerpt, /--修订后正文/);
});

test('structured candidates promote with stable identity and evidence changes remove default authority', async t => {
  const f = fixture(t), call = runtime(f), sha = text => createHash('sha256').update(text).digest('hex');
  const sourcePath = writeNote(f, '03-经验/AI工具/来源.md', '来源', '原始材料', '甲在乙工作。甲已经发送材料。');
  const origin = readActiveNote(f.vault, sourcePath);
  const evidence = quote => ({ note_id: origin.id, source_sha256: origin.source_sha256, quote, quote_sha256: sha(quote), trust: origin.trust });
  const record = { schema: 'brainkit-record/v1', kind: 'fact', id: recordId('fact', 'scratch-affiliation'), version: 1, confirmation: 'proposed', sources: [evidence('甲在乙工作。')], statement: '甲在乙工作。', subject: { name: '甲' }, predicate: 'works_at', object: { name: '乙' } };
  // No subfolder: observations must default to the ingest month on their own.
  const proposed = await call('remember', { title: '待确认记录', type: 'observation', record, provenance: 'synthetic acceptance', request_id: randomUUID() });
  assert.equal(proposed.status, 'committed');
  assert.match(proposed.receipt.candidate_id, /^cand_/);
  assert.equal((await call('recall', { record_id: record.id, semantic: false })).items.length, 0);
  const candidate = (await call('recall', { record_id: record.id, include_unconfirmed: true, detail: 'record', semantic: false })).items[0];
  assert.equal(candidate.record.confirmation, 'proposed');
  await assert.rejects(call('revise', { id: candidate.id, expected_sha256: candidate.source_sha256, reason: 'illegal candidate replacement', body: renderCandidate({ ...record, statement: '甲在丙工作。' }) }), error => error.code === 'write_failed');
  const confirmed = { ...record, confirmation: 'confirmed' };
  await call('remember', { title: '正式记录', type: 'experience', subfolder: 'AI工具', record: confirmed, provenance: 'reviewed synthetic source' });
  const first = (await call('recall', { record_id: record.id, detail: 'record', semantic: false })).items[0];
  assert.equal(first.record.id, record.id);
  assert.equal(first.record.version, 1);
  await assert.rejects(call('remember', { title: '重复稳定ID', type: 'experience', subfolder: 'AI工具', record: confirmed, provenance: 'duplicate synthetic identity' }), error => error.code === 'write_failed');
  const revision = await call('revise', { id: first.id, expected_sha256: first.source_sha256, record: { ...confirmed, version: 2, statement: '根据原文，甲在乙工作。' }, reason: 'wording correction', request_id: randomUUID() });
  assert.equal(revision.receipt.record_version, 2);
  const updated = (await call('recall', { record_id: record.id, detail: 'record', semantic: false })).items[0];
  const forget = { id: updated.id, expected_sha256: updated.source_sha256, reason: 'reversible acceptance', request_id: randomUUID() };
  const withdrawn = await call('forget', forget);
  assert.equal((await call('forget', forget)).replayed, true);
  assert.equal((await call('recall', { record_id: record.id, semantic: false })).items.length, 0);
  await call('restore', { operation_id: withdrawn.receipt.operation_id, reason: 'restore synthetic fact' });
  assert.equal((await call('recall', { record_id: record.id, detail: 'record', semantic: false })).items[0].record.version, 2);
  const task = { schema: 'brainkit-record/v1', kind: 'commitment', id: recordId('commitment', 'send-material'), version: 1, confirmation: 'confirmed', sources: [evidence('甲在乙工作。')], summary: '甲发送材料', owner: { name: '甲' }, counterparty: null, due: null, status: 'open', completion_sources: [] };
  await call('remember', { title: '材料承诺', type: 'experience', subfolder: 'AI工具', record: task, provenance: 'synthetic commitment' });
  const loop = (await call('open_loops')).items[0];
  await assert.rejects(call('loops_close', { id: loop.note_id, loop_id: task.id, expected_sha256: loop.source_sha256, reason: 'without completion evidence' }), /completion_sources/);
  await call('loops_close', { id: loop.note_id, loop_id: task.id, expected_sha256: loop.source_sha256, reason: 'explicit completion', completion_sources: [evidence('甲已经发送材料。')] });
  assert.equal((await call('open_loops')).items.length, 0);
  await call('revise', { id: origin.id, expected_sha256: origin.source_sha256, body: '修订来源：甲目前在丙工作。', reason: 'original source changed' });
  assert.equal((await call('recall', { record_id: record.id, semantic: false })).items.length, 0);
  assert.ok((await call('synthesize', { mode: 'enrich', include_unconfirmed: true, budget_bytes: 16000 })).items.some(item => item.type === 'source_changed' && item.record_id === record.id));
});

test('connector intake validates windows before writing and only checkpoints a complete batch', async t => {
  const f = fixture(t), call = createMemoryRuntime({ paths: f, allowWrites: true, actor: 'codex', syncStateRoot: join(f.root, 'sync') });
  const input = { provider: 'gmail', events: [{ external_id: 'synthetic-message', updated_at: '2026-09-22T01:00:00Z', title: '合成收件', summary: '验收用信息' }], window_start: '2026-09-22T00:00:00Z', window_end: '2026-09-23T00:00:00Z', expected_revision: 0, complete_window: true };
  await assert.rejects(call('ingest_events', { ...input, window_end: '2026-02-30T00:00:00Z' }), error => error.code === 'invalid_params');
  assert.equal((await call('recall', { query: '合成收件', include_unconfirmed: true, semantic: false })).items.length, 0);
  const first = await call('ingest_events', input);
  assert.equal(first.succeeded, 1);
  assert.equal(first.watermark_advanced, true);
  const eventNote = listStructuredNotes(f.vault)[0];
  let alteredBody;
  await ingestEvents({ provider: 'gmail', events: [{ ...input.events[0], summary: 'different data at same source revision' }], notes: [], readNote: () => null, write: (_args, text) => { alteredBody = JSON.parse(text).body; return { status: 'failed' }; } });
  await assert.rejects(call('revise', { id: eventNote.id, expected_sha256: eventNote.source_sha256, body: alteredBody, reason: 'same-time raw revision must be rejected too' }), error => error.code === 'write_failed');
  const retry = await call('ingest_events', input);
  assert.equal(retry.skipped, 1);
  assert.equal(retry.succeeded, 0);
  await assert.rejects(call('ingest_events', { ...input, window_start: '2026-09-01T00:00:00Z' }), error => error.code === 'conflict');
  const conflict = await call('ingest_events', { ...input, expected_revision: 1, window_end: '2026-09-24T00:00:00Z', events: [{ ...input.events[0], summary: 'same-time conflicting data' }] });
  assert.equal(conflict.failed, 1);
  assert.equal(conflict.watermark_advanced, false);
  const state = await call('sync_status', { provider: 'gmail' });
  assert.equal(state.checkpoints.gmail.completed_through, '2026-09-23T00:00:00.000Z');
});

test('connector request_id binds the whole batch before writes and resumes partial failures', async t => {
  const f = fixture(t); let failOnce = true;
  const call = createMemoryRuntime({ paths: f, allowWrites: true, actor: 'codex', syncStateRoot: join(f.root, 'sync'), run: (cmd, args, options) => {
    if (failOnce && args.includes('--json') && options.input?.includes('second event')) { failOnce = false; return { status: 1, stdout: '', stderr: 'synthetic temporary failure' }; }
    return spawnSync(cmd, args, options);
  } });
  const input = { provider: 'gmail', request_id: randomUUID(), events: [{ external_id: 'first', updated_at: '2026-09-22T01:00:00Z', title: 'first event', summary: 'one' }, { external_id: 'second', updated_at: '2026-09-22T02:00:00Z', title: 'second event', summary: 'two' }], window_start: '2026-09-22T00:00:00Z', window_end: '2026-09-23T00:00:00Z', expected_revision: 0, complete_window: true };
  const partial = await call('ingest_events', input);
  assert.equal(partial.failed, 1);
  assert.equal(partial.watermark_advanced, false);
  await assert.rejects(call('ingest_events', { ...input, events: [] }), error => error.code === 'idempotency_conflict');
  const resumed = await call('ingest_events', input);
  assert.equal(resumed.failed, 0);
  assert.equal(resumed.skipped, 1);
  assert.equal(resumed.succeeded, 1);
  assert.equal(resumed.watermark_advanced, true);
  assert.equal((await call('ingest_events', input)).replayed, true);
  await assert.rejects(call('ingest_events', { ...input, events: [...input.events, { ...input.events[0], external_id: 'different' }] }), error => error.code === 'idempotency_conflict');
  assert.equal(listStructuredNotes(f.vault).length, 2);
  const empty = { ...input, request_id: randomUUID(), events: [], expected_revision: resumed.checkpoint.revision };
  await call('ingest_events', empty);
  await assert.rejects(call('ingest_events', { ...empty, events: input.events }), error => error.code === 'idempotency_conflict');
});

test('an over-limit unconfirmed scan is a typed scan_limit, confirmed-only still works', async t => {
  const f = fixture(t), call = runtime(f);
  writeNote(f, '03-经验/AI工具/可确认.md', '可确认', '确认分区', '确认正文');
  const observations = join(f.vault, '08-观察', '2026-09');
  mkdirSync(observations, { recursive: true });
  // Past maxNotes only once 08-观察 is in scope, which is the live vault's shape.
  for (let index = 0; index <= 10_000; index++) writeFileSync(join(observations, `${index}.md`), 'observation');
  await assert.rejects(call('recall', { query: '确认', include_unconfirmed: true, semantic: false }),
    error => error.code === 'scan_limit' && /maxNotes/.test(error.message) && error.suggestion.includes('source_ids'));
  const confirmed = await call('recall', { query: '确认正文', semantic: false });
  assert.equal(confirmed.items.length, 1);
});

test('observations default to the ingest month, explicit subfolders and other types are untouched', async t => {
  const f = fixture(t), call = runtime(f), sha = text => createHash('sha256').update(text).digest('hex');
  const at = new Date();
  const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
  const sourcePath = writeNote(f, '03-经验/AI工具/来源.md', '来源', '原始材料', '甲在乙工作。');
  const origin = readActiveNote(f.vault, sourcePath), quote = '甲在乙工作。';
  const record = { schema: 'brainkit-record/v1', kind: 'fact', id: recordId('fact', 'default-month'), version: 1, confirmation: 'proposed',
    sources: [{ note_id: origin.id, source_sha256: origin.source_sha256, quote, quote_sha256: sha(quote), trust: origin.trust }],
    statement: '甲在乙工作。', subject: { name: '甲' }, predicate: 'works_at', object: { name: '乙' } };
  const defaulted = await call('remember', { title: '默认月份候选', type: 'observation', record, provenance: 'synthetic default' });
  assert.equal(defaulted.status, 'committed');
  assert.ok(defaulted.receipt.path.includes(`/08-观察/${month}/`), defaulted.receipt.path);
  // An explicit subfolder still wins.
  mkdirSync(join(f.vault, '08-观察', '2026-01'), { recursive: true });
  const explicit = await call('remember', { title: '显式月份观察', type: 'observation', subfolder: '2026-01', fact: '显式落点。', provenance: 'synthetic explicit' });
  assert.ok(explicit.receipt.path.includes('/08-观察/2026-01/'), explicit.receipt.path);
  // Other types keep their existing no-subfolder behaviour.
  const weekly = await call('remember', { title: '周报条目', type: 'weekly', fact: '周报正文。', provenance: 'synthetic weekly' });
  assert.ok(weekly.receipt.path.includes('/09-周报/'), weekly.receipt.path);
  assert.equal(weekly.receipt.path.includes(month), false, weekly.receipt.path);
});

test('connector events land in their own event month, stay discoverable, and name a redirect', async t => {
  const f = fixture(t), call = createMemoryRuntime({ paths: f, allowWrites: true, actor: 'codex', syncStateRoot: join(f.root, 'sync') });
  const month = at => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
  // A backfill spanning two months must split across both, not pile into one.
  const input = { provider: 'gmail', events: [
      { external_id: 'july-event', updated_at: '2026-07-04T01:00:00Z', title: '七月事件', summary: '七月' },
      { external_id: 'september-event', updated_at: '2026-09-22T01:00:00Z', title: '九月事件', summary: '九月' },
    ], window_start: '2026-07-01T00:00:00Z', window_end: '2026-09-23T00:00:00Z', expected_revision: 0, complete_window: true };
  const first = await call('ingest_events', { ...input, request_id: randomUUID() });
  assert.equal(first.succeeded, 2);
  const ids = listStructuredNotes(f.vault).map(note => note.id).sort();
  assert.equal(ids.length, 2);
  assert.ok(ids.some(id => id.startsWith(`08-观察/${month(new Date('2026-07-04T01:00:00Z'))}/`)), ids.join(', '));
  assert.ok(ids.some(id => id.startsWith(`08-观察/${month(new Date('2026-09-22T01:00:00Z'))}/`)), ids.join(', '));
  for (const id of ids) assert.match(id, /\/同步-evt_[a-f0-9]{24}\.md$/);
  // A fresh request_id must find the existing notes rather than write second copies.
  const replay = await call('ingest_events', { ...input, expected_revision: 1, request_id: randomUUID() });
  assert.deepEqual(replay.results.map(row => row.status), ['skipped_stale_or_unchanged', 'skipped_stale_or_unchanged']);
  assert.deepEqual(listStructuredNotes(f.vault).map(note => note.id).sort(), ids);
  assert.deepEqual((await call('sync_status', { provider: 'gmail' })).known_events.map(row => row.note_id).sort(), ids);

  // A routing policy the payload cannot satisfy must surface why, not a bare 'failed'.
  const blocked = fixture(t);
  writeFileSync(blocked.routing, JSON.stringify({ ...routing,
    section_policies: { ...routing.section_policies, '08-观察/': { policy: 'deny_new_subfolder', requires_subfolder: true, allowed_subfolders: ['已存在'] } } }));
  const blockedCall = createMemoryRuntime({ paths: blocked, allowWrites: true, actor: 'codex', syncStateRoot: join(blocked.root, 'sync') });
  const redirected = await blockedCall('ingest_events', { ...input, request_id: randomUUID() });
  assert.equal(redirected.results[0].status, 'failed');
  assert.match(redirected.results[0].reason, /inbox|pending_classification/);
});

test('a structured note archived outside the governed sections stops blocking the ledger scan', async t => {
  const f = fixture(t), call = createMemoryRuntime({ paths: f, allowWrites: true, actor: 'codex', syncStateRoot: join(f.root, 'sync') });
  const window = { provider: 'gmail', window_start: '2026-09-22T00:00:00Z', window_end: '2026-09-23T00:00:00Z', complete_window: true };
  const first = await call('ingest_events', { ...window, expected_revision: 0, events: [
    { external_id: 'kept', updated_at: '2026-09-22T01:00:00Z', title: '保留事件', summary: '保留' },
    { external_id: 'archived', updated_at: '2026-09-22T02:00:00Z', title: '归档事件', summary: '归档' },
  ] });
  assert.equal(first.succeeded, 2);
  const notes = listStructuredNotes(f.vault);
  assert.equal(notes.length, 2);
  // brain-archive-aged moves aged notes with a plain rename and writes no receipt.
  mkdirSync(join(f.vault, '06-归档'), { recursive: true });
  renameSync(notes[0].path, join(f.vault, '06-归档', basename(notes[0].path)));
  const diagnostics = [];
  assert.deepEqual(listStructuredNotes(f.vault, { diagnostics }).map(note => note.id), [notes[1].id]);
  assert.deepEqual(diagnostics, []);
  const state = await call('sync_status', { provider: 'gmail' });
  assert.equal(state.known_events.length, 1);
  const after = await call('ingest_events', { ...window, window_end: '2026-09-24T00:00:00Z', expected_revision: state.checkpoints.gmail.revision, events: [{ external_id: 'after-archive', updated_at: '2026-09-22T03:00:00Z', title: '归档后事件', summary: '归档后' }] });
  assert.equal(after.succeeded, 1);
});

test('one invalid structured note names its own path instead of silently blocking every structured write', async t => {
  const f = fixture(t), call = createMemoryRuntime({ paths: f, allowWrites: true, actor: 'codex', syncStateRoot: join(f.root, 'sync') });
  const first = await call('ingest_events', { provider: 'gmail', events: [{ external_id: 'valid', updated_at: '2026-09-22T01:00:00Z', title: '有效事件', summary: '有效' }], window_start: '2026-09-22T00:00:00Z', window_end: '2026-09-23T00:00:00Z', expected_revision: 0, complete_window: true });
  assert.equal(first.succeeded, 1);
  const note = listStructuredNotes(f.vault)[0], original = readFileSync(note.path, 'utf8');
  writeFileSync(note.path, original.replace(/```brainkit-event\n[\s\S]*?\n```/, '```brainkit-event\n{}\n```'));
  // The suggestion must locate the note without handing a remote caller the host path.
  await assert.rejects(call('sync_status', { provider: 'gmail' }), error => error.code === 'source_invalid'
    && error.suggestion.includes(note.id) && !error.suggestion.includes(f.vault));
  const writerEnv = { ...process.env, BRAIN_VAULT_ROOT: f.vault, BRAIN_MEMORY_DIR: f.memory, BRAIN_ROUTING_JSON: f.routing };
  const payload = external_id => JSON.stringify({ type: 'observation', title: `新结构化笔记-${external_id}`, description: '新事件', body: eventBody(external_id), provenance: 'test fixture' });
  const blocked = spawnSync(process.execPath, [WRITER, '--json', '--source', 'codex'], { encoding: 'utf8', input: payload('blocked-by-invalid'), env: writerEnv });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /cannot verify structured identity/);
  assert.ok(blocked.stderr.includes(note.path), blocked.stderr);
  writeFileSync(note.path, original);
  assert.equal((await call('sync_status', { provider: 'gmail' })).known_events.length, 1);
  const allowed = spawnSync(process.execPath, [WRITER, '--json', '--source', 'codex'], { encoding: 'utf8', input: payload('allowed-after-repair'), env: writerEnv });
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('closing a structured commitment without completion evidence is a typed parameter error', async t => {
  const f = fixture(t), call = runtime(f);
  const sourcePath = writeNote(f, '03-经验/AI工具/承诺来源.md', '承诺来源', '原始材料', '甲已经发送材料。');
  const origin = readActiveNote(f.vault, sourcePath), quote = '甲已经发送材料。';
  const task = { schema: 'brainkit-record/v1', kind: 'commitment', id: recordId('commitment', 'typed-close'), version: 1, confirmation: 'confirmed', sources: [{ note_id: origin.id, source_sha256: origin.source_sha256, quote, quote_sha256: sha256(quote), trust: origin.trust }], summary: '甲发送材料', owner: { name: '甲' }, counterparty: null, due: null, status: 'open', completion_sources: [] };
  await call('remember', { title: '材料承诺', type: 'experience', subfolder: 'AI工具', record: task, provenance: 'synthetic commitment' });
  const loop = (await call('open_loops')).items[0];
  await assert.rejects(
    call('loops_close', { id: loop.note_id, loop_id: task.id, expected_sha256: loop.source_sha256, reason: 'without completion evidence' }),
    error => error.code === 'invalid_params' && /completion_sources must contain 1\.\.8/.test(error.message) && error.suggestion.includes('quote_sha256'),
  );
});

test('an unreadable evidence note removes record authority instead of raising a bare filesystem error', async t => {
  if (process.getuid?.() === 0) return;
  const f = fixture(t), call = runtime(f);
  const sourcePath = writeNote(f, '03-经验/AI工具/证据.md', '证据', '原始材料', '甲在乙工作。');
  const origin = readActiveNote(f.vault, sourcePath), quote = '甲在乙工作。';
  const record = { schema: 'brainkit-record/v1', kind: 'fact', id: recordId('fact', 'unreadable-evidence'), version: 1, confirmation: 'confirmed', sources: [{ note_id: origin.id, source_sha256: origin.source_sha256, quote, quote_sha256: sha256(quote), trust: origin.trust }], statement: '甲在乙工作。', subject: { name: '甲' }, predicate: 'works_at', object: { name: '乙' } };
  await call('remember', { title: '证据记录', type: 'experience', subfolder: 'AI工具', record, provenance: 'synthetic evidence' });
  chmodSync(sourcePath, 0o000);
  let recalled, failure = null;
  try { recalled = await call('recall', { record_id: record.id, include_unconfirmed: true, semantic: false }); }
  catch (error) { failure = error; }
  chmodSync(sourcePath, 0o644);
  assert.equal(failure, null, String(failure));
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].evidence_current, false);
  assert.equal(recalled.items[0].trust, 'observation_unconfirmed');
  // The write path fails closed, and names the note without the host path or errno text.
  chmodSync(sourcePath, 0o000);
  const write = await call('remember', { title: '再写一条', type: 'experience', subfolder: 'AI工具', provenance: 'synthetic evidence',
    record: { ...record, id: recordId('fact', 'unreadable-evidence-2') } }).then(() => null, error => error);
  chmodSync(sourcePath, 0o644);
  assert.equal(write.code, 'source_invalid');
  assert.ok(write.message.includes(origin.id), write.message);
  assert.equal(write.message.includes(f.vault) || write.suggestion.includes(f.vault), false);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listActiveNotes, listStructuredNotes, parseFrontmatter, readActiveNote, readWriteEvents } from '../scripts/lib/memory-read.mjs';
import { eventId } from '../scripts/lib/memory-ingestion.mjs';
import { recordId } from '../scripts/lib/memory-records.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => value && typeof value === 'object' && !Array.isArray(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
function eventNote(external_id) {
  const content = { provider: 'gmail', source_updated_at: '2026-09-21T00:00:00.000Z', title: '同步标题', summary: '同步摘要' };
  const event = { schema: 'brainkit-event/v1', event_id: eventId('gmail', external_id), source_ref: external_id, ...content, data_sha256: sha(stable(content)) };
  return `---\nname: Structured\ndescription: fixture\n---\n\`\`\`brainkit-event\n${JSON.stringify(event)}\n\`\`\`\n`;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-read-'));
  for (const section of ['01-项目', '02-知识', '03-经验', '04-对话', '05-persona', '07-随笔', '08-观察', '09-周报']) mkdirSync(join(root, section));
  t?.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('parses bounded frontmatter and reads a Chinese source note', t => {
  const vault = fixture(t);
  const note = join(vault, '03-经验', '中文.md');
  writeFileSync(note, '---\ntitle: 中文标题\ndescription: 简短说明\ntags: [记忆, true, 2]\nexpires: 2000-01-01\n---\n正文\n');
  assert.deepEqual(parseFrontmatter('---\ntags:\n - 一\n - 二\n---\nbody'), { meta: { tags: ['一', '二'] }, body: 'body' });
  const read = readActiveNote(vault, note, { now: Date.UTC(2026, 0, 1) });
  assert.equal(read.title, '中文标题');
  assert.equal(read.body, '正文\n');
  assert.equal(read.expired, true);
  assert.equal(read.trust, 'vault_source');
  assert.deepEqual(parseFrontmatter('---\ndescription: |\n  第一行\n  第二行\naliases: ["a,b", \'c,d\']\n---\nbody'), {
    meta: { description: '第一行\n第二行', aliases: ['a,b', 'c,d'] }, body: 'body',
  });
  assert.deepEqual(parseFrontmatter('---\n项目: 春招\n描述: `code` 开头\n---\nbody'), {
    meta: { 项目: '春招', 描述: '`code` 开头' }, body: 'body',
  });
});

test('rejects a note with unsafe frontmatter but reports its scan diagnostic', t => {
  const vault = fixture(t);
  writeFileSync(join(vault, '03-经验', 'valid.md'), 'valid');
  writeFileSync(join(vault, '03-经验', 'unsafe-status.md'), '---\nactive: {not-supported}\n---\nbody');
  const diagnostics = [];
  assert.deepEqual(listActiveNotes(vault, { diagnostics }).map(note => note.id), ['03-经验/valid.md']);
  assert.match(diagnostics[0].message, /unsupported frontmatter/);
});

test('rejects unsafe paths, invalid utf8, and oversized content', t => {
  const vault = fixture(t);
  const outside = join(tmpdir(), `outside-${Date.now()}.md`);
  writeFileSync(outside, 'outside');
  const linked = join(vault, '03-经验', 'linked.md');
  symlinkSync(outside, linked);
  const invalid = join(vault, '03-经验', 'invalid.md');
  writeFileSync(invalid, Buffer.from([0xff, 0xfe]));
  const big = join(vault, '03-经验', 'big.md');
  writeFileSync(big, Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.equal(readActiveNote(vault, linked), null);
  assert.equal(readActiveNote(vault, invalid), null);
  assert.equal(readActiveNote(vault, big), null);
});

test('allows only an outer vault alias and excludes observations by default', t => {
  const vault = fixture(t);
  const alias = `${vault}-alias`;
  symlinkSync(vault, alias);
  const active = join(vault, '02-知识', 'active.md');
  const observed = join(vault, '08-观察', 'observed.md');
  writeFileSync(active, 'active');
  writeFileSync(observed, 'observed');
  assert.equal(readActiveNote(alias, join(alias, '02-知识', 'active.md')).id, '02-知识/active.md');
  assert.deepEqual(listActiveNotes(alias).map(note => note.id), ['02-知识/active.md']);
  assert.deepEqual(listActiveNotes(alias, { includeUnconfirmed: true }).map(note => note.id), ['02-知识/active.md', '08-观察/observed.md']);
  // Typed so the runtime can turn it into an actionable error, not operation_failed.
  assert.throws(() => listActiveNotes(alias, { includeUnconfirmed: true, maxNotes: 1 }), error => /exceeds maxNotes/.test(error.message) && error.code === 'scan_limit');
});

test('reads only complete successful writer events from the fixed ledger', t => {
  const vault = fixture(t);
  assert.deepEqual(readWriteEvents(vault), []);
  const logs = join(vault, '00-系统', 'logs');
  mkdirSync(logs, { recursive: true });
  const ledger = join(logs, 'brain-write-ledger.jsonl');
  writeFileSync(ledger, '{"status":"ok","ts":"2026-09-22T00:00:00.000Z","action":"write"}\n{"status":"failed","ts":"2026-09-22T00:00:00.000Z"}\n');
  assert.deepEqual(readWriteEvents(vault).map(event => event.action), ['write']);
  writeFileSync(ledger, '{"status":"ok"');
  assert.throws(() => readWriteEvents(vault), /incomplete JSON/);
});

test('discovers governed structured notes from ledger paths without scanning over 10k ordinary observations', t => {
  const vault = fixture(t);
  const structured = join(vault, '08-观察', 'record.md');
  writeFileSync(structured, eventNote('discovered'));
  const ordinary = join(vault, '08-观察', 'ordinary');
  mkdirSync(ordinary);
  for (let index = 0; index <= 10_000; index++) writeFileSync(join(ordinary, `${index}.md`), 'ordinary');
  assert.throws(() => listActiveNotes(vault, { includeUnconfirmed: true }), /exceeds maxNotes/);
  const logs = join(vault, '00-系统', 'logs');
  mkdirSync(logs, { recursive: true });
  const outside = join(tmpdir(), 'not-a-vault-note.md');
  writeFileSync(outside, 'outside');
  writeFileSync(join(logs, 'brain-write-ledger.jsonl'), [
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:00Z', action: 'write', record_id: 'rec_1', target_path: join(vault, '08-观察', 'missing.md') }),
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:01Z', action: 'rename', record_id: 'rec_1', target_path: join(vault, '08-观察', 'missing.md'), new_path: structured }),
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:02Z', action: 'write', record_id: 'rec_ordinary', target_path: join(vault, '08-观察', 'ordinary', '0.md') }),
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:03Z', action: 'write', event_id: 'evt_bad', target_path: outside }),
  ].join('\n') + '\n');
  const diagnostics = [];
  assert.deepEqual(listStructuredNotes(vault, { diagnostics }).map(note => note.id), ['08-观察/record.md']);
  // A ledger path outside the readable sections carries no identity, so it is
  // skipped silently; a readable note that lost its structured body is not.
  assert.equal(diagnostics.some(row => row.path === outside), false);
  assert.ok(diagnostics.some(row => row.path.endsWith('ordinary/0.md')));
  writeFileSync(join(logs, 'brain-write-ledger.jsonl'), JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:04Z', action: 'deactivate', record_id: 'rec_1', target_path: structured }) + '\n');
  assert.deepEqual(listStructuredNotes(vault), []);
});

test('one invalid structured body is isolated to its own path instead of failing the scan', t => {
  const vault = fixture(t), logs = join(vault, '00-系统', 'logs');
  mkdirSync(logs, { recursive: true });
  const good = join(vault, '08-观察', 'good.md'), bad = join(vault, '08-观察', 'bad.md');
  writeFileSync(good, eventNote('good'));
  writeFileSync(bad, '---\nname: Structured\ndescription: fixture\n---\n```brainkit-event\n{}\n```\n');
  writeFileSync(join(logs, 'brain-write-ledger.jsonl'), [
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:00Z', action: 'write', event_id: eventId('gmail', 'good'), target_path: good }),
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:01Z', action: 'write', event_id: `evt_${'a'.repeat(24)}`, target_path: bad }),
  ].join('\n') + '\n');
  const diagnostics = [];
  assert.deepEqual(listStructuredNotes(vault, { diagnostics }).map(note => note.id), ['08-观察/good.md']);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].path, bad);
  assert.match(diagnostics[0].message, /structured ledger body is invalid/);
});

test('a valid record fence does not smuggle a broken event fence past the scan', t => {
  const vault = fixture(t), logs = join(vault, '00-系统', 'logs');
  mkdirSync(logs, { recursive: true });
  const good = join(vault, '08-观察', 'good.md'), mixed = join(vault, '08-观察', 'mixed.md');
  writeFileSync(good, eventNote('good'));
  writeFileSync(mixed, `---\nname: Structured\ndescription: fixture\n---\n\`\`\`brainkit-record\n${JSON.stringify({
    schema: 'brainkit-record/v1', kind: 'fact', id: recordId('fact', 'mixed'), version: 1, confirmation: 'confirmed',
    sources: [{ note_id: '08-观察/good.md', source_sha256: '0'.repeat(64), quote: '同步摘要', quote_sha256: '1'.repeat(64), trust: 'observation_unconfirmed' }],
    statement: '甲在乙工作。', subject: { name: '甲' }, predicate: 'works_at', object: { name: '乙' },
  })}\n\`\`\`\n\n\`\`\`brainkit-event\n{}\n\`\`\`\n`);
  writeFileSync(join(logs, 'brain-write-ledger.jsonl'), [
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:00Z', action: 'write', event_id: eventId('gmail', 'good'), target_path: good }),
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:01Z', action: 'write', record_id: recordId('fact', 'mixed'), target_path: mixed }),
  ].join('\n') + '\n');
  const diagnostics = [];
  assert.deepEqual(listStructuredNotes(vault, { diagnostics }).map(note => note.id), ['08-观察/good.md']);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].path, mixed);
});

test('normal create, rename, restore, and deactivate ledger history leaves no stale-path diagnostics', t => {
  const vault = fixture(t), logs = join(vault, '00-系统', 'logs'), oldPath = join(vault, '08-观察', 'old.md'), newPath = join(vault, '08-观察', 'new.md');
  mkdirSync(logs, { recursive: true });
  const body = eventNote('renamed');
  writeFileSync(newPath, body);
  writeFileSync(join(logs, 'brain-write-ledger.jsonl'), [
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:00Z', action: 'write', event_id: 'evt_1', target_path: oldPath }),
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:01Z', action: 'rename', operation_id: '11111111-1111-4111-8111-111111111111', event_id: 'evt_1', target_path: oldPath, new_path: newPath }),
  ].join('\n') + '\n');
  const renamedDiagnostics = [];
  assert.deepEqual(listStructuredNotes(vault, { diagnostics: renamedDiagnostics }).map(note => note.id), ['08-观察/new.md']);
  assert.deepEqual(renamedDiagnostics, []);
  writeFileSync(oldPath, body);
  writeFileSync(join(logs, 'brain-write-ledger.jsonl'), [
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:00Z', action: 'write', event_id: 'evt_1', target_path: oldPath }),
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:01Z', action: 'rename', operation_id: '11111111-1111-4111-8111-111111111111', event_id: 'evt_1', target_path: oldPath, new_path: newPath }),
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:02Z', action: 'restore', operation_id: '22222222-2222-4222-8222-222222222222', reverts_operation_id: '11111111-1111-4111-8111-111111111111', event_id: 'evt_1', target_path: oldPath, new_path: oldPath }),
  ].join('\n') + '\n');
  const restoredDiagnostics = [];
  assert.deepEqual(listStructuredNotes(vault, { diagnostics: restoredDiagnostics }).map(note => note.id), ['08-观察/old.md']);
  assert.deepEqual(restoredDiagnostics, []);
  writeFileSync(join(logs, 'brain-write-ledger.jsonl'), JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:03Z', action: 'deactivate', event_id: 'evt_1', target_path: oldPath }) + '\n');
  const deactivatedDiagnostics = [];
  assert.deepEqual(listStructuredNotes(vault, { diagnostics: deactivatedDiagnostics }), []);
  assert.deepEqual(deactivatedDiagnostics, []);
});

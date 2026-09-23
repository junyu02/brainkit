import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  assertRecordRevision, parseRecord, parseCandidate, renderCandidate, recordId, recordIssues, renderRecord,
  validateRecord, validateSources,
} from '../scripts/lib/memory-records.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const note = { id: '03-经验/原则.md', source_sha256: sha('current note'), body: '原文引语在这里。', trust: 'confirmed' };
const source = { note_id: note.id, source_sha256: note.source_sha256, quote: '原文引语', quote_sha256: sha('原文引语'), trust: note.trust };

function relationship(overrides = {}) {
  return {
    schema: 'brainkit-record/v1', kind: 'relationship', id: recordId('relationship', 'works-at'), version: 1,
    confirmation: 'confirmed', sources: [source],
    statement: '甲在乙工作。', subject: { entity_id: recordId('entity', '甲'), name: '甲' }, predicate: 'works_at', object: { name: '乙' },
    valid_from: '2026-09-20T00:00:00Z',
    ...overrides,
  };
}

test('parses and renders exactly one normalized brainkit record block', () => {
  const record = relationship();
  const body = `说明文字\n\n${renderRecord(record)}\n`;
  const parsed = parseRecord(body);
  assert.deepEqual(parsed, validateRecord(record));
  assert.equal(parseRecord('普通 Markdown 正文'), null);
  assert.throws(() => parseRecord(`${renderRecord(record)}\n${renderRecord(record)}`), /at most one/);
  assert.throws(() => parseRecord('```brainkit-record\n{bad json}\n```'), /invalid JSON/);
  assert.equal(parseRecord('````md\n' + renderRecord(record) + '\n````'), null);
  assert.equal(parseRecord('~~~md\n' + renderRecord(record) + '\n~~~'), null);
  assert.equal(parseRecord(renderRecord(record).split('\n').map(line => '    ' + line).join('\n')), null);
  const candidate = parseCandidate(renderCandidate({ ...record, confirmation: 'proposed' }));
  assert.equal(candidate.record.id, record.id);
  assert.equal(parseRecord(renderCandidate(candidate.record)), null);
});

test('rejects malformed records and protects confirmation/source provenance', () => {
  assert.throws(() => validateRecord({ ...relationship(), stray: true }), /unknown field/);
  assert.throws(() => validateRecord({ ...relationship(), id: 'rel_short' }), /id/);
  assert.throws(() => validateRecord({ ...relationship(), version: 0 }), /version/);
  assert.throws(() => validateRecord({ ...relationship(), confirmation: 'model-confirmed' }), /confirmation/);
  assert.throws(() => validateRecord({ ...relationship(), valid_from: '2026-09-20' }), /ISO/);
  assert.throws(() => validateRecord({ ...relationship(), valid_from: '2026-02-30T00:00:00Z' }), /ISO/);
  assert.throws(() => validateRecord({ ...relationship(), sources: [{ ...source, quote_sha256: '0'.repeat(64) }] }), /quote_sha256/);
  assert.throws(() => validateRecord({ ...relationship(), sources: Array.from({ length: 9 }, () => source) }), /sources/);
  assert.throws(() => validateRecord({
    schema: 'brainkit-record/v1', kind: 'commitment', id: recordId('commitment', 'done'), version: 1,
    confirmation: 'proposed', sources: [source], summary: '完成材料', owner: { name: '我' }, counterparty: null,
    due: null, status: 'done', completion_sources: [],
  }), /completion_sources/);
  assert.throws(() => validateRecord({
    schema: 'brainkit-record/v1', kind: 'commitment', id: recordId('commitment', 'cancelled'), version: 1,
    confirmation: 'proposed', sources: [source], summary: '取消材料', owner: { name: '我' }, counterparty: null,
    due: null, status: 'cancelled', completion_sources: [],
  }), /reason/);
});

test('validates current source SHA, quote text, quote hash, and trust without filesystem access', () => {
  assert.deepEqual(validateSources(relationship(), [note]), validateRecord(relationship()));
  assert.throws(() => validateSources(relationship(), [{ ...note, source_sha256: sha('changed') }]), /SHA/);
  assert.throws(() => validateSources(relationship(), [{ ...note, body: '引语已不在此处。' }]), /quote/);
  assert.throws(() => validateSources(relationship(), [{ ...note, trust: 'unverified' }]), /trust/);
});

test('record revisions preserve identity and require exactly one version increment', () => {
  const before = `正文\n${renderRecord(relationship())}`;
  const after = `更新正文\n${renderRecord(relationship({ version: 2, statement: '甲曾在乙工作。' }))}`;
  assert.equal(assertRecordRevision(before, after).version, 2);
  assert.equal(assertRecordRevision('普通正文', '修改后的普通正文'), null);
  assert.throws(() => assertRecordRevision(before, `正文\n${renderRecord(relationship({ version: 3 }))}`), /version/);
  assert.throws(() => assertRecordRevision(before, `正文\n${renderRecord({ ...relationship({ version: 2 }), kind: 'fact', id: recordId('fact', 'works-at') })}`), /id or kind/);
});

test('commitment dates preserve explicit calendar boundaries and rendered summaries are visible escaped Markdown', () => {
  const commitment = validateRecord({
    schema: 'brainkit-record/v1', kind: 'commitment', id: recordId('commitment', 'date-only'), version: 1,
    confirmation: 'proposed', sources: [source], summary: '不要嵌入 ![远程图片](https://example.test/a.png)', owner: { name: '我' }, counterparty: null,
    due: '2026-09-30', status: 'open', completion_sources: [],
  });
  assert.equal(commitment.due, '2026-09-30');
  const rendered = renderRecord(commitment);
  assert.doesNotMatch(rendered, /<!--/);
  assert.match(rendered, /\\!\\\[/);
});

test('reports duplicate, candidate conflict, expiration and overdue issues without mutating records', () => {
  const first = relationship();
  const conflicting = relationship({ id: recordId('relationship', 'works-at-other'), confirmation: 'proposed', object: { name: '丙' } });
  const sameTriple = relationship({ id: recordId('relationship', 'works-at-copy') });
  const nonOverlapping = relationship({ id: recordId('relationship', 'former-works-at'), object: { name: '丁' }, valid_from: '2026-09-01T00:00:00Z', valid_until: '2026-09-10T00:00:00Z' });
  const expired = relationship({ id: recordId('relationship', 'expired'), valid_from: '2026-08-20T00:00:00Z', valid_until: '2026-08-31T23:59:59Z' });
  const overdue = {
    schema: 'brainkit-record/v1', kind: 'commitment', id: recordId('commitment', 'overdue'), version: 1,
    confirmation: 'confirmed', sources: [source], summary: '发送材料', owner: { name: '我' }, counterparty: null,
    due: '2026-09-10T00:00:00Z', status: 'open', completion_sources: [],
  };
  const records = [first, { ...first }, conflicting, sameTriple, nonOverlapping, expired, overdue];
  const issues = recordIssues(records, '2026-09-22T00:00:00Z');
  assert.ok(issues.some(issue => issue.type === 'duplicate_id'));
  assert.ok(issues.some(issue => issue.type === 'possible_conflict' && issue.confirmed === false && issue.requires_cardinality_review));
  assert.ok(issues.some(issue => issue.type === 'possible_duplicate' && issue.ids.includes(sameTriple.id)));
  assert.ok(!issues.some(issue => issue.type.includes('conflict') && issue.ids.includes(nonOverlapping.id)));
  assert.ok(issues.some(issue => issue.type === 'expired'));
  assert.ok(issues.some(issue => issue.type === 'overdue'));
  assert.equal(records[0].version, 1);
  assert.throws(() => validateRecord(relationship({ valid_from: '2026-09-22T00:00:00-08:00', valid_until: '2026-09-22T01:00:00+08:00' })), /precedes/);
  assert.ok(recordIssues([relationship({ valid_from: '2026-09-20T00:00:00Z', valid_until: '2026-09-22T01:00:00+08:00' })], '2026-09-21T18:00:00Z').some(issue => issue.type === 'expired'));
});

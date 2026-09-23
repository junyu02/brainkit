import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { extractMemoryRecords, synthesizeMemory } from '../scripts/lib/memory-synthesis.mjs';
import { recordId, renderRecord } from '../scripts/lib/memory-records.mjs';

const env = { OPENAI_BASE_URL: 'http://fixture', OPENAI_API_KEY: 'fixture', OBSERVE_MODEL: 'fixture' };
const sha = value => createHash('sha256').update(value).digest('hex');
const notes = [
  { id: 'a', path: '03-经验/a.md', title: 'A', description: 'desc A', body: '原文 A。甲在乙工作。明天发送材料。已经发送材料。', source_sha256: sha('current-a'), updated_at: '2026-09-22T10:00:00Z', trust: 'confirmed', ignored_url: 'https://untrusted.example' },
  { id: 'b', path: '03-经验/b.md', title: 'B', description: 'desc B', body: '原文 B。乙否认甲在乙工作。', source_sha256: sha('current-b'), updated_at: '2026-09-21T10:00:00Z', trust: 'confirmed' },
];

test('synthesizes only claims with supplied source ids', async () => {
  const options = [];
  let call = 0;
  const result = await synthesizeMemory({ question: '问题', notes, env, request: async (_env, messages, requestOptions) => {
    options.push(requestOptions);
    if (++call === 1) {
      assert.ok(!Object.hasOwn(JSON.parse(messages[1].content).notes[0], 'path'));
      return { data: { claims: [{ text: '结论', source_ids: ['a'], evidence_quote: [{ source_id: 'a', quote: '原文 A。' }] }], gaps: ['缺少后续资料'] }, usage: { input_tokens: 2, output_tokens: 3 }, model: 'fixture-model' };
    }
    return { data: { claims: [{ claim_index: 0, status: 'supported' }] }, usage: { input_tokens: 5, output_tokens: 7 }, model: 'fixture-model' };
  } });
  assert.equal(result.synthesis_status, 'synthesized');
  assert.equal(result.answer, '结论 [S1]');
  assert.deepEqual(result.sources, [{ id: 'a', path: '03-经验/a.md', title: 'A', description: 'desc A', source_sha256: notes[0].source_sha256, updated_at: '2026-09-22T10:00:00Z', trust: 'confirmed', citation: 'S1' }]);
  assert.deepEqual(result.supporting_evidence, [{ claim_index: 0, source_id: 'a', quote: '原文 A。', citation: 'S1' }]);
  assert.deepEqual(options, [{ timeoutMs: 30_000, retryDelays: [], maxTokens: 2048 }, { timeoutMs: 30_000, retryDelays: [], maxTokens: 2048 }]);
  assert.deepEqual(result.support_check, { status: 'supported', claims: [{ claim_index: 0, status: 'supported' }] });
  assert.deepEqual(result.cost, { model: 'fixture-model', input_tokens: 7, output_tokens: 10, usd_estimate: null });
});

test('empty notes avoid API calls and missing configuration is stable', async () => {
  let called = false;
  const empty = await synthesizeMemory({ question: '问题', notes: [], request: async () => { called = true; } });
  assert.equal(empty.synthesis_status, 'no_evidence');
  assert.equal(called, false);
  await assert.rejects(synthesizeMemory({ question: '问题', notes, env: {}, request: async () => { throw new Error('must not call'); } }), /LLM synthesis unavailable: configure/);
});

test('forged citations and provider failures return extractive fallbacks', async () => {
  for (const request of [
    async () => ({ data: { claims: [{ text: '伪造', source_ids: ['fake'], evidence_quote: [{ source_id: 'fake', quote: '原文 A。' }] }], gaps: [] }, usage: {}, model: 'fixture' }),
    async () => ({ data: { claims: [{ text: '伪结论 [来源：fake] https://fake.example', source_ids: ['a'], evidence_quote: [{ source_id: 'a', quote: '原文 A。' }] }], gaps: [] }, usage: {}, model: 'fixture' }),
    async () => ({ data: { claims: [{ text: '没有原文支持', source_ids: ['a'], evidence_quote: [{ source_id: 'a', quote: '伪造引语' }] }], gaps: [] }, usage: {}, model: 'fixture' }),
    ...['伪结论（来源：fake）', '伪结论【来源：fake】', '伪结论 www.fake.example'].map(text => async () => ({ data: { claims: [{ text, source_ids: ['a'], evidence_quote: [{ source_id: 'a', quote: '原文 A。' }] }], gaps: [] }, usage: {}, model: 'fixture' })),
    async () => { throw new Error('provider failed'); },
  ]) {
    const result = await synthesizeMemory({ question: '问题', notes, env, request });
    assert.equal(result.synthesis_status, 'extractive_fallback');
    assert.match(result.answer, /原文 A。/);
    assert.deepEqual(result.sources.map(source => source.id), ['a', 'b']);
    assert.ok(result.gaps[0].includes('未能完成模型综合'));
  }
});

test('citations use safe tokens and preserve observation and retention metadata', async () => {
  const id = '08-观察/x](https://evil.example).md';
  let page, calls = 0;
  const result = await synthesizeMemory({ question: '问题', notes: [{ ...notes[0], id, trust: 'observation_unconfirmed', expired: true }], env, request: async (_env, messages) => {
    if (++calls === 1) {
      page = JSON.parse(messages[1].content).notes[0];
      return { data: { claims: [{ text: '待核实结论', source_ids: [id], evidence_quote: [{ source_id: id, quote: '原文 A。' }] }], gaps: [] }, usage: {}, model: 'fixture' };
    }
    return { data: { claims: [{ claim_index: 0, status: 'supported' }] }, usage: {}, model: 'fixture' };
  } });
  assert.equal(page.trust, 'observation_unconfirmed');
  assert.equal(page.expired, true);
  assert.equal(result.sources[0].expired, true);
  assert.equal(result.answer, '【未确认观察】待核实结论 [S1]');
  const badGap = await synthesizeMemory({ question: '问题', notes, env, request: async () => ({ data: { claims: [{ text: '结论', source_ids: ['a'], evidence_quote: [{ source_id: 'a', quote: '原文 A。' }] }], gaps: ['https://fake.example [来源：fake]'] }, usage: {}, model: 'fixture' }) });
  assert.equal(badGap.synthesis_status, 'extractive_fallback');
});

test('synthesis returns mechanically checked support for conflicting evidence without declaring truth', async () => {
  let calls = 0;
  const result = await synthesizeMemory({ question: '甲是否在乙工作', notes, env, request: async () => {
    if (++calls === 1) return {
      data: { claims: [
      { text: '资料 A 记载甲在乙工作。', source_ids: ['a'], evidence_quote: [{ source_id: 'a', quote: '甲在乙工作。' }] },
      { text: '资料 B 记载乙否认该说法。', source_ids: ['b'], evidence_quote: [{ source_id: 'b', quote: '乙否认甲在乙工作。' }] },
      ], gaps: ['资料相互矛盾，无法据此裁定。'] }, usage: {}, model: 'fixture' };
    return { data: { claims: [{ claim_index: 0, status: 'supported' }, { claim_index: 1, status: 'supported' }] }, usage: {}, model: 'fixture' };
  } });
  assert.equal(result.synthesis_status, 'synthesized');
  assert.equal(result.supporting_evidence.length, 2);
  assert.match(result.gaps[0], /矛盾/);
});

test('extracts proposed records once with program-owned provenance and entity ids', async () => {
  const entity = { schema: 'brainkit-record/v1', kind: 'entity', id: recordId('entity', '甲'), version: 1, confirmation: 'confirmed', sources: [{ note_id: 'a', source_sha256: notes[0].source_sha256, quote: '甲在乙工作。', quote_sha256: sha('甲在乙工作。'), trust: 'confirmed' }], name: '甲', entity_type: 'person', aliases: [] };
  const input = [...notes, { id: 'entity-note', title: '实体', description: '', body: renderRecord(entity), source_sha256: sha('entity-note'), updated_at: '2026-09-22T10:00:00Z', trust: 'confirmed' }];
  let calls = 0;
  const result = await extractMemoryRecords({ notes: input, env, now: '2026-09-22T12:00:00Z', request: async (_env, messages, options) => {
    calls++;
    assert.deepEqual(options, { timeoutMs: 30_000, retryDelays: [], maxTokens: 2048 });
    assert.equal(JSON.parse(messages[1].content).notes[0].source_key, 'a');
    return { data: { records: [
      { kind: 'relationship', statement: '甲在乙工作。', subject: { name: '甲' }, predicate: 'works_at', object: { name: '乙' }, evidence: [{ source_key: 'a', quote: '甲在乙工作。' }] },
      { kind: 'commitment', summary: '发送材料', owner: { name: '甲' }, counterparty: null, due: '明天', status: 'open', evidence: [{ source_key: 'a', quote: '明天发送材料。' }], completion_evidence: [] },
      { kind: 'commitment', summary: '发送材料', owner: { name: '甲' }, counterparty: null, due: null, status: 'done', evidence: [{ source_key: 'a', quote: '已经发送材料。' }], completion_evidence: [{ source_key: 'a', quote: '已经发送材料。' }] },
    ] }, usage: { input_tokens: 5, output_tokens: 7 }, model: 'fixture-model' };
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'proposed', JSON.stringify(result));
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].record.confirmation, 'proposed');
  assert.equal(result.candidates[0].record.subject.entity_id, entity.id);
  assert.deepEqual(result.candidates[0].needs_entity, ['乙']);
  assert.equal(result.candidates[1].record.due, null);
  assert.match(result.candidates[1].issues[0], /relative due retained/);
  assert.equal(result.candidates[2].record.completion_sources.length, 1);
  assert.equal(result.candidates[0].record.sources[0].source_sha256, notes[0].source_sha256);
});

test('a valid quote with an unsupported assertion falls back after independent support review', async () => {
  let calls = 0;
  const result = await synthesizeMemory({ question: '甲是否在乙工作', notes, env, request: async () => {
    if (++calls === 1) return { data: { claims: [{ text: '甲担任乙公司 CEO。', source_ids: ['a'], evidence_quote: [{ source_id: 'a', quote: '甲在乙工作。' }] }], gaps: [] }, usage: { input_tokens: 2, output_tokens: 3 }, model: 'fixture' };
    return { data: { claims: [{ claim_index: 0, status: 'unsupported' }] }, usage: { input_tokens: 5, output_tokens: 7 }, model: 'fixture' };
  } });
  assert.equal(result.synthesis_status, 'extractive_fallback');
  assert.deepEqual(result.support_check, { status: 'rejected', claims: [{ claim_index: 0, status: 'unsupported' }] });
  assert.deepEqual(result.cost, { model: 'fixture', input_tokens: 7, output_tokens: 10, usd_estimate: null });
});

test('record extraction rejects forged evidence and avoids calls for no evidence', async () => {
  let called = false;
  const empty = await extractMemoryRecords({ notes: [], env, request: async () => { called = true; } });
  assert.equal(empty.status, 'no_evidence');
  assert.equal(called, false);
  const forged = await extractMemoryRecords({ notes, env, request: async () => ({ data: { records: [{ kind: 'fact', statement: '伪造', subject: { name: '甲' }, predicate: 'says', object: { name: '乙' }, evidence: [{ source_key: 'a', quote: '不存在' }] }] }, usage: {}, model: 'fixture' }) });
  assert.equal(forged.status, 'failed');
  assert.equal(forged.candidates.length, 0);
  const excess = await extractMemoryRecords({ notes, env, request: async () => ({ data: { records: Array(4).fill({}) } }) });
  assert.equal(excess.status, 'failed');
  assert.match(excess.issues[0], /at most 3/);
});

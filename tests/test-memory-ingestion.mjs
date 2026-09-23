import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { eventId, ingestEvents, monthSubfolder, parseEvent, syncStatus } from '../scripts/lib/memory-ingestion.mjs';
import { redactCredentials } from '../scripts/lib/memory-records.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const event = { external_id: 'mail-private-123', updated_at: '2026-09-22T10:00:00+08:00', title: '会议确认', summary: '周三讨论方案。', status: 'confirmed', start: '2026-09-24T09:00:00+08:00', end: '2026-09-24T10:00:00+08:00' };
const committed = { status: 'committed', receipt: { status: 'ok' } };

function note(body, source_sha256 = sha(body), path = '08-观察/event.md') {
  return { id: path, path, body, source_sha256 };
}

test('event ids are deterministic and rendered bodies retain bounded opaque provider references', async () => {
  assert.equal(eventId('gmail', event.external_id), eventId('gmail', event.external_id));
  assert.notEqual(eventId('gmail', event.external_id), eventId('google-calendar', event.external_id));
  const calls = [];
  const result = await ingestEvents({ provider: 'gmail', events: [event], notes: [], write: async (...args) => { calls.push(args); return committed; }, readNote: async () => null });
  assert.equal(result.succeeded, 1);
  assert.equal(result.batch_complete, true);
  assert.equal(result.watermark_advanced, false);
  assert.deepEqual(calls[0][0], ['--json']);
  const payload = JSON.parse(calls[0][1]);
  assert.equal(payload.type, 'observation');
  // The month comes from the event's own time, not from when the batch ran.
  assert.equal(payload.subfolder, monthSubfolder('2026-09-22T02:00:00.000Z'));
  assert.match(payload.provenance, /^connector:gmail; event=evt_[a-f0-9]{24}$/);
  assert.match(payload.body, /mail-private-123/);
  const parsed = parseEvent(payload.body);
  assert.equal(parsed.event_id, eventId('gmail', event.external_id));
  assert.equal(parsed.source_updated_at, '2026-09-22T02:00:00.000Z');
  assert.equal(parsed.data_sha256.length, 64);
  assert.equal(parsed.source_ref, event.external_id);
  const dangerous = await ingestEvents({ provider: 'gmail', events: [{ ...event, external_id: 'mail-private-danger', title: '![远程](https://example.test/x)' }], notes: [], write: async (...args) => { calls.push(args); return committed; }, readNote: async () => null });
  assert.equal(dangerous.succeeded, 1);
  assert.match(JSON.parse(calls.at(-1)[1]).body, /\\!\\\[/);
});

test('replay is idempotent, newer event revises with CAS, and older revisions do not overwrite', async () => {
  const writes = [];
  const first = await ingestEvents({ provider: 'gmail', events: [event], notes: [], write: async (...args) => { writes.push(args); return committed; }, readNote: async () => null });
  const created = note(JSON.parse(writes[0][1]).body, 'current-note-sha');
  const replay = await ingestEvents({ provider: 'gmail', events: [event], notes: [created], write: async () => { throw new Error('must not write replay'); }, readNote: async () => null });
  assert.equal(replay.skipped, 1);
  const changed = { ...event, updated_at: '2026-09-22T11:00:00+08:00', status: 'cancelled', summary: '会议取消。' };
  const revised = await ingestEvents({ provider: 'gmail', events: [changed], notes: [created], write: async (...args) => { writes.push(args); return committed; }, readNote: async () => null });
  assert.equal(revised.succeeded, 1);
  assert.deepEqual(writes[1][0].slice(0, 5), ['--revise', created.path, '--expected-sha256', 'current-note-sha', '--reason']);
  assert.equal(parseEvent(writes[1][1]).status, 'cancelled');
  const stale = await ingestEvents({ provider: 'gmail', events: [event], notes: [note(writes[1][1], 'new-note-sha')], write: async () => { throw new Error('must not write stale'); }, readNote: async () => null });
  assert.equal(stale.skipped, 1);
});

test('partial failures preserve per-event outcomes and conflict rereads never claim success', async () => {
  const second = { ...event, external_id: 'mail-private-456', title: '另一个事件' };
  let call = 0;
  const result = await ingestEvents({
    provider: 'gmail', events: [event, second], notes: [],
    write: async () => (++call === 1 ? committed : { status: 'failed' }),
    readNote: async () => null,
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results.find(row => row.status === 'failed').event_id, eventId('gmail', second.external_id));
  assert.equal(result.watermark_advanced, false);
  assert.equal(result.batch_complete, false);
});

test('bad events and malformed persisted event notes are explicit errors', async () => {
  await assert.rejects(ingestEvents({ provider: 'gmail', events: [{ ...event, extra: true }], notes: [], write: async () => committed, readNote: async () => null }), /unknown field/);
  await assert.rejects(ingestEvents({ provider: 'slack', events: [], notes: [], write: async () => committed, readNote: async () => null }), /provider/);
  assert.throws(() => parseEvent('```brainkit-event\n{bad}\n```'), /invalid JSON/);
  assert.throws(() => syncStatus([note('```brainkit-event\n{bad}\n```')]), /invalid stored event in 08-观察\/event\.md:.*invalid JSON/);
  assert.throws(() => syncStatus([note('```brainkit-event\n{}\n```', undefined, '08-观察/schema.md')]), /invalid stored event in 08-观察\/schema\.md:.*schema is invalid/);
});

test('credentials are redacted before the event hash, so a redacted event still replays as unchanged', async () => {
  for (const [label, secret] of [['password', 'hunter2secret'], ['bearer', 'a1b2c3d4e5'.repeat(4)], ['status', 'hunter2secret']]) {
    const text = label === 'bearer' ? `接口回执 Bearer ${secret} 已签发。` : `报警邮件 password: ${secret} 请处理。`;
    // status also reaches data_sha256, so it has to be redacted before hashing too.
    const input = label === 'status'
      ? { ...event, external_id: 'redact-status', status: `password: ${secret}` }
      : { ...event, external_id: `redact-${label}`, summary: text };
    let body;
    const first = await ingestEvents({ provider: 'gmail', events: [input], notes: [], readNote: async () => null,
      write: async (_args, text) => { body = JSON.parse(text).body; return committed; } });
    assert.equal(first.results[0].status, 'created', label);
    assert.equal(body.includes(secret), false, label);
    assert.ok(body.includes('[REDACTED]'), label);
    // The writer runs exactly this gate on what it stores; a second pass must be a no-op
    // or the stored note stops matching the data_sha256 the connector already committed to.
    assert.equal(redactCredentials(body).text, body, label);
    const replay = await ingestEvents({ provider: 'gmail', events: [input], notes: [note(body)], readNote: async () => null,
      write: async () => { throw new Error('a redacted replay must not write again'); } });
    assert.equal(replay.results[0].status, 'skipped_stale_or_unchanged', label);
  }
  // external_id derives event_id and cannot be rewritten, so the batch is refused
  // up front rather than failing forever against the writer's redaction gate.
  await assert.rejects(ingestEvents({ provider: 'gmail', events: [{ ...event, external_id: `sk-${'a1b2c3d4'.repeat(3)}` }], notes: [], readNote: async () => null,
    write: async () => { throw new Error('a credential-shaped external_id must not reach the writer'); } }), /external_id matches a credential pattern/);
});

test('sync status paginates stable event ids without titles, gaps, or a false completion claim', async () => {
  const writes = [];
  const events = Array.from({ length: 12 }, (_, index) => ({ ...event, external_id: `calendar-${index}`, title: `private title ${index}`, updated_at: `2026-09-22T${String(index % 10).padStart(2, '0')}:00:00+08:00` }));
  for (const input of events) await ingestEvents({ provider: 'google-calendar', events: [input], notes: [], write: async (...args) => { writes.push(args); return committed; }, readNote: async () => null });
  const notes = writes.map(call => note(JSON.parse(call[1]).body));
  const delivered = []; let after;
  do {
    const page = syncStatus(notes, { provider: 'google-calendar', ...(after ? { after_event_id: after } : {}) });
    assert.ok(page.known_events.length > 0);
    assert.ok(page.known_events.length <= 5);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1100);
    assert.equal(JSON.stringify(page).includes('private title'), false);
    delivered.push(...page.known_events.map(row => row.event_id));
    after = page.next_after_event_id;
    if (!page.has_more) assert.equal(after, null);
  } while (after);
  assert.deepEqual(delivered, [...delivered].sort());
  assert.deepEqual(new Set(delivered), new Set(events.map(row => eventId('google-calendar', row.external_id))));
  assert.equal(delivered.length, 12);
  assert.equal(syncStatus(notes, { provider: 'google-calendar' }).providers['google-calendar'].count, 12);
  assert.equal(syncStatus(notes, { provider: 'google-calendar' }).complete, false);
});

test('legacy event bodies remain readable but cannot be rechecked, and all-day dates stay dates', async () => {
  const writes = [];
  await ingestEvents({ provider: 'google-calendar', events: [{ ...event, external_id: 'all-day', start: '2026-09-24', end: '2026-09-25' }], notes: [], write: async (...args) => { writes.push(args); return committed; }, readNote: async () => null });
  const parsed = parseEvent(JSON.parse(writes[0][1]).body);
  assert.equal(parsed.start, '2026-09-24'); assert.equal(parsed.end, '2026-09-25');
  const forged = { ...parsed, source_ref: 'different-provider-id' };
  assert.throws(() => parseEvent(`\`\`\`brainkit-event\n${JSON.stringify(forged)}\n\`\`\``), /source_ref/);
  const legacy = { ...parsed }; delete legacy.source_ref;
  const status = syncStatus([note(`\`\`\`brainkit-event\n${JSON.stringify(legacy)}\n\`\`\``)], { provider: 'google-calendar' });
  assert.equal(status.known_events[0].recheckable, false);
  assert.equal(status.known_events[0].source_ref, null);
});

test('normalizes the full batch before writing and refreshes same-batch CAS state', async () => {
  let writes = 0;
  await assert.rejects(ingestEvents({ provider: 'gmail', events: [event, { ...event, title: 'x'.repeat(201) }], notes: [], write: async () => { writes++; return committed; }, readNote: async () => null }), /title/);
  assert.equal(writes, 0);

  const writesByPath = new Map(), current = new Map();
  const write = async (args, input) => {
    const body = args[0] === '--json' ? JSON.parse(input).body : input;
    const parsed = parseEvent(body), path = args[0] === '--json' ? `08-观察/${parsed.event_id}.md` : args[1];
    const note = noteFor(body, `sha-${parsed.source_updated_at}` , path);
    current.set(path, note); writesByPath.set(path, (writesByPath.get(path) || 0) + 1);
    return { status: 'committed', receipt: { path, target_path: path } };
  };
  const older = { ...event, updated_at: '2026-09-22T09:00:00+08:00' }, newer = { ...event, updated_at: '2026-09-22T11:00:00+08:00', summary: '变更会议。' };
  const result = await ingestEvents({ provider: 'gmail', events: [older, newer], notes: [], write, readNote: async path => current.get(path) });
  assert.equal(result.succeeded, 2);
  assert.equal([...writesByPath.values()][0], 2);
  const clash = await ingestEvents({ provider: 'gmail', events: [{ ...newer, summary: '同时间不同内容。' }], notes: [...current.values()], write: async () => { throw new Error('must not write conflict'); }, readNote: async path => current.get(path) });
  assert.equal(clash.results[0].status, 'revision_conflict');

  const previous = { ...event, updated_at: '2026-09-22T10:00:00+08:00' };
  const remote = { ...event, updated_at: '2026-09-22T11:00:00+08:00', summary: '远端并发变更。' };
  const priorStored = await eventNote('gmail', previous), remoteStored = await eventNote('gmail', remote);
  const reread = await ingestEvents({ provider: 'gmail', events: [newer], notes: [priorStored], write: async () => ({ status: 'failed' }), readNote: async () => remoteStored });
  assert.equal(reread.results[0].status, 'failed');
});

function noteFor(body, source_sha256, path) { return { id: path, path, body, source_sha256 }; }
async function eventNote(provider, input) {
  let payload;
  await ingestEvents({ provider, events: [input], notes: [], write: async (_args, value) => { payload = JSON.parse(value); return committed; }, readNote: async () => null });
  return noteFor(payload.body, sha(payload.body), `08-观察/${eventId(provider, input.external_id)}.md`);
}

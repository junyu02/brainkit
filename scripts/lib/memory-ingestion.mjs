import { createHash } from 'node:crypto';
import { redactCredentials, structuredJson } from './memory-records.mjs';

const PROVIDERS = new Set(['gmail', 'google-calendar']);
const EVENT_SCHEMA = 'brainkit-event/v1';
const EVENT_FIELDS = new Set(['external_id', 'updated_at', 'title', 'summary', 'status', 'start', 'end', 'due']);
const STORED_FIELDS = new Set(['schema', 'event_id', 'provider', 'source_ref', 'source_updated_at', 'title', 'summary', 'status', 'start', 'end', 'due', 'data_sha256']);
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SOURCE_REF_MAX = 160;
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => value && typeof value === 'object' && !Array.isArray(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  : JSON.stringify(value);

function fail(message) { throw new Error(`invalid connector event: ${message}`); }
function redacted(value) { return typeof value === 'string' ? redactCredentials(value).text : value; }
// A bare 'failed' hides a note that actually landed, just in the wrong section.
function reasonFor(outcome) {
  const receipt = outcome?.receipt, state = receipt?.recall_state, redirect = receipt?.inbox_redirect?.reason;
  // Stable token first so a caller can branch on it, human detail after. The
  // redirect carries paths in other fields; only its reason text is echoed.
  const reason = redirect ? `${state || 'inbox_redirect'}: ${redirect}` : state || outcome?.error?.code || outcome?.error?.message;
  return typeof reason === 'string' && reason ? reason.slice(0, 120) : undefined;
}
function string(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`${label} must be a nonempty string`);
  return value.trim();
}
function calendar(year, month, day, hour, minute, second) {
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && hour <= 23 && minute <= 59 && second <= 59;
}
function iso(value, label) {
  const match = typeof value === 'string' && ISO.exec(value);
  if (!match || !calendar(...match.slice(1, 7).map(Number)) || Number.isNaN(Date.parse(value))) fail(`${label} must be an explicit ISO timestamp`);
  return new Date(value).toISOString();
}
function date(value, label) {
  const match = typeof value === 'string' && DATE.exec(value);
  if (!match || !calendar(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0)) fail(`${label} must be an ISO date`);
  return value;
}
function temporal(value, label, provider) {
  return provider === 'google-calendar' && DATE.test(value) ? date(value, label) : iso(value, label);
}
function providerName(provider) {
  if (!PROVIDERS.has(provider)) fail('provider must be gmail or google-calendar');
  return provider;
}
function normalizeEvent(value, provider) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('event must be an object');
  for (const key of Object.keys(value)) if (!EVENT_FIELDS.has(key)) fail(`event has unknown field ${key}`);
  // Redact before hashing: the writer redacts what lands, so a credential left
  // in here would make data_sha256 disagree with the stored note forever.
  const external_id = string(value.external_id, 'external_id', SOURCE_REF_MAX);
  // external_id derives event_id and is stored as source_ref, so it cannot be
  // rewritten the way free text is; reject the batch instead of looping on it.
  if (redactCredentials(external_id).count) fail('external_id matches a credential pattern');
  const event = {
    external_id, updated_at: iso(value.updated_at, 'updated_at'),
    title: string(redacted(value.title), 'title', 200), summary: string(redacted(value.summary), 'summary', 4000),
  };
  for (const key of ['status', 'start', 'end', 'due']) {
    if (value[key] === undefined) continue;
    event[key] = key === 'status' ? string(redacted(value[key]), key, 100) : key === 'due' ? iso(value[key], key) : temporal(value[key], key, provider);
  }
  if (event.start && event.end && DATE.test(event.start) !== DATE.test(event.end)) fail('all-day start and end must both be dates');
  if (event.start && event.end && event.start > event.end) fail('end precedes start');
  return event;
}
function validateStored(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('stored event must be an object');
  for (const key of Object.keys(value)) if (!STORED_FIELDS.has(key)) fail(`stored event has unknown field ${key}`);
  if (value.schema !== EVENT_SCHEMA) fail('stored event schema is invalid');
  const provider = providerName(value.provider);
  const event_id = string(value.event_id, 'event_id', 28);
  if (!/^evt_[a-f0-9]{24}$/.test(event_id)) fail('stored event_id is invalid');
  const source_ref = value.source_ref === undefined ? null : string(value.source_ref, 'source_ref', SOURCE_REF_MAX);
  if (source_ref !== null && eventId(provider, source_ref) !== event_id) fail('source_ref does not match event_id');
  const result = { schema: EVENT_SCHEMA, event_id, ...(source_ref === null ? {} : { source_ref }), provider, source_updated_at: iso(value.source_updated_at, 'source_updated_at'), title: string(value.title, 'title', 200), summary: string(value.summary, 'summary', 4000), data_sha256: string(value.data_sha256, 'data_sha256', 64) };
  if (!/^[a-f0-9]{64}$/.test(result.data_sha256)) fail('stored data_sha256 is invalid');
  for (const key of ['status', 'start', 'end', 'due']) if (value[key] !== undefined) result[key] = key === 'status' ? string(value[key], key, 100) : key === 'due' ? iso(value[key], key) : temporal(value[key], key, provider);
  if (result.start && result.end && DATE.test(result.start) !== DATE.test(result.end)) fail('all-day start and end must both be dates');
  const content = { provider: result.provider, source_updated_at: result.source_updated_at, title: result.title, summary: result.summary, ...(result.status === undefined ? {} : { status: result.status }), ...(result.start === undefined ? {} : { start: result.start }), ...(result.end === undefined ? {} : { end: result.end }), ...(result.due === undefined ? {} : { due: result.due }) };
  if (sha(stable(content)) !== result.data_sha256) fail('stored data_sha256 does not match content');
  return result;
}
function eventNotes(notes) {
  if (!Array.isArray(notes)) fail('notes must be an array');
  const result = [];
  for (const note of notes) {
    let event;
    try { event = parseEvent(String(note?.body ?? note?.text ?? '')); }
    catch (error) { fail(`invalid stored event in ${note?.path ?? note?.id ?? 'unknown note'}: ${error.message}`); }
    if (event) result.push({ note, event });
  }
  return result;
}
function rendered(event) {
  const title = event.title.replace(/[\\`*_{}\[\]<>()#!|]/g, character => `\\${character}`);
  return `**Connector event — ${event.provider} ${event.event_id}**\n\n${title}\n\n\`\`\`brainkit-event\n${JSON.stringify(event, null, 2)}\n\`\`\``;
}
function stored(provider, event) {
  const event_id = eventId(provider, event.external_id);
  const content = { provider, source_updated_at: event.updated_at, title: event.title, summary: event.summary, ...(event.status === undefined ? {} : { status: event.status }), ...(event.start === undefined ? {} : { start: event.start }), ...(event.end === undefined ? {} : { end: event.end }), ...(event.due === undefined ? {} : { due: event.due }) };
  return { schema: EVENT_SCHEMA, event_id, source_ref: event.external_id, ...content, data_sha256: sha(stable(content)) };
}

// 08-观察/ is allow_month + requires_subfolder. A payload without one is
// redirected to 99-inbox, which listStructuredNotes excludes, so the note stops
// being discoverable and later writes recreate it. Same YYYY-MM local-time shape
// observe.mjs uses; not named observationSubfolder because observe.mjs exports
// that name for a different signature and a different notion of "when".
export function monthSubfolder(at = Date.now()) {
  const time = new Date(at);
  return `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}`;
}

export function eventId(provider, external_id) {
  providerName(provider);
  return `evt_${sha(`${provider}\0${string(external_id, 'external_id', 1000)}`).slice(0, 24)}`;
}

export function parseEvent(body) {
  const value = structuredJson(body, 'brainkit-event');
  return value === null ? null : validateStored(value);
}

export async function ingestEvents({ provider, events, notes, write, readNote, now = new Date().toISOString() }) {
  providerName(provider);
  if (!Array.isArray(events) || events.length > 20) fail('events must contain at most 20 entries');
  if (typeof write !== 'function' || typeof readNote !== 'function') fail('write and readNote callbacks are required');
  iso(now, 'now');
  // Normalize the complete batch before the first writer call: a later bad row
  // must never leave an earlier write without an honest batch outcome.
  const incoming = events.map(event => normalizeEvent(event, provider)).map(event => ({ event, stored: stored(provider, event) }));
  const existing = new Map(eventNotes(notes).filter(row => row.event.provider === provider).map(row => [row.event.event_id, row]));
  const unrefreshed = new Set();
  const results = [];
  for (const { stored: next } of incoming) {
    if (unrefreshed.has(next.event_id)) {
      results.push({ event_id: next.event_id, status: 'failed', reason: 'committed event could not be reread for a fresh CAS hash' });
      continue;
    }
    const previous = existing.get(next.event_id);
    if (previous && previous.event.source_updated_at > next.source_updated_at) {
      results.push({ event_id: next.event_id, status: 'skipped_stale_or_unchanged' });
      continue;
    }
    if (previous && previous.event.source_updated_at === next.source_updated_at) {
      results.push({ event_id: next.event_id, status: previous.event.data_sha256 === next.data_sha256 ? 'skipped_stale_or_unchanged' : 'revision_conflict' });
      continue;
    }
    // File by the event's own time, so a backfill spreads across the months it
    // actually covers instead of piling a year of mail into the ingest month.
    const body = rendered(next), payload = JSON.stringify({ type: 'observation', subfolder: monthSubfolder(next.source_updated_at), title: `同步-${next.event_id}`, description: next.summary.slice(0, 150), body, provenance: `connector:${provider}; event=${next.event_id}` });
    const args = previous ? ['--revise', previous.note.path, '--expected-sha256', previous.note.source_sha256, '--reason', `connector ${provider} event update`] : ['--json'];
    const input = previous ? body : payload;
    let outcome;
    try { outcome = await write(args, input); } catch (error) { outcome = { status: 'failed', error }; }
    if (outcome?.status === 'committed') {
      const receipt = outcome.receipt || outcome;
      const path = receipt.path || receipt.target_path;
      let refreshed = null;
      try {
        const note = path ? await readNote(path) : null;
        const event = note ? parseEvent(String(note.body ?? note.text ?? '')) : null;
        if (event?.event_id === next.event_id && event.source_updated_at === next.source_updated_at && event.data_sha256 === next.data_sha256 && typeof note.source_sha256 === 'string') refreshed = { note, event };
      } catch { /* A commit remains committed, but later same-batch updates need a fresh CAS note. */ }
      if (refreshed) existing.set(next.event_id, refreshed);
      else unrefreshed.add(next.event_id);
      results.push({ event_id: next.event_id, status: previous ? 'revised' : 'created', refresh_verified: Boolean(refreshed) });
      continue;
    }
    let current = null;
    try { current = previous ? await readNote(previous.note.path) : null; } catch { /* A failed reread must not become a successful sync. */ }
    let currentEvent = null;
    try { currentEvent = current ? parseEvent(String(current.body ?? current.text ?? '')) : null; } catch { /* Keep failure explicit below. */ }
    if (currentEvent && currentEvent.event_id === next.event_id && (currentEvent.data_sha256 === next.data_sha256 || currentEvent.source_updated_at > next.source_updated_at)) results.push({ event_id: next.event_id, status: 'skipped_after_conflict' });
    else {
      const reason = reasonFor(outcome);
      results.push({ event_id: next.event_id, status: 'failed', ...(reason ? { reason } : {}) });
    }
  }
  const failed = results.filter(row => row.status === 'failed' || row.status === 'revision_conflict').length;
  return { provider, results, succeeded: results.filter(row => row.status === 'created' || row.status === 'revised').length, failed, skipped: results.filter(row => row.status.startsWith('skipped')).length, batch_complete: failed === 0, watermark_advanced: false };
}

export function syncStatus(notes, { provider, after_event_id } = {}) {
  if (provider !== undefined) providerName(provider);
  if (after_event_id !== undefined && (typeof after_event_id !== 'string' || !/^evt_[a-f0-9]{24}$/.test(after_event_id))) fail('after_event_id must be an event id');
  const groups = new Map(), byEvent = new Map();
  for (const { event, note } of eventNotes(notes)) {
    if (provider && event.provider !== provider) continue;
    const rows = groups.get(event.provider) || [];
    rows.push(event); groups.set(event.provider, rows);
    const previous = byEvent.get(event.event_id);
    if (!previous || event.source_updated_at > previous.source_updated_at) byEvent.set(event.event_id, { ...event, note_id: note.id });
  }
  const providers = {};
  for (const [name, rows] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const ordered = [...rows].sort((a, b) => b.source_updated_at.localeCompare(a.source_updated_at) || a.event_id.localeCompare(b.event_id));
    const latest = ordered[0];
    providers[name] = { highest_observed_source_updated_at: latest.source_updated_at, count: rows.length };
  }
  const candidates = [...byEvent.values()].filter(event => !after_event_id || event.event_id > after_event_id).sort((left, right) => left.event_id.localeCompare(right.event_id));
  const result = { providers, known_events: [], complete: false, has_more: false, next_after_event_id: null };
  for (const event of candidates.slice(0, 5)) {
    const row = { provider: event.provider, event_id: event.event_id, note_id: event.note_id, source_ref: event.source_ref ?? null, recheckable: typeof event.source_ref === 'string', ...(event.status === undefined ? {} : { status: event.status }), ...(event.start === undefined ? {} : { start: event.start }), ...(event.end === undefined ? {} : { end: event.end }) };
    const trial = { ...result, known_events: [...result.known_events, row], has_more: true, next_after_event_id: event.event_id };
    if (Buffer.byteLength(JSON.stringify(trial)) > 1100) {
      if (!result.known_events.length) fail('sync status event exceeds the 1100 byte page budget');
      break;
    }
    result.known_events.push(row);
  }
  result.has_more = result.known_events.length < candidates.length;
  result.next_after_event_id = result.has_more ? result.known_events.at(-1).event_id : null;
  return result;
}

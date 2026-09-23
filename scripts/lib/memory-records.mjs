import { createHash } from 'node:crypto';

// 凭据脱敏闸（2026-08-21）：所有 source 的写入在落盘前过此闸。
// per-line 豁免示例/引用形态（process.env.X、占位符）；password 值限 ASCII 凭据形态，中文叙述不受影响。
// Lives here rather than in the writer because content that carries its own
// content hash must redact before hashing, or the hash never matches what lands.
const CREDENTIAL_RULES = [
  [/(passwor?d"?\s*[:=]\s*["']?)[A-Za-z0-9!@#%^&*_.+-]{6,}(["']?)/gi, '$1[REDACTED]$2'],
  [/\bsk-[A-Za-z0-9]{20,}/g, '[REDACTED-OPENAI-KEY]'],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, '[REDACTED-GOOGLE-KEY]'],
  [/\bghp_[A-Za-z0-9]{30,}/g, '[REDACTED-GITHUB-PAT]'],
  [/\bxoxb-[0-9A-Za-z-]{20,}/g, '[REDACTED-SLACK-TOKEN]'],
  [/(Bearer\s+)[A-Za-z0-9._-]{30,}/g, '$1[REDACTED]'],
];
const CREDENTIAL_EXEMPT = /your[_-]|xxx|placeholder|<[a-z_]+>|\*\*\*|example|redacted|\$\{|process\.env/i;
export function redactCredentials(text) {
  if (!text) return { text, count: 0 };
  let count = 0;
  const out = text.split('\n').map(line => {
    if (CREDENTIAL_EXEMPT.test(line)) return line;
    let current = line;
    for (const [re, sub] of CREDENTIAL_RULES) {
      const n = (current.match(re) || []).length;
      if (n) { count += n; current = current.replace(re, sub); }
    }
    return current;
  }).join('\n');
  return { text: out, count };
}

const SCHEMA = 'brainkit-record/v1';
const PREFIX = { entity: 'ent_', fact: 'fact_', relationship: 'rel_', commitment: 'commit_' };
const KINDS = new Set(Object.keys(PREFIX));
const CONFIRMATIONS = new Set(['proposed', 'confirmed']);
const ENTITY_TYPES = new Set(['person', 'project', 'org', 'concept']);
const STATUSES = new Set(['open', 'done', 'cancelled']);
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const sha = value => createHash('sha256').update(value).digest('hex');

function fail(message) { throw new Error(`invalid brainkit record: ${message}`); }
function plain(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`${label} must be a nonempty string`);
  return value.trim();
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function exactKeys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has unknown field ${key}`);
}
function validCalendar(year, month, day, hour = 0, minute = 0, second = 0) {
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && hour <= 23 && minute <= 59 && second <= 59;
}
function iso(value, label, { dateOnly = false } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${label} must be an explicit ISO timestamp`);
  const match = ISO.exec(value);
  if (match && validCalendar(...match.slice(1, 7).map(Number)) && !Number.isNaN(Date.parse(value))) return value;
  const day = DATE.exec(value);
  if (dateOnly && day && validCalendar(...day.slice(1).map(Number))) return value;
  fail(`${label} must be an explicit ISO timestamp${dateOnly ? ' or YYYY-MM-DD' : ''}`);
}
function id(value, kind) {
  const result = plain(value, 'id', 64);
  if (!new RegExp(`^${PREFIX[kind]}[0-9a-f]{24}$`).test(result)) fail(`id must use the ${PREFIX[kind]} prefix and 24 lowercase hex characters`);
  return result;
}
function ref(value, label) {
  exactKeys(value, new Set(['entity_id', 'name', 'ref']), label);
  const result = {};
  if (value.entity_id !== undefined) {
    const entity = plain(value.entity_id, `${label}.entity_id`, 28);
    if (!/^ent_[0-9a-f]{24}$/.test(entity)) fail(`${label}.entity_id must be an entity id`);
    result.entity_id = entity;
  }
  if (value.name !== undefined) result.name = plain(value.name, `${label}.name`, 300);
  if (value.ref !== undefined) result.ref = plain(value.ref, `${label}.ref`, 1000);
  if (!Object.keys(result).length) fail(`${label} needs entity_id, name, or ref`);
  return result;
}
function source(value, label) {
  exactKeys(value, new Set(['note_id', 'source_sha256', 'quote', 'quote_sha256', 'trust']), label);
  const quote = value.quote;
  if (typeof quote !== 'string' || !quote || quote.length > 2000 || quote.includes('\0')) fail(`${label}.quote must be a nonempty string`);
  const result = {
    note_id: plain(value.note_id, `${label}.note_id`, 1000),
    source_sha256: plain(value.source_sha256, `${label}.source_sha256`, 64),
    quote,
    quote_sha256: plain(value.quote_sha256, `${label}.quote_sha256`, 64),
    trust: plain(value.trust, `${label}.trust`, 100),
  };
  if (!/^[a-f0-9]{64}$/.test(result.source_sha256) || !/^[a-f0-9]{64}$/.test(result.quote_sha256)) fail(`${label} SHA must be lowercase SHA-256`);
  if (sha(result.quote) !== result.quote_sha256) fail(`${label}.quote_sha256 does not match quote`);
  return result;
}
function sources(value, label = 'sources', { required = true } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 8 || (required && !value.length)) fail(`${label} must contain ${required ? '1..8' : '0..8'} sources`);
  return value.map((entry, index) => source(entry, `${label}[${index}]`));
}
function common(record) {
  const result = {
    schema: plain(record.schema, 'schema', 32), kind: plain(record.kind, 'kind', 20), version: record.version,
    confirmation: plain(record.confirmation, 'confirmation', 20), sources: sources(record.sources),
  };
  if (result.schema !== SCHEMA) fail('schema must be brainkit-record/v1');
  if (!KINDS.has(result.kind)) fail('kind is not supported');
  result.id = id(record.id, result.kind);
  if (!Number.isInteger(result.version) || result.version < 1) fail('version must be a positive integer');
  if (!CONFIRMATIONS.has(result.confirmation)) fail('confirmation must be proposed or confirmed');
  const from = iso(record.valid_from, 'valid_from'), until = iso(record.valid_until, 'valid_until');
  if (from) result.valid_from = from;
  if (until) result.valid_until = until;
  if (from && until && Date.parse(from) > Date.parse(until)) fail('valid_until precedes valid_from');
  return result;
}

export function recordId(kind, seed) {
  if (!KINDS.has(kind)) throw new Error('unsupported record kind');
  if (typeof seed !== 'string' || !seed || seed.includes('\0')) throw new Error('record id seed must be a nonempty string');
  return PREFIX[kind] + sha(`${kind}\0${seed}`).slice(0, 24);
}

export function validateRecord(value) {
  object(value, 'record');
  const kind = value.kind;
  const commonKeys = new Set(['schema', 'kind', 'id', 'version', 'confirmation', 'sources', 'valid_from', 'valid_until']);
  const extra = {
    entity: ['name', 'entity_type', 'aliases'],
    fact: ['statement', 'subject', 'predicate', 'object'],
    relationship: ['statement', 'subject', 'predicate', 'object'],
    commitment: ['summary', 'owner', 'counterparty', 'due', 'status', 'completion_sources', 'reason'],
  }[kind];
  if (!extra) fail('kind is not supported');
  exactKeys(value, new Set([...commonKeys, ...extra]), 'record');
  const result = common(value);
  if (kind === 'entity') {
    result.name = plain(value.name, 'name', 300);
    result.entity_type = plain(value.entity_type, 'entity_type', 30);
    if (!ENTITY_TYPES.has(result.entity_type)) fail('entity_type is not supported');
    if (value.aliases !== undefined) {
      if (!Array.isArray(value.aliases) || value.aliases.length > 32) fail('aliases must contain at most 32 values');
      result.aliases = [...new Set(value.aliases.map((entry, index) => plain(entry, `aliases[${index}]`, 300)))];
    } else result.aliases = [];
    return result;
  }
  if (kind === 'fact' || kind === 'relationship') {
    result.statement = plain(value.statement, 'statement', 8000);
    result.subject = ref(value.subject, 'subject');
    result.predicate = plain(value.predicate, 'predicate', 100);
    result.object = ref(value.object, 'object');
    return result;
  }
  result.summary = plain(value.summary, 'summary', 4000);
  result.owner = ref(value.owner, 'owner');
  result.counterparty = value.counterparty === null ? null : ref(value.counterparty, 'counterparty');
  result.due = value.due === null ? null : iso(value.due, 'due', { dateOnly: true });
  result.status = plain(value.status, 'status', 20);
  if (!STATUSES.has(result.status)) fail('status is not supported');
  result.completion_sources = sources(value.completion_sources, 'completion_sources', { required: result.status === 'done' });
  if (result.status === 'done' && !result.completion_sources.length) fail('done commitments need completion_sources');
  if (value.reason !== undefined) result.reason = plain(value.reason, 'reason', 4000);
  if (result.status === 'cancelled' && !result.reason) fail('cancelled commitments need reason');
  return result;
}

export function structuredJson(body, language) {
  if (typeof body !== 'string') throw new Error('structured body must be a string');
  let fence = null, lines = [], found = false, result = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) {
        if (fence.target) {
          try { result = JSON.parse(lines.join('\n')); } catch { fail(`${language} contains invalid JSON`); }
        }
        fence = null;
      } else if (fence.target) lines.push(line);
      continue;
    }
    if (!marker || marker[1][0] === '`' && marker[2].includes('`')) continue;
    const target = marker[2].trim() === language;
    if (target && found) fail(`at most one ${language} block is allowed`);
    if (target) { found = true; lines = []; }
    fence = { character: marker[1][0], length: marker[1].length, target };
  }
  if (fence?.target) fail(`${language} block is not closed`);
  if (found && result === null) fail(`${language} must contain an object`);
  return result;
}

export function parseRecord(body) {
  const value = structuredJson(body, 'brainkit-record');
  return value === null ? null : validateRecord(value);
}

function summary(record) {
  return (record.summary || record.statement || record.name).replace(/\s+/g, ' ').slice(0, 160);
}
function markdownSummary(value) {
  return summary(value).replace(/[\\`*_{}\[\]<>()#!|]/g, character => `\\${character}`);
}

export function renderRecord(record) {
  const normalized = validateRecord(record);
  return `**Brainkit record — ${normalized.kind} ${normalized.id} v${normalized.version}**\n\n${markdownSummary(normalized)}\n\n\`\`\`brainkit-record\n${JSON.stringify(normalized, null, 2)}\n\`\`\``;
}

export function renderCandidate(record) {
  const normalized = validateRecord(record);
  if (normalized.confirmation !== 'proposed') fail('a candidate must remain proposed');
  const candidate = { schema: 'brainkit-candidate/v1', candidate_id: 'cand_' + sha(JSON.stringify(normalized)).slice(0, 24), record: normalized };
  return `待确认的结构化记忆；不能当作已经确认的事实。\n\n\`\`\`brainkit-candidate\n${JSON.stringify(candidate, null, 2)}\n\`\`\``;
}

export function parseCandidate(body) {
  const candidate = structuredJson(body, 'brainkit-candidate');
  if (candidate === null) return null;
  exactKeys(candidate, new Set(['schema', 'candidate_id', 'record']), 'candidate');
  const record = validateRecord(candidate.record);
  if (candidate.schema !== 'brainkit-candidate/v1' || record.confirmation !== 'proposed' || candidate.candidate_id !== 'cand_' + sha(JSON.stringify(record)).slice(0, 24)) fail('candidate identity is invalid');
  return { ...candidate, record };
}

export function validateSources(record, notes) {
  const normalized = validateRecord(record);
  if (!Array.isArray(notes)) throw new Error('notes must be an array');
  const byId = new Map(notes.filter(note => note && typeof note.id === 'string').map(note => [note.id, note]));
  for (const entry of [...normalized.sources, ...normalized.completion_sources || []]) {
    const note = byId.get(entry.note_id);
    if (!note) throw new Error(`record source note not found: ${entry.note_id}`);
    if (note.source_sha256 !== entry.source_sha256) throw new Error(`record source SHA mismatch: ${entry.note_id}`);
    const text = typeof note.text === 'string' ? note.text : note.body;
    if (typeof text !== 'string' || !text.includes(entry.quote)) throw new Error(`record source quote is absent: ${entry.note_id}`);
    if (sha(entry.quote) !== entry.quote_sha256) throw new Error(`record source quote hash mismatch: ${entry.note_id}`);
    if (note.trust !== entry.trust) throw new Error(`record source trust mismatch: ${entry.note_id}`);
  }
  return normalized;
}

export function assertRecordRevision(beforeBody, afterBody) {
  const before = parseRecord(beforeBody), after = parseRecord(afterBody);
  if (!before && !after) return null;
  if (!before || !after) throw new Error('record block cannot be added or removed during a record revision');
  if (before.id !== after.id || before.kind !== after.kind) throw new Error('record id or kind must not change');
  if (after.version !== before.version + 1) throw new Error('record version must increment by one');
  return after;
}

function entityKey(refValue) { return refValue.entity_id || refValue.name || refValue.ref; }
function nowIso(now) {
  const date = typeof now === 'string' ? new Date(now) : new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('invalid issue scan time');
  return date.toISOString();
}
function overlaps(left, right) {
  const start = Math.max(left.valid_from ? Date.parse(left.valid_from) : -Infinity, right.valid_from ? Date.parse(right.valid_from) : -Infinity);
  const end = Math.min(left.valid_until ? Date.parse(left.valid_until) : Infinity, right.valid_until ? Date.parse(right.valid_until) : Infinity);
  return start <= end;
}
function dueOverdue(due, time) {
  if (DATE.test(due)) return due < time.slice(0, 10);
  return Date.parse(due) < Date.parse(time);
}

export function recordIssues(records, now) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const normalized = records.map(validateRecord), time = nowIso(now), issues = [];
  const ids = new Map(), triples = new Map();
  for (const record of normalized) {
    const same = ids.get(record.id) || [];
    same.push(record); ids.set(record.id, same);
    if (record.valid_until && Date.parse(record.valid_until) < Date.parse(time)) issues.push({ type: 'expired', id: record.id, candidate: record.confirmation !== 'confirmed', valid_until: record.valid_until });
    if (record.kind === 'commitment' && record.status === 'open' && record.due && dueOverdue(record.due, time)) issues.push({ type: 'overdue', id: record.id, candidate: record.confirmation !== 'confirmed', due: record.due });
    if (record.kind === 'fact' || record.kind === 'relationship') {
      const key = `${entityKey(record.subject)}\0${record.predicate}`;
      const group = triples.get(key) || [];
      group.push(record); triples.set(key, group);
    }
  }
  for (const [id, group] of ids) if (group.length > 1) issues.push({ type: 'duplicate_id', id, ids: group.map(record => record.id), candidate: group.some(record => record.confirmation !== 'confirmed') });
  for (const [key, group] of triples) {
    const sameTriple = new Map();
    for (const record of group) {
      const objectKey = entityKey(record.object), matches = sameTriple.get(objectKey) || [];
      matches.push(record); sameTriple.set(objectKey, matches);
    }
    for (const [objectKey, matches] of sameTriple) {
      const uniqueIds = [...new Set(matches.map(record => record.id))];
      if (uniqueIds.length > 1) issues.push({ type: 'possible_duplicate', subject_predicate: key, object: objectKey, ids: uniqueIds, candidate: matches.some(record => record.confirmation !== 'confirmed') });
    }
    for (let left = 0; left < group.length; left++) for (let right = left + 1; right < group.length; right++) {
      if (entityKey(group[left].object) === entityKey(group[right].object) || !overlaps(group[left], group[right])) continue;
      const confirmed = group[left].confirmation === 'confirmed' && group[right].confirmation === 'confirmed';
      issues.push({ type: 'possible_conflict', subject_predicate: key, ids: [group[left].id, group[right].id], objects: [entityKey(group[left].object), entityKey(group[right].object)], confirmed, candidate: true, requires_cardinality_review: true });
    }
  }
  return issues;
}

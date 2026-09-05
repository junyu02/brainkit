import { createHash } from 'node:crypto';

export const EXPERIENCE_SUBFOLDERS = Object.freeze([
  'AI工具', '方法论', '前端开发', '系统配置', 'Swift-iOS', 'Python',
]);
export const DEDUP_ROOMS = Object.freeze(['经验', '项目', '知识', 'persona']);
export const LLM_NETWORK_RETRY_DELAYS_MS = Object.freeze([5_000, 30_000]);
// Copied from observe.mjs because it does not export these constants; changing
// the production collector to share a module is outside harvest v1.
export const TRANSIENT_LLM_NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);
export const UI_TYPE_CONFIG = Object.freeze({
  experience: { writeType: 'experience', field: 'subfolder' },
  project: { writeType: 'project', field: 'project' },
  knowledge: { writeType: 'reference', field: 'knowledge_subfolder' },
  persona: { writeType: 'user-profile', field: null },
});
const TERMINAL = new Set(['promoted', 'rejected', 'redirected']);
const CANDIDATE_STATUSES = new Set(['pending', 'promoted', 'rejected', 'skipped', 'needs_check', 'redirected']);

export class HarvestValidationError extends Error {}

function scalar(raw) {
  const value = raw.trim();
  if (value === '[]') return [];
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map(v => scalar(v)).filter(Boolean);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  return value;
}

export function normalizeObservationPath(value) {
  const path = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path.startsWith('08-观察/') || path.includes('/../') || path.endsWith('/..') || path.includes('\0')) {
    throw new HarvestValidationError(`invalid observation path: ${value}`);
  }
  return path;
}

export function parseObservationMarkdown(text, path) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new HarvestValidationError('missing YAML frontmatter');
  const meta = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      meta[listKey].push(scalar(item[1]));
      continue;
    }
    const field = line.match(/^([A-Za-z_][\w-]*):(?:\s*(.*))?$/);
    if (!field) continue;
    listKey = field[2] ? null : field[1];
    meta[field[1]] = field[2] ? scalar(field[2]) : [];
  }
  const title = String(meta.name ?? '').trim();
  const description = String(meta.description ?? '').trim();
  const created = String(meta.created ?? '').trim();
  const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(created)) {
    throw new HarvestValidationError('observation requires name and YYYY-MM-DD created');
  }
  return {
    path: normalizeObservationPath(path), title, description, created, tags,
    excerpt: match[2].trim().replace(/\s+/g, ' ').slice(0, 400),
  };
}

export function observationEligible(item, { since, consumed = {}, locked = new Set() } = {}) {
  return item.tags.includes('durable-candidate')
    && (!since || item.created >= since)
    && !consumed[item.path]
    && !locked.has(item.path);
}

export function buildInputBatches(items, maxItems = 25, maxChars = 60_000) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const item of items) {
    const size = JSON.stringify({ title: item.title, description: item.description.slice(0, 300), created: item.created }).length;
    if (batch.length && (batch.length >= maxItems || chars + size > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function mapUiType(uiType) {
  const config = UI_TYPE_CONFIG[uiType];
  if (!config) throw new HarvestValidationError(`invalid ui_type: ${uiType}`);
  return config;
}

export function candidateId(evidence, factTitle) {
  const paths = evidence.map(v => normalizeObservationPath(v.path)).sort();
  return createHash('sha256').update(JSON.stringify([paths, String(factTitle)])).digest('hex').slice(0, 16);
}

function requiredText(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new HarvestValidationError(`${name} is required`);
  const result = value.trim();
  if (result.length > max) throw new HarvestValidationError(`${name} exceeds ${max} characters`);
  return result;
}

export function validateCandidate(raw, { inputPaths, projects = [], knowledgeSubfolders = [] }) {
  const uiType = String(raw.ui_type ?? raw.memory_type ?? '');
  mapUiType(uiType);
  const factTitle = requiredText(raw.fact_title, 'fact_title', 120);
  const factBody = requiredText(raw.fact_body, 'fact_body', 4000);
  const rationale = requiredText(raw.rationale, 'rationale', 1000);
  if (!Number.isInteger(raw.value_score) || raw.value_score < 1 || raw.value_score > 5) {
    throw new HarvestValidationError('value_score must be an integer from 1 to 5');
  }
  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) {
    throw new HarvestValidationError('evidence must be non-empty');
  }
  const allowed = inputPaths instanceof Set ? inputPaths : new Set(inputPaths);
  const seen = new Set();
  const evidence = raw.evidence.map(item => {
    const path = normalizeObservationPath(item.path);
    if (!allowed.has(path)) throw new HarvestValidationError(`evidence not in input: ${path}`);
    if (seen.has(path)) throw new HarvestValidationError(`duplicate evidence: ${path}`);
    seen.add(path);
    return {
      path,
      title: requiredText(item.title, 'evidence.title', 200),
      desc: String(item.desc ?? '').trim().slice(0, 200),
      excerpt: String(item.excerpt ?? '').trim().slice(0, 400),
    };
  });
  let subfolder = null;
  let project = null;
  let knowledgeSubfolder = null;
  if (uiType === 'experience') {
    subfolder = String(raw.subfolder ?? '');
    if (!EXPERIENCE_SUBFOLDERS.includes(subfolder)) throw new HarvestValidationError('invalid experience subfolder');
  } else if (uiType === 'project') {
    project = String(raw.project ?? '');
    if (!projects.includes(project)) throw new HarvestValidationError('project is not registered');
  } else if (uiType === 'knowledge') {
    knowledgeSubfolder = String(raw.knowledge_subfolder ?? raw.subfolder ?? '');
    if (!knowledgeSubfolders.includes(knowledgeSubfolder)) throw new HarvestValidationError('knowledge subfolder does not exist');
  }
  const status = raw.status ?? 'pending';
  if (!CANDIDATE_STATUSES.has(status)) throw new HarvestValidationError(`invalid status: ${status}`);
  return {
    candidate_id: candidateId(evidence, factTitle), status,
    fact_title: factTitle, fact_body: factBody, ui_type: uiType,
    subfolder, project, knowledge_subfolder: knowledgeSubfolder,
    value_score: raw.value_score, rationale, evidence,
    dedup: raw.dedup ?? { available: false, top: [], likely_covered: false, rooms: [] },
    receipt_path: raw.receipt_path ?? null,
  };
}

export function clustersToCandidates(payload, batch, options) {
  if (!payload || !Array.isArray(payload.clusters)) throw new HarvestValidationError('LLM JSON requires clusters array');
  const inputPaths = new Set(batch.map(v => v.path));
  const candidates = [];
  const errors = [];
  payload.clusters.forEach((cluster, index) => {
    try {
      if (!cluster || !Array.isArray(cluster.members) || cluster.members.length === 0) {
        throw new HarvestValidationError('members must be non-empty');
      }
      const memberIndexes = [...new Set(cluster.members)];
      if (memberIndexes.length !== cluster.members.length || memberIndexes.some(v => !Number.isInteger(v) || v < 1 || v > batch.length)) {
        throw new HarvestValidationError('member index is duplicate or out of range');
      }
      const evidence = memberIndexes.map(member => {
        const item = batch[member - 1];
        return { path: item.path, title: item.title, desc: item.description, excerpt: item.excerpt };
      });
      const candidate = validateCandidate({ ...cluster, evidence, status: 'pending' }, { ...options, inputPaths });
      candidates.push({ ...candidate, cluster_id: `c${index + 1}` });
    } catch (error) {
      errors.push({ stage: 'first-layer', cluster_index: index, message: error.message });
    }
  });
  return { candidates, errors };
}

export function applyMergeGroups(candidates, groups) {
  if (!Array.isArray(groups)) throw new HarvestValidationError('merges must be an array');
  const byId = new Map(candidates.map(v => [v.cluster_id, v]));
  const appearances = new Map();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const id of group) appearances.set(id, (appearances.get(id) ?? 0) + 1);
  }
  const errors = [];
  const valid = [];
  groups.forEach((group, index) => {
    const reason = !Array.isArray(group) || group.length < 2
      ? 'merge group requires at least two ids'
      : group.some(id => !byId.has(id))
        ? 'merge group contains unknown cluster_id'
        : group.some(id => appearances.get(id) > 1)
          ? 'merge group overlaps another group'
          : null;
    if (reason) errors.push({ stage: 'merge', group_index: index, message: reason });
    else valid.push(group);
  });
  const mergedIds = new Set(valid.flat());
  const output = candidates.filter(v => !mergedIds.has(v.cluster_id));
  valid.forEach((group, groupIndex) => {
    const members = group.map(id => byId.get(id));
    const winner = members.reduce((best, item) => item.value_score > best.value_score ? item : best);
    const evidence = [...new Map(members.flatMap(v => v.evidence).map(v => [v.path, v])).values()];
    const extras = members.filter(v => v !== winner).map(v => v.rationale).filter(Boolean);
    output.push({
      ...winner,
      cluster_id: `m${groupIndex + 1}-${group.join('-')}`,
      candidate_id: candidateId(evidence, winner.fact_title),
      evidence,
      rationale: extras.length ? `${winner.rationale}；附注：${extras.join('；')}` : winner.rationale,
    });
  });
  return { candidates: output, errors };
}

export function parseMempalaceOutput(output) {
  const lines = String(output ?? '').split(/\r?\n/);
  const results = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(/^\s*\[(\d+)]\s+(.+?)\s+\/\s+(.+?)\s*$/);
    if (!header) continue;
    let source = '';
    let cosine = null;
    for (let j = i + 1; j < lines.length && !/^\s*\[\d+]\s+/.test(lines[j]); j += 1) {
      const sourceMatch = lines[j].match(/^\s*Source:\s*(.+?)\s*$/);
      const scoreMatch = lines[j].match(/\bcosine_sim=(-?\d+(?:\.\d+)?)/);
      if (sourceMatch) source = sourceMatch[1];
      if (scoreMatch) cosine = Number(scoreMatch[1]);
    }
    if (source && Number.isFinite(cosine)) {
      results.push({ room: header[3], title: source.replace(/\.md$/i, ''), cosine });
    }
  }
  return results;
}

export function buildDedupCommands(title) {
  return DEDUP_ROOMS.map(room => ({ room, args: ['search', title, '--room', room, '--results', '3'] }));
}

export function aggregateDedupRoomResults(roomResults) {
  const rooms = [];
  const hits = [];
  for (const result of roomResults) {
    if (!result.ok) {
      rooms.push({ room: result.room, available: false, error: String(result.error ?? 'search failed').slice(0, 300) });
      continue;
    }
    const parsed = parseMempalaceOutput(result.output);
    const available = parsed.length > 0 || /No results found/i.test(String(result.output));
    rooms.push({ room: result.room, available, error: available ? null : 'unparseable output' });
    if (available) hits.push(...parsed.map(v => ({ ...v, room: result.room })));
  }
  hits.sort((a, b) => b.cosine - a.cosine);
  const available = rooms.some(v => v.available);
  return { available, top: hits.slice(0, 3), likely_covered: hits.some(v => v.cosine >= 0.62), rooms };
}

export function isTransientLlmError(error) {
  if (Number.isInteger(error?.httpStatus)) return false;
  return TRANSIENT_LLM_NETWORK_CODES.has(error?.code)
    || TRANSIENT_LLM_NETWORK_CODES.has(error?.cause?.code)
    || (error instanceof TypeError && /terminated|fetch failed/i.test(error.message));
}

export function encodeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function validateHttpRequest({ method, path, host, origin, contentType, bodyBytes = 0, token, port }) {
  const base = `/t/${token}/`;
  const sameOrigin = `http://127.0.0.1:${port}`;
  if (host !== `127.0.0.1:${port}`) return { ok: false, status: 403, message: 'invalid Host' };
  if (origin && origin !== sameOrigin) return { ok: false, status: 403, message: 'invalid Origin' };
  if (!path.startsWith(base)) return { ok: false, status: 404, message: 'not found' };
  const endpoint = path.slice(base.length);
  if (endpoint === '' && method === 'GET') return { ok: true, endpoint: 'page' };
  if (!['decide', 'finish'].includes(endpoint)) return { ok: false, status: 404, message: 'not found' };
  if (method !== 'POST') return { ok: false, status: 405, message: 'POST required' };
  if (!String(contentType ?? '').toLowerCase().startsWith('application/json')) return { ok: false, status: 415, message: 'application/json required' };
  if (bodyBytes > 64 * 1024) return { ok: false, status: 413, message: 'body exceeds 64KB' };
  return { ok: true, endpoint };
}

function parseJsonChannel(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  try { return JSON.parse(value); } catch {}
  for (const line of value.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

export function classifyBrainWriteResult(result) {
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  if (result.error?.code === 'ETIMEDOUT') return { status: 'needs_check', outcome: 'timeout', message: stderr || result.error.message };
  if (result.signal) return { status: 'needs_check', outcome: 'signal', message: `brain-write killed by ${result.signal}` };
  if (result.status === 0) {
    const receipt = parseJsonChannel(stdout);
    if (receipt?.status !== 'ok' || !receipt.path) return { status: 'needs_check', outcome: 'invalid-receipt', message: stdout || 'invalid success receipt' };
    return receipt.inbox_redirect
      ? { status: 'redirected', outcome: 'inbox_redirect', receipt_path: receipt.path, message: `路由被重定向：${receipt.inbox_redirect.reason ?? 'section policy'}` }
      : { status: 'promoted', outcome: 'ok', receipt_path: receipt.path, message: '晋升成功' };
  }
  const failure = parseJsonChannel(stderr);
  if (failure?.rollback === 'partial') return { status: 'needs_check', outcome: 'rollback-partial', message: stderr };
  return {
    status: 'pending', outcome: `exit-nonzero(${result.status ?? 'unknown'})`, exit_code: result.status,
    message: result.status === 6 ? 'vault 写锁忙，稍后重试' : (stderr || stdout || `brain-write exited ${result.status}`),
  };
}

export function applyCandidateOutcome(candidate, outcome) {
  if (candidate.status !== 'pending') return { ...candidate };
  return { ...candidate, status: outcome.status, receipt_path: outcome.receipt_path ?? candidate.receipt_path ?? null };
}

export function resolveNeedsCheck(candidate, action, receiptPath = null) {
  if (candidate.status !== 'needs_check') return { ...candidate };
  if (action === 'confirm') return { ...candidate, status: 'promoted', receipt_path: receiptPath || candidate.receipt_path || null };
  if (action === 'retry') return { ...candidate, status: 'pending', evidence_locked: true };
  if (action === 'reject') return { ...candidate, status: 'rejected' };
  throw new HarvestValidationError(`invalid needs_check action: ${action}`);
}

export function recomputeConsumed(existing, candidates, ts = new Date().toISOString()) {
  const consumed = { ...(existing ?? {}) };
  const byPath = new Map();
  for (const candidate of candidates) {
    for (const evidence of candidate.evidence) {
      const statuses = byPath.get(evidence.path) ?? [];
      statuses.push(candidate.status);
      byPath.set(evidence.path, statuses);
    }
  }
  for (const [path, statuses] of byPath) {
    if (statuses.length && statuses.every(status => TERMINAL.has(status))) consumed[path] ??= { ts };
  }
  return consumed;
}

export function collectLockedEvidence(candidates) {
  return new Set(candidates.filter(v => v.status === 'needs_check' || v.evidence_locked).flatMap(v => v.evidence.map(e => e.path)));
}

export function protectQueue(candidates, forceRegen) {
  const pending = candidates.filter(v => v.status === 'pending');
  const needsCheck = candidates.filter(v => v.status === 'needs_check');
  if (!forceRegen && (pending.length || needsCheck.length)) {
    throw new HarvestValidationError(`unreviewed queue exists: pending=${pending.length}, needs_check=${needsCheck.length}`);
  }
  return {
    carried: forceRegen ? candidates.filter(v => v.status === 'needs_check' || (v.status === 'pending' && v.evidence_locked)) : [],
    invalidated: forceRegen ? pending.filter(v => !v.evidence_locked) : [],
  };
}

export function filterDecided(candidates, decided = {}) {
  return candidates.filter(v => !decided[v.candidate_id]);
}

export function recoverOperations(entries, candidates) {
  const operations = new Map();
  for (const entry of entries) {
    if (!entry.operation_id) continue;
    const operation = operations.get(entry.operation_id) ?? { intents: [], outcomes: [] };
    if (entry.phase === 'intent') operation.intents.push(entry);
    if (entry.phase === 'outcome') operation.outcomes.push(entry);
    operations.set(entry.operation_id, operation);
  }
  for (const [id, operation] of operations) {
    if (operation.outcomes.length > 1) throw new HarvestValidationError(`operation ${id} has multiple outcomes`);
  }
  const resolved = new Set([...operations.values()].flatMap(v => v.intents.map(i => i.resolves).filter(Boolean)));
  const updated = candidates.map(v => ({ ...v }));
  const byCandidate = new Map(updated.map(v => [v.candidate_id, v]));
  const replayOutcomes = [];
  for (const [id, operation] of operations) {
    const intent = operation.intents.at(-1);
    if (!intent || operation.outcomes.length || resolved.has(id)) continue;
    const candidate = byCandidate.get(intent.candidate_id);
    if (!candidate) continue;
    if (intent.action === 'promote') {
      candidate.status = 'needs_check';
      candidate.operation_id = id;
    } else if (intent.action === 'reject' || intent.action === 'skip') {
      candidate.status = intent.action === 'reject' ? 'rejected' : 'skipped';
      replayOutcomes.push({
        ts: new Date().toISOString(), phase: 'outcome', operation_id: id,
        candidate_id: candidate.candidate_id, outcome: `${intent.action}-replayed`, resulting_status: candidate.status,
        ...(intent.decided_by ? { decided_by: intent.decided_by } : {}),
      });
    }
  }
  return { candidates: updated, replayOutcomes };
}

export function sortedCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (Boolean(a.dedup?.likely_covered) !== Boolean(b.dedup?.likely_covered)) return a.dedup?.likely_covered ? 1 : -1;
    return b.value_score - a.value_score || b.evidence.length - a.evidence.length || a.fact_title.localeCompare(b.fact_title);
  });
}

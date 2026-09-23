import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_LEDGER_BYTES, listActiveNotes, listStructuredNotes, readActiveNote, readWriteEvents } from './memory-read.mjs';
import { parseRecord, recordIssues } from './memory-records.mjs';
import { parseEvent } from './memory-ingestion.mjs';
import { sundayHealth } from '../cli/brain-sunday.mjs';
import { loadObserveEnv } from './plist-render.mjs';

const MAX_BYTES = 2000;
const MAX_SAMPLES = 3;
const WRITER = fileURLToPath(new URL('../cli/brain-write.mjs', import.meta.url));

const samplePath = (vault, value) => {
  const path = typeof value === 'string' ? relative(vault, value) : '';
  return path && !path.startsWith('..') && !isAbsolute(path) ? path.slice(0, 180) : null;
};
const status = (value, extra = {}) => ({ status: value, ...extra });
const shortError = error => String(error?.code || error?.name || 'unavailable').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 64) || 'unavailable';

function safeRegular(path, max = 1024 * 1024) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max) throw new Error('unsafe_file');
  return info;
}

function vaultCheck(vault) {
  try {
    const info = lstatSync(vault);
    return info.isDirectory() && !info.isSymbolicLink() ? status('ok') : status('error', { error: 'not_directory' });
  } catch (error) { return status('error', { error: shortError(error) }); }
}

function routingCheck(path) {
  try {
    safeRegular(path);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const routes = value?.routes;
    const valid = value?.schema === 'vault-routing-v2' && Array.isArray(routes) && routes.length > 0
      && routes.every(row => row && typeof row.type === 'string' && typeof row.path === 'string'
        && !row.path.startsWith('/') && !row.path.split('/').includes('..'));
    return valid ? status('ok', { routes: routes.length }) : status('error', { error: 'invalid_routing' });
  } catch (error) { return status('error', { error: shortError(error) }); }
}

function newestIndexMtime(path) {
  let latest = 0, count = 0;
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) { latest = Math.max(latest, Number(statSync(child).mtimeMs)); count++; }
    }
  };
  walk(path);
  return { latest, count };
}

function indexCheck(paths, run) {
  const vault = paths?.vault;
  const path = join(vault, '00-系统', '.index-cache');
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return status('error', { error: 'invalid_index_directory' });
    const { latest, count } = newestIndexMtime(path);
    const execute = typeof run === 'function' ? run : spawnSync;
    const result = execute(process.execPath, [WRITER, '--verify'], { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, env: { ...process.env, BRAIN_VAULT_ROOT: vault, BRAIN_MEMORY_DIR: paths?.memory, BRAIN_ROUTING_JSON: paths?.routing } });
    if (result?.error) return status('warning', { exists: true, freshness: 'unknown', files: count, latest_mtime: latest ? new Date(latest).toISOString() : null, error: shortError(result.error) });
    let report;
    try { report = JSON.parse(result?.stdout || ''); } catch { return status('warning', { exists: true, freshness: 'unknown', files: count, latest_mtime: latest ? new Date(latest).toISOString() : null, error: 'invalid_verify_output' }); }
    const counts = Object.fromEntries(['dead_links', 'duplicates', 'inconsistent_group', 'intent_map_issues'].map(key => [key, Array.isArray(report?.[key]) ? report[key].length : null]));
    if (Object.values(counts).some(value => value === null)) return status('warning', { exists: true, freshness: 'unknown', files: count, latest_mtime: latest ? new Date(latest).toISOString() : null, error: 'invalid_verify_schema' });
    const problems = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return status(problems ? 'warning' : 'ok', { exists: true, freshness: 'unknown', files: count, latest_mtime: latest ? new Date(latest).toISOString() : null, verify: counts, verify_overall: report.overall === 'PASS' ? 'PASS' : 'FAIL' });
  } catch (error) { return status('warning', { error: shortError(error), files: 0, latest_mtime: null }); }
}

function modelCheck(modelEnv) {
  try {
    const env = modelEnv || loadObserveEnv(resolve(process.env.BRAIN_OBSERVE_ENV_PATH || join(homedir(), '.config/second-brain/observe.env')));
    return env?.OPENAI_API_KEY && env?.OPENAI_BASE_URL ? status('ok', { configuration: 'configured', model: String(env.OBSERVE_MODEL || 'default').slice(0, 120), not_probed: true }) : status('not_configured', { configuration: 'not_configured', not_probed: true });
  } catch (error) {
    // Absent is a choice; present but unreadable is a fault that only shows up
    // later as synthesize returning unavailable.
    return error.code === 'ENOENT'
      ? status('not_configured', { configuration: 'not_configured', not_probed: true })
      : status('warning', { configuration: 'unreadable', error: shortError(error), not_probed: true });
  }
}

function semanticCheck(run) {
  if (typeof run !== 'function') return status('not_configured', { configured: false, fresh: false, probed: false });
  try {
    const result = run(process.env.MEMPALACE_BIN || 'mempalace', ['status'], { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 });
    return result?.error || result?.status !== 0
      ? status('warning', { configured: true, fresh: false, error: shortError(result?.error || { code: `exit_${result?.status ?? 'unknown'}` }) })
      : status('ok', { configured: true, reachable: true, fresh: false, freshness: 'unknown', probed: true });
  } catch (error) { return status('warning', { configured: true, fresh: false, error: shortError(error) }); }
}

// The ledger only grows. Past the limit every ledger-backed read fails closed,
// so report the approach while there is still room to act.
function ledgerCheck(vault) {
  const path = join(vault, '00-系统', 'logs', 'brain-write-ledger.jsonl');
  let info;
  // lstat, not stat: a symlinked ledger is refused by every reader, so doctor
  // must not report its target's size as ok.
  try { info = lstatSync(path); }
  catch (error) { return error.code === 'ENOENT' ? status('ok', { bytes: 0, limit: MAX_LEDGER_BYTES }) : status('warning', { error: shortError(error), limit: MAX_LEDGER_BYTES }); }
  const bytes = Number(info.size);
  if (!info.isFile()) return status('warning', { error: 'ledger_unsafe', bytes, limit: MAX_LEDGER_BYTES });
  if (bytes >= MAX_LEDGER_BYTES) return status('error', { error: 'ledger_too_large', bytes, limit: MAX_LEDGER_BYTES });
  return status(bytes >= MAX_LEDGER_BYTES * 0.8 ? 'warning' : 'ok', { bytes, limit: MAX_LEDGER_BYTES });
}

function recordsCheck(notes, now, vault) {
  const records = [], bad = [], drifts = [];
  let unconfirmedRecords = 0;
  const byId = new Map(notes.map(note => [note.id, note]));
  for (const note of notes) {
    try {
      const record = parseRecord(note.body);
      if (!record) continue;
      records.push(record);
      if (note.trust === 'observation_unconfirmed') unconfirmedRecords++;
      for (const source of [...record.sources, ...(record.completion_sources || [])]) {
        let current = byId.get(source.note_id);
        if (!current && vault) {
          try { current = readActiveNote(vault, resolve(vault, source.note_id), { includeUnconfirmed: true, now }); }
          catch { current = null; }
          if (current) byId.set(source.note_id, current);
        }
        if (!current || current.source_sha256 !== source.source_sha256) drifts.push(note.id);
      }
    } catch { bad.push(note.id); }
  }
  let issues = [];
  try { issues = recordIssues(records, now); } catch { bad.push('recordIssues'); }
  const counts = Object.fromEntries(['expired', 'overdue', 'duplicate_id', 'possible_duplicate', 'possible_conflict'].map(type => [type, issues.filter(issue => issue.type === type).length]));
  const problemCount = bad.length + drifts.length + issues.length;
  return status(problemCount ? 'warning' : 'ok', {
    records: records.length, unconfirmed_records: unconfirmedRecords, invalid: bad.length, source_sha_drift: drifts.length, issues: counts,
    samples: [...new Set([...bad, ...drifts])].slice(0, MAX_SAMPLES),
  });
}

function ingestionCheck(notes) {
  const providers = new Map(), invalid = [];
  for (const note of notes) {
    try {
      const event = parseEvent(note.body);
      if (!event) continue;
      const provider = event.provider, updated = event.source_updated_at;
      const previous = providers.get(provider) || { records: 0, latest_source_updated_at: null };
      previous.records++;
      if (updated && (!previous.latest_source_updated_at || updated > previous.latest_source_updated_at)) previous.latest_source_updated_at = updated;
      providers.set(provider, previous);
    } catch { invalid.push(note.id); }
  }
  return status(invalid.length ? 'warning' : 'ok', { providers: Object.fromEntries([...providers].slice(0, MAX_SAMPLES)), invalid: invalid.length, samples: invalid.slice(0, MAX_SAMPLES) });
}

function bounded(result) {
  for (const check of Object.values(result.checks)) if (Array.isArray(check.samples)) check.samples = check.samples.slice(0, MAX_SAMPLES);
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
    const sample = Object.values(result.checks).find(check => Array.isArray(check.samples) && check.samples.length);
    if (!sample) break;
    sample.samples.pop();
  }
  return result;
}

export function memoryHealth({ paths, now = Date.now, run, modelEnv } = {}) {
  const time = typeof now === 'function' ? now() : now;
  const vault = paths?.vault, checks = { vault: vaultCheck(vault), routing: routingCheck(paths?.routing) };
  if (checks.vault.status === 'ok') {
    checks.index = indexCheck(paths, run);
    checks.ledger = ledgerCheck(vault);
    try {
      const diagnostics = [], notes = listActiveNotes(vault, { diagnostics, now: time });
      const structuredDiagnostics = [], structuredNotes = listStructuredNotes(vault, { includeUnconfirmed: true, diagnostics: structuredDiagnostics, now: time });
      const allNotes = [...new Map([...notes, ...structuredNotes].map(note => [note.id, note])).values()];
      checks.sources = status(diagnostics.length ? 'warning' : 'ok', { notes: notes.length, diagnostics: diagnostics.length, samples: diagnostics.map(row => samplePath(vault, row.path)).filter(Boolean).slice(0, MAX_SAMPLES) });
      try { checks.writer = status('ok', { events: readWriteEvents(vault).length }); }
      catch (error) { checks.writer = status('error', { error: shortError(error) }); }
      checks.records = recordsCheck(allNotes, time, vault);
      checks.ingestion = ingestionCheck(structuredNotes);
      if (structuredDiagnostics.length) {
        checks.records = status('warning', { ...checks.records, structured_diagnostics: structuredDiagnostics.length, samples: [...(checks.records.samples || []), ...structuredDiagnostics.map(row => samplePath(vault, row.path)).filter(Boolean)].slice(0, MAX_SAMPLES) });
      }
    } catch (error) {
      checks.sources = status('error', { error: shortError(error), notes: 0, diagnostics: 0 });
      checks.writer = status('warning', { error: 'not_checked' });
      checks.records = status('warning', { error: 'not_checked' });
      checks.ingestion = status('warning', { error: 'not_checked' });
    }
    try { const pipeline = sundayHealth(vault, time); checks.pipeline = status(pipeline.healthy ? 'ok' : 'warning', { state: String(pipeline.status || 'unknown').slice(0, 40), stale: pipeline.stale === true, last_success: pipeline.last_success || null }); }
    catch (error) { checks.pipeline = status('warning', { error: shortError(error) }); }
  } else {
    for (const name of ['index', 'ledger', 'sources', 'writer', 'records', 'ingestion', 'pipeline']) checks[name] = status('error', { error: 'vault_unavailable' });
  }
  checks.model = modelCheck(modelEnv);
  checks.semantic_index = semanticCheck(run);
  // not_configured is an optional capability that is absent, not a fault.
  const healthy = Object.values(checks).every(check => check.status === 'ok' || check.status === 'not_configured');
  return bounded({ healthy, status: healthy ? 'healthy' : 'degraded', checked_at: new Date(time).toISOString(), checks });
}

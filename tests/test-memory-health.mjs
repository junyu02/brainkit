import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { memoryHealth } from '../scripts/lib/memory-health.mjs';
import { recordId } from '../scripts/lib/memory-records.mjs';
import { eventId } from '../scripts/lib/memory-ingestion.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-health-')), vault = join(root, 'vault'), memory = join(root, 'memory'), routing = join(root, 'routing.json');
  for (const path of [join(vault, '00-系统', '.index-cache'), join(vault, '00-系统', 'logs'), join(vault, '03-经验', 'AI工具'), join(vault, '08-观察'), memory]) mkdirSync(path, { recursive: true });
  writeFileSync(routing, JSON.stringify({ schema: 'vault-routing-v2', routes: [{ type: 'experience', path: '03-经验/', scope: 'global' }] }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, vault, memory, routing };
}
const clock = () => Date.parse('2026-09-22T00:00:00Z');
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => value && typeof value === 'object' && !Array.isArray(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
function eventBody({ hash = null } = {}) {
  const content = { provider: 'gmail', source_updated_at: '2026-09-21T00:00:00.000Z', title: '同步标题', summary: '同步摘要' };
  const event = { schema: 'brainkit-event/v1', event_id: eventId('gmail', 'fixture-event'), ...content, data_sha256: hash || sha(stable(content)) };
  return `\`\`\`brainkit-event\n${JSON.stringify(event)}\n\`\`\``;
}

test('health reports empty and unconfigured services without probing or leaking secrets', t => {
  const f = fixture(t);
  const result = memoryHealth({ paths: f, now: clock, modelEnv: { OPENAI_API_KEY: 'secret-never-output', OPENAI_BASE_URL: 'https://private.example', OBSERVE_MODEL: 'test' } });
  assert.equal(result.checks.semantic_index.status, 'not_configured');
  assert.equal(result.checks.model.status, 'ok');
  assert.equal(result.checks.model.not_probed, true);
  assert.equal(JSON.stringify(result).includes('secret-never-output'), false);
  assert.equal(JSON.stringify(result).includes('private.example'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2000);
});

test('health finds diagnostics, stale pipeline, records and source drift without emitting note bodies', t => {
  const f = fixture(t), note = join(f.vault, '03-经验', 'AI工具', 'record.md');
  writeFileSync(note, `---\ntitle: record\ndescription: x\n---\n\`\`\`brainkit-record\nnot json\n\`\`\`\nprivate note body`);
  writeFileSync(join(f.vault, '08-观察', 'event.md'), `---\ntitle: event\ndescription: x\n---\n${eventBody()}\nprivate connector body`);
  writeFileSync(join(f.vault, '08-观察', 'bad-event.md'), `---\ntitle: bad event\ndescription: x\n---\n${eventBody({ hash: '0'.repeat(64) })}`);
  writeFileSync(join(f.vault, '00-系统', 'logs', 'brain-write-ledger.jsonl'), [
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:00Z', action: 'write', event_id: eventId('gmail', 'fixture-event'), target_path: join(f.vault, '08-观察', 'event.md') }),
    JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:01Z', action: 'write', event_id: eventId('gmail', 'fixture-event-bad'), target_path: join(f.vault, '08-观察', 'bad-event.md') }),
  ].join('\n') + '\n');
  writeFileSync(join(f.vault, '03-经验', 'AI工具', 'bad.md'), '---\nactive: {bad}\n---\nprivate bad body');
  writeFileSync(join(f.vault, '00-系统', 'logs', 'sunday-pipeline.log'), '');
  const result = memoryHealth({ paths: f, now: clock, run: () => ({ status: 1, stdout: 'private cli output' }) });
  assert.equal(result.checks.sources.status, 'warning');
  assert.equal(result.checks.records.invalid, 1);
  assert.equal(result.checks.ingestion.providers.gmail.records, 1);
  // An unparseable event is now isolated to its own path by the ledger scan.
  assert.equal(result.checks.ingestion.invalid, 0);
  assert.equal(result.checks.records.structured_diagnostics, 1);
  assert.ok(result.checks.records.samples.some(sample => sample.endsWith('bad-event.md')));
  assert.equal(result.checks.semantic_index.fresh, false);
  assert.equal(result.healthy, false);
  assert.equal(JSON.stringify(result).includes('private note body'), false);
  assert.equal(JSON.stringify(result).includes('private connector body'), false);
  assert.equal(JSON.stringify(result).includes('private cli output'), false);
});

test('health treats valid current state as healthy and reports explicit record expiry only', t => {
  const f = fixture(t), note = join(f.vault, '03-经验', 'AI工具', 'current.md');
  writeFileSync(note, '---\ntitle: current\ndescription: x\nexpires: 2000-01-01\n---\nbody');
  writeFileSync(join(f.vault, '00-系统', '.index-cache', 'index.json'), '{}');
  writeFileSync(join(f.vault, '00-系统', 'logs', 'sunday-pipeline.log'), '===== 2026-09-21T00:00:00Z START sunday pipeline =====\n===== 2026-09-21T00:00:00Z END sunday pipeline exit=0 =====\n');
  writeFileSync(join(f.vault, '00-系统', '.index-cache', 'sunday-state.json'), JSON.stringify({ status: 'completed' }));
  const verify = JSON.stringify({ overall: 'PASS', dead_links: [], duplicates: [], inconsistent_group: [], intent_map_issues: [] });
  const run = (_bin, args) => args?.[1] === '--verify' ? { status: 0, stdout: verify } : { status: 0 };
  const result = memoryHealth({ paths: f, now: clock, run, modelEnv: { OPENAI_API_KEY: 'x', OPENAI_BASE_URL: 'https://x', OBSERVE_MODEL: 'x' } });
  assert.equal(result.checks.records.issues.expired, 0);
  assert.equal(result.checks.semantic_index.status, 'ok');
  assert.equal(result.checks.semantic_index.reachable, true);
  assert.equal(result.checks.semantic_index.freshness, 'unknown');
  assert.equal(result.checks.semantic_index.fresh, false);
  assert.equal(result.checks.index.freshness, 'unknown');
  assert.equal(result.checks.ledger.status, 'ok');
  assert.equal(result.checks.ledger.bytes, 0);
  assert.equal(result.healthy, true);
  assert.equal(result.status, 'healthy');
});

test('a writer ledger approaching its hard limit degrades health and names the ledger', t => {
  const f = fixture(t);
  writeFileSync(join(f.vault, '00-系统', '.index-cache', 'index.json'), '{}');
  writeFileSync(join(f.vault, '00-系统', 'logs', 'sunday-pipeline.log'), '===== 2026-09-21T00:00:00Z START sunday pipeline =====\n===== 2026-09-21T00:00:00Z END sunday pipeline exit=0 =====\n');
  writeFileSync(join(f.vault, '00-系统', '.index-cache', 'sunday-state.json'), JSON.stringify({ status: 'completed' }));
  // Valid JSONL in few large rows: the size must be what trips the check, not a parse failure.
  const row = JSON.stringify({ status: 'skipped', ts: '2026-09-21T00:00:00Z', pad: 'a'.repeat(1024 * 1024) });
  writeFileSync(join(f.vault, '00-系统', 'logs', 'brain-write-ledger.jsonl'), `${Array.from({ length: 27 }, () => row).join('\n')}\n`);
  const verify = JSON.stringify({ overall: 'PASS', dead_links: [], duplicates: [], inconsistent_group: [], intent_map_issues: [] });
  const result = memoryHealth({ paths: f, now: clock, run: (_bin, args) => args?.[1] === '--verify' ? { status: 0, stdout: verify } : { status: 0 }, modelEnv: { OPENAI_API_KEY: 'x', OPENAI_BASE_URL: 'https://x', OBSERVE_MODEL: 'x' } });
  assert.equal(result.checks.ledger.status, 'warning');
  assert.ok(result.checks.ledger.bytes >= result.checks.ledger.limit * 0.8);
  assert.ok(result.checks.ledger.bytes < result.checks.ledger.limit);
  assert.equal(result.checks.sources.status, 'ok');
  assert.equal(result.checks.writer.status, 'ok');
  assert.equal(result.healthy, false);
  assert.equal(result.status, 'degraded');
});

test('an unreachable semantic index degrades health without claiming freshness', t => {
  const f = fixture(t);
  writeFileSync(join(f.vault, '00-系统', '.index-cache', 'index.json'), '{}');
  writeFileSync(join(f.vault, '00-系统', 'logs', 'sunday-pipeline.log'), '===== 2026-09-21T00:00:00Z START sunday pipeline =====\n===== 2026-09-21T00:00:00Z END sunday pipeline exit=0 =====\n');
  writeFileSync(join(f.vault, '00-系统', '.index-cache', 'sunday-state.json'), JSON.stringify({ status: 'completed' }));
  const verify = JSON.stringify({ overall: 'PASS', dead_links: [], duplicates: [], inconsistent_group: [], intent_map_issues: [] });
  const result = memoryHealth({ paths: f, now: clock, run: (_bin, args) => args?.[1] === '--verify' ? { status: 0, stdout: verify } : { status: 1 }, modelEnv: { OPENAI_API_KEY: 'x', OPENAI_BASE_URL: 'https://x', OBSERVE_MODEL: 'x' } });
  assert.equal(result.checks.semantic_index.status, 'warning');
  assert.equal(result.checks.semantic_index.fresh, false);
  assert.equal(result.healthy, false);
  assert.equal(result.status, 'degraded');
});

test('a symlinked ledger is unsafe rather than ok, and an unreadable model config is a fault', t => {
  const f = fixture(t), ledger = join(f.vault, '00-系统', 'logs', 'brain-write-ledger.jsonl');
  writeFileSync(join(f.root, 'elsewhere.jsonl'), '');
  symlinkSync(join(f.root, 'elsewhere.jsonl'), ledger);
  const result = memoryHealth({ paths: f, now: clock, modelEnv: { OPENAI_API_KEY: 'x', OPENAI_BASE_URL: 'https://x' } });
  assert.equal(result.checks.ledger.status, 'warning');
  assert.equal(result.checks.ledger.error, 'ledger_unsafe');
  assert.equal(result.healthy, false);
  // An observe.env that exists but cannot be read is not the same as never configured.
  const previous = process.env.BRAIN_OBSERVE_ENV_PATH;
  process.env.BRAIN_OBSERVE_ENV_PATH = f.root;
  const unreadable = memoryHealth({ paths: f, now: clock });
  if (previous === undefined) delete process.env.BRAIN_OBSERVE_ENV_PATH; else process.env.BRAIN_OBSERVE_ENV_PATH = previous;
  assert.equal(unreadable.checks.model.status, 'warning');
  assert.equal(unreadable.checks.model.configuration, 'unreadable');
  assert.equal(unreadable.healthy, false);
});

test('health counts source SHA drift from an unconfirmed record without upgrading its trust', t => {
  const f = fixture(t), source = join(f.vault, '03-经验', 'AI工具', 'source.md'), record = join(f.vault, '08-观察', 'record.md');
  writeFileSync(source, '---\ntitle: source\ndescription: x\n---\nquoted evidence');
  writeFileSync(record, `---\ntitle: record\ndescription: x\n---\n\`\`\`brainkit-record\n${JSON.stringify({
    schema: 'brainkit-record/v1', kind: 'relationship', id: recordId('relationship', 'drift'), version: 1, confirmation: 'confirmed',
    sources: [{ note_id: '03-经验/AI工具/source.md', source_sha256: '0'.repeat(64), quote: 'quoted evidence', quote_sha256: sha('quoted evidence'), trust: 'vault_source' }],
    statement: '甲在乙工作。', subject: { name: '甲' }, predicate: 'works_at', object: { name: '乙' }, valid_from: '2026-09-20T00:00:00Z',
  })}\n\`\`\``);
  writeFileSync(join(f.vault, '00-系统', 'logs', 'brain-write-ledger.jsonl'), JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:00Z', action: 'write', record_id: recordId('relationship', 'drift'), target_path: record }) + '\n');
  const result = memoryHealth({ paths: f, now: clock });
  assert.equal(result.checks.records.source_sha_drift, 1);
  assert.equal(result.checks.records.unconfirmed_records, 1);
  assert.equal(JSON.stringify(result).includes('quoted evidence'), false);
});

test('index health runs governed verify and reports link categories even when overall says PASS', t => {
  const f = fixture(t), calls = [];
  const run = (bin, args, options) => {
    calls.push({ bin, args, options });
    if (args[1] === '--verify') return { status: 0, stdout: JSON.stringify({ overall: 'PASS', dead_links: [], duplicates: [], inconsistent_group: [{}, {}, {}], intent_map_issues: [] }) };
    return { status: 0, stdout: '' };
  };
  const result = memoryHealth({ paths: f, now: clock, run });
  assert.equal(result.checks.index.status, 'warning');
  assert.deepEqual(result.checks.index.verify, { dead_links: 0, duplicates: 0, inconsistent_group: 3, intent_map_issues: 0 });
  assert.equal(result.checks.index.verify_overall, 'PASS');
  const verify = calls.find(call => call.args[1] === '--verify');
  assert.equal(verify.bin, process.execPath);
  assert.equal(verify.options.timeout, 5000);
  assert.equal(verify.options.env.BRAIN_VAULT_ROOT, f.vault);
  assert.equal(result.checks.index.freshness, 'unknown');
});

test('index health reports a bounded writer verify timeout without claiming freshness', t => {
  const f = fixture(t);
  const result = memoryHealth({ paths: f, now: clock, run: (_bin, args) => args[1] === '--verify'
    ? { error: { code: 'ETIMEDOUT' }, status: null }
    : { status: 1, stdout: '' } });
  assert.equal(result.checks.index.status, 'warning');
  assert.equal(result.checks.index.error, 'ETIMEDOUT');
  assert.equal(result.checks.index.freshness, 'unknown');
});

test('record source lookup safely rereads an ordinary observation outside the sparse structured set', t => {
  const f = fixture(t), source = join(f.vault, '08-观察', 'ordinary.md'), record = join(f.vault, '08-观察', 'record.md');
  writeFileSync(source, '---\ntitle: source\ndescription: x\n---\nquoted observation');
  writeFileSync(record, `---\ntitle: record\ndescription: x\n---\n\`\`\`brainkit-record\n${JSON.stringify({
    schema: 'brainkit-record/v1', kind: 'fact', id: recordId('fact', 'observation-source'), version: 1, confirmation: 'proposed',
    sources: [{ note_id: '08-观察/ordinary.md', source_sha256: sha(readFileSync(source)), quote: 'quoted observation', quote_sha256: sha('quoted observation'), trust: 'observation_unconfirmed' }],
    statement: '观察记录。', subject: { name: '甲' }, predicate: 'observed', object: { name: '乙' },
  })}\n\`\`\``);
  writeFileSync(join(f.vault, '00-系统', 'logs', 'brain-write-ledger.jsonl'), JSON.stringify({ status: 'ok', ts: '2026-09-22T00:00:00Z', action: 'write', record_id: recordId('fact', 'observation-source'), target_path: record }) + '\n');
  const result = memoryHealth({ paths: f, now: clock, run: () => ({ status: 0, stdout: JSON.stringify({ overall: 'PASS', dead_links: [], duplicates: [], inconsistent_group: [], intent_map_issues: [] }) }) });
  assert.equal(result.checks.records.source_sha_drift, 0);
});

import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { loadSyncState, recordSyncAttempt, validateSyncWindow } from '../scripts/lib/memory-sync-state.mjs';

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sync-state-')), vault = join(root, 'vault'), stateRoot = join(root, 'state');
  mkdirSync(vault); t.after(() => rmSync(root, { recursive: true, force: true }));
  return { vault, stateRoot };
}
const now = () => Date.parse('2026-09-22T00:00:00Z');
const attempt = (f, extra = {}) => recordSyncAttempt({ vault: f.vault, stateRoot: f.stateRoot, provider: 'gmail', window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-10T00:00:00Z', expected_revision: 0, complete: true, failed: 0, processed: 3, now, ...extra });

test('a far-future window cannot mark every real window already covered', t => {
  const day = 86400_000, at = now();
  const iso = offset => new Date(at + offset).toISOString();
  assert.throws(() => validateSyncWindow('2999-01-01T00:00:00Z', '2999-12-31T00:00:00Z', { provider: 'gmail', now }), /window_end is too far in the future for gmail/);
  assert.throws(() => validateSyncWindow(iso(0), iso(400 * day), { provider: 'google-calendar', now }), /too far in the future for google-calendar/);
  assert.deepEqual(validateSyncWindow(iso(0), iso(14 * day), { provider: 'google-calendar', now }), { start: iso(0), end: iso(14 * day) });
  const f = fixture(t);
  assert.throws(() => attempt(f, { window_start: '2999-01-01T00:00:00Z', window_end: '2999-12-31T00:00:00Z' }), /too far in the future/);
  assert.deepEqual(loadSyncState(f), { version: 1, providers: {} });
});

test('missing state is an empty checkpoint and a complete explicit first window advances only that window', t => {
  const f = fixture(t);
  assert.deepEqual(loadSyncState(f), { version: 1, providers: {} });
  const result = attempt(f);
  assert.equal(result.advanced, true);
  assert.equal(result.checkpoint.initial_from, '2026-09-01T00:00:00.000Z');
  assert.equal(result.checkpoint.completed_through, '2026-09-10T00:00:00.000Z');
  assert.equal(result.checkpoint.last_attempt.status, 'complete');
  assert.equal(lstatSync(join(f.stateRoot, 'sync.json')).mode & 0o777, 0o600);
});

test('failed, partial and gapped windows record attempts but never advance the watermark', t => {
  const f = fixture(t); attempt(f);
  const failed = attempt(f, { expected_revision: 1, failed: 1, window_end: '2026-09-20T00:00:00Z' });
  assert.equal(failed.advanced, false); assert.equal(failed.checkpoint.completed_through, '2026-09-10T00:00:00.000Z');
  const partial = attempt(f, { expected_revision: 2, complete: false, window_end: '2026-09-20T00:00:00Z' });
  assert.equal(partial.checkpoint.last_attempt.status, 'partial');
  const gap = attempt(f, { expected_revision: 3, window_start: '2026-09-12T00:00:00Z', window_end: '2026-09-20T00:00:00Z' });
  assert.equal(gap.checkpoint.last_attempt.status, 'window_gap');
  assert.equal(gap.checkpoint.completed_through, '2026-09-10T00:00:00.000Z');
});

test('CAS lets only one same-revision attempt commit', t => {
  const f = fixture(t); attempt(f);
  assert.throws(() => attempt(f, { expected_revision: 0 }), /revision conflict/);
  assert.equal(loadSyncState(f).providers.gmail.revision, 1);
});

test('overlapping backfill extends the start without losing the end; disconnected history stays a gap', t => {
  const f = fixture(t);
  attempt(f, { window_start: '2026-09-10T00:00:00Z', window_end: '2026-09-20T00:00:00Z' });
  const backfill = attempt(f, { expected_revision: 1, window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-15T00:00:00Z' });
  assert.equal(backfill.advanced, true);
  assert.equal(backfill.checkpoint.initial_from, '2026-09-01T00:00:00.000Z');
  assert.equal(backfill.checkpoint.completed_through, '2026-09-20T00:00:00.000Z');
  const gap = attempt(f, { expected_revision: 2, window_start: '2026-08-01T00:00:00Z', window_end: '2026-08-15T00:00:00Z' });
  assert.equal(gap.advanced, false);
  assert.equal(gap.checkpoint.last_attempt.status, 'window_gap');
});

test('corrupt, hardlinked and live lock files fail closed', t => {
  const f = fixture(t); mkdirSync(f.stateRoot, { recursive: true });
  writeFileSync(join(f.stateRoot, 'sync.json'), '{bad', { mode: 0o600 });
  assert.throws(() => loadSyncState(f), /corrupt/);
  rmSync(join(f.stateRoot, 'sync.json'));
  writeFileSync(join(f.stateRoot, 'other'), '{}', { mode: 0o600 }); linkSync(join(f.stateRoot, 'other'), join(f.stateRoot, 'sync.json'));
  assert.throws(() => loadSyncState(f), /unsafe/);
  rmSync(join(f.stateRoot, 'sync.json')); symlinkSync(join(f.stateRoot, 'other'), join(f.stateRoot, 'sync.json'));
  assert.throws(() => loadSyncState(f), /unsafe/);
  rmSync(join(f.stateRoot, 'sync.json')); writeFileSync(join(f.stateRoot, 'sync.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  assert.throws(() => attempt(f), /busy/);
});

test('a dead-pid lock is recovered only after its checked identity is stable', t => {
  const f = fixture(t); mkdirSync(f.stateRoot, { recursive: true });
  writeFileSync(join(f.stateRoot, 'sync.lock'), JSON.stringify({ pid: 99999999 }), { mode: 0o600 });
  assert.equal(attempt(f).checkpoint.revision, 1);
});

test('load is read-only and rejects parent links or unknown file permissions', t => {
  const f = fixture(t), linked = join(f.vault, 'linked-state');
  assert.deepEqual(loadSyncState(f), { version: 1, providers: {} });
  assert.equal(lstatSync(f.vault).isDirectory(), true);
  assert.throws(() => lstatSync(f.stateRoot));
  mkdirSync(join(f.vault, 'real-state')); symlinkSync(join(f.vault, 'real-state'), linked);
  assert.throws(() => loadSyncState({ vault: f.vault, stateRoot: linked }), /symlink/);
  assert.throws(() => loadSyncState({ vault: f.vault, stateRoot: join(linked, 'child') }), /symlink/);
  mkdirSync(f.stateRoot); writeFileSync(join(f.stateRoot, 'sync.json'), JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 }); chmodSync(join(f.stateRoot, 'sync.json'), 0o644);
  assert.throws(() => loadSyncState(f), /unsafe/);
  assert.match(readFileSync(join(f.stateRoot, 'sync.json'), 'utf8'), /providers/);
});

test('state roots reject shared-writable directories and read-only load does not repair them', t => {
  const f = fixture(t);
  mkdirSync(f.stateRoot, { mode: 0o700 }); chmodSync(f.stateRoot, 0o777);
  const before = lstatSync(f.stateRoot).mode & 0o777;
  assert.throws(() => loadSyncState(f), /state root must be current-user owned/);
  assert.equal(lstatSync(f.stateRoot).mode & 0o777, before);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { drainHarvest, sundayHealth } from '../scripts/cli/brain-sunday.mjs';

const script = new URL('../scripts/cli/brain-sunday.mjs', import.meta.url).pathname;
function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'sunday-test-'));
  mkdirSync(join(vault, '00-系统/.index-cache'), { recursive: true });
  mkdirSync(join(vault, '00-系统/logs'), { recursive: true });
  return { vault, state: join(vault, '00-系统/.index-cache/sunday-test-state.json'), env: { ...process.env, BRAIN_VAULT_ROOT: vault, BRAIN_SUNDAY_TEST_STEPS: '1' } };
}

test('Sunday run records success; stale or interrupted runs are unhealthy', () => {
  const f = fixture();
  const run = spawnSync(process.execPath, [script], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);
  const state = JSON.parse(readFileSync(f.state, 'utf8'));
  assert.equal(state.status, 'completed');
  assert.equal(sundayHealth(f.vault).healthy, false, 'test execution must never count as production success');
  writeFileSync(join(f.vault, '00-系统/.index-cache/sunday-state.json'), JSON.stringify({ ...state, test_mode: false, last_success: '2026-09-01T00:00:00Z' }));
  assert.equal(sundayHealth(f.vault, Date.parse('2026-09-12')).healthy, false);
  writeFileSync(join(f.vault, '00-系统/.index-cache/sunday-state.json'), JSON.stringify({ ...state, test_mode: false, status: 'running', pid: 2147483647 }));
  assert.equal(sundayHealth(f.vault).status, 'interrupted');
  const status = spawnSync(process.execPath, [script, '--status'], { env: f.env, encoding: 'utf8' });
  assert.equal(JSON.parse(status.stdout).healthy, false);
});

test('a stuck step is killed within its bound and leaves a failed receipt', () => {
  const f = fixture();
  const run = spawnSync(process.execPath, [script], { env: { ...f.env, BRAIN_SUNDAY_STEP_TIMEOUT_MS: '1' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /timed out/);
  assert.equal(JSON.parse(readFileSync(f.state, 'utf8')).status, 'failed');
});

test('Sunday rejects state symlinks and logs outside the vault', () => {
  const f = fixture();
  const outside = join(mkdtempSync(join(tmpdir(), 'sunday-outside-')), 'note');
  writeFileSync(outside, 'keep');
  symlinkSync(outside, join(f.vault, '00-系统/.index-cache/sunday-state.json'));
  assert.throws(() => sundayHealth(f.vault));
  const other = fixture();
  const run = spawnSync(process.execPath, [script], { env: { ...other.env, BRAIN_SUNDAY_LOG_PATH: outside }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
});

test('Sunday drains multiple pages and reports partial when the shared budget runs out', async () => {
  let clock = 0;
  let remaining = [101, 1, 0];
  const calls = [];
  const run = async step => { calls.push(step.name); clock += 10; };
  assert.deepEqual(await drainHarvest({ run, now: () => clock, budgetMs: 100,
    readScan: () => ({ remaining: remaining.shift() }) }), { complete: true, remaining: 0 });
  assert.equal(calls.filter(name => name === 'harvest cluster').length, 3);
  clock = 0;
  remaining = [101, 1, 0];
  calls.length = 0;
  assert.deepEqual(await drainHarvest({ run, now: () => clock, budgetMs: 30,
    readScan: () => ({ remaining: remaining.shift() }) }), { complete: false, remaining: 101 });
  assert.equal(calls.filter(name => name === 'harvest cluster').length, 1);
  await assert.rejects(drainHarvest({ run: async () => { throw new Error('network failed'); } }), /network failed/);
});

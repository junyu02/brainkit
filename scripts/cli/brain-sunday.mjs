#!/usr/bin/env node
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, lstatSync, writeFileSync, realpathSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';
import { assertInsideVault } from '../lib/clip-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const TEST_MODE = process.env.BRAIN_SUNDAY_TEST_STEPS === '1';
const LOG_PATH = resolve(process.env.BRAIN_SUNDAY_LOG_PATH || join(VAULT_ROOT, '00-系统', 'logs', TEST_MODE ? 'sunday-test-pipeline.log' : 'sunday-pipeline.log'));
const LOCK_PATH = resolve(process.env.BRAIN_SUNDAY_LOCK_PATH || join(VAULT_ROOT, '00-系统', '.index-cache', 'harvest.lock'));
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const STATE_PATH = join(VAULT_ROOT, '00-系统', '.index-cache', TEST_MODE ? 'sunday-test-state.json' : 'sunday-state.json');
let runState;

function safeFile(path, vault = VAULT_ROOT) {
  assertInsideVault(path, vault);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1) throw new Error(`not a single-link regular file: ${path}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function sundayHealth(vault = VAULT_ROOT, now = Date.now()) {
  const path = join(vault, '00-系统', '.index-cache', 'sunday-state.json');
  safeFile(path, vault);
  const log = join(vault, '00-系统', 'logs', 'sunday-pipeline.log');
  safeFile(log, vault);
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const successfulRuns = text.split(/===== \S+ START sunday pipeline =====/).slice(1)
    .filter(run => !run.includes('probe:') && !run.includes('FAILED sunday pipeline'))
    .map(run => run.match(/===== (\S+) END sunday pipeline exit=0 =====/)?.[1]).filter(Boolean);
  let state;
  if (existsSync(path)) state = JSON.parse(readFileSync(path, 'utf8'));
  else {
    state = { status: 'unknown' };
  }
  // Test probes and an orphan START are not evidence of a completed production run.
  state.last_success = successfulRuns.at(-1) ?? null;
  if (state.status === 'running') {
    if (!Number.isInteger(state.pid) || state.pid <= 0) throw new Error('invalid sunday state pid');
    try { process.kill(state.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') state.status = 'interrupted'; else if (error.code !== 'EPERM') throw error; }
  }
  const stale = !state.last_success || !Number.isFinite(Date.parse(state.last_success)) || now - Date.parse(state.last_success) > 8 * 86400_000;
  return { ...state, stale, healthy: !stale && ['completed', 'running'].includes(state.status) };
}

function saveState(changes) {
  runState = { ...runState, ...changes };
  safeFile(STATE_PATH);
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  safeFile(temporary);
  writeFileSync(temporary, JSON.stringify(runState) + '\n', { flag: 'wx', mode: 0o600 });
  safeFile(STATE_PATH);
  renameSync(temporary, STATE_PATH);
}

function milliseconds(name, fallback, { allowZero = true } = {}) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  return value;
}

const LOCK_WAIT_MS = milliseconds('BRAIN_SUNDAY_LOCK_WAIT_MS', 10 * 60 * 1000);
const LOCK_POLL_MS = milliseconds('BRAIN_SUNDAY_LOCK_POLL_MS', 5000, { allowZero: false });
const STEP_TIMEOUT_MS = milliseconds('BRAIN_SUNDAY_STEP_TIMEOUT_MS', 60 * 60 * 1000, { allowZero: false });
const HARVEST_BUDGET_MS = milliseconds('BRAIN_SUNDAY_HARVEST_BUDGET_MS', 60 * 60 * 1000, { allowZero: false });

function appendLog(line) {
  safeFile(LOG_PATH);
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, `${line}\n`);
}

function separator(phase, name, detail = '') {
  appendLog(`===== ${new Date().toISOString()} ${phase} ${name}${detail ? ` ${detail}` : ''} =====`);
}

function rotateLog() {
  safeFile(LOG_PATH);
  safeFile(`${LOG_PATH}.old`);
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_LOG_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.old`);
}

function activeLockPid() {
  safeFile(LOCK_PATH);
  if (!existsSync(LOCK_PATH)) return null;
  let lock;
  try { lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); }
  catch (error) { throw new Error(`cannot read harvest lock ${LOCK_PATH}: ${error.message}`); }
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error(`invalid harvest lock pid in ${LOCK_PATH}`);
  try { process.kill(lock.pid, 0); return lock.pid; }
  catch (error) {
    if (error.code === 'ESRCH') return null;
    if (error.code === 'EPERM') return lock.pid;
    throw error;
  }
}

async function waitForHarvest() {
  let pid = activeLockPid();
  if (pid === null) return;
  separator('WAIT', 'harvest lock', `pid=${pid} max_ms=${LOCK_WAIT_MS}`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(Math.min(LOCK_POLL_MS, deadline - Date.now()));
    pid = activeLockPid();
    if (pid === null) {
      separator('CLEARED', 'harvest lock');
      return;
    }
  }
  pid = activeLockPid();
  if (pid !== null) throw new Error(`harvest lock pid=${pid} remained active after ${LOCK_WAIT_MS}ms`);
}

const productionSteps = [
  { name: 'harvest resume', args: [join(HERE, 'brain-harvest.mjs'), 'auto'] },
  { name: 'harvest cluster', args: [join(HERE, 'brain-harvest.mjs'), 'cluster', '--limit', '100', '--continue-scan'] },
  { name: 'harvest auto', args: [join(HERE, 'brain-harvest.mjs'), 'auto'] },
  { name: 'weekly', args: [join(HERE, 'brain-weekly.mjs')] },
];

function steps() {
  if (process.env.BRAIN_SUNDAY_TEST_STEPS !== '1') return productionSteps;
  return productionSteps.map(step => ({
    name: step.name,
    args: ['-e', `process.stdout.write(${JSON.stringify(`probe:${step.name}\n`)})`],
  }));
}

export async function runStep(step, timeoutMs = STEP_TIMEOUT_MS) {
  separator('START', step.name);
  const logFd = openSync(LOG_PATH, 'a');
  let result;
  try {
    result = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, step.args, { cwd: HERE, detached: true, stdio: ['ignore', logFd, logFd] });
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        // Kill only the process group created for this step, including its CLI children.
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') reject(error); }
      }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (status, signal) => { clearTimeout(timer); resolveResult({ status, signal, expired }); });
    });
  } finally { closeSync(logFd); }
  const status = result.status ?? 1;
  separator('END', step.name, `exit=${status}${result.signal ? ` signal=${result.signal}` : ''}`);
  if (result.expired) throw Object.assign(new Error(`${step.name} timed out after ${timeoutMs}ms`), { code: 'STEP_TIMEOUT' });
  if (status !== 0) throw new Error(`${step.name} failed with exit ${status}${result.signal ? ` (${result.signal})` : ''}`);
}

function currentScan() {
  if (TEST_MODE) return { remaining: 0 };
  const path = join(VAULT_ROOT, '00-系统', '.index-cache', 'harvest-candidates.json');
  safeFile(path);
  const scan = JSON.parse(readFileSync(path, 'utf8')).scan;
  if (!scan || !Number.isSafeInteger(scan.remaining) || scan.remaining < 0) throw new Error('harvest scan progress is missing or invalid');
  return scan;
}

export async function drainHarvest({ run = runStep, readScan = currentScan, now = Date.now,
  budgetMs = HARVEST_BUDGET_MS, update = () => {}, harvestSteps = steps().slice(0, 3) } = {}) {
  const deadline = now() + budgetMs;
  let scan = { remaining: null };
  const execute = async step => {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    update({ step: step.name, remaining: scan.remaining });
    await run(step, Math.min(STEP_TIMEOUT_MS, remaining));
    return true;
  };
  try {
    if (!await execute(harvestSteps[0])) return { complete: false, remaining: null };
    do {
      if (!await execute(harvestSteps[1])) return { complete: false, remaining: scan.remaining };
      scan = readScan();
      if (!await execute(harvestSteps[2])) return { complete: false, remaining: scan.remaining };
      if (scan.remaining === 0) return { complete: true, remaining: 0 };
    } while (now() < deadline);
  } catch (error) {
    if (error.code !== 'STEP_TIMEOUT' || now() < deadline) throw error;
    return { complete: false, remaining: null };
  }
  return { complete: false, remaining: scan.remaining };
}

async function main() {
  if (process.argv.includes('--status')) {
    process.stdout.write(JSON.stringify(sundayHealth()) + '\n');
    return;
  }
  const previous = sundayHealth();
  if (TEST_MODE) {
    const productionVault = brainkitPaths({ env: { ...process.env, BRAIN_VAULT_ROOT: '' } }).vault;
    if (!process.env.BRAIN_VAULT_ROOT || realpathSync(VAULT_ROOT) === realpathSync(productionVault)) throw new Error('test steps require an explicit isolated BRAIN_VAULT_ROOT');
  }
  if (previous.status === 'running') throw new Error(`sunday pipeline already running pid=${previous.pid}`);
  rotateLog();
  saveState({ version: 1, test_mode: TEST_MODE, status: 'running', pid: process.pid, started_at: new Date().toISOString(), last_success: previous.last_success ?? null, step: 'wait for harvest' });
  separator('START', 'sunday pipeline');
  await waitForHarvest();
  const harvest = await drainHarvest({ update: saveState });
  const weekly = steps()[3];
  saveState({ step: weekly.name, remaining: harvest.remaining });
  await runStep(weekly);
  if (!harvest.complete) {
    separator('PARTIAL', 'sunday pipeline', `remaining=${harvest.remaining ?? 'unknown'}`);
    saveState({ status: 'partial', finished_at: new Date().toISOString(), remaining: harvest.remaining });
    return;
  }
  separator('END', 'sunday pipeline', 'exit=0');
  saveState({ status: 'completed', finished_at: new Date().toISOString(), last_success: new Date().toISOString() });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  if (runState) {
    try { saveState({ status: 'failed', finished_at: new Date().toISOString(), error: error.message }); }
    catch (stateError) { process.stderr.write(`cannot save failure: ${stateError.message}\n`); }
  }
  if (!process.argv.includes('--status')) {
    try { separator('FAILED', 'sunday pipeline', error.message); } catch {}
  }
  if (process.platform === 'darwin' && process.env.BRAIN_SUNDAY_TEST_STEPS !== '1' && !process.argv.includes('--status')) {
    spawnSync('/usr/bin/osascript', ['-e', 'display notification "自动提炼失败，请检查二脑任务状态。" with title "Brainkit"'], { timeout: 5000, stdio: 'ignore' });
  }
  process.stderr.write(`brain-sunday: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

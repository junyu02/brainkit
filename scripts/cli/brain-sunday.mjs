#!/usr/bin/env node
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const LOG_PATH = resolve(process.env.BRAIN_SUNDAY_LOG_PATH || join(VAULT_ROOT, '00-系统', 'logs', 'sunday-pipeline.log'));
const LOCK_PATH = resolve(process.env.BRAIN_SUNDAY_LOCK_PATH || join(VAULT_ROOT, '00-系统', '.index-cache', 'harvest.lock'));
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function milliseconds(name, fallback, { allowZero = true } = {}) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  return value;
}

const LOCK_WAIT_MS = milliseconds('BRAIN_SUNDAY_LOCK_WAIT_MS', 10 * 60 * 1000);
const LOCK_POLL_MS = milliseconds('BRAIN_SUNDAY_LOCK_POLL_MS', 5000, { allowZero: false });

function appendLog(line) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, `${line}\n`);
}

function separator(phase, name, detail = '') {
  appendLog(`===== ${new Date().toISOString()} ${phase} ${name}${detail ? ` ${detail}` : ''} =====`);
}

function rotateLog() {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_LOG_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.old`);
}

function activeLockPid() {
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
  { name: 'harvest cluster', args: [join(HERE, 'brain-harvest.mjs'), 'cluster'] },
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

function runStep(step) {
  separator('START', step.name);
  const logFd = openSync(LOG_PATH, 'a');
  let result;
  try {
    result = spawnSync(process.execPath, step.args, { cwd: HERE, stdio: ['ignore', logFd, logFd] });
  } finally { closeSync(logFd); }
  const status = result.status ?? 1;
  separator('END', step.name, `exit=${status}${result.signal ? ` signal=${result.signal}` : ''}`);
  if (result.error) throw new Error(`${step.name} failed to start: ${result.error.message}`);
  if (status !== 0) throw new Error(`${step.name} failed with exit ${status}${result.signal ? ` (${result.signal})` : ''}`);
}

async function main() {
  rotateLog();
  separator('START', 'sunday pipeline');
  await waitForHarvest();
  for (const step of steps()) runStep(step);
  separator('END', 'sunday pipeline', 'exit=0');
}

main().catch(error => {
  try { separator('FAILED', 'sunday pipeline', error.message); } catch {}
  process.stderr.write(`brain-sunday: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

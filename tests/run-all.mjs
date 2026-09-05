#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(HERE, '..', 'scripts', 'cli');
const tasks = [
  {
    name: 'test-brain-status',
    cwd: HERE,
    args: ['--test', './test-brain-status.mjs'],
  },
  {
    name: 'test-brain-clip',
    cwd: HERE,
    args: ['--test', './test-brain-clip.mjs'],
  },
  {
    name: 'test-observe-extract',
    cwd: HERE,
    args: ['./test-observe-extract.mjs'],
  },
  {
    name: 'test-brain-write',
    cwd: HERE,
    args: ['--test', './test-brain-write.mjs'],
  },
  {
    name: 'test-archive-aged',
    cwd: HERE,
    args: ['--test', './test-archive-aged.mjs'],
  },
  {
    name: 'test-brainkit-conf',
    cwd: HERE,
    args: ['--test', './test-brainkit-conf.mjs'],
  },
  {
    name: 'test-publish',
    cwd: HERE,
    args: ['--test', './test-publish.mjs'],
  },
  {
    name: 'test-plist-render',
    cwd: HERE,
    args: ['--test', './test-plist-render.mjs'],
  },
  {
    name: 'test-launchctl',
    cwd: HERE,
    args: ['--test', './test-launchctl.mjs'],
  },
  {
    name: 'test-install',
    cwd: HERE,
    args: ['--test', './test-install.mjs'],
  },
  {
    name: 'test-uninstall-plan',
    cwd: HERE,
    args: ['--test', './test-uninstall-plan.mjs'],
  },
  {
    name: 'harvest --self-test',
    cwd: CLI_DIR,
    args: ['./brain-harvest.mjs', '--self-test'],
  },
  {
    name: 'weekly --self-test',
    cwd: CLI_DIR,
    args: ['./brain-weekly.mjs', '--self-test'],
  },
];

let passed = 0;
for (const task of tasks) {
  process.stdout.write('\n=== RUN ' + task.name + ' ===\n');
  const result = spawnSync(process.execPath, task.args, {
    cwd: task.cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const ok = !result.error && result.status === 0;
  process.stdout.write((ok ? 'PASS ' : 'FAIL ') + task.name + '\n');
  if (ok) passed++;
}

process.stdout.write('\nSUMMARY ' + passed + '/' + tasks.length + ' PASS\n');
if (passed !== tasks.length) process.exitCode = 1;

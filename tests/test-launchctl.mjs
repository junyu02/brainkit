#!/usr/bin/env node

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRetryableLaunchctlFailure, runLaunchctl, runLaunchctlRetrying } from '../scripts/lib/launchctl.mjs';

const OK = { status: 0, stdout: '', stderr: '' };
const ERROR_5 = { status: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error\n' };
const PERMISSION = { status: 1, stdout: '', stderr: 'Bootstrap failed: 1: Operation not permitted\n' };

function recorder(results) {
  const slept = [];
  const calls = [];
  const queue = [...results];
  const run = (launchctl, argv) => {
    calls.push(argv);
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return { calls, slept, run, sleep: ms => slept.push(ms) };
}

test('retries launchctl error 5 with bounded backoff and returns the successful result', () => {
  const mock = recorder([ERROR_5, ERROR_5, OK]);
  const result = runLaunchctlRetrying({}, ['bootstrap', 'gui/501', '/tmp/x.plist'], { run: mock.run, sleep: mock.sleep });
  assert.equal(result.status, 0);
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(mock.slept, [500, 1000]);
});

test('exhausting the budget throws the last stderr after at least six seconds of backoff', () => {
  const mock = recorder([ERROR_5]);
  assert.throws(
    () => runLaunchctlRetrying({}, ['bootout', 'gui/501/com.example'], { run: mock.run, sleep: mock.sleep }),
    error => error.name === 'LaunchctlError'
      && error.status === 5
      && /Input\/output error/.test(error.message)
      && /Input\/output error/.test(error.stderr),
  );
  assert.ok(mock.slept.reduce((sum, ms) => sum + ms, 0) >= 6000, `cumulative backoff was ${mock.slept}`);
  assert.equal(mock.calls.length, mock.slept.length + 1);
});

test('permission failures and spawn errors fail on the first attempt', () => {
  const denied = recorder([PERMISSION]);
  assert.throws(
    () => runLaunchctlRetrying({}, ['bootstrap', 'gui/501', '/tmp/x.plist'], { run: denied.run, sleep: denied.sleep }),
    /Operation not permitted/,
  );
  assert.equal(denied.calls.length, 1);
  assert.deepEqual(denied.slept, []);

  const spawnFailed = recorder([{ error: new Error('spawn ENOENT'), status: null, stderr: '' }]);
  assert.throws(
    () => runLaunchctlRetrying({}, ['bootout', 'gui/501/com.example'], { run: spawnFailed.run, sleep: spawnFailed.sleep }),
    /spawn ENOENT/,
  );
  assert.equal(spawnFailed.calls.length, 1);
});

test('a handle that carries a runner is never bypassed, by either entry point', () => {
  // The command is a real executable that records every time it is run. If
  // either entry point falls through to a real spawn, the file it appends to
  // proves it -- a call count, not an argument about which default applies.
  const directory = mkdtempSync(join(tmpdir(), 'brainkit-launchctl-'));
  const witness = join(directory, 'executed.log');
  const command = join(directory, 'launchctl');
  writeFileSync(command, `#!/bin/sh\necho ran >> ${witness}\nexit 0\n`, { mode: 0o755 });
  chmodSync(command, 0o755);
  writeFileSync(witness, '');

  const seen = [];
  const handle = {
    command,
    env: {},
    run: (self, argv) => { seen.push(argv); return { status: 0, stdout: '', stderr: '' }; },
  };

  assert.equal(runLaunchctl(handle, ['print', 'gui/501/com.example']).status, 0);
  assert.equal(runLaunchctlRetrying(handle, ['bootout', 'gui/501/com.example']).status, 0);

  assert.deepEqual(seen, [['print', 'gui/501/com.example'], ['bootout', 'gui/501/com.example']]);
  assert.equal(readFileSync(witness, 'utf8'), '', 'the real command must never be executed');
});

test('a handle without a runner still spawns for real, which is what the publisher relies on', () => {
  // Not a behavioural change smuggled in: publish.mjs builds its handle as
  // { command, directory, env } in both branches and never sets `run`, so this
  // is the path it keeps taking. /usr/bin/true stands in for launchctl.
  const result = runLaunchctl({ command: '/usr/bin/true', env: {} }, []);
  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
});

test('only EIO and EBUSY class failures are retryable', () => {
  assert.equal(isRetryableLaunchctlFailure(ERROR_5), true);
  assert.equal(isRetryableLaunchctlFailure({ status: 16, stderr: '' }), true);
  assert.equal(isRetryableLaunchctlFailure({ status: 37, stderr: 'Resource busy\n' }), true);
  assert.equal(isRetryableLaunchctlFailure(PERMISSION), false);
  assert.equal(isRetryableLaunchctlFailure({ status: 2, stderr: 'No such file or directory\n' }), false);
  assert.equal(isRetryableLaunchctlFailure({ error: new Error('spawn ENOENT'), status: null }), false);
});

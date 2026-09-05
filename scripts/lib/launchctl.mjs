// launchctl.mjs -- launchctl invocation with bounded retry.
// Repo-only: shared by scripts/publish.mjs and the installer, never published to
// the vault (see REPO_ONLY_SCRIPTS in scripts/publish.mjs).

import { spawnSync } from 'node:child_process';

// bootout of a KeepAlive job returns before the process is gone; a bootstrap of
// the same label inside that window fails with EIO. Measured 2-4s on macOS 14.
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];
const MAX_ELAPSED_MS = 6000;
// launchctl exits with the underlying errno: EIO(5) while a job is still exiting,
// EBUSY(16) while the domain is momentarily locked. Permission (EPERM/EACCES),
// missing paths (ENOENT) and label mismatches must fail immediately.
const RETRYABLE_STATUS = new Set([5, 16]);
const RETRYABLE_STDERR = /input\/output error|resource busy|device busy/i;

export class LaunchctlError extends Error {
  constructor(message, { status = null, stderr = '' } = {}) {
    super(message);
    this.name = 'LaunchctlError';
    this.status = status;
    this.stderr = stderr;
  }
}

export function isRetryableLaunchctlFailure(result) {
  if (result.error) return false;
  return RETRYABLE_STATUS.has(result.status) || RETRYABLE_STDERR.test(result.stderr || '');
}

function spawnLaunchctl(launchctl, argv) {
  return spawnSync(launchctl.command, argv, { encoding: 'utf8', env: launchctl.env });
}

// The runner lives on the handle, so a caller that supplies one cannot be
// bypassed by a call site that forgets to pass it along. Both entry points read
// it; the default is still a real spawn, so a handle without `run` -- which is
// every handle the publisher builds -- behaves exactly as before.
export function runLaunchctl(launchctl, argv) {
  return (launchctl.run ?? spawnLaunchctl)(launchctl, argv);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function launchctlFailure(result, argv) {
  const detail = result.error?.message || String(result.stderr || '').trim() || `exit status ${result.status}`;
  return new LaunchctlError(detail, { status: result.status ?? null, stderr: String(result.stderr || '') });
}

export function runLaunchctlRetrying(launchctl, argv, options = {}) {
  const {
    retryOn = isRetryableLaunchctlFailure,
    maxElapsedMs = MAX_ELAPSED_MS,
    sleep = sleepSync,
  } = options;
  // Explicit option first, then the handle's own runner, then a real spawn.
  // The middle term is the point: it makes injection a property of the handle
  // rather than something every call site has to remember to forward.
  const run = options.run ?? launchctl.run ?? runLaunchctl;
  let slept = 0;
  for (let attempt = 0; ; attempt += 1) {
    const result = run(launchctl, argv);
    if (!result.error && result.status === 0) return result;
    const failure = launchctlFailure(result, argv);
    if (!retryOn(result)) throw failure;
    const delay = Math.min(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)], maxElapsedMs - slept);
    if (delay <= 0) throw failure;
    sleep(delay);
    slept += delay;
  }
}

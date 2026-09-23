#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRpcHandler, isWriteToolCall } from '../cli/brain.mjs';
import { MemoryError } from '../lib/memory-ops.mjs';
import { isMain } from '../lib/plist-render.mjs';

const MAX_BODY = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const BRAIN_CLI = join(dirname(fileURLToPath(import.meta.url)), '../cli/brain.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = (response, status, body) => {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body === undefined ? '' : JSON.stringify(body));
};
const rpcError = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } });
function bareHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  return host.replace(/:\d+$/, '');
}

function authEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.actor) || !Array.isArray(value.scopes) || !value.scopes.length || !value.scopes.every(scope => scope === 'read' || scope === 'write') || !value.scopes.includes('read') || typeof value.expires !== 'string' || !Number.isFinite(Date.parse(value.expires))) throw new Error('Invalid auth token entry.');
  return { actor: value.actor, scopes: new Set(value.scopes), expires: Date.parse(value.expires) };
}

const fileIdentity = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');

export function loadAuthConfig(path, { uid = process.getuid?.(), readFile = readFileSync, stat = fstatSync, lstat = lstatSync, open = openSync, close = closeSync } = {}) {
  const parent = lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 || (uid !== undefined && parent.uid !== uid)) throw new Error('Auth config parent must be a current-user owned, non-symlink directory not writable by group or others.');
  if (fsConstants.O_NOFOLLOW === undefined) throw new Error('Auth config requires O_NOFOLLOW support.');
  let fd;
  try {
    try { fd = open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (error) {
      if (error?.code === 'ELOOP') throw new Error('Auth config must be a current-user owned, single-link regular file with mode 0600.');
      throw error;
    }
    const before = stat(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (uid !== undefined && before.uid !== uid) || before.size > 64 * 1024) throw new Error('Auth config must be a current-user owned, single-link regular file with mode 0600.');
    const content = readFile(fd, 'utf8');
    if (fileIdentity(before) !== fileIdentity(stat(fd))) throw new Error('Auth config changed while reading.');
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error('Auth config must be valid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.tokens || typeof parsed.tokens !== 'object' || Array.isArray(parsed.tokens)) throw new Error('Auth config requires a tokens object.');
    const tokens = new Map();
    for (const [digest, entry] of Object.entries(parsed.tokens)) {
      if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error('Auth config token keys must be SHA-256 hex digests.');
      tokens.set(digest.toLowerCase(), authEntry(entry));
    }
    const allowList = (value, name) => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || !value.length || !value.every(item => typeof item === 'string' && item.length <= 255)) throw new Error(`${name} must be a nonempty array of short strings.`);
      return value;
    };
    return { tokens, allowedHosts: allowList(parsed.allowed_hosts, 'allowed_hosts'), allowedOrigins: allowList(parsed.allowed_origins, 'allowed_origins') };
  } finally {
    if (fd !== undefined) close(fd);
  }
}

function authorize(header, tokens, now) {
  const token = /^Bearer ([^\s]+)$/i.exec(String(header || ''))?.[1];
  if (!token) return null;
  const digest = hash(token), actual = Buffer.from(digest, 'utf8');
  let found = null;
  for (const [expected, entry] of tokens) {
    const candidate = Buffer.from(expected, 'utf8');
    if (candidate.length === actual.length && timingSafeEqual(candidate, actual)) found = entry;
  }
  return found && found.expires > now() ? { digest, ...found } : null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { request.destroy(); fail(Object.assign(new Error('too_large'), { code: 'too_large' })); return; }
      chunks.push(chunk);
    });
    request.once('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    request.once('aborted', () => fail(new Error('request aborted')));
    request.once('close', () => { if (!request.complete) fail(new Error('request closed')); });
    request.once('error', fail);
  });
}

function cliRuntime({ actor, allowWrites, env, execPath, spawnImpl, onStart, hardTimeoutMs, killGraceMs }) {
  return async (name, params) => new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawnImpl(execPath, [BRAIN_CLI, name, ...(allowWrites ? ['--source', actor] : [])], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: grouped });
    let stdout = '', stderr = '';
    const signal = value => {
      try { grouped ? process.kill(-child.pid, value) : child.kill(value); } catch { /* The child may already have exited. */ }
    };
    let killTimer;
    const hardTimer = setTimeout(() => { signal('SIGTERM'); killTimer = setTimeout(() => signal('SIGKILL'), killGraceMs); }, hardTimeoutMs);
    onStart?.({ abort: () => signal('SIGTERM') });
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => {
      clearTimeout(hardTimer); clearTimeout(killTimer);
      if (status === 0) {
        try { return resolve(JSON.parse(stdout)); } catch { return reject(new Error('brain CLI returned invalid JSON')); }
      }
      let detail;
      try { detail = JSON.parse(stderr); } catch { detail = null; }
      reject(new MemoryError(detail?.code || 'operation_failed', detail?.message || 'Memory operation failed.', detail?.suggestion || 'Inspect the local operation and retry only when its outcome is known.'));
    });
    // The child may exit before the payload drains; an unhandled EPIPE would kill the daemon.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(params));
  });
}

export function createHttpServer(config, { createRuntime, now = Date.now, spawnImpl = spawn } = {}) {
  if (!config || !(config.tokens instanceof Map)) throw new Error('createHttpServer requires validated token configuration.');
  const host = config.host || '127.0.0.1';
  if (!LOOPBACK.has(host)) throw new Error('HTTP MCP must bind to a loopback host.');
  const allowedHosts = new Set((config.allowedHosts || [host]).map(bareHost));
  const allowedOrigins = config.allowedOrigins ? new Set(config.allowedOrigins) : null;
  const limits = { concurrent: config.limits?.concurrent ?? 8, perClient: config.limits?.perClient ?? 2, perMinute: config.limits?.perMinute ?? 60, timeoutMs: config.limits?.timeoutMs ?? 15_000, hardTimeoutMs: config.limits?.hardTimeoutMs ?? 120_000, killGraceMs: config.limits?.killGraceMs ?? 5_000 };
  if (!Object.values(limits).every(value => Number.isInteger(value) && value > 0)) throw new Error('HTTP limits must be positive integers.');
  const clients = new Map(); let active = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405, { allow: 'POST' }); return response.end(); }
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); return response.end(); }
    if (!allowedHosts.has(bareHost(request.headers.host))) return json(response, 403, rpcError(-32001, 'Host rejected'));
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin);
        if ((allowedOrigins && !allowedOrigins.has(origin.origin)) || (!allowedOrigins && !allowedHosts.has(origin.hostname))) return json(response, 403, rpcError(-32001, 'Origin rejected'));
      } catch { return json(response, 403, rpcError(-32001, 'Origin rejected')); }
    }
    if (Number(request.headers['content-length']) > MAX_BODY) return json(response, 413, rpcError(-32000, 'Request exceeds 1 MiB'));
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(response, 415, rpcError(-32000, 'Content-Type must be application/json'));
    const auth = authorize(request.headers.authorization, config.tokens, now);
    if (!auth) return json(response, 401, rpcError(-32001, 'Unauthorized'));
    const client = clients.get(auth.digest) || { since: now(), requests: 0, active: 0 };
    if (now() - client.since >= 60_000) { client.since = now(); client.requests = 0; }
    if (active >= limits.concurrent || client.active >= limits.perClient || client.requests >= limits.perMinute) return json(response, 429, rpcError(-32002, 'Rate limit exceeded'));
    client.requests++; client.active++; clients.set(auth.digest, client); active++;
    let timer, timedOut = false, write = false, activeOperation = null;
    try {
      timer = setTimeout(() => {
        timedOut = true;
        if (!write) activeOperation?.abort?.();
        json(response, 504, rpcError(-32000, write ? 'Write outcome unknown; retry or inspect the governed writer using the same request_id.' : 'Request timed out'));
        if (!write) request.destroy();
      }, limits.timeoutMs);
      const body = await readBody(request);
      let message;
      try { message = JSON.parse(body); } catch { return json(response, 400, rpcError(-32700, 'Parse error')); }
      write = isWriteToolCall(message);
      const runtime = createRuntime || (options => cliRuntime({ ...options, env: config.env || process.env, execPath: config.execPath || process.execPath, spawnImpl, hardTimeoutMs: limits.hardTimeoutMs, killGraceMs: limits.killGraceMs, onStart: operation => { activeOperation = operation; } }));
      const handler = createRpcHandler({ actor: auth.actor, allowWrites: auth.scopes.has('write'), createRuntime: runtime, stateless: true, requireWriteRequestId: true });
      const result = await handler(message);
      if (!timedOut) json(response, result ? 200 : 202, result);
    } catch (error) {
      if (!timedOut) json(response, error.code === 'too_large' ? 413 : 400, rpcError(-32000, error.code === 'too_large' ? 'Request exceeds 1 MiB' : 'Invalid request'));
    } finally {
      clearTimeout(timer); client.active--; active--;
    }
  });
  return server;
}

async function main() {
  const args = process.argv.slice(2), take = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  const path = take('--auth-config');
  if (!path || args.some((arg, index) => arg.startsWith('--') && !['--auth-config', '--host', '--port'].includes(arg) || (['--auth-config', '--host', '--port'].includes(arg) && !args[index + 1]))) throw new Error('Usage: node brain-http.mjs --auth-config /secure/path [--host 127.0.0.1] [--port 3333]');
  const host = take('--host') || '127.0.0.1', port = Number(take('--port') || 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1..65535');
  const server = createHttpServer({ ...loadAuthConfig(path), host });
  server.listen(port, host);
}

if (isMain(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

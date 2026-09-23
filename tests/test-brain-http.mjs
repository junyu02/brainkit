import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHttpServer, loadAuthConfig } from '../scripts/daemon/brain-http.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const routing = { schema: 'vault-routing-v2', routes: [{ type: 'experience', path: '03-经验/', scope: 'global' }], inbox_root: '99-inbox/', inbox_subfolders: {}, section_policies: { '03-经验/': { policy: 'deny_new_subfolder', requires_subfolder: true, allowed_subfolders: ['AI工具'], new_subfolder_policy: 'deny' } } };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'brain-http-')), vault = join(root, 'vault'), memory = join(root, 'memory'), routingPath = join(root, 'routing.json'), authPath = join(root, 'auth.json');
  for (const path of [join(vault, '00-系统', '.index-cache'), join(vault, '00-系统', 'logs'), join(vault, '03-经验', 'AI工具'), join(vault, '99-inbox'), memory]) mkdirSync(path, { recursive: true });
  writeFileSync(join(vault, '03-经验', 'AI工具', '网络笔记.md'), '---\ntitle: 网络笔记\ndescription: HTTP fixture\n---\n仅用于 HTTP 检索。\n');
  writeFileSync(routingPath, JSON.stringify(routing));
  for (const name of ['MEMORY.md', 'MEMORY-experience.md', 'MEMORY-knowledge.md', 'MEMORY-project.md', 'MEMORY-persona.md', 'MEMORY-archive.md', 'MEMORY-notes.md']) writeFileSync(join(memory, name), '# index\n');
  const tokens = { reader: 'reader-secret', readerTwo: 'reader-two-secret', writer: 'writer-secret', expired: 'expired-secret' };
  writeFileSync(authPath, JSON.stringify({ tokens: {
    [digest(tokens.reader)]: { actor: 'http-reader', scopes: ['read'], expires: '2026-12-31T00:00:00Z' },
    [digest(tokens.readerTwo)]: { actor: 'http-reader-two', scopes: ['read'], expires: '2026-12-31T00:00:00Z' },
    [digest(tokens.writer)]: { actor: 'http-writer', scopes: ['read', 'write'], expires: '2026-12-31T00:00:00Z' },
    [digest(tokens.expired)]: { actor: 'expired', scopes: ['read'], expires: '2000-01-01T00:00:00Z' },
  } }), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { vault, memory, routing: routingPath, authPath, tokens };
}

async function start(t, f, { createRuntime, limits, spawnImpl } = {}) {
  const auth = loadAuthConfig(f.authPath);
  const server = createHttpServer({ ...auth, host: '127.0.0.1', limits, env: { ...process.env, BRAIN_VAULT_ROOT: f.vault, BRAIN_MEMORY_DIR: f.memory, BRAIN_ROUTING_JSON: f.routing } }, { createRuntime, spawnImpl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function post(url, token, message, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(message) });
}
const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });

test('HTTP MCP rejects absent, wrong, expired tokens and cross-origin requests', async t => {
  const f = fixture(t), { url } = await start(t, f);
  for (const token of [undefined, 'wrong', f.tokens.expired]) assert.equal((await post(url, token, rpc(1, 'initialize'))).status, 401);
  assert.equal((await post(url, f.tokens.reader, rpc(1, 'initialize'), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(url)).status, 405);
});

test('read tokens remain read-only while independently authenticated clients can initialize and recall', async t => {
  const f = fixture(t), { url } = await start(t, f);
  const initialized = await post(url, f.tokens.reader, rpc(1, 'initialize', { clientInfo: { name: 'pretend-writer' } }));
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, 'brainkit');
  const tools = await post(url, f.tokens.reader, rpc(2, 'tools/list'));
  assert.equal((await tools.json()).result.tools.some(tool => tool.name === 'remember'), false);
  const rejected = await post(url, f.tokens.reader, rpc(3, 'tools/call', { name: 'remember', arguments: {} }));
  assert.match((await rejected.json()).result.content[0].text, /unknown_operation/);
  const [first, second] = await Promise.all([post(url, f.tokens.reader, rpc(4, 'tools/call', { name: 'recall', arguments: { query: 'HTTP 检索', semantic: false } })), post(url, f.tokens.readerTwo, rpc(5, 'tools/call', { name: 'recall', arguments: { query: '网络笔记', semantic: false } }))]);
  for (const response of [first, second]) assert.equal((await response.json()).result.isError, undefined);
});

test('real writer replays across HTTP servers and rejects request-id payload conflicts', async t => {
  const f = fixture(t), firstServer = await start(t, f), url = firstServer.url;
  const missingId = await post(url, f.tokens.writer, rpc(1, 'tools/call', { name: 'remember', arguments: { title: 'HTTP 写入', description: '受管写入', fact: 'HTTP writer fixture', type: 'experience', subfolder: 'AI工具', provenance: 'http test' } }));
  assert.match((await missingId.json()).result.content[0].text, /request_id/);
  const request_id = '26d9c24d-ae71-4e5c-b644-5a3eb6a0804e';
  const arguments_ = { title: 'HTTP 写入', description: '受管写入', fact: 'HTTP writer fixture', type: 'experience', subfolder: 'AI工具', provenance: 'http test', request_id };
  const created = await post(url, f.tokens.writer, rpc(2, 'tools/call', { name: 'remember', arguments: arguments_ }));
  const first = JSON.parse((await created.json()).result.content[0].text);
  assert.equal(first.receipt.source, 'http-writer');
  const replayed = await post(url, f.tokens.writer, rpc(3, 'tools/call', { name: 'remember', arguments: arguments_ }));
  assert.equal(JSON.parse((await replayed.json()).result.content[0].text).status, 'committed');
  const conflict = await post(url, f.tokens.writer, rpc(4, 'tools/call', { name: 'remember', arguments: { ...arguments_, fact: 'different payload' } }));
  assert.match((await conflict.json()).result.content[0].text, /idempotency_conflict/);
  await new Promise(resolve => firstServer.server.close(resolve));
  const urlAfterRestart = (await start(t, f)).url;
  const replayAfterRestart = await post(urlAfterRestart, f.tokens.writer, rpc(5, 'tools/call', { name: 'remember', arguments: arguments_ }));
  assert.equal(JSON.parse((await replayAfterRestart.json()).result.content[0].text).status, 'committed');
  const recalled = await post(urlAfterRestart, f.tokens.reader, rpc(6, 'tools/call', { name: 'recall', arguments: { query: 'writer fixture', semantic: false } }));
  assert.equal(JSON.parse((await recalled.json()).result.content[0].text).items.filter(item => item.id.includes('HTTP 写入')).length, 1);
});

test('a slow remote write reports an unknown outcome and the same request id does not duplicate it', async t => {
  const f = fixture(t), committed = new Map(); let writes = 0;
  const createRuntime = ({ actor }) => async (name, params) => {
    if (name !== 'remember') return { protocol: 'brainkit/v1' };
    if (committed.has(params.request_id)) return committed.get(params.request_id);
    await new Promise(resolve => setTimeout(resolve, 40));
    writes++;
    const result = { protocol: 'brainkit/v1', status: 'committed', granularity: 'note', receipt: { status: 'ok', source: actor, request_id: params.request_id } };
    committed.set(params.request_id, result);
    return result;
  };
  const { url } = await start(t, f, { createRuntime, limits: { timeoutMs: 10, concurrent: 8, perClient: 2, perMinute: 60 } });
  const request_id = '26d9c24d-ae71-4e5c-b644-5a3eb6a0804f';
  const request = rpc(1, 'tools/call', { name: 'remember', arguments: { title: 'slow', type: 'experience', provenance: 'test', request_id } });
  const timedOut = await post(url, f.tokens.writer, request);
  assert.equal(timedOut.status, 504);
  assert.match((await timedOut.json()).error.message, /outcome unknown.*same request_id/i);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(writes, 1);
  const retry = await post(url, f.tokens.writer, request);
  assert.equal(JSON.parse((await retry.json()).result.content[0].text).receipt.request_id, request_id);
  assert.equal(writes, 1);
});

test('deadline interrupts a real blocking child for reads but lets an already-started write finish', async t => {
  const f = fixture(t), marker = join(f.vault, 'write-finished');
  const spawnImpl = (_command, args, options) => {
    const write = args.includes('remember');
    const result = JSON.stringify({ protocol: 'brainkit/v1', status: 'committed', granularity: 'note', receipt: { status: 'ok', source: 'http-writer' } });
    const script = `setTimeout(() => { ${write ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done');` : ''} process.stdout.write(${JSON.stringify(result)}); }, 80);`;
    return spawn(process.execPath, ['-e', script], options);
  };
  const { url } = await start(t, f, { spawnImpl, limits: { timeoutMs: 15, concurrent: 8, perClient: 2, perMinute: 60 } });
  const began = Date.now();
  const read = await post(url, f.tokens.reader, rpc(1, 'tools/call', { name: 'recall', arguments: { query: 'slow', semantic: false } }));
  assert.equal(read.status, 504);
  assert.ok(Date.now() - began < 500, 'read deadline must not wait for the child');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(existsSync(marker), false, 'timed-out reads terminate their child');
  const write = await post(url, f.tokens.writer, rpc(2, 'tools/call', { name: 'remember', arguments: { title: 'slow', type: 'experience', provenance: 'test', request_id: '26d9c24d-ae71-4e5c-b644-5a3eb6a0804f' } }));
  assert.equal(write.status, 504);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(existsSync(marker), true, 'timed-out writes keep running for an idempotent retry');
});

test('a partial body times out before dispatch and releases its per-client slot', async t => {
  const f = fixture(t);
  const createRuntime = () => async () => ({ protocol: 'brainkit/v1', items: [] });
  const { url } = await start(t, f, { createRuntime, limits: { timeoutMs: 15, concurrent: 8, perClient: 1, perMinute: 60 } });
  const slow = new Promise(resolve => {
    const request = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${f.tokens.reader}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.once('error', () => resolve('closed'));
    request.write('{"jsonrpc":"2.0"');
  });
  await new Promise(resolve => setTimeout(resolve, 60));
  const fast = await post(url, f.tokens.reader, rpc(2, 'tools/call', { name: 'recall', arguments: { query: 'HTTP 检索', semantic: false } }));
  assert.equal(fast.status, 200);
  await slow;
});

test('hard execution ceiling terminates a blocking write child and releases its slot', async t => {
  const f = fixture(t), marker = join(f.vault, 'hard-ceiling-finished');
  const spawnImpl = (_command, _args, options) => spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500); setInterval(() => {}, 1000);`], options);
  const limits = { timeoutMs: 15, hardTimeoutMs: 50, killGraceMs: 10, concurrent: 8, perClient: 1, perMinute: 60 };
  const { url } = await start(t, f, { spawnImpl, limits });
  const write = await post(url, f.tokens.writer, rpc(1, 'tools/call', { name: 'remember', arguments: { title: 'hard', type: 'experience', provenance: 'test', request_id: '36d9c24d-ae71-4e5c-b644-5a3eb6a0804f' } }));
  assert.equal(write.status, 504);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(existsSync(marker), false);
  const next = await post(url, f.tokens.writer, rpc(2, 'tools/call', { name: 'remember', arguments: { title: 'hard-two', type: 'experience', provenance: 'test', request_id: '46d9c24d-ae71-4e5c-b644-5a3eb6a0804f' } }));
  assert.notEqual(next.status, 429, 'hard ceiling must release the per-client slot');
});

test('a payload larger than the stdin pipe buffer never kills the daemon when the child ignores stdin', async t => {
  // capabilities is a real child that exits without draining stdin, so the parent write ends in EPIPE.
  const f = fixture(t), { url } = await start(t, f);
  const flooded = await post(url, f.tokens.reader, rpc(1, 'tools/call', { name: 'capabilities', arguments: { padding: 'y'.repeat(300_000) } }));
  assert.equal(flooded.status, 200);
  const next = await post(url, f.tokens.reader, rpc(2, 'tools/call', { name: 'capabilities', arguments: {} }));
  assert.equal(next.status, 200);
});

test('HTTP MCP bounds bodies and rejects unsafe config files', async t => {
  const f = fixture(t), { url } = await start(t, f);
  const oversized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${f.tokens.reader}`, 'content-length': String(1024 * 1024 + 1) }, body: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  writeFileSync(f.authPath, '{}', { mode: 0o644 });
  chmodSync(f.authPath, 0o644);
  assert.throws(() => loadAuthConfig(f.authPath), /0600/);
  const link = `${f.authPath}.link`;
  symlinkSync(f.authPath, link);
  assert.throws(() => loadAuthConfig(link), /single-link regular file/);
});

test('auth config rejects a pathname replacement during descriptor read', t => {
  const f = fixture(t), replacement = join(f.vault, 'replacement-auth.json'), parked = `${f.authPath}.original`;
  const replacementToken = 'replacement-secret';
  writeFileSync(replacement, JSON.stringify({ tokens: { [digest(replacementToken)]: { actor: 'replacement', scopes: ['read'], expires: '2026-12-31T00:00:00Z' } } }), { mode: 0o600 });
  assert.throws(() => loadAuthConfig(f.authPath, {
    readFile: fd => {
      renameSync(f.authPath, parked);
      symlinkSync(replacement, f.authPath);
      return readFileSync(fd, 'utf8');
    },
  }), /changed while reading/);
});

test('auth config rejects content changed after descriptor validation', t => {
  const f = fixture(t);
  assert.throws(() => loadAuthConfig(f.authPath, {
    readFile: fd => {
      writeFileSync(f.authPath, '{"tokens":{}}');
      return readFileSync(fd, 'utf8');
    },
  }), /changed while reading/);
});

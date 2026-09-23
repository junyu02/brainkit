import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRpcHandler } from '../scripts/cli/brain.mjs';

const BRAIN = new URL('../scripts/cli/brain.mjs', import.meta.url).pathname;
const routingFixture = {
  schema: 'vault-routing-v2',
  routes: [
    { type: 'experience', path: '03-经验/', scope: 'global' },
    { type: 'reference', path: '02-知识/', scope: 'global' },
    { type: 'project', path: '01-项目/{project-name}/', scope: 'project' },
    { type: 'user-profile', path: '05-persona/', scope: 'global' },
    { type: 'note', path: '07-随笔/', scope: 'global' },
    { type: 'weekly', path: '09-周报/', scope: 'global' },
  ],
  inbox_root: '99-inbox/', inbox_subfolders: {},
  section_policies: {
    '01-项目/': { policy: 'bind_to_project', requires_subfolder: true, subfolder_source: '00-系统/.project-map.json' },
    '02-知识/': { policy: 'propose', requires_subfolder: true, allow_existing_subfolders: true, new_subfolder_policy: 'propose' },
    '03-经验/': { policy: 'deny_new_subfolder', requires_subfolder: true, allowed_subfolders: ['AI工具'], new_subfolder_policy: 'deny' },
    '05-persona/': { policy: 'allow_root', requires_subfolder: false },
    '07-随笔/': { policy: 'allow_root', requires_subfolder: false },
    '09-周报/': { policy: 'allow_root', requires_subfolder: false },
  },
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-mcp-'));
  const vault = join(root, 'vault'), memory = join(root, 'memory'), routing = join(root, 'routing.json');
  for (const path of [
    join(vault, '00-系统', '.index-cache'), join(vault, '00-系统', 'logs'),
    join(vault, '01-项目', 'test-project'), join(vault, '02-知识', '研究'), join(vault, '03-经验', 'AI工具'),
    join(vault, '05-persona'), join(vault, '07-随笔'), join(vault, '09-周报'), join(vault, '99-inbox'), memory,
  ]) mkdirSync(path, { recursive: true });
  writeFileSync(join(vault, '00-系统', '.project-map.json'), JSON.stringify({ mappings: [{ localPath: join(root, 'project'), vaultDir: '01-项目/test-project' }] }));
  writeFileSync(routing, JSON.stringify(routingFixture));
  for (const name of ['MEMORY.md', 'MEMORY-experience.md', 'MEMORY-knowledge.md', 'MEMORY-project.md', 'MEMORY-persona.md', 'MEMORY-archive.md', 'MEMORY-notes.md']) writeFileSync(join(memory, name), '# index\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { vault, memory, routing };
}

function serve(f, args, frames) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRAIN, 'serve', ...args], {
      env: { ...process.env, BRAIN_VAULT_ROOT: f.vault, BRAIN_MEMORY_DIR: f.memory, BRAIN_ROUTING_JSON: f.routing },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
  });
}

function replies(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function callReply(frames, id) {
  const reply = frames.find(frame => frame.id === id);
  assert.ok(reply, `missing JSON-RPC response ${id}`);
  assert.equal(reply.result?.isError, undefined, reply.result?.content?.[0]?.text);
  return JSON.parse(reply.result.content[0].text);
}

function failedCall(frames, id) {
  const reply = frames.find(frame => frame.id === id);
  assert.ok(reply, `missing JSON-RPC response ${id}`);
  assert.equal(reply.result?.isError, true);
  return JSON.parse(reply.result.content[0].text);
}

test('stdio MCP serves framed JSON without stdout pollution and keeps writes disabled by default', async t => {
  const f = fixture(t);
  const result = await serve(f, [], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall', arguments: { query: '测试', semantic: false, extra: true } } },
    { jsonrpc: '2.0', id: 4, method: 'unknown/method', params: {} },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'remember', arguments: {} } },
  ]);
  const frames = replies(result);
  assert.equal(frames.length, 5);
  assert.equal(frames[0].result.serverInfo.name, 'brainkit');
  assert.ok(!frames[1].result.tools.some(tool => tool.name === 'remember'));
  assert.equal(frames[2].result.isError, true);
  assert.equal(frames[3].error.code, -32601);
  assert.equal(frames[4].result.isError, true);
  assert.match(frames[4].result.content[0].text, /unknown_operation/);
});

test('stdio MCP exposes write tools only with --allow-writes', async t => {
  const f = fixture(t);
  const result = await serve(f, ['--allow-writes'], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const frames = replies(result);
  assert.ok(frames[1].result.tools.some(tool => tool.name === 'remember'));
});

test('stdio MCP persists a governed lifecycle across cold processes and maps known clients', async t => {
  const f = fixture(t);
  const first = replies(await serve(f, ['--allow-writes'], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: { title: 'MCP 生命周期', description: '临时服务写入', fact: '旧生命周期结论。', type: 'experience', subfolder: 'AI工具', provenance: 'stdio lifecycle fixture' } } },
  ]));
  const remembered = callReply(first, 2);
  assert.equal(remembered.receipt.source, 'codex');

  const second = replies(await serve(f, ['--allow-writes'], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: '旧生命周期结论', semantic: false } } },
  ]));
  const original = callReply(second, 2).items[0];
  assert.ok(original, 'a fresh process must recall the prior governed write');

  const third = replies(await serve(f, ['--allow-writes'], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'revise', arguments: { id: original.id, expected_sha256: '0'.repeat(64), reason: 'stale fixture', body: '不应写入' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'revise', arguments: { id: original.id, expected_sha256: original.source_sha256, reason: '更新结论', body: '新生命周期结论。' } } },
  ]));
  assert.equal(failedCall(third, 2).code, 'conflict');
  const revised = callReply(third, 3);
  assert.equal(revised.receipt.actor, 'claude');

  const fourth = replies(await serve(f, ['--allow-writes'], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-ai' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: '旧生命周期结论', semantic: false } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall', arguments: { query: '新生命周期结论', semantic: false } } },
  ]));
  assert.ok(callReply(fourth, 2).items.every(item => !item.excerpt.includes('旧生命周期结论。')));
  const current = callReply(fourth, 3).items[0];
  assert.ok(current, 'claude-ai must map to the writable claude actor');

  const fifth = replies(await serve(f, ['--allow-writes'], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-ai' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'forget', arguments: { id: current.id, expected_sha256: current.source_sha256, reason: 'temporary lifecycle withdrawal' } } },
  ]));
  const forgotten = callReply(fifth, 2);
  assert.equal(forgotten.receipt.actor, 'claude');

  const sixth = replies(await serve(f, ['--allow-writes'], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: '新生命周期结论', semantic: false } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'restore', arguments: { operation_id: forgotten.receipt.operation_id, reason: 'restore lifecycle fixture' } } },
  ]));
  assert.equal(callReply(sixth, 2).items.length, 0);
  const restored = callReply(sixth, 3);
  assert.equal(restored.receipt.actor, 'codex');

  const seventh = replies(await serve(f, [], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: '新生命周期结论', semantic: false } } },
  ]));
  const restoredNote = callReply(seventh, 2).items[0];
  assert.ok(restoredNote);
  assert.match(readFileSync(join(f.vault, restoredNote.id), 'utf8'), /新生命周期结论。/);
  const ledger = readFileSync(join(f.vault, '00-系统', 'logs', 'brain-write-ledger.jsonl'), 'utf8');
  for (const [action, actor] of [['write', 'codex'], ['revise', 'claude'], ['deactivate', 'claude'], ['restore', 'codex']]) assert.match(ledger, new RegExp(`"action":"${action}"[\\s\\S]*?"actor":"${actor}"`));
});

test('unknown client remains read-only even when the server receives --allow-writes', async t => {
  const f = fixture(t);
  const frames = replies(await serve(f, ['--allow-writes'], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'unrecognized-client' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: {} } },
  ]));
  assert.ok(!frames[1].result.tools.some(tool => tool.name === 'remember'));
  assert.equal(failedCall(frames, 3).code, 'unknown_operation');
});

test('MCP errors obey the byte ceiling even with escaped or multibyte unknown keys', async t => {
  const f = fixture(t);
  for (const key of ['界'.repeat(3000), '\u0001'.repeat(3000)]) {
    const result = await serve(f, [], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: '测试', [key]: true } } },
    ]);
    const reply = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(reply.result.isError, true);
    assert.ok(Buffer.byteLength(reply.result.content[0].text) <= 2000);
  }
});

test('MCP rejects non-object argument values before normalization', async t => {
  const f = fixture(t);
  const result = await serve(f, [], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } },
    ...[1, [], null].map((value, index) => ({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name: 'capabilities', arguments: value } })),
  ]);
  for (const reply of result.stdout.trim().split('\n').map(JSON.parse).slice(1)) assert.equal(reply.result.isError, true);
});

test('large connector write receipts stay bounded without hiding failure counts', async () => {
  const results = Array.from({ length: 20 }, (_, index) => ({ event_id: 'evt_' + String(index).padStart(24, '0'), status: 'failed', reason: '来源尚未确认。'.repeat(40) }));
  const handler = createRpcHandler({ stateless: true, actor: 'codex', allowWrites: true, createRuntime: () => async () => ({ protocol: 'brainkit/v1', provider: 'gmail', results, failed: 20, succeeded: 0, skipped: 0, batch_complete: false, watermark_advanced: false }) });
  const response = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ingest_events', arguments: { provider: 'gmail', events: [], window_start: '2026-09-01T00:00:00Z', window_end: '2026-09-02T00:00:00Z', expected_revision: 0, complete_window: false } } });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.failed, 20);
  assert.equal(payload.watermark_advanced, false);
  assert.ok(payload.results_omitted > 0);
  assert.ok(Buffer.byteLength(response.result.content[0].text) <= 2000);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callLlm, firstLayer, judgeAutoCandidate } from '../scripts/cli/brain-harvest.mjs';
import { callLlm as callWeeklyLlm } from '../scripts/cli/brain-weekly.mjs';
import { callLlm as callObserveLlm } from '../scripts/cli/observe.mjs';
import { extractWithRetry } from '../scripts/cli/observe.mjs';
import { observationEligible, parseObservationMarkdown } from '../scripts/cli/harvest-lib.mjs';

test('observe retains reduced retry after length-truncated provider output', async () => {
  const previous = globalThis.fetch, requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => requests.length === 1
      ? { choices: [{ finish_reason: 'length', message: { content: '' } }] }
      : { choices: [{ finish_reason: 'stop', message: { content: '{"observations":[]}' } }] } };
  };
  try {
    assert.deepEqual(await extractWithRetry({ source: 'codex', text: 'fixture' }, { OPENAI_BASE_URL: 'http://fixture', OPENAI_API_KEY: 'fixture', OBSERVE_MODEL: 'fixture' }), []);
    assert.match(requests[1].messages[0].content, /at most 4 observations/);
  } finally { globalThis.fetch = previous; }
});
import { requestJson } from '../scripts/lib/llm-json.mjs';

const HARVEST = new URL('../scripts/cli/brain-harvest.mjs', import.meta.url).pathname;

test('harvest and weekly still execute when invoked through a symbolic link', t => {
  const root = mkdtempSync(join(tmpdir(), 'memory-cli-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['brain-harvest.mjs', 'brain-weekly.mjs']) {
    const link = join(root, name);
    symlinkSync(new URL(`../scripts/cli/${name}`, import.meta.url).pathname, link);
    const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/, `${name} silently skipped its entry point`);
  }
});

for (const [name, run, maxTokens] of [
  ['weekly', env => callWeeklyLlm(env, []), 16384],
  ['observe', env => callObserveLlm({ source: 'codex', text: 'fixture' }, env), 8192],
]) {
  test(`${name} uses the same request deadline and DeepSeek reasoning bound as harvest`, async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (_url, options) => {
      request = options;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"observations":[]}' } }] }) };
    };
    try {
      await run({ OPENAI_BASE_URL: 'http://fixture', OPENAI_API_KEY: 'fixture', OBSERVE_MODEL: 'deepseek-flash' });
      assert.ok(request.signal instanceof AbortSignal, 'request must carry an abort deadline');
      const body = JSON.parse(request.body);
      assert.equal(body.reasoning_effort, 'low');
      assert.equal(body.max_tokens, maxTokens);
    } finally { globalThis.fetch = originalFetch; }
  });
}

function runHarvest(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARVEST, ...args], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('DeepSeek structured jobs request bounded reasoning without changing other providers', async () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'fixture']) {
    let request;
    await callLlm({ OPENAI_BASE_URL: 'http://fixture', OPENAI_API_KEY: 'fixture' }, [], model, {
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
      },
    });
    assert.equal(request.reasoning_effort, model === 'fixture' ? undefined : 'low');
    assert.equal(request.model, model);
    assert.equal(request.max_tokens, 16384);
  }
});

test('an unresponsive LLM request is aborted within the configured bound', async () => {
  const started = Date.now();
  await assert.rejects(callLlm({ OBSERVE_MODEL: 'fixture', OPENAI_BASE_URL: 'http://fixture', OPENAI_API_KEY: 'fixture' }, [], undefined, {
    timeoutMs: 30, retryDelays: [],
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('deadline did not abort')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }),
  }), /timeout/i);
  assert.ok(Date.now() - started < 800);
});

test('shared LLM transport returns usage and redacts HTTP response bodies', async () => {
  const env = { OPENAI_BASE_URL: 'http://fixture', OPENAI_API_KEY: 'fixture', OBSERVE_MODEL: 'fixture' };
  const result = await requestJson(env, [], {
    fetchImpl: async () => ({ ok: true, json: async () => ({ model: 'served-model', usage: { input_tokens: 3, output_tokens: 5 }, choices: [{ message: { content: '{"ok":true}' } }] }) }),
  });
  assert.deepEqual(result, { data: { ok: true }, usage: { input_tokens: 3, output_tokens: 5 }, model: 'served-model' });
  await assert.rejects(requestJson(env, [], {
    retryDelays: [],
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret response body' }),
  }), error => error.httpStatus === 401 && error.message === 'LLM HTTP 401' && !error.message.includes('secret'));
});

test('completed first-layer batches survive a later network failure and are reused', async () => {
  const batches = ['a', 'b'].map(name => [{ path: `08-观察/${name}.md`, title: name, description: name, created: '2026-09-12', excerpt: name }]);
  const payload = { clusters: [{ members: [1], fact_title: '保留原始编码', fact_body: '后台必须固定 UTF-8。', memory_type: 'experience', subfolder: 'AI工具', value_score: 5, rationale: '避免损坏' }] };
  const progress = {};
  let requests = 0;
  const options = { projects: [], knowledge_subfolders: [] };
  const checkpoint = { decided: {}, rejected_facts: [] };
  await assert.rejects(firstLayer({}, batches, options, checkpoint, {
    completed: progress,
    onBatch: (key, response) => { progress[key] = response; },
    request: async (_env, _messages, validate) => { if (++requests === 2) throw new TypeError('fetch failed'); return validate(payload); },
  }), /fetch failed/);
  assert.equal(Object.keys(progress).length, 1);
  requests = 0;
  const resumed = await firstLayer({}, batches, options, checkpoint, {
    completed: progress,
    request: async (_env, _messages, validate) => { requests++; return validate(payload); },
  });
  assert.equal(requests, 1);
  assert.equal(resumed.candidates.length, 2);
  assert.equal(resumed.errors.length, 0);
  requests = 0;
  await firstLayer({}, [[{ ...batches[0][0], excerpt: '原始证据发生变化' }]], options, checkpoint, {
    completed: progress,
    request: async (_env, _messages, validate) => { requests++; return validate(payload); },
  });
  assert.equal(requests, 1, 'changed evidence must invalidate cached model output');
});

test('passive Chronicle evidence cannot be silently promoted into confirmed facts', async () => {
  let called = false;
  const result = await judgeAutoCandidate({ fact_title: '界面观察', fact_body: '看到一个按钮', ui_type: 'knowledge', evidence: [{ path: '08-观察/chronicle-2026-09/a.md' }] }, () => { called = true; return { decision: 'promote' }; });
  assert.equal(result.decision, 'skip');
  assert.equal(called, false);
});

test('top-level structured candidates, records, and connector events stay out of legacy harvest promotion', () => {
  const frontmatter = '---\nname: Structured fixture\ndescription: fixture\ncreated: 2026-09-22\ntags:\n  - durable-candidate\n---\n';
  for (const language of ['brainkit-candidate', 'brainkit-record', 'brainkit-event']) {
    const item = parseObservationMarkdown(`${frontmatter}\`\`\`${language}\n{}\n\`\`\`\n`, `08-观察/${language}.md`);
    assert.equal(item.structured_kind, language);
    assert.equal(observationEligible(item), false);
  }
  const nested = parseObservationMarkdown(`${frontmatter}\`\`\`md\n\`\`\`brainkit-event\n{}\n\`\`\`\n\`\`\`\n`, '08-观察/example.md');
  assert.equal(nested.structured_kind, null);
  assert.equal(observationEligible(nested), true);
  assert.throws(() => parseObservationMarkdown(`${frontmatter}\`\`\`brainkit-event\n{bad}\n\`\`\`\n`, '08-观察/bad.md'), /invalid structured brainkit-event/);
});

test('continued CLI scan advances past 100 empty clusters and only commits successful windows', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harvest-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, 'vault');
  const observations = join(vault, '08-观察');
  const cache = join(vault, '00-系统/.index-cache');
  mkdirSync(observations, { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(join(vault, '02-知识'));
  writeFileSync(join(vault, '00-系统/.project-map.json'), '{"mappings":[]}\n');
  for (let index = 0; index < 101; index += 1) {
    const name = `a${String(index).padStart(3, '0')}.md`;
    writeFileSync(join(observations, name), `---\nname: Observation ${index}\ndescription: fixture\ncreated: '2026-09-12'\ntags:\n  - durable-candidate\n---\nfixture\n`);
  }
  let failNext = false;
  let invalidResponses = 0;
  const queuedContents = [];
  const receivedMessages = [];
  const invalidSubfolder = JSON.stringify({ clusters: [{ members: [1], fact_title: '分类测试', fact_body: '候选经验正文', memory_type: 'experience', subfolder: '不存在的分类', value_score: 5, rationale: '回归测试' }] });
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', chunk => { body += chunk; });
    request.on('end', () => {
      receivedMessages.push(JSON.parse(body).messages);
      const content = queuedContents.length ? queuedContents.shift() : invalidResponses ? '{"clusters":"invalid"}' : '{"clusters":[]}';
      response.writeHead(failNext ? 500 : 200, { 'content-type': 'application/json' });
      response.end(failNext ? 'fixture failure' : JSON.stringify({ choices: [{ message: { content } }] }));
      failNext = false;
      if (invalidResponses) invalidResponses -= 1;
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const envFile = join(root, 'observe.env');
  writeFileSync(envFile, `OPENAI_API_KEY=fixture\nOPENAI_BASE_URL=http://127.0.0.1:${server.address().port}\nOBSERVE_MODEL=fixture\n`, { mode: 0o600 });
  const env = { ...process.env, NODE_ENV: 'test', BRAIN_VAULT_ROOT: vault, BRAIN_OBSERVE_ENV_PATH: envFile };
  const documentPath = join(cache, 'harvest-candidates.json');
  const progressPath = join(cache, 'harvest-progress.json');
  const dry = await runHarvest(['cluster', '--limit', '100', '--continue-scan', '--dry-run'], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(existsSync(documentPath), false);
  assert.equal(existsSync(progressPath), false);
  const first = await runHarvest(['cluster', '--limit', '100', '--continue-scan'], env);
  assert.equal(first.code, 0, first.stderr);
  const firstScan = JSON.parse(readFileSync(documentPath, 'utf8')).scan;
  assert.deepEqual({ after: firstScan.after, processed: firstScan.processed, remaining: firstScan.remaining, eligible_total: firstScan.eligible_total },
    { after: '08-观察/a099.md', processed: 100, remaining: 1, eligible_total: 101 });
  assert.equal(JSON.parse(readFileSync(documentPath, 'utf8')).candidates.length, 0);
  const auto = await runHarvest(['auto'], env);
  assert.equal(auto.code, 0, auto.stderr);
  assert.deepEqual(JSON.parse(readFileSync(documentPath, 'utf8')).scan, firstScan);
  failNext = true;
  const failed = await runHarvest(['cluster', '--limit', '100', '--continue-scan'], env);
  assert.notEqual(failed.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(documentPath, 'utf8')).scan, firstScan);
  invalidResponses = 2;
  const invalid = await runHarvest(['cluster', '--limit', '100', '--continue-scan'], env);
  assert.notEqual(invalid.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(documentPath, 'utf8')).scan, firstScan);
  queuedContents.push(invalidSubfolder, invalidSubfolder);
  const beforeInvalid = receivedMessages.length;
  const invalidCategory = await runHarvest(['cluster', '--limit', '100', '--continue-scan'], env);
  assert.notEqual(invalidCategory.code, 0);
  assert.equal(receivedMessages.length - beforeInvalid, 2, 'invalid category should receive one corrective retry');
  assert.match(JSON.parse(invalidCategory.stdout).batch_errors[0].message, /invalid experience subfolder/);
  assert.deepEqual(JSON.parse(readFileSync(documentPath, 'utf8')).scan, firstScan);
  queuedContents.push(invalidSubfolder, '{"clusters":[]}');
  const beforeCorrection = receivedMessages.length;
  const second = await runHarvest(['cluster', '--limit', '100', '--continue-scan'], env);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(receivedMessages.length - beforeCorrection, 2, 'corrected category should complete within the same batch');
  const feedback = receivedMessages[beforeCorrection + 1].at(-1).content;
  assert.match(feedback, /invalid experience subfolder/);
  assert.ok(feedback.length <= 300, 'schema correction feedback must be bounded');
  const secondScan = JSON.parse(readFileSync(documentPath, 'utf8')).scan;
  assert.deepEqual({ after: secondScan.after, processed: secondScan.processed, remaining: secondScan.remaining, eligible_total: secondScan.eligible_total },
    { after: '08-观察/a100.md', processed: 101, remaining: 0, eligible_total: 101 });
  const nextCycle = await runHarvest(['cluster', '--limit', '100', '--continue-scan'], env);
  assert.equal(nextCycle.code, 0, nextCycle.stderr);
  const resetScan = JSON.parse(readFileSync(documentPath, 'utf8')).scan;
  assert.equal(resetScan.after, '08-观察/a099.md');
  assert.equal(resetScan.processed, 100);
  assert.equal(resetScan.remaining, 1);
});

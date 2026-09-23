#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { extractClaudeSession, extractCodexSession, findClaudeTranscripts, validateObservations } from '../scripts/cli/observe.mjs';

const dir = mkdtempSync(join(tmpdir(), 'observe-fixture-'));
const transcripts = join(dir, 'transcripts');
mkdirSync(transcripts);
const agentTranscript = join(transcripts, 'agent-x.jsonl');
const rolloutTranscript = join(transcripts, 'rollout-y.jsonl');
const homeFile = join(homedir(), 'Desktop', 'second-brain', 'a.md');
writeFileSync(agentTranscript, '{}\n');
writeFileSync(rolloutTranscript, '{}\n');
assert.deepEqual(findClaudeTranscripts(transcripts), [rolloutTranscript]);

const claude = join(dir, 'claude.jsonl');
writeFileSync(claude, [
  JSON.stringify({ isSidechain: true, message: { role: 'user', content: 'skip me' } }),
  JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'fix the vault routing' }] } }),
  JSON.stringify({ message: { role: 'assistant', content: [{ type: 'thinking', text: 'private chain' }, { type: 'text', text: 'patched observe flow' }, { type: 'tool_result', content: 'noisy output' }] } }),
  JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: homeFile } }] } }),
].join('\n') + '\n');

const codex = join(dir, 'codex.jsonl');
writeFileSync(codex, [
  JSON.stringify({ type: 'session_meta', payload: { cwd: '/private/tmp', thread_source: 'user' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'implement P1' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: { cmd: 'sed -n 1p /private/tmp/a.js', workdir: '/private/tmp' } } }),
].join('\n') + '\n');

const c = extractClaudeSession(claude);
assert.match(c.text, /fix the vault routing/);
assert.match(c.text, /patched observe flow/);
assert.doesNotMatch(c.text, /private chain|noisy output|skip me/);
assert(c.files.includes(homeFile));

const x = extractCodexSession(codex);
assert.match(x.text, /implement P1/);
assert(x.files.includes('/private/tmp'));
assert(x.files.some(f => f.includes('/private/tmp/a.js')));

assert.equal(validateObservations([{ title: 't', type: 'status', facts: ['f'], files: [], project: null, narrative: 'n', durable_candidate: false }]).length, 1);
console.log('observe fixture check PASS');

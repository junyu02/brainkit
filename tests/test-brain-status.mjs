#!/usr/bin/env node

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const TMP_PARENT = resolve(process.env.BRAIN_TEST_TMP_ROOT || join(PROJECT_ROOT, '.migration-state'));
mkdirSync(TMP_PARENT, { recursive: true });
const ROOT = mkdtempSync(join(TMP_PARENT, 'brain-status-tests-'));
const VAULT = join(ROOT, 'vault');
const MEMORY = join(ROOT, 'memory');
const STATUS = join(PROJECT_ROOT, 'scripts', 'cli', 'brain-status.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

test('brain-status generates reports with env roots and unavailable mempalace', () => {
  for (const path of [
    join(VAULT, '00-系统', '.index-cache'),
    join(VAULT, '00-系统', 'logs'),
    join(VAULT, '08-观察'),
    join(VAULT, 'raw', 'pending'),
    MEMORY,
    join(ROOT, 'claude'),
    join(ROOT, 'codex'),
    join(ROOT, 'chronicle'),
    join(ROOT, 'empty-path'),
  ]) mkdirSync(path, { recursive: true });
  writeFileSync(join(VAULT, '00-系统', '.index-cache', 'observe-checkpoint.json'), '{"processed":{},"errors":{}}\n');
  writeFileSync(join(VAULT, '00-系统', 'logs', 'brain-write-ledger.jsonl'), '');
  writeFileSync(join(MEMORY, 'MEMORY.md'), '## 🔥 热记忆\n\n- [fixture]\n\n## 其他\n');

  const result = spawnSync(process.execPath, [STATUS], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: join(ROOT, 'empty-path'),
      BRAIN_VAULT_ROOT: VAULT,
      BRAIN_MEMORY_DIR: MEMORY,
      BRAIN_CLAUDE_SESSIONS_ROOT: join(ROOT, 'claude'),
      BRAIN_CODEX_SESSIONS_ROOT: join(ROOT, 'codex'),
      BRAIN_CHRONICLE_ROOT: join(ROOT, 'chronicle'),
      MEMPALACE_BIN: join(ROOT, 'missing-mempalace'),
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const name of ['状态总览.md', '状态总览.html']) {
    const path = join(VAULT, name);
    assert.ok(existsSync(path));
    assert.match(result.stdout, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(readFileSync(path, 'utf8'), /mempalace: 不可用/);
  }
});

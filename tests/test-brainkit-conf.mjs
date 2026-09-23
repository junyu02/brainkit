import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brainkitPaths } from '../scripts/lib/brainkit-conf.mjs';

function home(conf) {
  const root = mkdtempSync(join(tmpdir(), 'brainkit-conf-'));
  if (conf !== null) {
    const dir = join(root, '.config', 'second-brain');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'brainkit.conf');
    writeFileSync(path, conf, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return root;
}

const legacyRouting = root => join(root, '.claude', 'vault-routing.json');
const legacyMemory = root => join(root, '.claude', 'projects', root.replace(/[:\\/]/g, '-'), 'memory');

// Situation A, and the reason this file exists: the machine this is deployed on
// today has a conf with one line in it, written before the installer learned to
// write the other three. Its routing and memory must still resolve to the Claude
// host paths its pipeline has always used. If this goes red, wiring the CLIs up
// moved somebody's live memory directory.
test('A: a conf with only vault leaves routing and memory on the legacy defaults', () => {
  const root = home('vault="/somewhere/vault"\n');
  const paths = brainkitPaths({ home: root, env: {} });

  assert.equal(paths.vault, '/somewhere/vault');
  assert.equal(paths.routing, legacyRouting(root));
  assert.equal(paths.memory, legacyMemory(root));
});

// Situation B: what the installer writes today. The keys are present, so the
// same ladder lands on them instead -- no branch, different data.
test('B: a full conf supplies all three, without any legacy path existing', () => {
  const root = home([
    'schema=1',
    'vault="/new/vault"',
    'routing_json="/new/config/vault-routing.json"',
    'memory_dir="/new/support/memory"',
    '',
  ].join('\n'));
  const paths = brainkitPaths({ home: root, env: {} });

  assert.deepEqual(paths, {
    vault: '/new/vault',
    routing: '/new/config/vault-routing.json',
    memory: '/new/support/memory',
  });
});

test('C: env wins over both, key by key', () => {
  const root = home('schema=1\nvault="/conf/vault"\nrouting_json="/conf/routing.json"\nmemory_dir="/conf/memory"\n');
  const paths = brainkitPaths({
    home: root,
    env: {
      BRAIN_VAULT_ROOT: '/env/vault',
      BRAIN_ROUTING_JSON: '/env/routing.json',
      BRAIN_MEMORY_DIR: '/env/memory',
    },
  });

  assert.deepEqual(paths, { vault: '/env/vault', routing: '/env/routing.json', memory: '/env/memory' });

  // One env var set is not all three: the ladder is per key.
  const mixed = brainkitPaths({ home: root, env: { BRAIN_MEMORY_DIR: '/env/memory' } });
  assert.equal(mixed.routing, '/conf/routing.json');
  assert.equal(mixed.memory, '/env/memory');
});

test('no conf at all is normal, not an error', () => {
  const root = home(null);
  const paths = brainkitPaths({ home: root, env: {} });

  assert.equal(paths.routing, legacyRouting(root));
  assert.equal(paths.memory, legacyMemory(root));
  // Self-location: two levels under 00-系统 in a deployed copy, which is right
  // there and wrong in a repo clone -- from tests/../scripts/lib it lands on the
  // clone's PARENT. That is exactly why the conf's `vault` key sits above it in
  // the ladder rather than being the only source.
  assert.equal(paths.vault, resolve(new URL('../scripts/lib/', import.meta.url).pathname, '..', '..', '..'));
});

test('an unusable conf is refused by name, not replaced with defaults', () => {
  // Silently falling back would point a write pipeline at a different vault
  // than the one the operator configured, which is the failure this whole
  // change exists to prevent.
  const unknown = home('vault="/v"\nsomething_else="/x"\n');
  assert.throws(() => brainkitPaths({ home: unknown, env: {} }), /not allowlisted/);

  const badSchema = home('schema=2\nvault="/v"\n');
  assert.throws(() => brainkitPaths({ home: badSchema, env: {} }), /only understands schema 1/);

  const root = home('vault="/v"\n');
  chmodSync(join(root, '.config', 'second-brain', 'brainkit.conf'), 0o644);
  assert.throws(() => brainkitPaths({ home: root, env: {} }), /mode must be 0600/);
});

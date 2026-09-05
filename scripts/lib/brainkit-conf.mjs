// Where the CLIs get their paths from. One resolver rather than the same three
// lines copied into thirteen files, which is how routing_json and memory_dir
// came to be hardcoded to one machine's Claude host in the first place.
//
// The ladder is per key, not per file: an env var wins, then the key in
// brainkit.conf IF IT IS THERE, then the historical default. That "if it is
// there" is the whole compatibility story -- a machine installed before the
// installer wrote those keys has a conf with only `vault`, falls through to the
// legacy defaults, and behaves exactly as it did. Nothing branches on which
// machine it is; the confs differ, the code does not.
//
// BRAIN_CLAUDE_SESSIONS_ROOT is deliberately NOT here. ~/.claude/projects is
// where the Claude host keeps its own session files; brainkit reads them but
// does not decide where they live, and putting it in brainkit.conf would claim
// otherwise. It stays env-only -- please do not "complete the set".

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './plist-render.mjs';

const CONF_KEYS = ['schema', 'vault', 'routing_json', 'memory_dir'];

// Both scripts/cli/*.mjs and scripts/lib/*.mjs sit two levels under 00-系统, so
// this resolves to the vault root from either -- the same expression the CLIs
// already used, moved rather than reinvented.
const SELF_LOCATED_VAULT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The Claude host's project-directory convention, spelled the same way
// brain-write.mjs and brain-status.mjs both already spelled it.
function legacyMemoryDir(home) {
  return join(home, '.claude', 'projects', home.replace(/[:\\/]/g, '-'), 'memory');
}

// Missing is the normal case for a repo clone and for a machine that has never
// run the installer, so absence is not an error. Anything else -- a key that is
// not allowlisted, a mode that is not 0600, a schema this code does not know --
// is refused by name, because a config that cannot be trusted must not be
// silently replaced with defaults that point somewhere else.
function readConf(path) {
  let values;
  try {
    values = parseEnvFile(path, { allowedKeys: CONF_KEYS });
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`${path} is unusable: ${error.message}`);
  }
  if (values.schema !== undefined && values.schema !== '1') {
    throw new Error(`${path} declares schema ${values.schema}, and this build only understands schema 1`);
  }
  return values;
}

function brainkitPaths({ home = homedir(), env = process.env } = {}) {
  const conf = readConf(join(home, '.config', 'second-brain', 'brainkit.conf'));
  const pick = (variable, key, fallback) => resolve(env[variable] || conf[key] || fallback);
  return {
    vault: pick('BRAIN_VAULT_ROOT', 'vault', SELF_LOCATED_VAULT),
    routing: pick('BRAIN_ROUTING_JSON', 'routing_json', join(home, '.claude', 'vault-routing.json')),
    memory: pick('BRAIN_MEMORY_DIR', 'memory_dir', legacyMemoryDir(home)),
  };
}

export { brainkitPaths, CONF_KEYS };

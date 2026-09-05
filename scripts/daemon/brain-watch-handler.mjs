#!/usr/bin/env node
// brain-watch-handler.mjs — Always-on stdin processor invoked by fswatch
// Reads fswatch output from stdin and processes file changes to update vault cards + MEMORY.md
// Zero npm dependencies — uses only Node.js built-ins.

import { appendFileSync, writeFileSync, readFileSync, statSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VAULT_ROOT = resolve(process.env.BRAIN_VAULT_ROOT || resolve(__dirname, '..', '..', '..'));
const PROJECT_MAP_PATH = join(VAULT_ROOT, '00-系统', '.project-map.json');
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'second-brain');
const LOG_PATH = join(LOG_DIR, 'daemon.log');
const DEBOUNCE_MS = 10_000;
const LOG_MAX_BYTES = 1_048_576; // 1MB
const SKIP_DIRS = new Set(['.obsidian', '.git', '.planning', '.claude', 'node_modules', '00-系统']);

// ─── Constants for index building ───

const GLOBAL_INDEX_HEADER = '# Memory Index\n\n';
const GLOBAL_MAX_LINES = 150;
const HEADER_LINES = 2;
const TYPE_PRIORITY = {
  'user-profile': 0,
  'feedback': 1,
  'reference': 2,
  'project': 3,
  'session': 4,
};

const BLOCK_REGEX = /<!-- AUTO-GENERATED: project-card -->[\s\S]*?<!-- \/AUTO-GENERATED -->/;
const FRONTMATTER_REGEX = /^---\n[\s\S]*?\n---\n/;

// ─── Debounce state ───

const debounceTimers = new Map();

// ─── Logging ───

function log(msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    // Rotate if >= 1MB
    try {
      const s = statSync(LOG_PATH);
      if (s.size >= LOG_MAX_BYTES) {
        writeFileSync(LOG_PATH, '');
      }
    } catch {
      // File doesn't exist yet — fine
    }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // Never crash on log failure
  }
}

const ERRORS_MD_PATH = join(VAULT_ROOT, '00-系统', 'ERRORS.md');

function appendErrorLog(stage, message) {
  try {
    appendFileSync(ERRORS_MD_PATH, `- ${new Date().toISOString()} [watch-daemon/${stage}] ${message}\n`);
  } catch { /* never crash on error logging */ }
}

function atomicWriteFileSync(filePath, content, encoding) {
  const tmpPath = filePath + '.tmp';
  try {
    writeFileSync(tmpPath, content, encoding);
    renameSync(tmpPath, filePath);
  } catch {
    writeFileSync(filePath, content, encoding);
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// ─── Startup ───

mkdirSync(LOG_DIR, { recursive: true });
log(`[DAEMON START] pid=${process.pid} at ${new Date().toISOString()}`);

// ─── Pure Functions (ported from vault-index.js CJS → ESM) ───

function parseFrontmatter(raw) {
  try {
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { data: {}, content: raw };

    const yamlBlock = match[1];
    const data = {};
    let currentKey = null;

    for (const line of yamlBlock.split('\n')) {
      const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
      if (kvMatch) {
        currentKey = kvMatch[1];
        const val = kvMatch[2].trim();
        if (val === '' || val === '[]') {
          data[currentKey] = [];
        } else if (val.startsWith("'") && val.endsWith("'")) {
          data[currentKey] = val.slice(1, -1);
        } else if (val.startsWith('"') && val.endsWith('"')) {
          data[currentKey] = val.slice(1, -1);
        } else if (val === 'true' || val === 'false') {
          data[currentKey] = val === 'true';
        } else {
          data[currentKey] = val;
        }
      } else if (currentKey && line.match(/^\s+-\s+(.*)/)) {
        const arrMatch = line.match(/^\s+-\s+(.*)/);
        if (!Array.isArray(data[currentKey])) data[currentKey] = [];
        data[currentKey].push(arrMatch[1].trim());
      }
    }

    const content = raw.slice(match[0].length).replace(/^\n/, '');
    return { data, content };
  } catch {
    return { data: {}, content: raw };
  }
}

function getTitle(data, filename) {
  if (data.name && typeof data.name === 'string') return data.name;
  return filename.replace(/\.md$/, '');
}

function getDescription(data, content) {
  if (data.description && typeof data.description === 'string') return data.description;
  if (data.name && typeof data.name === 'string') return data.name;
  const lines = (content || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      return trimmed.substring(0, 120);
    }
  }
  return null;
}

function inferProjectType(localPath) {
  const check = (name) => existsSync(join(localPath, name));
  if (check('package.json')) return 'Node.js / Frontend';
  if (check('requirements.txt') || check('pyproject.toml')) return 'Python';
  if (check('Cargo.toml')) return 'Rust';
  if (check('go.mod')) return 'Go';
  if (check('CLAUDE.md')) return 'Claude Project';
  return 'General';
}

function buildAutoBlock(name, type, localPath, mtimeMs) {
  const home = homedir();
  const displayPath = localPath.startsWith(home) ? '~' + localPath.slice(home.length) : localPath;
  const d = new Date(mtimeMs);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return [
    '<!-- AUTO-GENERATED: project-card -->',
    `**类型：** ${type}`,
    `**本地路径：** ${displayPath}`,
    `**最后活跃：** ${dateStr}`,
    '<!-- /AUTO-GENERATED -->',
  ].join('\n');
}

function writeCardToFile(filePath, autoBlock) {
  // New file
  if (!existsSync(filePath)) {
    const content = '---\ntype: system\ngenerated: auto\n---\n\n' + autoBlock + '\n';
    mkdirSync(dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, content, 'utf8');
    return;
  }
  // Existing file
  const existing = readFileSync(filePath, 'utf8');
  if (BLOCK_REGEX.test(existing)) {
    atomicWriteFileSync(filePath, existing.replace(BLOCK_REGEX, autoBlock), 'utf8');
    return;
  }
  // No block yet — insert after frontmatter if present, else at top
  const fmMatch = existing.match(FRONTMATTER_REGEX);
  if (fmMatch) {
    const afterFm = existing.slice(fmMatch[0].length);
    atomicWriteFileSync(filePath, fmMatch[0] + '\n' + autoBlock + '\n\n' + afterFm, 'utf8');
  } else {
    atomicWriteFileSync(filePath, autoBlock + '\n\n' + existing, 'utf8');
  }
}

function scanVault(vaultRoot, oldCache) {
  if (!existsSync(vaultRoot)) return { entries: [], newCache: {} };

  try {
    const stat = statSync(vaultRoot);
    if (!stat.isDirectory()) return { entries: [], newCache: {} };
  } catch {
    return { entries: [], newCache: {} };
  }

  const entries = [];
  const newCache = {};
  let dirEntries;
  try {
    dirEntries = readdirSync(vaultRoot, { recursive: true, withFileTypes: true });
  } catch {
    return { entries: [], newCache: {} };
  }

  for (const dirent of dirEntries) {
    try {
      if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue;
      if (dirent.name === '_index.md') continue;

      const relPath = dirent.parentPath
        ? relative(vaultRoot, join(dirent.parentPath, dirent.name))
        : dirent.name;

      const topDir = relPath.split(sep)[0];
      if (SKIP_DIRS.has(topDir)) continue;

      const absPath = join(vaultRoot, relPath);
      const currentMtimeMs = statSync(absPath).mtimeMs;
      const cached = oldCache[absPath];

      let title, description, type, scope, created, projects;

      if (cached && cached.mtime === currentMtimeMs) {
        title = cached.title;
        description = cached.description;
        type = cached.type;
        scope = cached.scope;
        created = cached.created;
        projects = cached.projects;
      } else {
        const raw = readFileSync(absPath, 'utf8');
        const { data, content } = parseFrontmatter(raw);
        const filename = dirent.name;
        title = getTitle(data, filename);
        description = getDescription(data, content);
        type = data.type || null;
        scope = data.scope || 'global';
        created = typeof data.created === 'string' ? data.created : String(data.created || '');
        projects = Array.isArray(data.projects) ? data.projects : [];
      }

      newCache[absPath] = { mtime: currentMtimeMs, title, description, type, scope, created, projects };
      entries.push({ relativePath: relPath, type, scope, created, title, description, projects });
    } catch {
      continue;
    }
  }

  return { entries, newCache };
}

function buildIndexLine(entry) {
  const desc = entry.description || entry.relativePath.replace(/\.md$/, '').split('/').pop();
  return `- [${entry.title}](${entry.relativePath}) -- ${desc}`;
}

function sortEntries(entries, projectMtimeMap = {}) {
  return [...entries].sort((a, b) => {
    const pA = TYPE_PRIORITY[a.type] ?? 99;
    const pB = TYPE_PRIORITY[b.type] ?? 99;
    if (pA !== pB) return pA - pB;
    if (a.type === 'project' && b.type === 'project') {
      const nameA = (a.projects && a.projects[0]) || null;
      const nameB = (b.projects && b.projects[0]) || null;
      const mtA = nameA ? (projectMtimeMap[nameA] ?? 0) : 0;
      const mtB = nameB ? (projectMtimeMap[nameB] ?? 0) : 0;
      if (mtA !== mtB) return mtB - mtA;
    }
    return (b.created || '').localeCompare(a.created || '');
  });
}

function truncateEntries(entries, maxLines) {
  const available = maxLines - HEADER_LINES;
  if (entries.length <= available) return entries;

  const personal = entries.filter(e => e.scope === '个人');
  const others = entries.filter(e => e.scope !== '个人');

  const sortedOthers = [...others].sort((a, b) => {
    const pA = TYPE_PRIORITY[a.type] ?? 99;
    const pB = TYPE_PRIORITY[b.type] ?? 99;
    if (pA !== pB) return pA - pB;
    return (b.created || '').localeCompare(a.created || '');
  });

  const result = sortedOthers.slice(0, available);
  if (result.length < available) {
    result.push(...personal.slice(0, available - result.length));
  }
  return result;
}

function buildGlobalIndex(entries, projectMtimeMap = {}) {
  const filtered = entries.filter(e => e.type !== 'system');
  const truncated = truncateEntries(filtered, GLOBAL_MAX_LINES);
  const sorted = sortEntries(truncated, projectMtimeMap);
  const lines = sorted.map(e => buildIndexLine(e));
  return GLOBAL_INDEX_HEADER + lines.join('\n') + '\n';
}

// ─── Core Processing ───

async function processProject(mapping) {
  const start = Date.now();
  try {
    // Get dir mtime
    const dirStat = statSync(mapping.localPath);
    const mtimeMs = dirStat.mtimeMs;

    // Infer type and build card
    const name = mapping.vaultDir.split('/').pop();
    const type = inferProjectType(mapping.localPath);
    const autoBlock = buildAutoBlock(name, type, mapping.localPath, mtimeMs);
    const cardPath = join(VAULT_ROOT, mapping.vaultDir, '_index.md');
    writeCardToFile(cardPath, autoBlock);

    // Scan vault (no cache — fresh every time for daemon)
    const { entries } = scanVault(VAULT_ROOT, {});

    // Build projectMtimeMap for all non-archived mappings
    let mappings = [];
    try {
      const mapData = JSON.parse(readFileSync(PROJECT_MAP_PATH, 'utf8'));
      mappings = Array.isArray(mapData.mappings) ? mapData.mappings : [];
    } catch {
      // Use empty mappings
    }

    const projectMtimeMap = {};
    for (const m of mappings) {
      if (m.archived === true) continue;
      if (!m.localPath || !m.vaultDir) continue;
      try {
        const s = statSync(m.localPath);
        const n = m.vaultDir.split('/').pop();
        projectMtimeMap[n] = s.mtimeMs;
      } catch {
        // Skip missing paths
      }
    }

    // Global shadow MEMORY.md write removed; project card update remains active.

    const elapsed = Date.now() - start;
    log(`[UPDATED] ${mapping.vaultDir} in ${elapsed}ms`);
  } catch (err) {
    log(`[ERROR] ${mapping.vaultDir}: ${err.message}`);
    appendErrorLog('processProject', `${mapping.vaultDir}: ${err.message}`);
  }
}

function handlePath(changedPath) {
  // Read .project-map.json fresh every call
  let mappings = [];
  try {
    const mapData = JSON.parse(readFileSync(PROJECT_MAP_PATH, 'utf8'));
    mappings = Array.isArray(mapData.mappings) ? mapData.mappings : [];
  } catch {
    log(`[SKIP] could not read project-map for: ${changedPath}`);
    return;
  }

  // Find longest-prefix match
  const sorted = [...mappings].sort((a, b) => b.localPath.length - a.localPath.length);
  let matched = null;
  for (const m of sorted) {
    const normalizedLocal = resolve(m.localPath);
    const normalizedChanged = resolve(changedPath);
    if (normalizedChanged === normalizedLocal || normalizedChanged.startsWith(normalizedLocal + '/')) {
      matched = m;
      break;
    }
  }

  if (!matched) {
    log(`[SKIP] no mapping for: ${changedPath}`);
    return;
  }

  // Debounce by localPath
  const key = matched.localPath;
  if (debounceTimers.has(key)) {
    clearTimeout(debounceTimers.get(key));
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    processProject(matched);
  }, DEBOUNCE_MS);

  debounceTimers.set(key, timer);
  log(`[DEBOUNCE] ${matched.vaultDir} — will process in 10s`);
}

// ─── stdin reading ───

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  // Keep last partial line in buffer
  buffer = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      handlePath(trimmed);
    }
  }
});

process.stdin.on('end', () => {
  // Process any remaining buffered content
  if (buffer.trim()) {
    handlePath(buffer.trim());
  }
  // HARD-04: stdin EOF means fswatch died -- exit non-zero so launchd restarts
  const msg = 'stdin EOF detected -- fswatch likely died, exiting for launchd restart';
  log(`[EOF] ${msg}`);
  appendErrorLog('eof', msg);
  process.exit(1);
});

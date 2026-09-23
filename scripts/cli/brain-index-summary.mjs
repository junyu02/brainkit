#!/usr/bin/env node
// brain-index-summary.mjs -- Generate an index health report for the Second Brain vault
//
// Usage:
//   node brain-index-summary.mjs                  # Markdown report to stdout
//   node brain-index-summary.mjs --json           # JSON report to stdout
//   node brain-index-summary.mjs --scan-missing   # Report vault files missing from domain indexes
//   node brain-index-summary.mjs --help

import {
  readFileSync, existsSync, readdirSync, statSync
} from 'node:fs';
import { resolve, join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;

const MEMORY_DIR  = BRAINKIT.memory;
const MEMORY_MD   = join(MEMORY_DIR, 'MEMORY.md');
const INTENT_MAP_PATH = join(VAULT_ROOT, '00-系统', '.index-cache', 'intent-map.json');

const DOMAIN_INDEX_FILES = [
  'MEMORY.md',
  'MEMORY-knowledge.md',
  'MEMORY-experience.md',
  'MEMORY-project.md',
  'MEMORY-persona.md',
  'MEMORY-archive.md',
  'MEMORY-notes.md',
];

// Directories to exclude from --scan-missing (top-level vault dirs and hidden dirs)
// 04-对话 is excluded: session logs are not cross-session retrievable; user decision
const SCAN_EXCLUDE_DIRS = ['04-对话', '06-归档', 'raw', '.trash', '00-系统', '.index-cache', '.obsidian', '.claude', '.git'];

const HOT_SECTION_HEADER = '## 🔥 热记忆（容量 40，按 type 配额+FIFO）';
const HOT_CAPACITY = 40;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--json')                 { args.json = true; continue; }
    if (arg === '--scan-missing')         { args.scanMissing = true; continue; }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node brain-index-summary.mjs [options]

Generate an index health report for the Second Brain vault.

Options:
  (none)           Print Markdown health report to stdout
  --json           Print JSON health report to stdout
  --scan-missing   Scan vault files not indexed in any domain index
  --help, -h       Show this help

Examples:
  node brain-index-summary.mjs
  node brain-index-summary.mjs --json | /usr/bin/jq .
  node brain-index-summary.mjs --scan-missing
`);
}

/**
 * getFileMtime(path) -> ISO string or null
 */
function getFileMtime(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * countLines(content) -> number
 */
function countLines(content) {
  return content.split('\n').length;
}

/**
 * Parse all entry lines from an index file.
 * Returns array of { title, path, group, line_number }
 */
function parseIndexEntries(content, indexFileName) {
  const lines = content.split('\n');
  const entries = [];
  let currentGroup = '（无子文件夹/顶层）';

  // For MEMORY.md: only count entries in the 🔥 hot section,
  // skip the 📚 domain-index pointer section to avoid inflating entry_count.
  let inHotSection = false;
  let pastHotSection = false;
  const isMainMemory = indexFileName === 'MEMORY.md';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      const headerText = line.slice(3).trim();
      if (isMainMemory) {
        if (headerText.startsWith('🔥')) {
          inHotSection = true;
          pastHotSection = false;
        } else {
          if (inHotSection) pastHotSection = true;
          inHotSection = false;
        }
      }
      const knownMeta = ['📚 领域索引（按需读取）', '索引维护规则'];
      if (!knownMeta.some(h => headerText.includes(h)) && !headerText.startsWith('🔥')) {
        currentGroup = headerText;
      }
      continue;
    }

    if (!line.startsWith('- [')) continue;

    // For MEMORY.md: only count lines in the hot section
    if (isMainMemory && !inHotSection) continue;

    // Q1: skip pointer lines (cross-type references) — they are not real entries
    if (line.includes('→ 见 MEMORY-')) continue;

    const titleMatch = line.match(/\[([^\]]+)\]/);
    const pathMatch  = line.match(/\(([^)]+)\)/);
    if (!titleMatch) continue;

    entries.push({
      title: titleMatch[1],
      path: pathMatch ? pathMatch[1] : '',
      group: currentGroup,
      line_number: i + 1,
      index_file: indexFileName,
    });
  }

  return entries;
}

/**
 * Parse hot section entries from MEMORY.md
 * Returns array of entry lines in hot section
 */
function parseHotEntries(content) {
  const lines = content.split('\n');
  const headerIdx = lines.findIndex(l => l === HOT_SECTION_HEADER);
  if (headerIdx === -1) return [];

  const nextSecIdx = lines.findIndex((l, i) => i > headerIdx + 1 && l.startsWith('## '));
  const end = nextSecIdx === -1 ? lines.length : nextSecIdx;

  return lines.slice(headerIdx + 1, end).filter(l => l.startsWith('- ['));
}

/**
 * Extract tags from a vault .md file's frontmatter.
 * Returns array of tag strings.
 */
function extractFileTags(absPath) {
  try {
    const content = readFileSync(absPath, 'utf8').slice(0, 3000);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return [];
    const fm = fmMatch[1];
    // Parse YAML tags field: "tags:\n  - foo\n  - bar" or "tags: []" or "tags: [foo, bar]"
    const tagsMatch = fm.match(/^tags:\s*([\s\S]*?)(?=\n\w|\n---|\s*$)/m);
    if (!tagsMatch) return [];
    const tagsBlock = tagsMatch[1].trim();
    if (!tagsBlock || tagsBlock === '[]') return [];
    // Multi-line format: "  - foo\n  - bar"
    if (tagsBlock.includes('\n') || tagsBlock.startsWith('-')) {
      return tagsBlock.split('\n')
        .map(l => l.replace(/^\s*-\s*/, '').trim())
        .filter(t => t.length > 0);
    }
    // Inline format: "[foo, bar]"
    const inlineMatch = tagsBlock.match(/^\[(.+)\]$/);
    if (inlineMatch) {
      return inlineMatch[1].split(',').map(t => t.trim()).filter(t => t.length > 0);
    }
    return [tagsBlock].filter(t => t.length > 0);
  } catch {
    return [];
  }
}

// --------------------------------------------------------------------------
// Dead link check (reuse verify logic without importing brain-write.mjs)
// --------------------------------------------------------------------------

function inferIndexTarget(relPath) {
  const base = relPath.split('/').pop() || relPath;

  if (relPath.includes('/02-知识/')) return { file: 'MEMORY-knowledge.md', subfolder: extractSubfolder(relPath, '02-知识') };
  if (relPath.includes('/03-经验/')) return { file: 'MEMORY-experience.md', subfolder: extractSubfolder(relPath, '03-经验') };
  if (relPath.includes('/01-项目/')) return { file: 'MEMORY-project.md',    subfolder: extractSubfolder(relPath, '01-项目') };
  if (relPath.includes('/05-persona/')) return { file: 'MEMORY-persona.md', subfolder: extractSubfolder(relPath, '05-persona') };
  if (relPath.includes('/06-归档/'))    return { file: 'MEMORY-archive.md', subfolder: extractSubfolder(relPath, '06-归档') };
  if (relPath.includes('/07-随笔/'))    return { file: 'MEMORY-notes.md',   subfolder: extractSubfolder(relPath, '07-随笔') };
  if (base.startsWith('reference_')) return { file: 'MEMORY-knowledge.md',  subfolder: '（无子文件夹/顶层）' };
  if (base.startsWith('feedback_'))  return { file: 'MEMORY-experience.md', subfolder: '（无子文件夹/顶层）' };
  if (base.startsWith('project_'))   return { file: 'MEMORY-project.md',    subfolder: '（无子文件夹/顶层）' };
  if (base.startsWith('user_'))      return { file: 'MEMORY-persona.md',    subfolder: '（无子文件夹/顶层）' };
  if (base === 'VAULT-MEMORY-PROTOCOL.md') return { file: 'MEMORY-knowledge.md', subfolder: '（无子文件夹/顶层）' };
  return { file: null, subfolder: null };
}

function extractSubfolder(relPath, layer) {
  const normalised = relPath.replace(/\\/g, '/');
  const marker = `/${layer}/`;
  const idx = normalised.indexOf(marker);
  if (idx === -1) return '（无子文件夹/顶层）';
  const after = normalised.slice(idx + marker.length);
  const parts = after.split('/');
  return parts.length <= 1 ? '（无子文件夹/顶层）' : parts[0];
}

function countDeadLinks() {
  let count = 0;
  for (const indexFileName of DOMAIN_INDEX_FILES) {
    const indexPath = join(MEMORY_DIR, indexFileName);
    if (!existsSync(indexPath)) continue;
    const content = readFileSync(indexPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.startsWith('- [')) continue;
      const pathMatch = line.match(/\(([^)]+)\)/);
      if (!pathMatch) continue;
      const rawPath = pathMatch[1];
      const absPath = rawPath.startsWith('/') ? rawPath : resolve(MEMORY_DIR, rawPath);
      if (!existsSync(absPath)) count++;
    }
  }
  return count;
}

// --------------------------------------------------------------------------
// P3: --scan-missing
// --------------------------------------------------------------------------

/**
 * collectAllVaultMdFiles(vaultRoot, excludeDirs)
 * Returns absolute paths of all .md files in vault, excluding specified top-level dirs.
 */
function collectAllVaultMdFiles(vaultRoot, excludeDirs) {
  const results = [];
  const topEntries = readdirSync(vaultRoot, { withFileTypes: true });

  for (const entry of topEntries) {
    // Skip explicitly excluded dirs and all hidden dirs/files (starting with '.')
    if (excludeDirs.includes(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const full = join(vaultRoot, entry.name);
    if (entry.isDirectory()) {
      collectMdRecursive(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function collectMdRecursive(dir, results) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs and excluded names
      if (!entry.name.startsWith('.')) {
        collectMdRecursive(full, results);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
}

/**
 * collectIndexedPaths()
 * Returns a Set of resolved absolute paths for all entries in all domain indexes.
 */
function collectIndexedPaths() {
  const indexed = new Set();
  for (const indexFileName of DOMAIN_INDEX_FILES) {
    const indexPath = join(MEMORY_DIR, indexFileName);
    if (!existsSync(indexPath)) continue;
    const content = readFileSync(indexPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.startsWith('- [')) continue;
      const pathMatch = line.match(/\(([^)]+)\)/);
      if (!pathMatch) continue;
      const rawPath = pathMatch[1];
      const absPath = rawPath.startsWith('/') ? rawPath : resolve(MEMORY_DIR, rawPath);
      indexed.add(absPath);
    }
  }
  return indexed;
}

function runScanMissing() {
  const vaultFiles = collectAllVaultMdFiles(VAULT_ROOT, SCAN_EXCLUDE_DIRS);
  const indexed = collectIndexedPaths();

  const missing = [];
  for (const absPath of vaultFiles) {
    // Skip index files themselves
    if (DOMAIN_INDEX_FILES.includes(basename(absPath))) continue;
    // Skip files inside MEMORY_DIR
    if (absPath.startsWith(MEMORY_DIR)) continue;

    if (!indexed.has(absPath)) {
      const relFromMem = relative(MEMORY_DIR, absPath);
      const { file: targetIndex, subfolder: targetGroup } = inferIndexTarget(relFromMem);
      missing.push({
        abs_path: absPath,
        vault_rel: relative(VAULT_ROOT, absPath),
        suggested_index: targetIndex || 'unknown',
        suggested_group: targetGroup || '（无子文件夹/顶层）',
      });
    }
  }
  return missing;
}

// --------------------------------------------------------------------------
// Main report builder
// --------------------------------------------------------------------------

function buildReport() {
  const indexStats = [];

  for (const indexFileName of DOMAIN_INDEX_FILES) {
    const indexPath = join(MEMORY_DIR, indexFileName);
    if (!existsSync(indexPath)) {
      indexStats.push({
        file: indexFileName,
        exists: false,
        entry_count: 0,
        line_count: 0,
        last_modified: null,
        groups: {},
      });
      continue;
    }

    const content = readFileSync(indexPath, 'utf8');
    const entries = parseIndexEntries(content, indexFileName);
    const lines = countLines(content);
    const mtime = getFileMtime(indexPath);

    // Group distribution
    const groups = {};
    for (const e of entries) {
      groups[e.group] = (groups[e.group] || 0) + 1;
    }

    indexStats.push({
      file: indexFileName,
      exists: true,
      entry_count: entries.length,
      line_count: lines,
      last_modified: mtime,
      groups,
    });
  }

  // Hot section capacity
  const memContent = existsSync(MEMORY_MD) ? readFileSync(MEMORY_MD, 'utf8') : '';
  const hotEntries = parseHotEntries(memContent);
  const hotCount = hotEntries.length;
  const hotCapacityPct = Math.round((hotCount / HOT_CAPACITY) * 100);

  // Top-10 tags across all vault files
  const tagCounts = {};
  const allIndexed = collectIndexedPaths();
  for (const absPath of allIndexed) {
    if (!existsSync(absPath)) continue;
    const tags = extractFileTags(absPath);
    for (const tag of tags) {
      if (tag) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  // Dead links
  const deadLinkCount = countDeadLinks();

  // intent-map stats
  let intentMapStats = null;
  if (existsSync(INTENT_MAP_PATH)) {
    try {
      const map = JSON.parse(readFileSync(INTENT_MAP_PATH, 'utf8'));
      const kwCount = Object.keys(map.keyword_routes || {}).length;
      const evLog = map.eviction_log || [];
      intentMapStats = {
        keyword_routes_count: kwCount,
        eviction_log_count: evLog.length,
        recent_evictions: evLog.slice(0, 5).map(e => ({
          title: e.title,
          evicted_at: e.evicted_at,
          destination_index: e.destination_index,
          subfolder: e.subfolder,
        })),
        last_updated: map.updated_at || null,
      };
    } catch {
      intentMapStats = { error: 'Cannot parse intent-map.json' };
    }
  } else {
    intentMapStats = { exists: false };
  }

  return {
    generated_at: new Date().toISOString(),
    index_files: indexStats,
    hot_section: {
      count: hotCount,
      capacity: HOT_CAPACITY,
      usage_pct: hotCapacityPct,
    },
    top_tags: topTags,
    dead_link_count: deadLinkCount,
    intent_map: intentMapStats,
  };
}

// --------------------------------------------------------------------------
// Markdown formatter
// --------------------------------------------------------------------------

function formatMarkdown(report) {
  const lines = [];
  lines.push('# Second Brain Index Health Report');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');

  // Index files table
  lines.push('## Index Files');
  lines.push('');
  lines.push('| File | Entries | Lines | Last Modified |');
  lines.push('|------|---------|-------|---------------|');
  for (const s of report.index_files) {
    const mtime = s.last_modified ? s.last_modified.slice(0, 16).replace('T', ' ') : 'N/A';
    const status = s.exists ? '' : ' (MISSING)';
    lines.push(`| ${s.file}${status} | ${s.entry_count} | ${s.line_count} | ${mtime} |`);
  }
  lines.push('');

  // Hot section
  lines.push('## Hot Section Capacity');
  lines.push('');
  const bar = '█'.repeat(Math.round(report.hot_section.usage_pct / 5)) +
              '░'.repeat(20 - Math.round(report.hot_section.usage_pct / 5));
  lines.push(`${bar} ${report.hot_section.count}/${report.hot_section.capacity} (${report.hot_section.usage_pct}%)`);
  lines.push('');

  // Subfolder distribution per domain index
  lines.push('## Subfolder Distribution');
  lines.push('');
  for (const s of report.index_files) {
    if (!s.exists || Object.keys(s.groups).length === 0) continue;
    if (s.file === 'MEMORY.md') continue; // hot section groups not meaningful
    lines.push(`### ${s.file}`);
    lines.push('');
    for (const [group, count] of Object.entries(s.groups).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${group}**: ${count}`);
    }
    lines.push('');
  }

  // Top tags
  lines.push('## Top 10 Tags');
  lines.push('');
  if (report.top_tags.length === 0) {
    lines.push('No tags found.');
  } else {
    for (let i = 0; i < report.top_tags.length; i++) {
      const { tag, count } = report.top_tags[i];
      lines.push(`${i + 1}. \`${tag}\` — ${count}`);
    }
  }
  lines.push('');

  // Dead links
  lines.push('## Dead Links');
  lines.push('');
  if (report.dead_link_count === 0) {
    lines.push('No dead links found.');
  } else {
    lines.push(`**${report.dead_link_count} dead link(s) found.** Run \`node brain-write.mjs --verify\` for details.`);
  }
  lines.push('');

  // Intent map
  lines.push('## Intent Map (intent-map.json)');
  lines.push('');
  const im = report.intent_map;
  if (!im) {
    lines.push('Not available.');
  } else if (im.exists === false) {
    lines.push('File does not exist yet (created on first write).');
  } else if (im.error) {
    lines.push(`Error: ${im.error}`);
  } else {
    lines.push(`- Keyword routes: **${im.keyword_routes_count}**`);
    lines.push(`- Eviction log entries: **${im.eviction_log_count}**`);
    lines.push(`- Last updated: ${im.last_updated ? im.last_updated.slice(0, 16).replace('T', ' ') : 'N/A'}`);
    if (im.recent_evictions && im.recent_evictions.length > 0) {
      lines.push('');
      lines.push('**Recent evictions (last 5):**');
      for (const e of im.recent_evictions) {
        const at = e.evicted_at ? e.evicted_at.slice(0, 16).replace('T', ' ') : '';
        lines.push(`- ${e.title} → ${e.destination_index}#${e.subfolder} (${at})`);
      }
    }
  }
  lines.push('');

  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.scanMissing) {
    const missing = runScanMissing();
    if (missing.length === 0) {
      console.log('No missing entries found. All vault files are indexed.');
    } else {
      console.log(`Found ${missing.length} unindexed vault file(s):\n`);
      for (const m of missing) {
        console.log(`MISSING: ${m.vault_rel} → 应加到 ${m.suggested_index} 的 "${m.suggested_group}" 组`);
      }
    }
    process.exit(0);
  }

  const report = buildReport();

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatMarkdown(report) + '\n');
  }

  process.exit(0);
}

main();

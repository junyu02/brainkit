#!/usr/bin/env node
// brain-archive-aged.mjs -- Archive orphaned vault entries older than N days
//
// Usage:
//   node brain-archive-aged.mjs                          # dry-run (default)
//   node brain-archive-aged.mjs --apply                  # actually move files
//   node brain-archive-aged.mjs --threshold 90           # custom age threshold
//   node brain-archive-aged.mjs --json                   # JSON output
//   node brain-archive-aged.mjs --help

import {
  readFileSync, writeFileSync, existsSync, readdirSync, statSync,
  mkdirSync, linkSync, unlinkSync
} from 'node:fs';
import { resolve, join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;

const MEMORY_DIR      = BRAINKIT.memory;
const MEMORY_MD       = join(MEMORY_DIR, 'MEMORY.md');
const INTENT_MAP_PATH = join(VAULT_ROOT, '00-系统', '.index-cache', 'intent-map.json');
const ARCHIVE_DIR     = join(VAULT_ROOT, '06-归档');

const DEFAULT_THRESHOLD_DAYS = 180;

// Directories to exclude from scanning
const EXCLUDE_DIRS = ['06-归档', 'raw', '.trash', '00-系统', '.index-cache', '.obsidian', '.claude', '.git', '04-对话'];

const DOMAIN_INDEX_FILES = [
  'MEMORY.md',
  'MEMORY-knowledge.md',
  'MEMORY-experience.md',
  'MEMORY-project.md',
  'MEMORY-persona.md',
  'MEMORY-archive.md',
  'MEMORY-notes.md',
];

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, threshold: DEFAULT_THRESHOLD_DAYS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--apply')               { args.apply = true; continue; }
    if (arg === '--json')                { args.json = true; continue; }
    if (arg === '--threshold') {
      const val = parseInt(argv[i + 1], 10);
      if (!isNaN(val) && val > 0) { args.threshold = val; i++; }
      continue;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node brain-archive-aged.mjs [options]

Scan vault for unreferenced files older than N days and archive them.
Default: dry-run mode (lists candidates without moving files).

Options:
  --apply              Actually move files to 06-归档/ and update indexes
  --threshold N        Age threshold in days (default: ${DEFAULT_THRESHOLD_DAYS})
  --json               Output JSON instead of text
  --help, -h           Show this help

Examples:
  node brain-archive-aged.mjs                        # dry-run, 180d threshold
  node brain-archive-aged.mjs --threshold 90         # dry-run, 90d threshold
  node brain-archive-aged.mjs --apply                # execute archiving
  node brain-archive-aged.mjs --json | jq .          # JSON output
`);
}

/**
 * collectAllVaultMdFiles(vaultRoot, excludeDirs) -> string[]
 */
function collectAllVaultMdFiles(vaultRoot, excludeDirs) {
  const results = [];
  let topEntries;
  try {
    topEntries = readdirSync(vaultRoot, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of topEntries) {
    if (excludeDirs.includes(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const full = join(vaultRoot, entry.name);
    if (entry.isDirectory()) {
      collectMdRecursive(full, results, excludeDirs);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function collectMdRecursive(dir, results, excludeDirs) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (excludeDirs.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMdRecursive(full, results, excludeDirs);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
}

/**
 * parseFrontmatterCreated(absPath) -> Date | null
 * Returns the `created` date from frontmatter, or null.
 */
function parseFrontmatterCreated(absPath) {
  try {
    const content = readFileSync(absPath, 'utf8').slice(0, 2000);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    const createdMatch = fm.match(/^created:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?/m);
    if (!createdMatch) return null;
    const d = new Date(createdMatch[1]);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * getFileAge(absPath) -> number (days since creation)
 * Uses frontmatter `created` if available, falls back to file ctime.
 */
function getFileAge(absPath) {
  const now = Date.now();
  // Try frontmatter created date
  const fmDate = parseFrontmatterCreated(absPath);
  if (fmDate) {
    return Math.floor((now - fmDate.getTime()) / (1000 * 60 * 60 * 24));
  }
  // Fallback: file ctime
  try {
    const st = statSync(absPath);
    return Math.floor((now - st.ctimeMs) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

/**
 * buildReferenceIndex(vaultFiles) -> Map<string, Set<string>>
 * For each vault file, stores which other files reference it by path or title.
 * Returns: targetAbsPath -> Set<referrerAbsPath>
 *
 * Strategy: scan body of each file for occurrences of other file's basename (without .md)
 * and also check index files for link entries.
 */
// A wikilink target may be written `note`, `folder/note`, `note#heading`,
// `note^block`, `note.md`, or with a trailing `|alias`. Everything that is not
// the name is stripped and the final path segment is what gets looked up.
function wikilinkName(raw) {
  const withoutAlias = raw.split('|')[0];
  const withoutAnchor = withoutAlias.split('#')[0].split('^')[0];
  const segments = withoutAnchor.trim().split('/').filter(Boolean);
  return segments.length === 0 ? '' : segments[segments.length - 1].replace(/\.md$/, '');
}

function buildReferenceIndex(vaultFiles) {
  // name -> every note with that name. The old map held one path per name and
  // later files overwrote earlier ones, so a link to a shared name credited a
  // single note and left its namesakes looking unreferenced -- which is how a
  // note somebody still links to becomes an archive candidate.
  //
  // All of them are marked referenced. Over-counting keeps a file that could
  // have been archived; under-counting archives one that is still in use.
  const byName = new Map();
  for (const f of vaultFiles) {
    const name = basename(f, '.md');
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(f);
  }

  const refs = new Map(); // target -> Set of referrers
  for (const f of vaultFiles) {
    refs.set(f, new Set());
  }

  for (const referrer of vaultFiles) {
    let body;
    try {
      body = readFileSync(referrer, 'utf8');
    } catch {
      continue;
    }
    // Find all wikilinks [[title]] and markdown links [text](path)
    const wikilinkMatches = body.matchAll(/\[\[([^\]]+)\]\]/g);
    for (const m of wikilinkMatches) {
      for (const target of byName.get(wikilinkName(m[1])) ?? []) {
        if (target !== referrer) refs.get(target)?.add(referrer);
      }
    }
    const mdlinkMatches = body.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
    for (const m of mdlinkMatches) {
      const linkPath = m[2];
      // Resolve relative path
      try {
        const absTarget = resolve(dirname(referrer), linkPath);
        if (refs.has(absTarget) && absTarget !== referrer) {
          refs.get(absTarget)?.add(referrer);
        }
      } catch { /* skip */ }
    }
  }

  return refs;
}

/**
 * buildIndexReferenceSet() -> Set<string>
 * Returns all absolute paths that appear in any domain index file.
 */
function buildIndexReferenceSet() {
  const indexed = new Set();
  for (const indexFileName of DOMAIN_INDEX_FILES) {
    const indexPath = join(MEMORY_DIR, indexFileName);
    if (!existsSync(indexPath)) continue;
    try {
      const content = readFileSync(indexPath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.startsWith('- [')) continue;
        const pathMatch = line.match(/\(([^)]+)\)/);
        if (!pathMatch) continue;
        const rawPath = pathMatch[1];
        const absPath = rawPath.startsWith('/') ? rawPath : resolve(MEMORY_DIR, rawPath);
        indexed.add(absPath);
      }
    } catch { /* skip */ }
  }
  return indexed;
}

/**
 * computeArchivePath(absPath) -> string
 * Returns destination path in 06-归档/ mirroring the note's place in the vault.
 *
 * The section is kept. Dropping it (03-经验/shared/note.md -> shared/note.md)
 * made every note that shared a sub-path across two sections land on the same
 * destination, and the move was a bare renameSync, so the second one replaced
 * the first: two titles in MEMORY-archive.md, one file on disk, exit 0.
 */
function computeArchivePath(absPath) {
  return join(ARCHIVE_DIR, relative(VAULT_ROOT, absPath));
}

/**
 * archiveCollisions(candidates) -> string[]
 * Everything about this batch that would make a move destroy something, found
 * before the first file is touched: two notes claiming one destination, and a
 * destination that is already occupied.
 */
function archiveCollisions(candidates) {
  const problems = [];
  const claimed = new Map();
  for (const c of candidates) {
    const rival = claimed.get(c.archive_path);
    if (rival) problems.push(`${c.vault_rel} and ${rival} would both become ${c.archive_rel}`);
    else claimed.set(c.archive_path, c.vault_rel);
    if (existsSync(c.archive_path)) problems.push(`${c.archive_rel} already exists; archiving ${c.vault_rel} would replace it`);
  }
  return problems;
}

// renameSync replaces whatever is at the destination -- that is how one note
// became another. linkSync refuses when the name is taken, so the check and
// the move are one operation instead of two with a gap between them.
//
// ponytail: link+unlink needs both paths on one filesystem. Inside a single
// vault they are; a section mounted separately would raise EXDEV and the note
// would be reported as failed rather than archived, which is the safe
// direction. Use copy-then-verify-then-unlink if that ever becomes real.
function moveNoClobber(from, to) {
  linkSync(from, to);
  unlinkSync(from);
}

// The metadata steps edit a handful of small files. Remembering their bytes
// before the first edit is enough to put all of them back, and is cheaper than
// making each edit individually reversible.
function snapshotFiles(paths) {
  return paths.filter(p => existsSync(p)).map(p => [p, readFileSync(p)]);
}

function restoreFiles(snapshot) {
  for (const [path, bytes] of snapshot) writeFileSync(path, bytes);
}

// --------------------------------------------------------------------------
// Index update helpers
// --------------------------------------------------------------------------

// These three used to swallow their own failures while the caller still
// recorded the note as archived -- a file moved away with its index entry left
// pointing at where it used to be. They throw now, and the caller undoes the
// move.
function removeLinesFromIndex(indexPath, absTarget) {
  if (!existsSync(indexPath)) return;
  const content = readFileSync(indexPath, 'utf8');
  const lines = content.split('\n').filter(line => {
    if (!line.startsWith('- [')) return true;
    const pathMatch = line.match(/\(([^)]+)\)/);
    if (!pathMatch) return true;
    const rawPath = pathMatch[1];
    const absPath = rawPath.startsWith('/') ? rawPath : resolve(MEMORY_DIR, rawPath);
    return absPath !== absTarget;
  });
  writeFileSync(indexPath, lines.join('\n'), 'utf8');
}

function appendLineToArchiveIndex(title, newAbsPath, description) {
  const archiveIndexPath = join(MEMORY_DIR, 'MEMORY-archive.md');
  const relPath = relative(MEMORY_DIR, newAbsPath);
  const line = `- [${title}](${relPath}) — ${description || '自动归档（超时无引用）'}`;

  let content = existsSync(archiveIndexPath) ? readFileSync(archiveIndexPath, 'utf8') : '# Archive Index\n';
  // Find or create ## 06-归档 group
  const groupHeader = '## 06-归档';
  if (!content.includes(groupHeader)) {
    content = content.trimEnd() + '\n\n' + groupHeader + '\n' + line + '\n';
  } else {
    const lines = content.split('\n');
    const groupIdx = lines.findIndex(l => l === groupHeader);
    let insertAt = groupIdx + 1;
    for (let i = groupIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break;
      if (lines[i].startsWith('- [')) insertAt = i + 1;
    }
    lines.splice(insertAt, 0, line);
    content = lines.join('\n');
  }
  writeFileSync(archiveIndexPath, content, 'utf8');
}

function updateIntentMapPaths(oldAbsPath, newAbsPath) {
  if (!existsSync(INTENT_MAP_PATH)) return;
  const map = JSON.parse(readFileSync(INTENT_MAP_PATH, 'utf8'));
  const oldRel = relative(MEMORY_DIR, oldAbsPath);
  const newRel = relative(MEMORY_DIR, newAbsPath);
  let changed = false;
  for (const [kw, routes] of Object.entries(map.keyword_routes || {})) {
    if (Array.isArray(routes)) {
      map.keyword_routes[kw] = routes.map(r => {
        if (r.includes(oldRel)) { changed = true; return r.replace(oldRel, newRel); }
        return r;
      });
    } else if (typeof routes === 'string' && routes.includes(oldRel)) {
      map.keyword_routes[kw] = routes.replace(oldRel, newRel);
      changed = true;
    }
  }
  if (changed) {
    map.updated_at = new Date().toISOString();
    writeFileSync(INTENT_MAP_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
  }
}

function extractTitleFromFile(absPath) {
  try {
    const content = readFileSync(absPath, 'utf8').slice(0, 1000);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
      if (nameMatch) return nameMatch[1].trim();
    }
    // Fallback: use basename without .md
    return basename(absPath, '.md');
  } catch {
    return basename(absPath, '.md');
  }
}

function extractDescFromFile(absPath) {
  try {
    const content = readFileSync(absPath, 'utf8').slice(0, 1000);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
      if (descMatch) return descMatch[1].trim();
    }
    return '自动归档（超时无引用）';
  } catch {
    return '自动归档（超时无引用）';
  }
}

// --------------------------------------------------------------------------
// Main logic
// --------------------------------------------------------------------------

function scan(thresholdDays) {
  const vaultFiles = collectAllVaultMdFiles(VAULT_ROOT, EXCLUDE_DIRS);
  // Exclude index files themselves
  const scanFiles = vaultFiles.filter(f => !DOMAIN_INDEX_FILES.includes(basename(f)));

  const refIndex = buildReferenceIndex(scanFiles);
  const indexedPaths = buildIndexReferenceSet();

  const candidates = [];
  for (const absPath of scanFiles) {
    const age = getFileAge(absPath);
    if (age < thresholdDays) continue;

    // Check references: file-to-file links
    const refs = refIndex.get(absPath) || new Set();
    if (refs.size > 0) continue; // referenced by another file

    // Check if referenced in any index file
    if (indexedPaths.has(absPath)) continue; // still actively indexed

    const title = extractTitleFromFile(absPath);
    const description = extractDescFromFile(absPath);
    const archivePath = computeArchivePath(absPath);
    const createdDate = parseFrontmatterCreated(absPath);

    candidates.push({
      abs_path: absPath,
      vault_rel: relative(VAULT_ROOT, absPath),
      title,
      description,
      age_days: age,
      created: createdDate ? createdDate.toISOString().slice(0, 10) : 'unknown',
      ref_count: 0,
      archive_path: archivePath,
      archive_rel: relative(VAULT_ROOT, archivePath),
    });
  }

  // Sort by age descending (oldest first)
  candidates.sort((a, b) => b.age_days - a.age_days);
  return candidates;
}

function applyArchive(candidates) {
  const results = [];
  for (const c of candidates) {
    // Everything the metadata steps can edit, as it stands before this note is
    // touched. A note is only archived if the move and all of its bookkeeping
    // succeed; anything short of that goes back to how it was.
    const touched = [...DOMAIN_INDEX_FILES.map(name => join(MEMORY_DIR, name)), INTENT_MAP_PATH];
    const before = snapshotFiles(touched);
    let moved = false;
    try {
      mkdirSync(dirname(c.archive_path), { recursive: true });
      moveNoClobber(c.abs_path, c.archive_path);
      moved = true;

      for (const indexFileName of DOMAIN_INDEX_FILES.filter(f => f !== 'MEMORY-archive.md')) {
        removeLinesFromIndex(join(MEMORY_DIR, indexFileName), c.abs_path);
      }
      appendLineToArchiveIndex(c.title, c.archive_path, c.description);
      updateIntentMapPaths(c.abs_path, c.archive_path);

      results.push({ ...c, status: 'archived' });
    } catch (err) {
      let rollback = null;
      try {
        restoreFiles(before);
        if (moved) moveNoClobber(c.archive_path, c.abs_path);
      } catch (undoErr) {
        rollback = undoErr.message;
      }
      results.push({
        ...c,
        status: 'error',
        error: err.message,
        ...(rollback ? { rollback_error: rollback } : {}),
      });
    }
  }
  return results;
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const thresholdDays = args.threshold;
  const isDryRun = !args.apply;

  const candidates = scan(thresholdDays);

  if (isDryRun) {
    if (args.json) {
      process.stdout.write(JSON.stringify({
        mode: 'dry-run',
        threshold_days: thresholdDays,
        candidate_count: candidates.length,
        candidates,
      }, null, 2) + '\n');
    } else {
      if (candidates.length === 0) {
        console.log(`Archive candidates (threshold: ${thresholdDays} days, unreferenced):\n\nNo candidates found.`);
      } else {
        console.log(`Archive candidates (threshold: ${thresholdDays} days, unreferenced):\n`);
        for (const c of candidates) {
          console.log(`[${c.age_days}d] ${c.vault_rel} (created ${c.created}, 0 refs) → ${c.archive_rel}`);
        }
        console.log(`\nTotal: ${candidates.length} candidate(s)`);
        console.log('Run with --apply to execute');
      }
    }
  } else {
    // Checked across the whole batch before the first move, because a
    // destination is only safe relative to every other note in the same run.
    const problems = archiveCollisions(candidates);
    if (problems.length > 0) {
      if (args.json) {
        process.stdout.write(JSON.stringify({
          mode: 'apply',
          threshold_days: thresholdDays,
          archived: 0,
          failed: 0,
          refused: problems,
        }, null, 2) + '\n');
      } else {
        console.log('Refusing to archive: these moves would overwrite something.\n');
        for (const problem of problems) console.log(`  ${problem}`);
        console.log('\nNothing was moved. Rename or remove the conflicting file, then run again.');
      }
      process.exitCode = 2;
      return;
    }
    const results = applyArchive(candidates);
    const succeeded = results.filter(r => r.status === 'archived').length;
    const failed    = results.filter(r => r.status === 'error').length;

    if (args.json) {
      process.stdout.write(JSON.stringify({
        mode: 'apply',
        threshold_days: thresholdDays,
        archived: succeeded,
        failed,
        results,
      }, null, 2) + '\n');
    } else {
      console.log(`Archiving complete: ${succeeded} archived, ${failed} failed\n`);
      for (const r of results) {
        const mark = r.status === 'archived' ? '[OK]' : '[ERR]';
        const extra = r.error ? ` — ${r.error}` : '';
        console.log(`${mark} ${r.vault_rel}${extra}`);
      }
    }
  }
}

main();

#!/usr/bin/env node
// brain-query.mjs -- Query the Second Brain vault via intent-map and domain indexes
//
// Usage:
//   node brain-query.mjs --query "CJK 字符编码踩坑"
//   node brain-query.mjs --keywords "CJK,字符编码"
//   node brain-query.mjs --query "上次 chromadb 超时" --json
//   node brain-query.mjs --help

import {
  readFileSync, existsSync
} from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
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

// Stop words shared with brain-write
const STOP_WORDS = new Set([
  '的', '是', '在', '了', '和', '与', '或', '及', '对', '从', '到', '为',
  '上', '下', '中', '内', '外', '前', '后', '方案', '问题', '总结', '分析',
  '介绍', '说明', '记录', '备注', '关于', '使用', '通过', '如何', '如果',
  '上次', '这次', '最近', '一个', '怎么', '处理',
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'has',
  'have', 'had', 'do', 'does', 'did', 'not', 'this', 'that', 'these',
]);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--json')                 { args.json = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node brain-query.mjs [options]

Query the Second Brain vault using intent-map keyword routes.

Options:
  --query "natural language query"    Tokenize and search intent-map
  --keywords "kw1,kw2,kw3"           Explicit comma-separated keywords
  --json                              Output JSON instead of Markdown
  --help, -h                          Show this help

Examples:
  node brain-query.mjs --query "CJK 字符编码问题"
  node brain-query.mjs --keywords "ChromaDB,超时"
  node brain-query.mjs --query "mempalace embedding 中文" --json
`);
}

/**
 * tokenizeQuery(query) -> string[]
 * Extract meaningful tokens from a natural-language query string.
 */
function tokenizeQuery(query) {
  const tokens = query
    .replace(/[-_\s]+/g, ' ')
    .split(' ')
    .flatMap(t => {
      // Split CJK runs (treat each CJK word as a token, not char-by-char)
      const cjkWords = t.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) || [];
      const latin = t.replace(/[\u4e00-\u9fff\u3400-\u4dbf]+/g, ' ').split(/\s+/);
      return [...cjkWords, ...latin];
    })
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t) && !STOP_WORDS.has(t.toLowerCase()));
  return [...new Set(tokens)];
}

/**
 * loadIntentMap() -> object
 */
function loadIntentMap() {
  if (!existsSync(INTENT_MAP_PATH)) return { keyword_routes: {}, eviction_log: [] };
  try {
    return JSON.parse(readFileSync(INTENT_MAP_PATH, 'utf8'));
  } catch {
    return { keyword_routes: {}, eviction_log: [] };
  }
}

/**
 * findCandidateIndexes(keywords, intentMap)
 * Returns { indexFile -> { subfolder, matchedKeywords[] } }
 */
function findCandidateIndexes(keywords, intentMap) {
  const candidates = {}; // indexFile#subfolder -> { indexFile, subfolder, keywords }

  for (const kw of keywords) {
    const routes = intentMap.keyword_routes[kw];
    if (!routes) continue;
    const routeList = Array.isArray(routes) ? routes : [routes];
    for (const route of routeList) {
      const [indexFile, subfolder] = route.split('#');
      const key = route;
      if (!candidates[key]) {
        candidates[key] = { indexFile, subfolder: subfolder || null, matchedKeywords: [] };
      }
      candidates[key].matchedKeywords.push(kw);
    }
  }

  return candidates;
}

/**
 * scoreEntryRelevance(entryLine, keywords) -> number
 * Simple relevance score: count keyword hits in entry line.
 */
function scoreEntryRelevance(entryLine, keywords) {
  const lower = entryLine.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) score++;
  }
  return score;
}

/**
 * grepIndexForEntries(indexFile, subfolder, keywords)
 * Reads the domain index file and returns relevant entries.
 */
function grepIndexForEntries(indexFile, subfolder, keywords) {
  const indexPath = join(MEMORY_DIR, indexFile);
  if (!existsSync(indexPath)) return [];

  let content;
  try {
    content = readFileSync(indexPath, 'utf8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const results = [];
  let currentGroup = null;
  let inTargetGroup = !subfolder; // if no subfolder filter, scan all

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3).trim();
      currentGroup = header;
      inTargetGroup = !subfolder || header === subfolder;
      continue;
    }
    if (!line.startsWith('- [')) continue;
    if (!inTargetGroup) continue;
    // Skip pointer lines
    if (line.includes('→ 见 MEMORY-')) continue;

    const score = scoreEntryRelevance(line, keywords);
    if (score === 0) continue;

    const titleMatch = line.match(/\[([^\]]+)\]/);
    const pathMatch  = line.match(/\(([^)]+)\)/);
    const descMatch  = line.match(/—\s*(.+)$/);

    if (!titleMatch) continue;

    const title = titleMatch[1];
    const relPath = pathMatch ? pathMatch[1] : '';
    const desc = descMatch ? descMatch[1].trim() : '';
    const absPath = relPath.startsWith('/')
      ? relPath
      : resolve(MEMORY_DIR, relPath);

    results.push({
      title,
      path: absPath,
      rel_path: relPath,
      description: desc,
      index_file: indexFile,
      group: currentGroup,
      score,
    });
  }

  return results;
}

/**
 * searchEvictionLog(keywords, evictionLog)
 * Check if any evicted entries match the keywords.
 */
function searchEvictionLog(keywords, evictionLog) {
  if (!evictionLog || evictionLog.length === 0) return [];
  const results = [];
  for (const entry of evictionLog) {
    let score = 0;
    const titleLower = (entry.title || '').toLowerCase();
    for (const kw of keywords) {
      if (titleLower.includes(kw.toLowerCase())) score++;
    }
    if (score > 0) {
      results.push({
        title: entry.title,
        destination_index: entry.destination_index,
        subfolder: entry.subfolder,
        evicted_at: entry.evicted_at,
        score,
        _evicted: true,
      });
    }
  }
  return results;
}

/**
 * runQuery(keywords) -> { candidates, entries, evictedMatches }
 */
function runQuery(keywords) {
  if (!keywords || keywords.length === 0) {
    return { keywords: [], candidates: {}, entries: [], evictedMatches: [] };
  }

  const intentMap = loadIntentMap();
  const candidates = findCandidateIndexes(keywords, intentMap);

  // Grep each candidate index
  const allEntries = [];
  const seen = new Set();

  for (const [, { indexFile, subfolder, matchedKeywords }] of Object.entries(candidates)) {
    const entries = grepIndexForEntries(indexFile, subfolder, keywords);
    for (const e of entries) {
      const key = e.rel_path || e.title;
      if (seen.has(key)) {
        // Boost score if already seen from another index
        const existing = allEntries.find(x => (x.rel_path || x.title) === key);
        if (existing) existing.score += e.score;
        continue;
      }
      seen.add(key);
      // Bonus: add matched keywords that routed to this index
      e.matched_keywords = [...new Set([
        ...(e.matched_keywords || []),
        ...matchedKeywords,
      ])];
      allEntries.push(e);
    }
  }

  // Also do a broad scan of MEMORY.md hot section
  const hotEntries = grepIndexForEntries('MEMORY.md', null, keywords);
  for (const e of hotEntries) {
    const key = e.rel_path || e.title;
    if (!seen.has(key)) {
      seen.add(key);
      e.matched_keywords = e.matched_keywords || [];
      allEntries.push(e);
    }
  }

  // Sort by score desc, then by title asc
  allEntries.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  // Search eviction log for context
  const evictedMatches = searchEvictionLog(keywords, intentMap.eviction_log || []);

  return {
    keywords,
    candidates,
    entries: allEntries.slice(0, 20), // top 20
    evictedMatches: evictedMatches.slice(0, 5),
  };
}

// --------------------------------------------------------------------------
// Formatters
// --------------------------------------------------------------------------

function formatMarkdown(result) {
  const lines = [];
  lines.push('# Brain Query Results');
  lines.push('');
  lines.push(`**Keywords searched:** ${result.keywords.join(', ')}`);
  lines.push('');

  const candidateCount = Object.keys(result.candidates).length;
  lines.push(`**Candidate indexes matched:** ${candidateCount}`);
  if (candidateCount > 0) {
    for (const [route, { matchedKeywords }] of Object.entries(result.candidates)) {
      lines.push(`- \`${route}\` (via: ${matchedKeywords.join(', ')})`);
    }
  }
  lines.push('');

  if (result.entries.length === 0) {
    lines.push('No matching entries found.');
  } else {
    lines.push(`## Top ${result.entries.length} Results`);
    lines.push('');
    for (const e of result.entries) {
      lines.push(`### ${e.title}`);
      if (e.description) lines.push(`> ${e.description}`);
      lines.push(`- **Index:** ${e.index_file}${e.group ? ' / ' + e.group : ''}`);
      lines.push(`- **Path:** ${e.path}`);
      lines.push(`- **Score:** ${e.score}`);
      lines.push('');
    }
  }

  if (result.evictedMatches.length > 0) {
    lines.push('## Eviction Log Matches (entries no longer in hot section)');
    lines.push('');
    for (const e of result.evictedMatches) {
      lines.push(`- **${e.title}** → ${e.destination_index}#${e.subfolder} (evicted ${e.evicted_at ? e.evicted_at.slice(0,10) : 'unknown'})`);
    }
    lines.push('');
  }

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

  let keywords = [];

  if (args.keywords) {
    keywords = args.keywords.split(',').map(k => k.trim()).filter(k => k.length >= 2);
  } else if (args.query) {
    keywords = tokenizeQuery(args.query);
  } else {
    process.stderr.write('Error: Provide --query or --keywords\n');
    printHelp();
    process.exit(1);
  }

  if (keywords.length === 0) {
    process.stderr.write('Error: No usable keywords extracted from query\n');
    process.exit(1);
  }

  const result = runQuery(keywords);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatMarkdown(result) + '\n');
  }
}

main();

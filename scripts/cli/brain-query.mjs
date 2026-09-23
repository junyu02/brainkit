#!/usr/bin/env node
// Bounded, read-only candidate lookup for second-brain notes.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

const { vault: VAULT_ROOT, memory: MEMORY_DIR } = brainkitPaths();
const INTENT_MAP_PATH = join(VAULT_ROOT, '00-系统', '.index-cache', 'intent-map.json');
const DOMAIN_INDEX_FILES = ['MEMORY.md', 'MEMORY-knowledge.md', 'MEMORY-experience.md', 'MEMORY-project.md', 'MEMORY-persona.md', 'MEMORY-archive.md', 'MEMORY-notes.md'];
const ALLOWED_SECTIONS = new Set(['01-项目', '02-知识', '03-经验', '05-persona', '07-随笔', '09-周报']);
const EXCLUDED_DIRS = new Set(['raw', 'system', '00-系统', 'rejected', '拒收', 'cache', 'node_modules', 'vendor', 'dist', 'build']);
const STOP_WORDS = new Set(['的', '是', '在', '了', '和', '与', '或', '及', '对', '从', '到', '为', '上次', '这次', '最近', '怎么', '处理', '方案', '问题', '总结', '分析', '介绍', '说明', '记录', '备注', '关于', '使用', '通过', '如何', '如果', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'do', 'does', 'did', 'not', 'this', 'that', 'these']);
const GENERIC_CJK_TERMS = new Set(['用户', '研究', '设计', '项目', '系统', '内容', '问题', '方案', '方法', '工作', '记录', '经验', '知识']);
const MAX_QUERY_LENGTH = 1000;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

function printHelp() {
  console.log('Usage: node brain-query.mjs --query "query" [--limit 1..20] [--json]\n       node brain-query.mjs --keywords "kw1,kw2" [--limit 1..20] [--json]');
}

function tokenizeQuery(query) {
  return [...new Set(query.replace(/[-_\s]+/g, ' ').split(' ').flatMap(token => {
    const cjk = token.match(/[\u3400-\u9fff]{2,}/gu) || [];
    return [...cjk, ...token.replace(/[\u3400-\u9fff]+/gu, ' ').split(/\s+/)];
  }).map(token => token.trim()).filter(token => token.length >= 2 && !STOP_WORDS.has(token) && !STOP_WORDS.has(token.toLowerCase())))];
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes(`${sep}..${sep}`));
}

function readBoundedRegularFile(path, root) {
  try {
    const leaf = lstatSync(path);
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1 || leaf.size > MAX_INDEX_BYTES) return null;
    if (realpathSync(dirname(path)) !== realpathSync(root)) return null;
    return readFileSync(path, 'utf8');
  } catch { return null; }
}

function loadIntentMap() {
  const cacheDir = join(VAULT_ROOT, '00-系统', '.index-cache');
  try {
    if (realpathSync(cacheDir) !== join(realpathSync(VAULT_ROOT), '00-系统', '.index-cache')) return { keyword_routes: {} };
  } catch { return { keyword_routes: {} }; }
  const content = readBoundedRegularFile(INTENT_MAP_PATH, cacheDir);
  if (!content) return { keyword_routes: {} };
  try {
    const map = JSON.parse(content);
    return map && map.keyword_routes && typeof map.keyword_routes === 'object' ? map : { keyword_routes: {} };
  } catch { return { keyword_routes: {} }; }
}

function validRoute(route) {
  if (typeof route !== 'string') return null;
  const parts = route.split('#');
  if (parts.length > 2 || !DOMAIN_INDEX_FILES.includes(parts[0])) return null;
  const subfolder = parts[1] || null;
  if (subfolder && (subfolder.includes('..') || subfolder.includes('/') || subfolder.includes('\\') || subfolder.includes('\0'))) return null;
  return { indexFile: parts[0], subfolder };
}

function routeKeywords(query, keywords, map) {
  const fromMap = Object.keys(map.keyword_routes || {}).filter(term => {
    if (term.length < 2 || STOP_WORDS.has(term.toLowerCase())) return false;
    if (/^[\u3400-\u9fff]+$/u.test(term) && term.length < 3) return false;
    return query.toLowerCase().includes(term.toLowerCase());
  });
  return [...new Set([...keywords, ...fromMap])];
}

function findCandidateIndexes(keywords, map) {
  const candidates = {};
  for (const keyword of keywords) {
    for (const route of (Array.isArray(map.keyword_routes?.[keyword]) ? map.keyword_routes[keyword] : [map.keyword_routes?.[keyword]])) {
      const parsed = validRoute(route);
      if (!parsed) continue;
      if (!candidates[route]) candidates[route] = { ...parsed, matchedKeywords: [] };
      candidates[route].matchedKeywords.push(keyword);
    }
  }
  return candidates;
}

function chinesePhrases(text) {
  const grams = new Set();
  // Four characters avoid incidental overlaps such as 设计模型/统计模型.
  // Shorter complete terms still work through explicit query/intent vocabulary.
  for (const run of text.match(/[\u3400-\u9fff]{4,}/gu) || []) {
    for (let i = 0; i <= run.length - 4; i++) grams.add(run.slice(i, i + 4));
  }
  return grams;
}

function scoreEntryRelevance(text, keywords, grams) {
  const lower = text.toLowerCase();
  const matched = keywords.filter(keyword => !GENERIC_CJK_TERMS.has(keyword) && lower.includes(keyword.toLowerCase()));
  for (const gram of chinesePhrases(lower)) if (grams.has(gram)) matched.push(gram);
  const terms = [...new Set(matched)];
  return { score: terms.reduce((sum, term) => sum + term.length, 0), terms };
}

function verifiedSource(relPath) {
  try {
    const candidate = relPath.startsWith('/') ? resolve(relPath) : resolve(MEMORY_DIR, relPath);
    const leaf = lstatSync(candidate);
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) return null;
    const vaultRoot = realpathSync(VAULT_ROOT);
    const aliasRoot = resolve(VAULT_ROOT);
    const base = isInside(aliasRoot, candidate) ? aliasRoot : vaultRoot;
    if (!isInside(base, candidate)) return null;
    const relativeParts = relative(base, candidate).split(sep);
    let current = base;
    for (const part of relativeParts) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    const sourcePath = realpathSync(candidate);
    if (!isInside(vaultRoot, sourcePath) || !sourcePath.endsWith('.md')) return null;
    const parts = relative(vaultRoot, sourcePath).split(sep);
    if (!ALLOWED_SECTIONS.has(parts[0]) || parts.at(-1) === '_index.md' || parts.some(part => !part || part.startsWith('.')) || parts.slice(0, -1).some(part => EXCLUDED_DIRS.has(part.toLowerCase()))) return null;
    return sourcePath;
  } catch { return null; }
}

function grepIndexForEntries(indexFile, subfolder, keywords, grams) {
  if (!DOMAIN_INDEX_FILES.includes(indexFile)) return [];
  const content = readBoundedRegularFile(join(MEMORY_DIR, indexFile), MEMORY_DIR);
  if (!content) return [];
  const results = [];
  let group = null, inGroup = !subfolder;
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) { group = line.slice(3).trim(); inGroup = !subfolder || group === subfolder; continue; }
    if (!inGroup || !line.startsWith('- [') || line.includes('→ 见 MEMORY-')) continue;
    const title = line.match(/\[([^\]]+)\]/), path = line.match(/\(([^)]+)\)/);
    if (!title || !path) continue;
    const description = line.match(/—\s*(.+)$/);
    const relevance = scoreEntryRelevance(title[1] + '\n' + (description?.[1] || ''), keywords, grams);
    const sourcePath = relevance.score && verifiedSource(path[1]);
    if (!sourcePath) continue;
    results.push({ title: title[1], path: sourcePath, source_path: sourcePath, rel_path: path[1], description: description ? description[1].trim() : '', index_file: indexFile, group, score: relevance.score, matched_keywords: relevance.terms });
  }
  return results;
}

function runQuery(query, keywords, limit) {
  const map = loadIntentMap(), terms = routeKeywords(query, keywords, map), candidates = findCandidateIndexes(terms, map);
  // Seven bounded index files are cheap; a broad intent route must not hide a
  // stronger match in another domain. This remains lexical, not semantic recall.
  const targets = DOMAIN_INDEX_FILES.map(indexFile => ({ indexFile, subfolder: null, matchedKeywords: [] }));
  const grams = chinesePhrases(query);
  const found = new Map();
  for (const target of targets) for (const entry of grepIndexForEntries(target.indexFile, target.subfolder, terms, grams)) {
    const existing = found.get(entry.source_path);
    if (existing) {
      existing.score = Math.max(existing.score, entry.score);
      existing.matched_keywords = [...new Set([...existing.matched_keywords, ...entry.matched_keywords, ...target.matchedKeywords])];
    } else {
      entry.matched_keywords = [...new Set([...entry.matched_keywords, ...target.matchedKeywords])];
      found.set(entry.source_path, entry);
    }
  }
  const entries = [...found.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  return { keywords: terms, candidates, entries, evictedMatches: [] };
}

function formatMarkdown(result) {
  const lines = ['# Brain Query Results', '', `**Keywords searched:** ${result.keywords.join(', ')}`, ''];
  if (!result.entries.length) return [...lines, 'No matching entries found.'].join('\n');
  for (const entry of result.entries) lines.push(`## ${entry.title}`, entry.description ? `> ${entry.description}` : '', `- **Path:** ${entry.source_path}`, `- **Score:** ${entry.score}`, '');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const query = args.query || args.keywords || '';
  if (!query) { process.stderr.write('Error: Provide --query or --keywords\n'); process.exitCode = 1; return; }
  if (query.length > MAX_QUERY_LENGTH) { process.stderr.write(`Error: Query must be at most ${MAX_QUERY_LENGTH} characters\n`); process.exitCode = 1; return; }
  const limit = args.limit === undefined ? 20 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) { process.stderr.write('Error: --limit must be an integer from 1 to 20\n'); process.exitCode = 1; return; }
  const keywords = args.keywords ? args.keywords.split(',').map(keyword => keyword.trim()).filter(keyword => keyword.length >= 2) : tokenizeQuery(args.query);
  if (!keywords.length) { process.stderr.write('Error: No usable keywords extracted from query\n'); process.exitCode = 1; return; }
  const result = runQuery(query, keywords, limit);
  process.stdout.write(args.json ? JSON.stringify(result, null, 2) + '\n' : formatMarkdown(result) + '\n');
}

export { tokenizeQuery, chinesePhrases, scoreEntryRelevance, runQuery };

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();

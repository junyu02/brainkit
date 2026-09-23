// Bounded, read-only access to Vault source notes. This verifies the path
// around the read, but cannot make pathname checks fully TOCTOU-free.
import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync,
  readdirSync, statSync, constants,
} from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseCandidate, parseRecord } from './memory-records.mjs';
import { parseEvent } from './memory-ingestion.mjs';

const MAX_NOTE_BYTES = 16 * 1024 * 1024;
export const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
const ACTIVE_SECTIONS = new Set(['01-项目', '02-知识', '03-经验', '05-persona', '07-随笔', '09-周报']);
const UNCONFIRMED_SECTIONS = new Set(['04-对话', '08-观察']);
const EXCLUDED_DIRS = new Set(['06-归档', '99-inbox', 'raw', 'system', '00-系统', 'cache', 'node_modules', 'vendor', 'build', 'dist', 'rejected', '拒收']);
const REJECTED_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EINVAL', 'EISDIR']);
const IDENTITY = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.nlink].join(':');

function rejected(error) {
  return error && REJECTED_CODES.has(error.code);
}

function scalar(value, line) {
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error(`unsupported frontmatter string at line ${line}`); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (/^[^#[\]{}&,*!|>@].*$/.test(value)) return value.trim();
  throw new Error(`unsupported frontmatter value at line ${line}`);
}

function parseInlineArray(value, line) {
  if (!value.startsWith('[') || !value.endsWith(']')) throw new Error(`unsupported frontmatter array at line ${line}`);
  const items = value.slice(1, -1).trim();
  if (!items) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(item => ['string', 'boolean', 'number'].includes(typeof item))) return parsed;
  } catch { /* fall through to the restricted YAML-compatible form */ }
  const parts = [];
  let quote = '', escaped = false, part = '';
  for (const char of items) {
    if (quote) {
      part += char;
      if (quote === '"' && char === '\\' && !escaped) { escaped = true; continue; }
      if (char === quote && !escaped) quote = '';
      escaped = false;
    } else if (char === '"' || char === "'") { quote = char; part += char; }
    else if (char === ',') { parts.push(part); part = ''; }
    else part += char;
  }
  if (quote) throw new Error(`unterminated frontmatter array string at line ${line}`);
  parts.push(part);
  return parts.map(item => scalar(item.trim(), line));
}

export function parseFrontmatter(text) {
  if (typeof text !== 'string') throw new TypeError('frontmatter text must be a string');
  const start = text.startsWith('\uFEFF') ? 1 : 0;
  if (!text.startsWith('---', start) || !/^---\r?\n/.test(text.slice(start))) return { meta: {}, body: text };
  const headerEnd = text.indexOf('\n---', start + 4);
  if (headerEnd < 0 || !/^\n---(?:\r?\n|$)/.test(text.slice(headerEnd))) return { meta: {}, body: text, warnings: ['unterminated frontmatter'] };
  const header = text.slice(start + 4, headerEnd).replace(/\r/g, '');
  const meta = {};
  const warnings = [];
  const lines = header.split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) { index++; continue; }
    const pair = line.match(/^([^\s:][^:]*):(?:\s*(.*))?$/);
    if (!pair) { warnings.push(`unsupported frontmatter shape at line ${index + 1}`); index++; continue; }
    const [, key, raw = ''] = pair;
    if (Object.hasOwn(meta, key)) { warnings.push(`duplicate frontmatter key: ${key}`); index++; continue; }
    try {
      if (/^[>|][+-]?$/.test(raw)) {
        const block = [];
        while (++index < lines.length && /^\s+/.test(lines[index])) block.push(lines[index]);
        const indent = block.filter(item => item.trim()).reduce((min, item) => Math.min(min, item.match(/^\s*/)[0].length), Infinity);
        meta[key] = block.map(item => Number.isFinite(indent) ? item.slice(indent) : '').join(raw.startsWith('>') ? ' ' : '\n');
        continue;
      }
      if (!raw) {
        const following = [];
        while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) following.push(lines[++index]);
        if (following.every(item => /^\s+-\s+.+$/.test(item))) meta[key] = following.map(item => scalar(item.replace(/^\s+-\s+/, '').trim(), index + 1));
        else if (following.length) {
          const indent = following.filter(item => item.trim()).reduce((min, item) => Math.min(min, item.match(/^\s*/)[0].length), Infinity);
          meta[key] = following.map(item => Number.isFinite(indent) ? item.slice(indent) : '').join('\n');
        } else meta[key] = '';
      } else meta[key] = raw.startsWith('[') ? parseInlineArray(raw, index + 1) : scalar(raw, index + 1);
    } catch (error) { warnings.push(error.message); }
    index++;
  }
  const closing = text.slice(headerEnd).match(/^\n---(\r?\n|$)/);
  const bodyStart = headerEnd + 4 + closing[1].length;
  const result = { meta, body: text.slice(bodyStart) };
  if (warnings.length) result.warnings = warnings;
  return result;
}

function rootInfo(vault) {
  try {
    const root = realpathSync(vault);
    const info = statSync(root, { bigint: true });
    return info.isDirectory() ? { root, info } : null;
  } catch (error) {
    if (rejected(error)) return null;
    throw error;
  }
}

function noteParts(vaultRoot, root, path, includeUnconfirmed) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  const supplied = resolve(path);
  const aliases = [resolve(vaultRoot), root];
  let parts;
  for (const base of aliases) {
    const rel = relative(base, supplied);
    if (rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)) { parts = rel.split(sep); break; }
  }
  if (!parts || parts.length < 2 || extname(parts.at(-1)).toLowerCase() !== '.md' || parts.at(-1) === '_index.md') return null;
  const allowed = includeUnconfirmed ? new Set([...ACTIVE_SECTIONS, ...UNCONFIRMED_SECTIONS]) : ACTIVE_SECTIONS;
  if (!allowed.has(parts[0]) || parts.some(part => !part || part.startsWith('.') || EXCLUDED_DIRS.has(part.toLowerCase()))) return null;
  return parts;
}

function safeBytes(root, parts, maxBytes = MAX_NOTE_BYTES) {
  let fileFd;
  try {
    let current = root;
    for (const part of parts) {
      const next = resolve(current, part);
      const link = lstatSync(next, { bigint: true });
      if (link.isSymbolicLink()) return null;
      current = next;
    }
    fileFd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fileFd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) return null;
    const bounded = Buffer.allocUnsafe(Math.min(maxBytes + 1, Number(before.size) + 1));
    let length = 0;
    while (length < bounded.length) {
      const read = readSync(fileFd, bounded, length, bounded.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const data = bounded.subarray(0, length);
    const after = fstatSync(fileFd, { bigint: true });
    const pathname = statSync(current, { bigint: true });
    if (data.length > maxBytes || IDENTITY(before) !== IDENTITY(after) || IDENTITY(pathname) !== IDENTITY(after) || realpathSync(current) !== current) return null;
    return { data, stat: after, path: resolve(root, ...parts) };
  } catch (error) {
    if (rejected(error)) return null;
    throw error;
  } finally { if (fileFd !== undefined) try { closeSync(fileFd); } catch {} }
}

function expiry(meta, now) {
  if (typeof meta.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(meta.expires)) return false;
  return new Date(`${meta.expires}T00:00:00.000Z`).getTime() < now;
}

function diagnostic(opts, path, message) {
  if (Array.isArray(opts.diagnostics)) opts.diagnostics.push({ path, message });
}

export function readActiveNote(vault, path, opts = {}) {
  const { includeUnconfirmed = false, now = Date.now() } = opts;
  const root = rootInfo(vault);
  const parts = root && noteParts(vault, root.root, path, includeUnconfirmed);
  if (!root || !parts) return null;
  const result = safeBytes(root.root, parts);
  if (!result) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(result.data); } catch { return null; }
  const { meta, body, warnings } = parseFrontmatter(text);
  if (warnings?.length) { diagnostic(opts, result.path, warnings.join('; ')); return null; }
  if (meta.inactive === true || meta.active === false || meta.status === 'inactive') return null;
  const section = parts[0];
  return {
    id: parts.join('/'), path: result.path, title: typeof meta.title === 'string' ? meta.title : typeof meta.name === 'string' ? meta.name : typeof meta.标题 === 'string' ? meta.标题 : typeof meta.名称 === 'string' ? meta.名称 : basename(parts.at(-1), '.md'),
    description: typeof meta.description === 'string' ? meta.description : typeof meta.描述 === 'string' ? meta.描述 : typeof meta.摘要 === 'string' ? meta.摘要 : '', body, text, meta,
    source_sha256: createHash('sha256').update(result.data).digest('hex'), updated_at: new Date(Number(result.stat.mtimeMs)).toISOString(),
    trust: UNCONFIRMED_SECTIONS.has(section) ? 'observation_unconfirmed' : 'vault_source', expired: expiry(meta, now),
  };
}

// "The vault is bigger than we scan" is actionable; a bare RangeError reaches
// remote callers as operation_failed. The message carries the limit, no paths.
const scanLimit = message => Object.assign(new RangeError(message), { code: 'scan_limit' });

export function listActiveNotes(vault, opts = {}) {
  const { includeUnconfirmed = false, maxNotes = 10_000 } = opts;
  if (!Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > 10_000) throw new RangeError('maxNotes must be an integer from 1 to 10000');
  const root = rootInfo(vault);
  if (!root) return [];
  const sections = includeUnconfirmed ? [...ACTIVE_SECTIONS, ...UNCONFIRMED_SECTIONS] : [...ACTIVE_SECTIONS];
  const candidates = [];
  let scannedBytes = 0;
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_index.md') {
        scannedBytes += Number(lstatSync(path, { bigint: true }).size);
        if (scannedBytes > MAX_SCAN_BYTES) throw scanLimit(`note bytes exceed scan limit (${MAX_SCAN_BYTES})`);
        candidates.push(path);
        if (candidates.length > maxNotes) throw scanLimit(`note count exceeds maxNotes (${maxNotes})`);
      }
    }
  };
  for (const section of sections) {
    const path = resolve(root.root, section);
    try { if (!lstatSync(path).isSymbolicLink()) walk(path); } catch (error) { if (!rejected(error)) throw error; }
  }
  return candidates.map(path => readActiveNote(vault, path, opts)).filter(Boolean);
}

// Parse, not just detect: an unparseable structured body must be isolated to
// its own path here, or every consumer of this scan fails without one. No
// short-circuit — a valid record fence must not smuggle a broken event fence
// past the scan and into eventNotes.
function isStructuredBody(body) {
  const record = parseRecord(body), candidate = parseCandidate(body), event = parseEvent(body);
  return Boolean(record || candidate || event);
}

// The ledger is only a bounded discovery index. Every selected path is read
// again through readActiveNote and its current body must still be structured.
export function listStructuredNotes(vault, opts = {}) {
  const { includeUnconfirmed = true, maxNotes = 10_000 } = opts;
  if (!Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > 10_000) throw new RangeError('maxNotes must be an integer from 1 to 10000');
  const candidates = new Set();
  const renameOperations = new Map();
  for (const row of readWriteEvents(vault)) {
    if (!row.record_id && !row.event_id && !row.candidate_id) continue;
    const target = typeof row.target_path === 'string' && isAbsolute(row.target_path) ? row.target_path : null;
    const renamed = typeof row.new_path === 'string' && isAbsolute(row.new_path) ? row.new_path : null;
    if (row.action === 'deactivate') { if (target) candidates.delete(target); continue; }
    if (row.action === 'rename') {
      if (target) candidates.delete(target);
      if (renamed) candidates.add(renamed);
      if (typeof row.operation_id === 'string' && target && renamed) renameOperations.set(row.operation_id, { target, renamed });
      continue;
    }
    if (row.action === 'restore') {
      const revertedRename = typeof row.reverts_operation_id === 'string' ? renameOperations.get(row.reverts_operation_id) : null;
      if (revertedRename) {
        candidates.delete(revertedRename.renamed);
        candidates.add(revertedRename.target);
        continue;
      }
      // A restore receipt's new_path is the active rename destination when
      // present; otherwise its target_path is the restored active note.
      if (renamed) { if (target) candidates.delete(target); candidates.add(renamed); }
      else if (target) candidates.add(target);
      continue;
    }
    if (target) candidates.add(target);
    if (renamed) candidates.add(renamed);
  }
  const notes = [];
  for (const path of [...candidates].sort()) {
    if (notes.length >= maxNotes) { diagnostic(opts, path, 'structured ledger candidate limit reached'); break; }
    let note;
    try { note = readActiveNote(vault, path, { ...opts, includeUnconfirmed }); }
    catch (error) { diagnostic(opts, path, `structured ledger path read failed: ${error.message}`); continue; }
    // A path that is gone, deactivated, or outside a readable section holds no
    // identity and is not a current event; only real failures are diagnostics.
    if (!note) continue;
    let structured;
    try { structured = isStructuredBody(note.body); }
    catch (error) { diagnostic(opts, path, `structured ledger body is invalid: ${error.message}`); continue; }
    if (!structured) { diagnostic(opts, path, 'structured ledger path no longer contains a structured body'); continue; }
    notes.push(note);
  }
  return notes;
}

export function readWriteEvents(vault, { maxBytes = MAX_LEDGER_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LEDGER_BYTES) throw new RangeError(`maxBytes must be an integer from 1 to ${MAX_LEDGER_BYTES}`);
  const root = rootInfo(vault);
  if (!root) return [];
  const parts = ['00-系统', 'logs', 'brain-write-ledger.jsonl'];
  let info;
  try { info = lstatSync(resolve(root.root, ...parts)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = safeBytes(root.root, parts, maxBytes);
  if (!result) {
    // Carry a code so doctor can name the ledger instead of reporting "Error",
    // and separate "too big, split it" from "wrong kind of file, inspect it".
    const oversize = Number(info.size) > maxBytes;
    const error = new Error(oversize
      ? `brain-write ledger exceeds its ${maxBytes} byte limit`
      : 'brain-write ledger is not a safe regular UTF-8 file');
    error.code = oversize ? 'ledger_too_large' : 'ledger_unsafe';
    throw error;
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(result.data); } catch { throw new Error('brain-write ledger is not valid UTF-8'); }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error(index === lines.length - 1 ? 'brain-write ledger ends with incomplete JSON; retry after the writer completes' : `invalid brain-write ledger JSON at line ${index + 1}`); }
    if (event && typeof event === 'object' && event.status === 'ok' && typeof event.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(event.ts) && !Number.isNaN(Date.parse(event.ts))) events.push(event);
  }
  return events;
}

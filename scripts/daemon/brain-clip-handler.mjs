#!/usr/bin/env node
// brain-clip-handler.mjs -- Clipboard monitoring daemon for Second Brain
// Polls macOS clipboard every 2s, detects new screenshots, processes via DeepSeek,
// reviews capture value before ingestion; unresolved candidates stay in raw/pending/.
// Zero npm dependencies -- only node:* built-ins.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
         renameSync, unlinkSync, appendFileSync, statSync, lstatSync } from 'node:fs';
import { join, dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  classifyClipText, classifyClipImage, readClipImage, clipDisposition, rejectPendingClip,
  createExclusiveLock,
  makeTimestamp,
  stripHtml,
  htmlToMarkdown,
  assertInsideVault,
} from '../lib/clip-utils.mjs';
import { loadClipEnv, isMain } from '../lib/plist-render.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VAULT_ROOT = resolve(process.env.BRAIN_VAULT_ROOT || resolve(__dirname, '..', '..', '..'));

const HELPER_BIN      = join(VAULT_ROOT, '00-系统', 'scripts', 'bin', 'brain-clip-helper');
const RAW_DIR         = join(VAULT_ROOT, 'raw');
const PENDING_DIR     = join(VAULT_ROOT, 'raw', 'pending');
const ATTACHMENTS_DIR = join(VAULT_ROOT, '00-系统', 'attachments');
const BRAIN_WRITE      = join(VAULT_ROOT, '00-系统', 'scripts', 'cli', 'brain-write.mjs');
const STATE_FILE      = join(homedir(), '.second-brain-clip-state.json');
const LOG_DIR         = join(homedir(), 'Library', 'Logs', 'second-brain');
const LOG_PATH        = join(LOG_DIR, 'clip-daemon.log');
const LOG_MAX_BYTES   = 1_048_576; // 1MB rotation
const POLL_INTERVAL_MS = 2000;

const clipEnv = loadClipEnv();
const DEEPSEEK_API_KEY = clipEnv.DEEPSEEK_API_KEY;

// --- State Management ---

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastChangeCount: -1 }; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

let lastChangeCount = loadState().lastChangeCount ?? -1;
let lastContentSig = ''; // content dedup: skip if same content arrives twice
const clipLock = createExclusiveLock();
const runExclusive = fn => clipLock.runExclusive(fn).catch(err => log(`[ERROR] ${err.message}`));

// --- Logging (with rotation) ---

function log(msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_PATH).size >= LOG_MAX_BYTES) writeFileSync(LOG_PATH, '');
    } catch { /* file doesn't exist yet */ }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* never crash on log */ }
}

// --- ERRORS.md Logging ---

const ERRORS_MD_PATH = join(VAULT_ROOT, '00-系统', 'ERRORS.md');

function appendErrorLog(stage, message) {
  try {
    appendFileSync(ERRORS_MD_PATH, `- ${new Date().toISOString()} [clip-daemon/${stage}] ${message}\n`);
  } catch { /* never crash on error logging */ }
}

// --- Atomic File Write ---

function atomicWriteFileSync(filePath, content, encoding) {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, content, encoding);
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    // Cross-device fallback: copy then delete
    writeFileSync(filePath, readFileSync(tmp, encoding), encoding);
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// --- DeepSeek API Call ---

// --- DeepSeek Text Classification ---

function rejectUnwantedText(ts, llm, text) {
  const decision = clipDisposition(llm, text);
  if (decision.action === 'reject') {
    try {
      rejectPendingClip(BRAIN_WRITE, ts, 'clip', decision.reason, Buffer.isBuffer(text) ? createHash('sha256').update(text).digest('hex') : undefined);
      log(`[REJECTED] ${ts}: ${decision.reason}`);
      return true;
    } catch (err) {
      // The pending file already owns this capture; observe retries rejection.
      log(`[REJECT-RETRY] ${ts}: ${err.message}`);
    }
  }
  return false;
}

// --- Merge Candidate Search (D-05) ---

function findMergeCandidate(keywords, targetLayer) {
  const layerDir = join(VAULT_ROOT, targetLayer);
  if (!existsSync(layerDir)) return null;
  try {
    const files = readdirSync(layerDir).filter(f => f.endsWith('.md') && f !== '_index.md');
    for (const file of files) {
      const filePath = join(layerDir, file);
      const content = readFileSync(filePath, 'utf8');
      const titleMatch = content.match(/^title:\s*(.+)$/m);
      const fileTitle = (titleMatch?.[1] || file.replace('.md', '')).toLowerCase();
      const hit = keywords.some(kw => fileTitle.includes(kw.toLowerCase()));
      if (hit) return { filePath, filename: file, layer: targetLayer };
    }
  } catch { /* skip on error */ }
  return null;
}

// --- Note Writing (D-03 and D-05) ---

const CLIP_WRITE_TYPES = new Map([
  ['02-知识', 'reference'],
  ['03-经验', 'experience'],
  ['07-随笔', 'note'],
]);

function argSafe(value, fallback) {
  const normalized = String(value ?? '').replace(/^[-\s]+/, '').trim();
  return normalized || fallback;
}

function buildNoteBody(llm, attachmentFilename) {
  const captured = new Date().toISOString().slice(0, 19);
  return [
    `Captured: ${captured}`,
    `**理解：** ${llm.summary}`,
    '',
    '## 提取文字',
    llm.ocr_text || '(无文字内容)',
    '',
    '## 原始截图',
    `![[00-系统/attachments/${attachmentFilename}]]`,
  ].join('\n') + '\n';
}

function writeClipNote(llm, attachmentFilename, relatedNote) {
  const type = CLIP_WRITE_TYPES.get(llm.vault_layer);
  if (!type) throw new Error(`Unsupported clip layer: ${llm.vault_layer}`);
  const attachmentRel = `00-系统/attachments/${attachmentFilename}`;
  const provenance = `clip screenshot ${attachmentFilename} via brain-clip-handler.mjs`
    + (relatedNote ? `; related ${relatedNote.layer}/${relatedNote.filename}` : '');
  const args = [
    BRAIN_WRITE,
    '--type', type,
    '--source', 'clip',
    '--title', argSafe(llm.title, '剪藏'),
    '--description', argSafe(String(llm.summary || llm.ocr_text || '剪藏').slice(0, 150), '剪藏'),
    '--files', attachmentRel,
    '--provenance', provenance,
    '--clip-id', attachmentFilename.replace(/\.png$/, ''),
    '--clip-image-sha256', llm.curator_sha256,
    '--clip-sha256', createHash('sha256').update(readFileSync(join(PENDING_DIR, `${attachmentFilename.replace(/\.png$/, '')}.json`))).digest('hex'),
  ];
  const result = spawnSync(process.execPath, args, {
    input: buildNoteBody(llm, attachmentFilename),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || result.error?.message || `brain-write exited ${result.status}`).trim());
  }
  let receipt;
  try { receipt = JSON.parse(result.stdout); }
  catch (error) { throw new Error(`Invalid brain-write receipt: ${error.message}`); }
  if (receipt.status !== 'ok' || typeof receipt.path !== 'string') {
    throw new Error('Invalid brain-write receipt: expected status=ok and path');
  }
  return receipt;
}

function queueImagePending(ts, llm, reason, error = null) {
  const pendingData = {
    timestamp: new Date().toISOString(),
    filename: ts,
    imagePath: `raw/${ts}.png`,
    llm,
    reason,
    ...(error ? { error } : {}),
    processedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  mkdirSync(PENDING_DIR, { recursive: true });
  atomicWriteFileSync(join(PENDING_DIR, `${ts}.json`), JSON.stringify(pendingData, null, 2), 'utf8');
}


// --- HTML Processing Pipeline ---

function retainCapture(bytes, extension) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const path = join(RAW_DIR, 'processed', 'clip-originals', `${digest}.${extension}`);
  assertInsideVault(path, VAULT_ROOT);
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || !readFileSync(path).equals(bytes)) throw new Error('capture original identity mismatch');
  }
  return relative(VAULT_ROOT, path);
}

function quarantineEncoding(bytes, format, error) {
  const originalPath = retainCapture(bytes, format);
  const path = join(RAW_DIR, 'processed', 'clip-encoding-errors', `${makeTimestamp()}-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.json`);
  assertInsideVault(path, VAULT_ROOT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ originalPath, format, error: error.message, status: 'encoding-error', timestamp: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  log(`[ENCODING-ERROR] ${originalPath}: ${error.message}; original retained outside pending`);
}

function readClipboardText() {
  // pbpaste can replace Chinese with valid ASCII '?' before decoding unless
  // its output locale is fixed. A UTF-8 validator alone cannot detect that loss.
  let bytes;
  try {
    bytes = execFileSync('/usr/bin/pbpaste', ['-Prefer', 'txt'], {
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
      timeout: 5000, maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (Buffer.isBuffer(error.stdout) && error.stdout.length) quarantineEncoding(error.stdout, 'bin', new Error('pbpaste failed; retained output may be partial'));
    throw error;
  }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) { quarantineEncoding(bytes, 'bin', error); throw error; }
}

function readHtmlCompanion(changeCount) {
  const checkPath = join(RAW_DIR, `tmp-clip-check-${randomUUID()}.png`);
  let owned = false;
  try {
    const text = readClipboardText();
    assertInsideVault(checkPath, VAULT_ROOT);
    writeFileSync(checkPath, '', { flag: 'wx', mode: 0o600 });
    owned = true;
    let result;
    try { result = execFileSync(HELPER_BIN, [checkPath], { encoding: 'utf8', timeout: 5000 }); }
    catch (error) { if (error.status !== 2) throw error; result = error.stdout; }
    // A second count read brackets pbpaste. Never attach text copied after
    // the helper captured the HTML, or pbpaste's RTF/PostScript fallback.
    if (Number(String(result).trim().split(':').at(-1)) !== changeCount || /^\s*(?:\{\\rtf|%!PS)/.test(text)) return undefined;
    return text;
  } catch (error) {
    log(`[HTML-TEXT-UNAVAILABLE] ${error.message}`);
    return undefined;
  } finally { if (owned && existsSync(checkPath)) unlinkSync(checkPath); }
}

async function processHtml(tmpPath, verifiedText) {
  const ts = makeTimestamp();
  let html, bytes, originalPath;
  try {
    assertInsideVault(tmpPath, VAULT_ROOT);
    bytes = readFileSync(tmpPath);
    originalPath = retainCapture(bytes, 'html');
    unlinkSync(tmpPath);
  } catch (err) {
    log(`[ERROR] processHtml read: ${err.message}`);
    appendErrorLog('processHtml', `read failed: ${err.message}`);
    throw err;
  }

  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const declarations = [...html.matchAll(/<meta\b[^>]*\bcharset\s*=\s*["']?\s*([\w-]+)/gi),
      ...html.matchAll(/<\?xml\b[^>]*\bencoding\s*=\s*["']\s*([\w-]+)/gi)];
    if (declarations.some(match => !/^utf-?8$/i.test(match[1]))) throw new Error('HTML declares a non-UTF-8 encoding');
  } catch (error) {
    quarantineEncoding(bytes, 'html', error);
    if (verifiedText !== undefined) await processText(verifiedText);
    return;
  }

  // Preserve image URLs as links; capture must not request third-party URLs.
  const markdownBody = htmlToMarkdown(html);
  const plainText = verifiedText ?? stripHtml(html);

  if (plainText.length < 200) {
    log(`[SKIP-HTML] too short after strip (${plainText.length} chars)`);
    return;
  }

  // Call DeepSeek for summary and classification
  const apiKey = DEEPSEEK_API_KEY;
  let llm;
  if (apiKey) {
    try {
      llm = await classifyClipText(plainText, clipEnv);
      log(`[DEEPSEEK-HTML] ${ts} -> layer=${llm.vault_layer} confidence=${llm.confidence}`);
    } catch (err) {
      log(`[DEEPSEEK-HTML-ERROR] ${ts}: ${err.message}`);
    }
  }

  // Fallback if DeepSeek unavailable
  if (!llm) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    llm = {
      title: titleMatch ? titleMatch[1].trim().slice(0, 60) : `网页内容 ${ts}`,
      summary: plainText.slice(0, 200),
      vault_layer: '02-知识',
      note_type: 'reference',
      confidence: 0,
      merge_keywords: [],
      reasoning: '审阅服务不可用，原文保留待重试，尚未批准入库'
    };
  }

  const pendingData = {
    timestamp: new Date().toISOString(),
    filename: ts,
    imagePath: null,
    originalPath,
    text: plainText,
    markdown: markdownBody,
    imageCount: 0,
    llm,
    reason: 'user_clip',
    processedAt: new Date().toISOString(),
    schemaVersion: 2
  };
  mkdirSync(PENDING_DIR, { recursive: true });
  atomicWriteFileSync(join(PENDING_DIR, `${ts}.json`), JSON.stringify(pendingData, null, 2), 'utf8');
  if (rejectUnwantedText(ts, llm, plainText)) return;
  log(`[PENDING-HTML] ${ts} "${llm.title}" (${plainText.length} chars; remote image URLs retained)`);
}

// --- Image Processing Pipeline ---

async function processImage(tmpPath) {
  assertInsideVault(tmpPath, VAULT_ROOT);
  retainCapture(readFileSync(tmpPath), 'png');
  const ts = makeTimestamp();
  const rawImagePath = join(RAW_DIR, `${ts}.png`);
  const attachmentFilename = `${ts}.png`;
  // Move tmp to raw/ for stable processing reference
  assertInsideVault(rawImagePath, VAULT_ROOT);
  renameSync(tmpPath, rawImagePath);

  let llm = null;
  try {
    const imageBytes = readClipImage(rawImagePath, VAULT_ROOT);
    log(`[DEEPSEEK] calling for ${ts}`);
    llm = await classifyClipImage(imageBytes, clipEnv);
    log(`[DEEPSEEK] ${ts} -> layer=${llm.vault_layer} confidence=${llm.confidence}`);

    const decision = clipDisposition(llm, imageBytes);
    queueImagePending(ts, llm, decision.action);
    if (!readClipImage(rawImagePath, VAULT_ROOT).equals(imageBytes)) throw new Error('图片在审阅后发生变化；保留候选重新审阅');
    if (rejectUnwantedText(ts, llm, imageBytes)) return;
    if (decision.action === 'accept') {
      const mergeCandidate = findMergeCandidate(llm.merge_keywords || [], llm.vault_layer);
      let receipt;
      try {
        receipt = writeClipNote(llm, attachmentFilename, mergeCandidate);
      } catch (error) {
        log(`[PIPELINE ERROR] ${ts}: ${error.message}; pending retained`);
        appendErrorLog('pipeline-write', `${ts}: ${error.message}`);
        return;
      }
      if (mergeCandidate) log(`[RELATED] created independent note for ${mergeCandidate.filename}: ${receipt.path}`);
      else log(`[NEW NOTE] ${receipt.path}`);
      if (receipt.inbox_redirect) log(`[INBOX REDIRECT] ${ts} -> ${receipt.inbox_redirect.to}`);
      log(`[DONE] ${ts} -> attachments/${attachmentFilename}`);

    } else {
      // LOW CONFIDENCE: write pending JSON, keep image in raw/
      queueImagePending(ts, llm, 'low_confidence');
      log(`[PENDING] ${ts} (confidence=${llm.confidence})`);
    }

  } catch (err) {
    log(`[ERROR] processImage ${ts}: ${err.message}`);
    appendErrorLog('processImage', `${ts}: ${err.message}`);
    // Create retriable pending entry instead of leaving orphan raw file
    try {
      const reason = llm ? 'storage_failure' : 'api_failure';
      if (!existsSync(join(PENDING_DIR, `${ts}.json`))) queueImagePending(ts, llm, reason, err.message);
      log(`[PENDING-RETRY] ${ts} (${reason}: ${err.message})`);
    } catch (writeErr) {
      log(`[ERROR] failed to write pending: ${writeErr.message}`);
      throw writeErr;
    }
  }
}

// --- Text Processing Pipeline ---

async function processText(text) {
  const ts = makeTimestamp();
  const originalPath = retainCapture(Buffer.from(text, 'utf8'), 'txt');

  // Smart length gate: skip short unstructured text to reduce pending-queue noise
  if (text.length < 200) {
    const hasCode = /`|[{}]|=>|\b(function|def|import|const|let|class)\s/.test(text);
    const hasShell = /(^|\n)\s*[\$>#]\s/.test(text)
      || /(^|\n)\s*(git|npm|pnpm|brew|cd|curl|sudo|node|python|docker)\s/.test(text);
    const nonEmptyLines = text.split('\n').filter(l => l.trim().length > 0).length;
    const isMultiLine = nonEmptyLines >= 3;

    if (!hasCode && !hasShell && !isMultiLine) {
      log(`[SKIP-TEXT-SHORT] unstructured text too short (${text.length} chars, ${nonEmptyLines} lines)`);
      return;
    }
    log(`[TEXT-EXEMPT] short but structured (${text.length} chars, code=${hasCode} shell=${hasShell} multiline=${isMultiLine})`);
  }

  // Call DeepSeek for summary and classification
  const apiKey = DEEPSEEK_API_KEY;
  let llm;
  if (apiKey) {
    try {
      llm = await classifyClipText(text, clipEnv);
      log(`[DEEPSEEK-TEXT] ${ts} -> layer=${llm.vault_layer} confidence=${llm.confidence}`);
    } catch (err) {
      log(`[DEEPSEEK-TEXT-ERROR] ${ts}: ${err.message}`);
    }
  }

  // Fallback if DeepSeek unavailable
  if (!llm) {
    const firstLine = text.split('\n').find(l => l.trim()) || text;
    llm = {
      title: firstLine.trim().slice(0, 60),
      summary: text.slice(0, 200),
      vault_layer: '03-经验',
      note_type: 'reference',
      confidence: 0,
      merge_keywords: [],
      reasoning: '审阅服务不可用，原文保留待重试，尚未批准入库'
    };
  }

  const pendingData = {
    timestamp: new Date().toISOString(),
    filename: ts,
    imagePath: null,
    originalPath,
    text,
    llm,
    reason: 'user_clip',
    processedAt: new Date().toISOString(),
    schemaVersion: 2
  };
  mkdirSync(PENDING_DIR, { recursive: true });
  atomicWriteFileSync(join(PENDING_DIR, `${ts}.json`), JSON.stringify(pendingData, null, 2), 'utf8');
  if (rejectUnwantedText(ts, llm, text)) return;
  log(`[PENDING-TEXT] ${ts} "${llm.title}" (${text.length} chars)`);
}

// --- Poll Loop ---

async function pollClipboard() {
  if (clipLock.isLocked()) return;
  const tmpPath = join(RAW_DIR, `tmp-clip-${Date.now()}.png`);
  let output;
  try {
    output = execFileSync(HELPER_BIN, [tmpPath], { encoding: 'utf8' }).trim();
  } catch (err) {
    // exit code 2 (NO_IMAGE) lands here too -- read stdout
    output = (err.stdout || '').trim() || `NO_IMAGE:${lastChangeCount}`;
  }

  const parts = output.split(':');
  const status = parts[0];
  const changeCount = parseInt(parts[parts.length - 1], 10);

  if (isNaN(changeCount) || changeCount === lastChangeCount) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    return;
  }

  await runExclusive(async () => {
    let sig = lastContentSig;
    if (status === 'OK' || status === 'HTML') {
      assertInsideVault(tmpPath, VAULT_ROOT);
      sig = status + ':' + createHash('sha256').update(readFileSync(tmpPath)).digest('hex');
      if (sig === lastContentSig) unlinkSync(tmpPath);
      else if (status === 'OK') await processImage(tmpPath);
      else await processHtml(tmpPath, readHtmlCompanion(changeCount));
    } else {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
      const text = readClipboardText();
      // Keep the existing short-copy policy; failures must remain retryable.
      if (text.length >= 200) {
        sig = 'txt:' + createHash('sha256').update(text).digest('hex');
        if (sig !== lastContentSig) await processText(text);
      }
    }
    saveState({ lastChangeCount: changeCount, processedAt: new Date().toISOString() });
    lastChangeCount = changeCount;
    lastContentSig = sig;
  });
}

// --- Startup ---

// HARD-05: Validate Swift binary compatibility at startup
function validateSwiftBinary() {
  if (!existsSync(HELPER_BIN)) {
    const msg = `Swift binary not found at ${HELPER_BIN} — run: swiftc "${HELPER_BIN}.swift" -o "${HELPER_BIN}"`;
    log(`[FATAL] ${msg}`);
    appendErrorLog('startup', msg);
    console.error(msg);
    process.exit(1);
  }
  // Test-run the binary to verify it's compatible with current macOS
  try {
    execFileSync(HELPER_BIN, ['/dev/null'], { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    // exit code 2 (NO_IMAGE) is expected and OK — binary works
    if (err.status === 2) return;
    // Any other failure means binary is incompatible
    const msg = `Swift binary incompatible or corrupted — recompile: swiftc "${HELPER_BIN}.swift" -o "${HELPER_BIN}" | Error: ${err.message}`;
    log(`[FATAL] ${msg}`);
    appendErrorLog('startup', msg);
    console.error(msg);
    process.exit(1);
  }
}

export { processHtml, processText, readClipboardText, readHtmlCompanion, pollClipboard };

if (isMain(import.meta.url)) {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(PENDING_DIR, { recursive: true });
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  log(`[DAEMON START] pid=${process.pid}`);
  validateSwiftBinary();
  setInterval(pollClipboard, POLL_INTERVAL_MS);
}

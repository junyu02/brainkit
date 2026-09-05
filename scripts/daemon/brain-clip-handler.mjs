#!/usr/bin/env node
// brain-clip-handler.mjs -- Clipboard monitoring daemon for Second Brain
// Polls macOS clipboard every 2s, detects new screenshots, processes via DeepSeek,
// routes notes into the correct vault layer. Low-confidence items go to raw/pending/.
// Zero npm dependencies -- only node:* built-ins.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
         renameSync, unlinkSync, appendFileSync, statSync, createWriteStream } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import {
  callDeepSeek,
  callDeepSeekVision,
  createExclusiveLock,
  makeTimestamp,
  stripHtml,
  htmlToMarkdown,
} from '../lib/clip-utils.mjs';
import { loadClipEnv } from '../lib/plist-render.mjs';

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
const CONFIDENCE_THRESHOLD = 0.9;       // image: auto-commit only at ≥0.9
const TEXT_ALWAYS_PENDING = true;       // text: always queue for human review

const clipEnv = loadClipEnv();
const DEEPSEEK_API_KEY = clipEnv.DEEPSEEK_API_KEY;
const CLIP_VISION_MODEL = clipEnv.CLIP_VISION_MODEL || 'deepseek-v4-flash-vision-exp';
const CLIP_TEXT_MODEL = clipEnv.CLIP_TEXT_MODEL || 'deepseek-v4-flash';
const CLIP_API_BASE = clipEnv.CLIP_API_BASE || 'https://api.deepseek.com';

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

const CLASSIFICATION_PROMPT = `You are a knowledge curator for a personal Obsidian vault.
Rule: filter aggressively. Only save content worth referencing 6 months from now.

---

STEP 1 — DISCARD CHECK
Discard immediately (vault_layer = "discard", confidence = 0.1) if the screenshot is ANY of:
- Chat, messaging app, social media feed
- System UI: menus, settings panel, desktop, dock
- Notification banner, status bar, loading/error screen
- Generic webpage, app store page, product homepage
- Code editor/IDE with no specific reusable lesson
- Appears accidental, partial, or unclear in purpose
- Cannot identify knowledge value within 5 seconds

If discarded → fill remaining fields minimally and stop.

STEP 2 — CLASSIFY (skip if discarded)
Pick exactly one:
  "02-知识"  → technical documentation, API reference, tool guide, reusable concept
  "03-经验"  → specific lesson learned, debugging solution, workflow improvement with a clear takeaway
  "07-随笔"  → meaningful quote, idea, or inspiration worth keeping (NOT random observations)

STEP 3 — CONFIDENCE
  0.9+    clearly valuable AND classification is certain
  0.7–0.8  valuable but layer choice is uncertain → still auto-commits
  <0.7    marginal value → routes to pending queue for human review

---

Return strict json (no markdown wrapper):
{
  "title": "中文标题，提炼核心主题（非'网页内容'等占位符），max 60 chars",
  "summary": "1–3 sentences: core value and use case of this screenshot",
  "ocr_text": "all visible text verbatim, empty string if none",
  "vault_layer": "02-知识 | 03-经验 | 07-随笔 | discard",
  "note_type": "reference | feedback | journal",
  "confidence": 0.0,
  "merge_keywords": ["2–5 terms to match against existing note titles"],
  "reasoning": "one sentence: why this classification"
}`;

// --- DeepSeek Text Classification ---

const TEXT_CLASSIFICATION_PROMPT = `You are a knowledge curator for a personal Obsidian vault.
Rule: filter aggressively. Only save content worth referencing 6 months from now.

Classify the following text content and return strict json (no markdown wrapper):
{
  "title": "中文标题，提炼核心主题（非'网页内容'等占位符），max 60 chars",
  "summary": "1–3 sentences: core value and use case of this content",
  "vault_layer": "02-知识 | 03-经验 | 07-随笔",
  "note_type": "reference | feedback | journal",
  "confidence": 0.95,
  "merge_keywords": ["2–5 terms to match against existing note titles"],
  "reasoning": "one sentence: why this classification"
}

Layer guide:
  "02-知识"  → technical documentation, API reference, tool guide, reusable concept
  "03-经验"  → specific lesson learned, debugging solution, workflow improvement with a clear takeaway
  "07-随笔"  → meaningful quote, idea, or inspiration worth keeping

Text content:
---
`;

async function callDeepSeekText(apiKey, text) {
  const content = await callDeepSeek({
    apiBase: CLIP_API_BASE,
    apiKey,
    model: CLIP_TEXT_MODEL,
    messages: [{ role: 'user', content: TEXT_CLASSIFICATION_PROMPT + text }],
    json: true,
    timeoutMs: 30_000,
  });
  return JSON.parse(content.replace(/^```json\n?|\n?```$/g, '').trim());
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

function downloadImage(url, destPath) {
  return new Promise((resolve) => {
    // Skip data: URIs
    if (url.startsWith('data:')) { resolve(false); return; }

    const doRequest = (targetUrl, redirectsLeft) => {
      if (redirectsLeft <= 0) { resolve(false); return; }

      const isHttps = targetUrl.startsWith('https');
      const reqFn = isHttps ? request : httpRequest;
      let urlObj;
      try { urlObj = new URL(targetUrl); }
      catch { resolve(false); return; }

      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        timeout: 10000,
      };

      const req = reqFn(options, (res) => {
        // Follow redirects
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          const nextUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${urlObj.protocol}//${urlObj.host}${res.headers.location}`;
          res.resume(); // discard body
          doRequest(nextUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }

        // Validate Content-Type is an image
        const contentType = (res.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('image/')) {
          res.resume();
          resolve(false);
          return;
        }

        // Reject if Content-Length exceeds 10MB
        const MAX_BYTES = 10_485_760;
        const declaredSize = parseInt(res.headers['content-length'], 10);
        if (declaredSize > MAX_BYTES) {
          res.resume();
          resolve(false);
          return;
        }

        // Stream with running byte counter to enforce 10MB limit mid-download
        const ws = createWriteStream(destPath);
        let bytesReceived = 0;
        res.on('data', (chunk) => {
          bytesReceived += chunk.length;
          if (bytesReceived > MAX_BYTES) {
            res.destroy();
            ws.destroy();
            try { unlinkSync(destPath); } catch { /* partial file cleanup */ }
            resolve(false);
          }
        });
        res.pipe(ws);
        ws.on('finish', () => resolve(true));
        ws.on('error', () => {
          try { unlinkSync(destPath); } catch { /* cleanup */ }
          resolve(false);
        });
      });

      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    };

    doRequest(url, 3);
  });
}

async function extractAndDownloadImages(html, timestamp) {
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;
  const images = [];
  while ((match = imgRegex.exec(html)) !== null) {
    images.push({ fullTag: match[0], src: match[1] });
  }

  let result = html;
  let imageCount = 0;

  for (let i = 0; i < images.length; i++) {
    const { fullTag, src } = images[i];

    // Only download http/https images
    if (!src.startsWith('http://') && !src.startsWith('https://')) {
      continue;
    }

    const urlExt = extname(new URL(src).pathname).slice(1) || 'png';
    const ext = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(urlExt.toLowerCase()) ? urlExt.toLowerCase() : 'png';
    const filename = `${timestamp}-img-${i}.${ext}`;
    const destPath = join(ATTACHMENTS_DIR, filename);

    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const success = await downloadImage(src, destPath);

    if (success) {
      result = result.replace(fullTag, `![[00-系统/attachments/${filename}]]`);
      imageCount++;
    } else {
      result = result.replace(fullTag, `![image](${src})`);
    }
  }

  return { markdown: result, imageCount };
}

// --- HTML Processing Pipeline ---

async function processHtml(tmpPath) {
  const ts = makeTimestamp();
  let html;
  try {
    const buf = readFileSync(tmpPath);
    html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    unlinkSync(tmpPath);
  } catch (err) {
    log(`[ERROR] processHtml read: ${err.message}`);
    appendErrorLog('processHtml', `read failed: ${err.message}`);
    return;
  }

  // Extract and download images BEFORE converting to markdown
  const { markdown: htmlWithLocalImages, imageCount } = await extractAndDownloadImages(html, ts);

  // Convert to Markdown
  const markdownBody = htmlToMarkdown(htmlWithLocalImages);
  const plainText = stripHtml(html);

  if (plainText.length < 200) {
    log(`[SKIP-HTML] too short after strip (${plainText.length} chars)`);
    return;
  }

  // Call DeepSeek for summary and classification
  const apiKey = DEEPSEEK_API_KEY;
  let llm;
  if (apiKey) {
    try {
      llm = await callDeepSeekText(apiKey, plainText.slice(0, 3000));
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
      confidence: 1.0,
      merge_keywords: [],
      reasoning: 'Rich text copied by user — DeepSeek unavailable, fallback used'
    };
  }

  const pendingData = {
    timestamp: new Date().toISOString(),
    filename: ts,
    imagePath: null,
    text: plainText,
    markdown: markdownBody,
    imageCount,
    llm,
    reason: 'user_clip',
    processedAt: new Date().toISOString(),
    schemaVersion: 2
  };
  mkdirSync(PENDING_DIR, { recursive: true });
  atomicWriteFileSync(join(PENDING_DIR, `${ts}.json`), JSON.stringify(pendingData, null, 2), 'utf8');
  log(`[PENDING-HTML] ${ts} "${llm.title}" (${plainText.length} chars, ${imageCount} images)`);
}

// --- Image Processing Pipeline ---

async function processImage(tmpPath) {
  const ts = makeTimestamp();
  const rawImagePath = join(RAW_DIR, `${ts}.png`);
  const attachmentFilename = `${ts}.png`;
  const attachmentPath = join(ATTACHMENTS_DIR, attachmentFilename);
  const apiKey = DEEPSEEK_API_KEY;

  if (!apiKey) {
    log('[ERROR] DEEPSEEK_API_KEY not set -- cannot process image');
    appendErrorLog('startup', 'DEEPSEEK_API_KEY not set');
    unlinkSync(tmpPath);
    return;
  }

  // Move tmp to raw/ for stable processing reference
  renameSync(tmpPath, rawImagePath);

  let llm = null;
  try {
    const imageBase64 = readFileSync(rawImagePath).toString('base64');
    log(`[DEEPSEEK] calling for ${ts}`);
    llm = await callDeepSeekVision({
      apiBase: CLIP_API_BASE,
      apiKey,
      model: CLIP_VISION_MODEL,
      prompt: CLASSIFICATION_PROMPT,
      imageBase64,
      timeoutMs: 60_000,
    });
    log(`[DEEPSEEK] ${ts} -> layer=${llm.vault_layer} confidence=${llm.confidence}`);

    // DISCARD path: delete image, no files left
    if (llm.vault_layer === 'discard') {
      unlinkSync(rawImagePath);
      log(`[DISCARD] ${ts} -- no value`);
      return;
    }

    if (llm.confidence >= CONFIDENCE_THRESHOLD) {
      const mergeCandidate = findMergeCandidate(llm.merge_keywords || [], llm.vault_layer);
      let receipt;
      try {
        receipt = writeClipNote(llm, attachmentFilename, mergeCandidate);
      } catch (error) {
        log(`[PIPELINE ERROR] ${ts}: ${error.message}; pending retained`);
        appendErrorLog('pipeline-write', `${ts}: ${error.message}`);
        queueImagePending(ts, llm, 'pipeline_failure', error.message);
        return;
      }
      mkdirSync(ATTACHMENTS_DIR, { recursive: true });
      renameSync(rawImagePath, attachmentPath);
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
      queueImagePending(ts, llm, reason, err.message);
      log(`[PENDING-RETRY] ${ts} (${reason}: ${err.message})`);
    } catch (writeErr) {
      log(`[ERROR] failed to write pending: ${writeErr.message}`);
    }
  }
}

// --- Text Processing Pipeline ---

async function processText(text) {
  const ts = makeTimestamp();

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
      llm = await callDeepSeekText(apiKey, text.slice(0, 3000));
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
      confidence: 1.0,
      merge_keywords: [],
      reasoning: 'Text copied by user — DeepSeek unavailable, fallback used'
    };
  }

  const pendingData = {
    timestamp: new Date().toISOString(),
    filename: ts,
    imagePath: null,
    text,
    llm,
    reason: 'user_clip',
    processedAt: new Date().toISOString(),
    schemaVersion: 2
  };
  mkdirSync(PENDING_DIR, { recursive: true });
  atomicWriteFileSync(join(PENDING_DIR, `${ts}.json`), JSON.stringify(pendingData, null, 2), 'utf8');
  log(`[PENDING-TEXT] ${ts} "${llm.title}" (${text.length} chars)`);
}

// --- Poll Loop ---

function pollClipboard() {
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

  lastChangeCount = changeCount;
  saveState({ lastChangeCount, processedAt: new Date().toISOString() });

  if (status === 'OK') {
    // Image detected — dedup by file size
    let sig = '';
    try { sig = `img:${parts[1]}`; } catch { sig = 'img:?'; }
    if (sig === lastContentSig) {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    } else {
      lastContentSig = sig;
      runExclusive(() => processImage(tmpPath));
    }
  } else if (status === 'HTML') {
    // Rich HTML content (web page copy) — dedup by byte size
    const sig = `html:${parts[1]}`;
    if (sig === lastContentSig) {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    } else {
      lastContentSig = sig;
      runExclusive(() => processHtml(tmpPath));
    }
  } else {
    // No image, no HTML — check for plain text via pbpaste
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    try {
      const buf = execFileSync('/usr/bin/pbpaste', []);
      let text;
      const utf8 = new TextDecoder('utf-8', { fatal: true });
      try {
        text = utf8.decode(buf).trim();
      } catch {
        text = new TextDecoder('gbk').decode(buf).trim();
        log('[INFO] clipboard decoded as GBK');
      }
      if (text.length >= 200) {
        const sig = 'txt:' + createHash('sha256').update(text).digest('hex').slice(0, 16);
        if (sig !== lastContentSig) {
          lastContentSig = sig;
          runExclusive(() => processText(text));
        }
      }
    } catch { /* pbpaste failed, ignore */ }
  }
}

// --- Startup ---

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(PENDING_DIR, { recursive: true });
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

log(`[DAEMON START] pid=${process.pid}`);

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

validateSwiftBinary();

setInterval(pollClipboard, POLL_INTERVAL_MS);

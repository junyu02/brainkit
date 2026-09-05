// clip-utils.mjs -- Shared clipboard utilities and DeepSeek client.
// Shared between handler, CLI, and tests. Zero npm dependencies.

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { validateApiBase } from './plist-render.mjs';

const DEFAULT_DEEPSEEK_TIMEOUT_MS = 60_000;

export function callDeepSeek({
  apiBase = 'https://api.deepseek.com',
  apiKey,
  model,
  messages,
  json = false,
  requestImpl,
  temperature = 0.2,
  timeoutMs = DEFAULT_DEEPSEEK_TIMEOUT_MS,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('DeepSeek timeoutMs must be a positive finite number');
  }
  const validatedBase = validateApiBase(apiBase, { keyName: 'CLIP_API_BASE' });
  return new Promise((resolveCall, rejectCall) => {
    const body = JSON.stringify({
      model,
      max_tokens: 8192,
      temperature,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages,
    });
    const apiUrl = new URL(`${validatedBase.replace(/\/+$/, '')}/chat/completions`);
    const transport = requestImpl || (apiUrl.protocol === 'http:' ? httpRequest : httpsRequest);
    const request = transport(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('error', error => {
        clearTimeout(timeout);
        rejectCall(error);
      });
      response.on('end', () => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          const content = choice?.message?.content;
          if (typeof content === 'string' && content.trim()) {
            resolveCall(content.trim());
          } else if (parsed.error) {
            rejectCall(new Error(`DeepSeek error ${parsed.error.code ?? response.statusCode}: ${parsed.error.message}`));
          } else if (choice?.finish_reason === 'length') {
            rejectCall(new Error('DeepSeek returned empty content (finish_reason=length; max_tokens exhausted)'));
          } else {
            rejectCall(new Error(`Unexpected DeepSeek response (finish_reason=${choice?.finish_reason ?? 'unknown'})`));
          }
        } catch (error) {
          rejectCall(new Error(`JSON parse failed: ${error.message}`));
        }
      });
    });
    const timeout = setTimeout(() => {
      request.destroy(new Error(`DeepSeek timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    request.on('error', error => {
      clearTimeout(timeout);
      rejectCall(error);
    });
    request.write(body);
    request.end();
  });
}

export async function callDeepSeekVision({ prompt, imageBase64, ...options }) {
  const content = await callDeepSeek({
    ...options,
    json: true,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    }],
  });
  return JSON.parse(content.replace(/^```json\n?|\n?```$/g, '').trim());
}

// --- Timestamp Utility ---

export function makeTimestamp() {
  const d = new Date();
  const pad = (n, w=2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

// --- HTML Utilities ---

export function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function htmlToMarkdown(html) {
  let md = html;
  // a. Remove <style> and <script> blocks entirely
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  // b. Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  // c. Bold
  md = md.replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  // d. Italic
  md = md.replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');
  // e. Links
  md = md.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // f. Inline code
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
  // g. Pre blocks
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  // h. Blockquote
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    return content.split('\n').map(line => '> ' + line.trim()).join('\n');
  });
  // i. List items (simplified: treat all as unordered)
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n');
  // j. Line breaks
  md = md.replace(/<br\s*\/?>/gi, '\n');
  // k. Paragraphs
  md = md.replace(/<p[^>]*>/gi, '\n\n');
  md = md.replace(/<\/p>/gi, '\n');
  // l. Horizontal rule
  md = md.replace(/<hr[^>]*\/?>/gi, '\n---\n');
  // m. Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');
  // m2. Auto-detect numbered sub-headings (e.g., "1.4.1 xxx" → "#### xxx")
  //     3-level (1.2.3) → ####, 2-level (1.2) → ###, 1-level standalone skipped (handled by h1-h4)
  md = md.replace(/^(\d+\.\d+\.\d+)\s+(.+)$/gm, '#### $1 $2');
  // n. Decode HTML entities
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');
  // o. Collapse 3+ consecutive newlines to 2
  md = md.replace(/\n{3,}/g, '\n\n');
  // p. Trim
  return md.trim();
}

// --- Content Dedup Signature ---

export function contentSignature(text) {
  return 'txt:' + createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// --- Path Traversal Protection ---

const VALID_LAYERS = ['01-项目', '02-知识', '03-经验', '04-对话', '05-persona', '07-随笔'];

export function isValidTimestamp(ts) {
  return /^\d{4}-\d{2}-\d{2}-\d{6,9}$/.test(ts);
}

export function isValidLayer(layer) {
  return VALID_LAYERS.includes(layer);
}

// The deepest existing ancestor, resolved, with the not-yet-existing tail put
// back on. canonicalPath in plist-render.mjs tolerates a missing leaf but not a
// missing parent, and these targets are checked before their directories are
// created. Same shape as realpathDeep in brain-write.mjs.
function realpathDeep(p) {
  let current = resolve(p);
  const tail = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  try { current = realpathSync(current); } catch { /* unreadable: keep the resolved form */ }
  return tail.length ? join(current, ...tail) : current;
}

// resolve() only rewrites the string, so a symlink anywhere under the vault --
// a linked attachments directory, a linked pending directory -- reads as inside
// while the write or unlink lands outside it.
export function assertInsideVault(p, vaultRoot) {
  const real = realpathDeep(p);
  const realRoot = realpathDeep(vaultRoot);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(`Security: path ${real} is outside vault ${realRoot}`);
  }
}

// --- Concurrency Lock ---

export function createExclusiveLock() {
  let isProcessing = false;
  const runExclusive = (fn) => {
    if (isProcessing) return Promise.resolve('skipped');
    isProcessing = true;
    return Promise.resolve().then(fn).finally(() => { isProcessing = false; });
  };
  return { runExclusive, isLocked: () => isProcessing };
}

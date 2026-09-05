#!/usr/bin/env node
// brain-clip.mjs -- CLI control for the Second Brain clipboard daemon
// Commands: stop | status | review | approve  (stop/status for hand
// troubleshooting only)
//
// install/start are gone, not merely refused. They were a second installer:
// they wrote process.execPath into the plist -- a versioned nvm path that
// vanishes on the next node upgrade -- and rebuilt a service configuration
// the real installer owns. The Swift helper compile went with them; it was
// only ever reachable from install, and the handler already tells you the
// swiftc line to run when the binary is missing.
// node install.mjs is the only installer.

import { mkdirSync, existsSync, unlinkSync, renameSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { callDeepSeek, isValidTimestamp, isValidLayer, assertInsideVault } from '../lib/clip-utils.mjs';
import { daemonStatus, daemonStop, isMain, loadClipEnv } from '../lib/plist-render.mjs';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const BRAIN_WRITE = join(__dirname, 'brain-write.mjs');

const PLIST_LABEL = 'com.second-brain.clip';
const PLIST_PATH  = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const LOG_PATH    = join(homedir(), 'Library', 'Logs', 'second-brain', 'clip-daemon.log');

// --- status ---

function status() {
  daemonStatus(PLIST_LABEL, LOG_PATH);

  // Show pending item count
  const pendingDir = join(VAULT_ROOT, 'raw', 'pending');
  try {
    const pending = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
    if (pending.length > 0) {
      console.log(`\nPending items: ${pending.length} awaiting review`);
      for (const f of pending.slice(0, 5)) {
        try {
          const data = JSON.parse(readFileSync(join(pendingDir, f), 'utf8'));
          const conf = ((data.llm?.confidence || 0) * 100).toFixed(0);
          console.log(`  - ${data.filename} -> ${data.llm?.vault_layer} (${conf}%) -- ${data.llm?.title || 'untitled'}`);
        } catch { /* skip malformed */ }
      }
      // Show reason breakdown
      const reasons = {};
      for (const f of pending) {
        try {
          const data = JSON.parse(readFileSync(join(pendingDir, f), 'utf8'));
          const r = data.reason || 'unknown';
          reasons[r] = (reasons[r] || 0) + 1;
        } catch { /* skip */ }
      }
      if (Object.keys(reasons).length > 0) {
        console.log(`  Breakdown: ${Object.entries(reasons).map(([k,v]) => `${k}=${v}`).join(', ')}`);
      }
    } else {
      console.log('\nPending: none');
    }
  } catch { /* pending dir missing */ }
}

// --- review / approve / reject ---

const PENDING_DIR   = join(VAULT_ROOT, 'raw', 'pending');
const ATTACHMENTS   = join(VAULT_ROOT, '00-系统', 'attachments');
const CLIP_WRITE_TYPES = new Map([
  ['01-项目', 'project'],
  ['02-知识', 'reference'],
  ['03-经验', 'experience'],
  ['04-对话', 'session'],
  ['05-persona', 'user-profile'],
  ['07-随笔', 'note'],
]);

function argSafe(value, fallback) {
  const normalized = String(value ?? '').replace(/^[-\s]+/, '').trim();
  return normalized || fallback;
}

function writeClipNote(data, llm, body, attachmentRel, provenance) {
  const type = CLIP_WRITE_TYPES.get(llm.vault_layer);
  if (!type) throw new Error(`Unsupported clip layer: ${llm.vault_layer}`);
  const args = [
    BRAIN_WRITE,
    '--type', type,
    '--source', 'clip',
    '--title', argSafe(llm.title, '剪藏'),
    '--description', argSafe(String(llm.summary || body.slice(0, 120)).slice(0, 150), '剪藏'),
    '--provenance', provenance,
  ];
  if (attachmentRel) args.push('--files', attachmentRel);
  if (type === 'project' || type === 'session') {
    const project = llm.project || data.project;
    if (project) args.push('--project', argSafe(project, '剪藏'));
  }
  const result = spawnSync(process.execPath, args, {
    input: body,
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
  assertInsideVault(receipt.path, VAULT_ROOT);
  return receipt;
}

function review() {
  let files;
  try { files = readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')); }
  catch { files = []; }

  if (files.length === 0) {
    console.log('No pending items.');
    return;
  }

  console.log(`\n${files.length} pending item(s):\n`);
  files.forEach((f, i) => {
    try {
      const d = JSON.parse(readFileSync(join(PENDING_DIR, f), 'utf8'));
      const kind = d.imagePath ? '📷' : '📝';
      const conf = ((d.llm?.confidence || 0) * 100).toFixed(0);
      console.log(`[${i + 1}] ${kind} ${d.filename}`);
      console.log(`    Layer:      ${d.llm?.vault_layer}`);
      console.log(`    Title:      ${d.llm?.title}`);
      console.log(`    Confidence: ${conf}%`);
      if (d.reason) {
        const reasonLabel = d.reason === 'api_failure' ? 'API FAILURE (retryable)'
          : d.reason === 'low_confidence' ? 'Low confidence (needs review)'
          : d.reason === 'user_clip' ? 'User clip (needs review)'
          : d.reason;
        console.log(`    Reason:     ${reasonLabel}`);
      }
      console.log(`    Summary:    ${d.llm?.summary}`);
      console.log(`    Reasoning:  ${d.llm?.reasoning}`);
      console.log('');
    } catch { console.log(`[${i + 1}] ${f} (unreadable)\n`); }
  });
}

// --- DeepSeek: restructure article with headings ---

// Longest article sent for restructuring. Past this the original is kept as-is:
// the reply replaces the whole body, so a truncated input would be a silent
// deletion of everything after the cut.
const RESTRUCTURE_LIMIT = 15000;

const RESTRUCTURE_PROMPT = `你是一个 Obsidian 知识库的排版助手。

任务：给以下文章添加清晰的 Markdown 标题层级结构。

规则：
1. 用 ## 作为一级章节标题，### 作为二级，#### 作为三级
2. 标题要用中文，简洁概括该段内容
3. 保留原文所有内容，一个字都不要删改
4. 保留原文中已有的 Markdown 格式（加粗、链接、图片嵌入 ![[...]] 等）
5. 如果原文已经有清晰的标题结构，直接返回原文不做修改
6. 不要添加总结、评论、前言或任何原文没有的内容
7. 直接返回整理后的 Markdown 正文，不要加代码块包裹

文章内容：
---
`;

function readDeepSeekConfig() {
  const env = loadClipEnv();
  return {
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.CLIP_TEXT_MODEL || 'deepseek-v4-flash',
    apiBase: env.CLIP_API_BASE || 'https://api.deepseek.com',
  };
}

function callDeepSeekRestructure({ apiKey, model, apiBase }, text) {
  return callDeepSeek({
    apiBase,
    apiKey,
    model,
    messages: [{ role: 'user', content: RESTRUCTURE_PROMPT + text }],
    temperature: 0.1,
    timeoutMs: 30_000,
  });
}

async function approvePendingAsync(ts) {
  // Validate timestamp format to prevent path traversal
  if (!isValidTimestamp(ts)) {
    console.error(`Invalid timestamp format: ${ts}`);
    process.exit(1);
  }

  const jsonPath = join(PENDING_DIR, `${ts}.json`);
  if (!existsSync(jsonPath)) { console.error(`Not found: ${ts}`); process.exit(1); }

  const d = JSON.parse(readFileSync(jsonPath, 'utf8'));
  if (!d.llm) {
    console.error(`Cannot approve: no classification data (reason: ${d.reason || 'unknown'}). Reject this item or wait for DeepSeek to process it.`);
    process.exit(1);
  }
  const llm = d.llm;
  const layer = llm.vault_layer;

  // Validate vault layer
  if (!isValidLayer(layer)) {
    console.error(`Invalid vault layer: ${layer}`);
    process.exit(1);
  }

  const captured = d.timestamp?.slice(0, 19) || new Date().toISOString().slice(0, 19);
  let body;
  let attachment = null;
  let attachmentRel = null;
  let provenance;
  if (d.imagePath) {
    const imgSrc = join(VAULT_ROOT, d.imagePath);
    const imgDst = join(ATTACHMENTS, `${ts}.png`);
    assertInsideVault(imgSrc, VAULT_ROOT);
    assertInsideVault(imgDst, VAULT_ROOT);
    if (existsSync(imgSrc)) {
      attachmentRel = `00-系统/attachments/${ts}.png`;
      attachment = { source: imgSrc, target: imgDst };
    }
    body = [
      `Captured: ${captured}`,
      `**理解：** ${llm.summary}`,
      '',
      '## 提取文字',
      llm.ocr_text || '(无文字内容)',
      '',
      '## 原始截图',
      attachmentRel ? `![[${attachmentRel}]]` : '（原始截图文件缺失）',
    ].join('\n') + '\n';
    provenance = `clip pending ${basename(jsonPath)}; screenshot ${basename(d.imagePath)} via brain-clip.mjs`;
  } else {
    // Text/HTML pending — use markdown body if available, fall back to raw text
    let content = d.markdown || d.text || '';

    // Call DeepSeek to restructure long content with proper headings.
    //
    // Over the limit the article is NOT sent and NOT restructured. It used to
    // send content.slice(0, 15000) and then assign the reply over the whole of
    // `content`, so anything past 15,000 characters was dropped -- and the
    // pending JSON, the only other copy, is deleted straight after. The
    // length > content.length * 0.5 check did not catch it: a 15,000-character
    // reply comfortably clears half of a 21,000-character original.
    if (content.length > RESTRUCTURE_LIMIT) {
      console.log(`  ⚠ 原文 ${content.length} 字符，超过排版上限 ${RESTRUCTURE_LIMIT}，跳过排版并保留全文`);
    } else if (content.length > 200) {
      const deepSeek = readDeepSeekConfig();
      if (deepSeek.apiKey) {
        try {
          console.log('  Restructuring with DeepSeek...');
          const restructured = await callDeepSeekRestructure(deepSeek, content);
          if (restructured && restructured.length > content.length * 0.5) {
            content = restructured;
            console.log('  ✓ Structure added');
          }
        } catch (err) {
          console.log(`  ⚠ DeepSeek unavailable (${err.message}), using original format`);
        }
      }
    }

    body = [
      `Captured: ${captured}`,
      `**理解：** ${llm.summary}`,
      '',
      '## 原文',
      content,
    ].join('\n') + '\n';
    provenance = `clip pending ${basename(jsonPath)}; ${d.markdown ? 'web' : 'clipboard'} via brain-clip.mjs`;
  }

  let receipt;
  try {
    receipt = writeClipNote(d, llm, body, attachmentRel, provenance);
  } catch (error) {
    console.error(`[PIPELINE ERROR] ${ts}: ${error.message}; pending retained`);
    throw error;
  }
  if (attachment) {
    mkdirSync(ATTACHMENTS, { recursive: true });
    renameSync(attachment.source, attachment.target);
  }
  unlinkSync(jsonPath);

  const redirect = receipt.inbox_redirect ? `; inbox_redirect=${receipt.inbox_redirect.to}` : '';
  console.log(`✓ Approved → ${receipt.path} (pipeline=ok${redirect})`);
}

function rejectPending(ts) {
  // Validate timestamp format to prevent path traversal
  if (!isValidTimestamp(ts)) {
    console.error(`Invalid timestamp format: ${ts}`);
    process.exit(1);
  }

  const jsonPath = join(PENDING_DIR, `${ts}.json`);
  if (!existsSync(jsonPath)) { console.error(`Not found: ${ts}`); process.exit(1); }

  try {
    const d = JSON.parse(readFileSync(jsonPath, 'utf8'));
    // Clean up raw image (screenshot pending)
    if (d.imagePath) {
      const imgPath = join(VAULT_ROOT, d.imagePath);
      assertInsideVault(imgPath, VAULT_ROOT);
      if (existsSync(imgPath)) unlinkSync(imgPath);
    }
    // Clean up downloaded HTML images in attachments/
    if (d.imageCount > 0 && d.filename) {
      const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
      try {
        const files = readdirSync(ATTACHMENTS);
        for (const f of files) {
          const isMatch = imgExts.some(ext => f.startsWith(`${d.filename}-img-`) && f.endsWith(`.${ext}`));
          if (isMatch) {
            unlinkSync(join(ATTACHMENTS, f));
          }
        }
      } catch { /* attachments dir may not exist */ }
    }
  } catch { /* ignore */ }

  unlinkSync(jsonPath);
  console.log(`✗ Rejected → deleted`);
}

// --- help ---

function printHelp() {
  console.log('Usage: node brain-clip.mjs <command>');
  console.log('');
  console.log('Commands:');
  console.log('  stop             Unload daemon (plist stays installed)');
  console.log('  status           Show running state, last 5 log lines, pending count');
  console.log('  review           List all pending items with details');
  console.log('  approve <ts>     Write pending item to vault');
  console.log('  reject <ts>      Delete pending item (no vault entry)');
  console.log('');
  console.log('  stop and status are for hand troubleshooting only. The installer and');
  console.log('  publisher never consume their output: their service snapshots always come');
  console.log('  from launchctl print gui/$UID/<label> read live.');
  console.log('');
  console.log('  To install or start, run  node install.mjs install  from the brainkit clone.');
}

// --- main ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'install':
    case 'start':
      // Before anything runs: this was a second installer, not a duplicate
      // entry point. It wrote process.execPath into the plist, skipped the
      // shim check and skipped the explicit watch-root choice, so running it
      // overwrote a correct installation with a broken one.
      console.error('这个子命令已关闭：它是会覆盖正确配置的第二套安装器。请从 brainkit clone 运行 node install.mjs install');
      process.exit(1);
      break;
    case 'stop':
      daemonStop(PLIST_PATH);
      break;
    case 'status':
      status();
      break;
    case 'review':
      review();
      break;
    case 'approve':
      await approvePendingAsync(args[1]);
      break;
    case 'reject':
      console.error(`${command} 已退役；剪藏由 observe.mjs --clips 自动消化。`);
      process.exit(1);
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

// --- Guard block ---

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const MEMORY_DIR = BRAINKIT.memory;
const checkpointPath = join(VAULT_ROOT, '00-系统/.index-cache/observe-checkpoint.json');
const ledgerPath = join(VAULT_ROOT, '00-系统/logs/brain-write-ledger.jsonl');
const memoryPath = join(MEMORY_DIR, 'MEMORY.md');
const observationsPath = join(VAULT_ROOT, '08-观察');
const pendingPath = join(VAULT_ROOT, 'raw/pending');
const claudeSessionsPath = resolve(process.env.BRAIN_CLAUDE_SESSIONS_ROOT || join(homedir(), '.claude', 'projects'));
const codexSessionsPath = resolve(process.env.BRAIN_CODEX_SESSIONS_ROOT || join(homedir(), '.codex', 'sessions'));
const chronicleResourcesPath = resolve(process.env.BRAIN_CHRONICLE_ROOT || join(homedir(), '.codex', 'memories', 'extensions', 'chronicle', 'resources'));
const outputPath = join(VAULT_ROOT, '状态总览.md');
const htmlOutputPath = join(VAULT_ROOT, '状态总览.html');

const escapeMd = (value) => String(value).replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const isChronicle = (source) => source.includes('/chronicle/');
const sourceCounts = (map) => {
  const sources = Object.keys(map);
  const chronicle = sources.filter(isChronicle).length;
  return { session: sources.length - chronicle, chronicle };
};
const countFiles = (root, accepts) => {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += countFiles(path, accepts);
    else if (entry.isFile() && accepts(entry.name)) count += 1;
  }
  return count;
};
const externalError = (error) =>
  String(error.stderr?.toString().trim() || error.message).replace(/\s+/g, ' ');
const formatNumber = (value) => value.toLocaleString('zh-CN');
const formatPercent = (value) => `${value.toFixed(1).replace(/\.0$/, '')}%`;

const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
const processedCounts = sourceCounts(checkpoint.processed);
const errorCounts = sourceCounts(checkpoint.errors);
const errorGroups = new Map();
for (const error of Object.values(checkpoint.errors)) {
  assert.equal(typeof error.message, 'string', '采集错误缺少 message');
  const prefix = error.message.slice(0, 40);
  errorGroups.set(prefix, (errorGroups.get(prefix) ?? 0) + 1);
}
const topErrors = [...errorGroups]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
  .slice(0, 3);

const sessionCandidateCount =
  countFiles(
    claudeSessionsPath,
    (name) => name.endsWith('.jsonl') && !name.startsWith('agent-'),
  ) + countFiles(codexSessionsPath, (name) => name.endsWith('.jsonl'));
const chronicleCandidateCount = countFiles(chronicleResourcesPath, () => true);
const candidateCount = sessionCandidateCount + chronicleCandidateCount;
const processedCount = processedCounts.session + processedCounts.chronicle;
const progressPercent = candidateCount ? (processedCount / candidateCount) * 100 : 0;
const progressWidth = Math.min(100, Math.max(0, progressPercent));

const observationRows = readdirSync(observationsPath, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^(?:chronicle-)?\d{4}-\d{2}$/.test(entry.name))
  .map((entry) => [
    entry.name,
    readdirSync(join(observationsPath, entry.name), { withFileTypes: true }).filter(
      (file) => file.isFile() && file.name.endsWith('.md'),
    ).length,
  ])
  .sort(([a], [b]) => a.localeCompare(b));

const ledgerLines = readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean);
const ledger = ledgerLines.map((line, index) => {
  const entry = JSON.parse(line);
  const timestamp = Date.parse(entry.ts);
  assert(Number.isFinite(timestamp), `台账第 ${index + 1} 行时间戳无效`);
  return { ...entry, timestamp };
});
const cutoff = Date.now() - 24 * 60 * 60 * 1000;
const recentCounts = new Map();
const actorCounts = new Map();
for (const entry of ledger.filter(({ timestamp }) => timestamp >= cutoff)) {
  assert.equal(typeof entry.actor, 'string', '最近 24 小时台账缺少 actor');
  assert.equal(typeof entry.action, 'string', '最近 24 小时台账缺少 action');
  const key = `${entry.actor}\0${entry.action}`;
  recentCounts.set(key, (recentCounts.get(key) ?? 0) + 1);
  actorCounts.set(entry.actor, (actorCounts.get(entry.actor) ?? 0) + 1);
}
const recentRows = [...recentCounts]
  .map(([key, count]) => [...key.split('\0'), count])
  .sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
const actorOrder = ['observe', 'claude', 'codex'];
const actorRows = [
  ...actorOrder.map((actor) => [actor, actorCounts.get(actor) ?? 0]),
  ...[...actorCounts].filter(([actor]) => !actorOrder.includes(actor)).sort(([a], [b]) => a.localeCompare(b)),
];
const latestEntries = ledger.slice(-10).reverse().map((entry) => {
  assert.equal(typeof entry.target_path, 'string', '最近台账缺少 target_path');
  const file = basename(entry.target_path);
  return { ...entry, file, title: file.replace(/\.md$/, '') };
});

const memoryLines = readFileSync(memoryPath, 'utf8').split(/\r?\n/);
const hotStart = memoryLines.findIndex((line) => line.startsWith('## 🔥'));
assert(hotStart >= 0, '未找到热记忆区');
const hotEnd = memoryLines.findIndex((line, index) => index > hotStart && line.startsWith('## '));
assert(hotEnd >= 0, '未找到热记忆区结束位置');
const hotCount = memoryLines.slice(hotStart + 1, hotEnd).filter((line) => line.startsWith('- [')).length;

const mempalaceResult = spawnSync(process.env.MEMPALACE_BIN || 'mempalace', ['status'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let mempalaceUnavailable = Boolean(mempalaceResult.error || mempalaceResult.status !== 0);
let roomRows = [];
if (!mempalaceUnavailable) {
  roomRows = [...mempalaceResult.stdout.matchAll(/^\s*ROOM:\s+(.+?)\s+(\d+)\s+drawers?\s*$/gim)]
    .map(([, room, drawers]) => [room.trim(), Number(drawers)])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
  mempalaceUnavailable = roomRows.length === 0;
}
const drawerCount = mempalaceUnavailable ? null : roomRows.reduce((sum, [, count]) => sum + count, 0);

const pendingCount = readdirSync(pendingPath, { withFileTypes: true }).filter(
  (entry) => entry.isFile() && entry.name.endsWith('.json'),
).length;

let launchOutput;
let launchError;
try {
  launchOutput = execSync('launchctl list', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  launchError = externalError(error);
}
let launchRows = [];
if (!launchError) {
  launchRows = launchOutput
    .split(/\r?\n/)
    .filter((line) => /second-brain|mempalace/i.test(line))
    .map((line) => {
      const columns = line.trim().split(/\s+/);
      assert(columns.length >= 3, `launchctl 行无法解析: ${line}`);
      return [columns.slice(2).join(' '), columns[0], columns[1]];
    });
}

const generatedAt = new Date().toLocaleString('sv-SE', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
});
const lines = [
  `生成时间：${generatedAt}（Asia/Shanghai）`,
  '',
  '## 采集与回填',
  '',
  `- 总进度：${processedCount}/${candidateCount}（${formatPercent(progressPercent)}）`,
  '',
  '| 来源 | 已处理 | 错误 | 候选数 |',
  '| --- | ---: | ---: | ---: |',
  `| 会话 | ${processedCounts.session} | ${errorCounts.session} | ${sessionCandidateCount} |`,
  `| Chronicle | ${processedCounts.chronicle} | ${errorCounts.chronicle} | ${chronicleCandidateCount} |`,
  '',
  '### 错误 Top 3',
  '',
  '| 错误前 40 字符 | 次数 |',
  '| --- | ---: |',
  ...(topErrors.length ? topErrors.map(([message, count]) => `| ${escapeMd(message)} | ${count} |`) : ['| 无 | 0 |']),
  '',
  '### 观察层体量',
  '',
  '| 子目录 | Markdown 文件数 |',
  '| --- | ---: |',
  ...observationRows.map(([directory, count]) => `| ${escapeMd(directory)} | ${count} |`),
  '',
  '## 记忆写入',
  '',
  `- 台账总行数：${ledger.length}`,
  '',
  '### 最近 24 小时',
  '',
  '| actor | action | 次数 |',
  '| --- | --- | ---: |',
  ...(recentRows.length
    ? recentRows.map(([actor, action, count]) => `| ${escapeMd(actor)} | ${escapeMd(action)} | ${count} |`)
    : ['| 无 | 无 | 0 |']),
  '',
  '### 最近 10 条',
  '',
  '| 时间 | actor | action | 标题 | 文件 |',
  '| --- | --- | --- | --- | --- |',
  ...latestEntries.map(
    ({ ts, actor, action, title, file }) =>
      `| ${escapeMd(ts)} | ${escapeMd(actor)} | ${escapeMd(action)} | ${escapeMd(title)} | ${escapeMd(file)} |`,
  ),
  '',
  '## 热记忆',
  '',
  `- ${hotCount}/40`,
  '',
  '## 语义索引',
  '',
  ...(mempalaceUnavailable
    ? ['mempalace: 不可用']
    : [
        '| Room | Drawer 数 |',
        '| --- | ---: |',
        ...roomRows.map(([room, drawers]) => `| ${escapeMd(room)} | ${drawers} |`),
      ]),
  '',
  '## 运行时',
  '',
  `- 剪藏积压：${pendingCount}`,
  '',
  '### launchd',
  '',
  ...(launchError
    ? [`获取失败: ${escapeMd(launchError)}`]
    : [
        '| 任务 | PID | 状态 |',
        '| --- | ---: | ---: |',
        ...(launchRows.length
          ? launchRows.map(([label, pid, status]) => `| ${escapeMd(label)} | ${escapeMd(pid)} | ${escapeMd(status)} |`)
          : ['| 无匹配任务 | — | — |']),
      ]),
  '',
  '提炼与治理面板待 8-29 harvest 数据模型定稿后新增',
  '',
];

const observationMax = Math.max(1, ...observationRows.map(([, count]) => count));
const observationWidth = Math.max(760, observationRows.length * 100 + 80);
const observationChart = observationRows.length
  ? `<div class="chart-scroll"><svg viewBox="0 0 ${escapeHtml(observationWidth)} 290" style="min-width:${escapeHtml(observationWidth)}px" role="img" aria-label="观察层按月份 Markdown 文件数量柱状图">
      <line x1="48" y1="238" x2="${escapeHtml(observationWidth - 24)}" y2="238" class="axis" />
      ${observationRows
        .map(([directory, count], index) => {
          const slot = (observationWidth - 80) / observationRows.length;
          const width = Math.min(58, slot * 0.62);
          const x = 52 + index * slot + (slot - width) / 2;
          const height = (count / observationMax) * 180;
          const y = 238 - height;
          return `<g>
            <rect x="${escapeHtml(x.toFixed(1))}" y="${escapeHtml(y.toFixed(1))}" width="${escapeHtml(width.toFixed(1))}" height="${escapeHtml(height.toFixed(1))}" rx="6" fill="#4c8dff" />
            <text x="${escapeHtml((x + width / 2).toFixed(1))}" y="${escapeHtml(Math.max(18, y - 9).toFixed(1))}" text-anchor="middle" class="chart-value">${escapeHtml(formatNumber(count))}</text>
            <text x="${escapeHtml((x + width / 2).toFixed(1))}" y="264" text-anchor="middle" class="chart-label">${escapeHtml(directory)}</text>
          </g>`;
        })
        .join('')}
    </svg></div>`
  : '<div class="empty-state">暂无月份数据</div>';

const roomMax = Math.max(1, ...roomRows.map(([, count]) => count));
const roomChart = mempalaceUnavailable
  ? '<div class="error-state">mempalace: 不可用</div>'
  : `<div class="chart-scroll"><svg viewBox="0 0 920 ${escapeHtml(Math.max(86, roomRows.length * 42 + 18))}" style="min-width:720px" role="img" aria-label="语义索引 room drawer 数水平柱状图">
      ${roomRows
        .map(([room, count], index) => {
          const y = 12 + index * 42;
          const width = (count / roomMax) * 600;
          return `<g>
            <text x="10" y="${escapeHtml(y + 17)}" class="chart-label">${escapeHtml(room)}</text>
            <rect x="220" y="${escapeHtml(y)}" width="${escapeHtml(width.toFixed(1))}" height="24" rx="6" fill="#4c8dff" />
            <text x="${escapeHtml((230 + width).toFixed(1))}" y="${escapeHtml(y + 17)}" class="chart-value">${escapeHtml(formatNumber(count))}</text>
          </g>`;
        })
        .join('')}
    </svg></div>`;

const actorColors = { observe: '#4c8dff', claude: '#a78bfa', codex: '#3ddc84' };
const actorMax = Math.max(1, ...actorRows.map(([, count]) => count));
const actorChart = `<div class="chart-scroll"><svg viewBox="0 0 920 ${escapeHtml(actorRows.length * 44 + 18)}" style="min-width:640px" role="img" aria-label="最近 24 小时按 actor 写入数量水平柱状图">
    ${actorRows
      .map(([actor, count], index) => {
        const y = 12 + index * 44;
        const width = (count / actorMax) * 650;
        return `<g>
          <text x="10" y="${escapeHtml(y + 18)}" class="chart-label">${escapeHtml(actor)}</text>
          <rect x="150" y="${escapeHtml(y)}" width="${escapeHtml(width.toFixed(1))}" height="26" rx="6" fill="${escapeHtml(actorColors[actor] ?? '#8a8f98')}" />
          <text x="${escapeHtml((160 + width).toFixed(1))}" y="${escapeHtml(y + 18)}" class="chart-value">${escapeHtml(formatNumber(count))}</text>
        </g>`;
      })
      .join('')}
  </svg></div>`;

const errorList = topErrors.length
  ? `<ul class="plain-list">${topErrors
      .map(
        ([message, count]) =>
          `<li class="error-row"><span class="truncate" title="${escapeHtml(message)}">${escapeHtml(message)}</span><span class="count-badge">${escapeHtml(count)}</span></li>`,
      )
      .join('')}</ul>`
  : '<div class="success-state">最近无采集错误</div>';

const launchList = launchError
  ? `<div class="error-state">获取失败：${escapeHtml(launchError)}</div>`
  : launchRows.length
    ? `<ul class="plain-list">${launchRows
        .map(([label, pid, status]) => {
          const healthy = /^\d+$/.test(pid) && (status === '0' || status === '-');
          return `<li class="launch-row"><span class="status-dot ${healthy ? 'healthy' : 'unhealthy'}" aria-label="${healthy ? '正常' : '异常'}"></span><span class="truncate" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="pid">PID ${escapeHtml(pid)}</span></li>`;
        })
        .join('')}</ul>`
    : '<div class="error-state">无匹配任务</div>';

const latestList = latestEntries.length
  ? `<ul class="plain-list recent-list">${latestEntries
      .map(({ timestamp, actor, title }) => {
        const time = new Date(timestamp).toLocaleTimeString('sv-SE', {
          timeZone: 'Asia/Shanghai',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const actorClass = actor === 'observe' ? 'actor-observe' : actor === 'claude' ? 'actor-claude' : actor === 'codex' ? 'actor-codex' : 'actor-other';
        return `<li class="recent-row"><time>${escapeHtml(time)}</time><span class="actor-badge ${actorClass}">${escapeHtml(actor)}</span><span class="truncate" title="${escapeHtml(title)}">${escapeHtml(title)}</span></li>`;
      })
      .join('')}</ul>`
  : '<div class="empty-state">暂无写入</div>';

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>二脑状态总览</title>
  <style>
    :root { color-scheme: dark; --bg:#111214; --card:#1b1d21; --text:#e6e6e6; --muted:#8a8f98; --accent:#4c8dff; --danger:#ff5d5d; --success:#3ddc84; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
    main { width:min(1080px,calc(100% - 32px)); margin:0 auto; padding:40px 0 28px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:24px; }
    h1 { margin:0; font-size:clamp(26px,4vw,38px); letter-spacing:-0.03em; }
    h2 { margin:0 0 20px; font-size:18px; }
    .generated { color:var(--muted); font-size:13px; white-space:nowrap; }
    .kpi-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin-bottom:16px; }
    .card { background:var(--card); border:1px solid #272a30; border-radius:12px; box-shadow:0 12px 30px rgba(0,0,0,.14); }
    .kpi { min-height:116px; padding:18px; display:flex; flex-direction:column; justify-content:space-between; }
    .kpi-label { color:var(--muted); font-size:13px; line-height:1.4; }
    .kpi-value { font-size:28px; font-weight:720; font-variant-numeric:tabular-nums; }
    .warning,.bad { color:var(--danger); }
    .panel { padding:22px; margin-bottom:16px; overflow:hidden; }
    .progress-track { height:18px; overflow:hidden; border-radius:999px; background:#292c32; }
    .progress-fill { height:100%; border-radius:inherit; background:linear-gradient(90deg,#397af0,var(--accent)); }
    .progress-meta { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px; color:var(--muted); font-size:13px; }
    .progress-meta span:last-child { text-align:right; }
    .chart-scroll { overflow-x:auto; overflow-y:hidden; }
    svg { display:block; width:100%; height:auto; }
    .axis { stroke:#3a3e46; stroke-width:1; }
    .chart-label { fill:var(--muted); font-size:13px; }
    .chart-value { fill:var(--text); font-size:13px; font-weight:650; font-variant-numeric:tabular-nums; }
    .split-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .plain-list { list-style:none; padding:0; margin:0; }
    .error-row,.launch-row,.recent-row { min-width:0; display:grid; align-items:center; gap:10px; padding:11px 0; border-top:1px solid #2a2d33; }
    .error-row:first-child,.launch-row:first-child,.recent-row:first-child { border-top:0; padding-top:0; }
    .error-row { grid-template-columns:minmax(0,1fr) auto; }
    .launch-row { grid-template-columns:auto minmax(0,1fr) auto; }
    .recent-row { grid-template-columns:48px auto minmax(0,1fr); }
    .truncate { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .count-badge,.actor-badge { display:inline-flex; align-items:center; border-radius:999px; font-size:12px; font-weight:650; }
    .count-badge { min-width:28px; justify-content:center; padding:4px 8px; color:#ffd7d7; background:rgba(255,93,93,.15); }
    .actor-badge { padding:4px 9px; }
    .actor-observe { color:#bcd3ff; background:rgba(76,141,255,.18); }
    .actor-claude { color:#dfd1ff; background:rgba(167,139,250,.18); }
    .actor-codex { color:#b8f4d1; background:rgba(61,220,132,.16); }
    .actor-other { color:#d7d9de; background:#31343a; }
    .status-dot { width:9px; height:9px; border-radius:50%; box-shadow:0 0 0 4px rgba(255,255,255,.03); }
    .healthy { background:var(--success); }
    .unhealthy { background:var(--danger); }
    .pid,time { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
    .error-state { color:var(--danger); overflow-wrap:anywhere; }
    .success-state { color:var(--success); }
    .empty-state { color:var(--muted); }
    footer { color:var(--muted); font-size:12px; text-align:center; padding-top:8px; }
    @media (max-width:850px) { .kpi-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .split-grid { grid-template-columns:1fr; } }
    @media (max-width:560px) { main { width:min(100% - 20px,1080px); padding-top:24px; } header { display:block; } .generated { margin-top:8px; white-space:normal; } .kpi-grid,.progress-meta { grid-template-columns:1fr; } .progress-meta span:last-child { text-align:left; } .panel { padding:18px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>二脑状态总览</h1>
      <div class="generated">生成时间 ${escapeHtml(generatedAt)}（Asia/Shanghai）</div>
    </header>

    <section class="kpi-grid" aria-label="关键指标">
      <article class="card kpi"><span class="kpi-label">语义索引总 drawer 数</span><strong class="kpi-value ${mempalaceUnavailable ? 'bad' : ''}">${escapeHtml(mempalaceUnavailable ? '不可用' : formatNumber(drawerCount))}</strong></article>
      <article class="card kpi"><span class="kpi-label">台账总写入</span><strong class="kpi-value">${escapeHtml(formatNumber(ledger.length))}</strong></article>
      <article class="card kpi"><span class="kpi-label">热记忆 N/40</span><strong class="kpi-value ${hotCount > 40 ? 'warning' : ''}">${escapeHtml(hotCount)}/40</strong></article>
      <article class="card kpi"><span class="kpi-label">剪藏积压</span><strong class="kpi-value">${escapeHtml(formatNumber(pendingCount))}</strong></article>
      <article class="card kpi"><span class="kpi-label">回填进度</span><strong class="kpi-value">${escapeHtml(formatPercent(progressPercent))}</strong></article>
    </section>

    <section class="card panel">
      <h2>回填进度 · ${escapeHtml(formatNumber(processedCount))}/${escapeHtml(formatNumber(candidateCount))}</h2>
      <div class="progress-track" role="progressbar" aria-label="回填进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(progressWidth.toFixed(1))}"><div class="progress-fill" style="width:${escapeHtml(progressWidth.toFixed(1))}%"></div></div>
      <div class="progress-meta">
        <span>会话：已处理 ${escapeHtml(formatNumber(processedCounts.session))} · 错误 ${escapeHtml(formatNumber(errorCounts.session))} · 候选 ${escapeHtml(formatNumber(sessionCandidateCount))}</span>
        <span>Chronicle：已处理 ${escapeHtml(formatNumber(processedCounts.chronicle))} · 错误 ${escapeHtml(formatNumber(errorCounts.chronicle))} · 候选 ${escapeHtml(formatNumber(chronicleCandidateCount))}</span>
      </div>
    </section>

    <section class="card panel"><h2>观察层体量</h2>${observationChart}</section>
    <section class="card panel"><h2>语义索引 room 分布</h2>${roomChart}</section>
    <section class="card panel"><h2>最近 24 小时写入</h2>${actorChart}</section>

    <div class="split-grid">
      <section class="card panel"><h2>错误 Top 3</h2>${errorList}</section>
      <section class="card panel"><h2>launchd 状态</h2>${launchList}</section>
    </div>

    <section class="card panel"><h2>最近 10 条写入</h2>${latestList}</section>
    <footer>提炼与治理面板待 8-29 harvest 数据模型定稿后新增</footer>
  </main>
</body>
</html>
`;

writeFileSync(outputPath, lines.join('\n'), 'utf8');
writeFileSync(htmlOutputPath, html, 'utf8');
assert(existsSync(outputPath), '状态总览.md 未生成');
assert(existsSync(htmlOutputPath), '状态总览.html 未生成');
assert(statSync(outputPath).size > 500, '状态总览.md 小于 500 字节');
assert(statSync(htmlOutputPath).size > 3000, '状态总览.html 小于 3000 字节');
console.log(`已生成 ${outputPath}（${statSync(outputPath).size} 字节）`);
console.log(`已生成 ${htmlOutputPath}（${statSync(htmlOutputPath).size} 字节）`);

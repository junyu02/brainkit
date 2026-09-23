#!/usr/bin/env node
// vault-lint.mjs — Audit-only lint for vault hygiene.
// Reports policy violations from vault-routing.json. NEVER moves or deletes files.
//
// Usage:
//   node vault-lint.mjs           # human-readable report
//   node vault-lint.mjs --json    # machine-readable JSON
//   node vault-lint.mjs --fail    # exit 1 if any violation (for cron)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const ROUTING_JSON = BRAINKIT.routing;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const failOnIssues = args.includes('--fail');

function loadRouting() {
  try { return JSON.parse(readFileSync(ROUTING_JSON, 'utf8')); }
  catch (e) { console.error(`Cannot read ${ROUTING_JSON}: ${e.message}`); process.exit(2); }
}

function listEntries(dir) {
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}

function ageInDays(absPath) {
  try {
    const m = statSync(absPath).mtimeMs;
    return Math.floor((Date.now() - m) / 86400000);
  } catch { return null; }
}

const routing = loadRouting();
const policies   = routing.section_policies || {};
const exemptSet  = new Set(routing.exempt_files || []);
const inboxRoot  = routing.inbox_root || '99-inbox/';
const inboxAbs   = join(VAULT_ROOT, inboxRoot);

const findings = {
  stray_root_md: [],          // .md sitting at section root where requires_subfolder=true
  unknown_subfolder: [],      // subfolder under managed section not in allowed/registered
  ghost_project_dir: [],      // 01-项目/X with no .project-map.json entry
  inbox_backlog: [],          // inbox files >14 days old
  inbox_volume: { count: 0 },
};

// 1) Walk each managed section root for stray .md and unknown subfolders
for (const [section, policy] of Object.entries(policies)) {
  const secAbs = join(VAULT_ROOT, section);
  const entries = listEntries(secAbs);

  // Skip section if it allows root writes
  const requiresSub = policy.requires_subfolder !== false && policy.policy !== 'allow_root';

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (exemptSet.has(e.name)) continue;

    if (e.isFile() && e.name.endsWith('.md')) {
      if (requiresSub) {
        findings.stray_root_md.push({
          section,
          file: e.name,
          path: join(section, e.name),
          age_days: ageInDays(join(secAbs, e.name))
        });
      }
    } else if (e.isDirectory()) {
      // Validate subfolder
      const sub = e.name;
      const allowedList = policy.allowed_subfolders;
      if (Array.isArray(allowedList) && !allowedList.includes(sub)) {
        findings.unknown_subfolder.push({
          section,
          subfolder: sub,
          policy: policy.policy,
          allowed: allowedList,
          age_days: ageInDays(join(secAbs, sub))
        });
      }
    }
  }
}

// 2) 01-项目/ unknown project dirs (not in .project-map.json)
const projectMapPath = join(VAULT_ROOT, '00-系统', '.project-map.json');
let registeredProjects = new Set();
try {
  const pm = JSON.parse(readFileSync(projectMapPath, 'utf8'));
  for (const m of (pm.mappings || [])) {
    const last = (m.vaultDir || '').split('/').pop();
    if (last) registeredProjects.add(last);
  }
} catch { /* skip */ }

const projectsAbs = join(VAULT_ROOT, '01-项目');
for (const e of listEntries(projectsAbs)) {
  if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
  if (e.isDirectory() && !registeredProjects.has(e.name)) {
    findings.ghost_project_dir.push({
      dir: e.name,
      path: `01-项目/${e.name}`,
      age_days: ageInDays(join(projectsAbs, e.name)),
      hint: `node 00-系统/scripts/cli/brain-init.mjs ${e.name} --path <project_path>`
    });
  }
}

// 3) Inbox backlog (>14 days old)
function walkInbox(dir, prefix = '') {
  if (!existsSync(dir)) return;
  for (const e of listEntries(dir)) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walkInbox(full, prefix + e.name + '/');
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const age = ageInDays(full);
      findings.inbox_volume.count++;
      if (age !== null && age >= 14) {
        findings.inbox_backlog.push({
          path: `${inboxRoot}${prefix}${e.name}`,
          age_days: age
        });
      }
    }
  }
}
walkInbox(inboxAbs);

// Compute summary
const summary = {
  stray_root_md: findings.stray_root_md.length,
  unknown_subfolder: findings.unknown_subfolder.length,
  ghost_project_dir: findings.ghost_project_dir.length,
  inbox_backlog: findings.inbox_backlog.length,
  inbox_total: findings.inbox_volume.count,
  total_issues: findings.stray_root_md.length + findings.unknown_subfolder.length +
                findings.ghost_project_dir.length + findings.inbox_backlog.length
};
const overall = summary.total_issues === 0 ? 'CLEAN' : 'ISSUES';

if (asJson) {
  process.stdout.write(JSON.stringify({ overall, summary, findings }, null, 2) + '\n');
} else {
  console.log(`vault-lint: ${overall} (${summary.total_issues} issue${summary.total_issues === 1 ? '' : 's'})`);
  console.log('');
  console.log(`Summary:`);
  console.log(`  顶层游离 .md            : ${summary.stray_root_md}`);
  console.log(`  未知/非白名单子文件夹   : ${summary.unknown_subfolder}`);
  console.log(`  幽灵项目目录            : ${summary.ghost_project_dir}`);
  console.log(`  inbox 积压 (>14天)      : ${summary.inbox_backlog} / total ${summary.inbox_total}`);
  console.log('');
  if (findings.stray_root_md.length) {
    console.log('=== 顶层游离 .md ===');
    for (const f of findings.stray_root_md) {
      console.log(`  ${f.path}  (age ${f.age_days}d)`);
    }
    console.log('');
  }
  if (findings.unknown_subfolder.length) {
    console.log('=== 未知/非白名单子文件夹 ===');
    for (const f of findings.unknown_subfolder) {
      console.log(`  ${f.section}${f.subfolder}/  (policy=${f.policy}, age ${f.age_days}d)`);
      if (f.allowed) console.log(`    allowed: ${f.allowed.join(', ')}`);
    }
    console.log('');
  }
  if (findings.ghost_project_dir.length) {
    console.log('=== 幽灵项目目录（未在 .project-map.json 注册）===');
    for (const f of findings.ghost_project_dir) {
      console.log(`  ${f.path}  (age ${f.age_days}d)`);
      console.log(`    fix: ${f.hint}`);
    }
    console.log('');
  }
  if (findings.inbox_backlog.length) {
    console.log('=== inbox 积压 (>14天) ===');
    for (const f of findings.inbox_backlog) {
      console.log(`  ${f.path}  (age ${f.age_days}d)`);
    }
  }
}

if (failOnIssues && summary.total_issues > 0) process.exit(1);
process.exit(0);

#!/usr/bin/env node
// brain-init.mjs — Initialize a new project in the Second Brain vault
// Run: node 00-系统/scripts/brain-init.mjs <project-name> [--path /absolute/path]
// Creates project directory, _index.md, and updates .project-map.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';
import { canonicalPath, isMain } from '../lib/plist-render.mjs';

const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const PROJECT_MAP_PATH = join(VAULT_ROOT, '00-系统', '.project-map.json');
const TODAY = new Date().toISOString().slice(0, 10);

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      path: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log('Usage: node brain-init.mjs <project-name> [--path /absolute/path]');
    console.log('');
    console.log('Initialize a new project in the Second Brain vault.');
    console.log('');
    console.log('Arguments:');
    console.log('  <project-name>    Name of the project directory to create');
    console.log('');
    console.log('Options:');
    console.log('  -p, --path        Absolute local path for .project-map.json mapping (default: cwd)');
    console.log('  -h, --help        Show this help message');
    process.exit(0);
  }

  if (positionals.length === 0) {
    console.error('Error: Missing required argument <project-name>');
    console.error('Usage: node brain-init.mjs <project-name> [--path /absolute/path]');
    process.exit(1);
  }

  const projectName = positionals[0];
  const localPath = values.path || process.cwd();

  // The name becomes a directory under 01-项目/, so it has to BE a single
  // directory name. join() happily resolves '../../outside-vault' and the
  // mkdir then lands wherever that points -- outside the vault entirely.
  if (projectName.includes('/') || projectName.includes('\\')
    || projectName === '.' || projectName === '..' || projectName.startsWith('.')) {
    console.error(`Error: Invalid project name "${projectName}"`);
    console.error('  A project name is a single directory name: no / or \\, not . or .., not starting with .');
    process.exit(1);
  }

  // Load .project-map.json
  const mapData = JSON.parse(readFileSync(PROJECT_MAP_PATH, 'utf8'));

  // D-09 idempotent check: reject if project already exists
  const existingMapping = mapData.mappings.find(
    (m) => m.vaultDir === '01-项目/' + projectName
  );
  if (existingMapping) {
    console.error('Error: Project "' + projectName + '" already exists in .project-map.json');
    console.error('  vaultDir: ' + existingMapping.vaultDir);
    console.error('  localPath: ' + existingMapping.localPath);
    process.exit(1);
  }

  // Create project directory. Belt and braces with the name check above: that
  // one reads the argument, this one reads the path actually about to be made.
  //
  // canonicalPath, not resolve: resolve only rewrites the string, so a
  // symlinked 01-项目 -- or an existing 01-项目/<name> pointing out of the
  // vault -- passed the comparison and mkdir followed the link out.
  //
  // The baseline is the vault root's real location with the two segments
  // appended, NOT canonicalPath of 01-项目. Canonicalising 01-项目 would follow
  // that same link, and the check would agree with itself all the way outside.
  const vaultReal = canonicalPath(VAULT_ROOT, 'vault root');
  const projectsRoot = join(vaultReal, '01-项目');
  // 01-项目 is part of the vault schema, and making it when absent also gives
  // canonicalPath a parent it can resolve. A no-op when it already exists --
  // including when it exists as a symlink, which the check below then catches.
  mkdirSync(join(VAULT_ROOT, '01-项目'), { recursive: true });
  const projectDir = canonicalPath(join(VAULT_ROOT, '01-项目', projectName), 'project directory');
  if (!projectDir.startsWith(projectsRoot + sep)) {
    console.error(`Error: "${projectName}" resolves to ${projectDir}, outside ${projectsRoot}`);
    process.exit(1);
  }
  mkdirSync(projectDir, { recursive: true });

  // Generate _index.md content (Linter sort order: type, created, scope, projects, source, tags)
  const indexContent = `---
type: system
created: ${TODAY}
scope: project
projects:
  - ${projectName}
source: brain-init
tags:
  - index
  - project
---

# ${projectName}

项目记忆索引。

## 本项目笔记

\`\`\`dataview
TABLE type, scope, created
FROM "01-项目/${projectName}"
WHERE file.name != "_index"
SORT created DESC
\`\`\`
`;

  // Belt-and-suspenders: skip writing _index.md if it already exists
  const indexPath = join(projectDir, '_index.md');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, indexContent, 'utf8');
  }

  // Update .project-map.json
  mapData.mappings.push({
    localPath: resolve(localPath),
    vaultDir: '01-项目/' + projectName,
  });
  writeFileSync(PROJECT_MAP_PATH, JSON.stringify(mapData, null, 2) + '\n', 'utf8');

  console.log('Project "' + projectName + '" initialized successfully.');
  console.log('  Vault dir: 01-项目/' + projectName);
  console.log('  Local path: ' + resolve(localPath));
  console.log('  Index file: ' + indexPath);
}

// Only run main if this is the entry point
if (isMain(import.meta.url)) {
  main();
}

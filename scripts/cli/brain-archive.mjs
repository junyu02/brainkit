#!/usr/bin/env node
// brain-archive.mjs — Archive or unarchive a project in the Second Brain vault
// Run: node 00-系统/scripts/brain-archive.mjs <project-name> [--undo]
// Marks _index.md and .project-map.json with archived: true (or removes it)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { brainkitPaths } from '../lib/brainkit-conf.mjs';
import { isMain } from '../lib/plist-render.mjs';

const BRAINKIT = brainkitPaths();
const VAULT_ROOT = BRAINKIT.vault;
const PROJECT_MAP_PATH = join(VAULT_ROOT, '00-系统', '.project-map.json');

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      undo: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log('Usage: node brain-archive.mjs <project-name> [--undo]');
    console.log('');
    console.log('Archive or unarchive a project in the Second Brain vault.');
    console.log('');
    console.log('Arguments:');
    console.log('  <project-name>    Name of the project to archive/unarchive');
    console.log('');
    console.log('Options:');
    console.log('  --undo            Unarchive a previously archived project');
    console.log('  -h, --help        Show this help message');
    process.exit(0);
  }

  if (positionals.length === 0) {
    console.error('Error: Missing required argument <project-name>');
    console.error('Usage: node brain-archive.mjs <project-name> [--undo]');
    process.exit(1);
  }

  const projectName = positionals[0];
  const isUndo = values.undo || false;

  // Load .project-map.json
  const mapData = JSON.parse(readFileSync(PROJECT_MAP_PATH, 'utf8'));

  // Find mapping for this project
  const mapping = mapData.mappings.find(
    (m) => m.vaultDir === '01-项目/' + projectName
  );
  if (!mapping) {
    console.error('Error: Project "' + projectName + '" not found in .project-map.json');
    process.exit(1);
  }

  const indexPath = join(VAULT_ROOT, '01-项目', projectName, '_index.md');

  if (!isUndo) {
    // Archive mode
    if (mapping.archived === true) {
      console.error('Error: Project "' + projectName + '" is already archived');
      process.exit(1);
    }

    // Mark _index.md frontmatter with archived: true
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, 'utf8');
      const updated = content.replace(/^(---\n[\s\S]*?)(---)/, '$1archived: true\n$2');
      writeFileSync(indexPath, updated, 'utf8');
    }

    // Mark .project-map.json
    mapping.archived = true;
    writeFileSync(PROJECT_MAP_PATH, JSON.stringify(mapData, null, 2) + '\n', 'utf8');

    console.log('Project "' + projectName + '" archived successfully.');
    console.log('  _index.md: archived: true added');
    console.log('  .project-map.json: archived: true added');
  } else {
    // Unarchive mode
    if (!mapping.archived) {
      console.error('Error: Project "' + projectName + '" is not archived');
      process.exit(1);
    }

    // Remove archived: true from _index.md frontmatter
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, 'utf8');
      const updated = content.replace(/archived: true\n/, '');
      writeFileSync(indexPath, updated, 'utf8');
    }

    // Remove archived field from mapping
    delete mapping.archived;
    writeFileSync(PROJECT_MAP_PATH, JSON.stringify(mapData, null, 2) + '\n', 'utf8');

    console.log('Project "' + projectName + '" unarchived successfully.');
    console.log('  _index.md: archived: true removed');
    console.log('  .project-map.json: archived field removed');
  }
}

// Only run main if this is the entry point
if (isMain(import.meta.url)) {
  main();
}

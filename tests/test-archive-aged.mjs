#!/usr/bin/env node
// Black-box regression suite for brain-archive-aged.
// Fixtures live under os.tmpdir() and are never deleted by a test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'scripts', 'cli', 'brain-archive-aged.mjs');

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'brain-archive-aged-'));
  const vault = join(root, 'vault');
  const memory = join(root, 'memory');
  mkdirSync(vault, { recursive: true });
  mkdirSync(memory, { recursive: true });
  return { root, vault, memory };
}

// An orphan old enough to archive: `created` well past any threshold, nothing
// linking to it, and absent from every memory index.
function writeNote(vault, relPath, { name, body }) {
  const abs = join(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\nname: ${name}\ncreated: 2020-01-01\ndescription: ${name} 的说明\n---\n\n${body}\n`, 'utf8');
  return abs;
}

function runArchive(fixture, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_VAULT_ROOT: fixture.vault, BRAIN_MEMORY_DIR: fixture.memory },
  });
}

// Every .md under the vault, keyed by its body line. What matters after an
// archive run is not where a note ended up but that its bytes still exist
// somewhere -- a note that was overwritten disappears from this map.
function bodiesUnderVault(vault) {
  const found = new Map();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = readFileSync(full, 'utf8');
      const body = text.split('---\n').slice(2).join('---\n').trim();
      found.set(body, full);
    }
  };
  walk(vault);
  return found;
}

test('two aged orphans that share a sub-path under different sections are both archived, not one over the other', () => {
  // The reported data loss. computeArchivePath drops the top-level section, so
  // 02-知识/shared/note.md and 03-经验/shared/note.md both want
  // 06-归档/shared/note.md, and the move is a bare renameSync -- on POSIX the
  // second rename replaces the first file, with exit 0 and "archived: 2".
  const fixture = makeFixture();
  writeNote(fixture.vault, '02-知识/shared/note.md', { name: '知识笔记', body: 'knowledge body' });
  writeNote(fixture.vault, '03-经验/shared/note.md', { name: '经验笔记', body: 'experience body' });

  const run = runArchive(fixture, ['--apply', '--json']);
  assert.equal(run.status, 0, `the run itself must not crash: ${run.stderr}`);
  const report = JSON.parse(run.stdout);

  const destinations = report.results.map(entry => entry.archive_path);
  assert.equal(new Set(destinations).size, destinations.length,
    `two notes were sent to the same destination: ${destinations.join(' , ')}`);

  const bodies = bodiesUnderVault(fixture.vault);
  assert.ok(bodies.has('knowledge body'), 'the note from 02-知识 must still exist somewhere in the vault');
  assert.ok(bodies.has('experience body'), 'the note from 03-经验 must still exist somewhere in the vault');
});

test('a destination that is already occupied stops the whole run before anything moves', () => {
  // The other way a move can destroy something: not two candidates colliding
  // with each other, but one landing on a file already in the archive. Checked
  // across the batch, so a later collision stops the earlier notes too.
  const fixture = makeFixture();
  writeNote(fixture.vault, '03-经验/shared/note.md', { name: '经验笔记', body: 'experience body' });
  writeNote(fixture.vault, '02-知识/other.md', { name: '另一条', body: 'other body' });
  const occupied = join(fixture.vault, '06-归档', '03-经验', 'shared', 'note.md');
  mkdirSync(dirname(occupied), { recursive: true });
  writeFileSync(occupied, 'a note archived by an earlier run\n', 'utf8');

  const before = bodiesUnderVault(fixture.vault);
  const run = runArchive(fixture, ['--apply', '--json']);
  const report = JSON.parse(run.stdout);

  assert.equal(run.status, 2, 'a refusal must not look like success');
  assert.equal(report.archived, 0);
  assert.ok(report.refused.some(line => line.includes('already exists')), report.refused?.join(' / '));
  assert.deepEqual(bodiesUnderVault(fixture.vault), before,
    'nothing may move -- including the note that had no conflict of its own');
});

test('bookkeeping that fails puts the note back where it was', () => {
  // The metadata steps used to swallow their failures while the caller still
  // recorded the note as archived, leaving a moved file with an index entry
  // pointing at where it used to be. An unreadable intent-map is the smallest
  // way to make one of them fail for real.
  const fixture = makeFixture();
  const source = writeNote(fixture.vault, '03-经验/lonely.md', { name: '孤儿', body: 'lonely body' });
  const intentMap = join(fixture.vault, '00-系统', '.index-cache', 'intent-map.json');
  mkdirSync(dirname(intentMap), { recursive: true });
  writeFileSync(intentMap, '{ this is not json', 'utf8');
  const archiveIndex = join(fixture.memory, 'MEMORY-archive.md');
  writeFileSync(archiveIndex, '# Archive Index\n', 'utf8');

  const run = runArchive(fixture, ['--apply', '--json']);
  const report = JSON.parse(run.stdout);

  assert.equal(report.archived, 0, 'a note whose bookkeeping failed is not archived');
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].status, 'error');
  assert.ok(existsSync(source), 'the note must be back at its original path');
  assert.equal(readFileSync(source, 'utf8').includes('lonely body'), true);
  assert.equal(existsSync(join(fixture.vault, '06-归档', '03-经验', 'lonely.md')), false,
    'and must not also be sitting in the archive');
  assert.equal(readFileSync(archiveIndex, 'utf8'), '# Archive Index\n',
    'the archive index entry is rolled back with it');
});

test('a note is not an orphan just because the link to it was written another way', () => {
  // buildReferenceIndex kept one path per basename and matched the link text
  // whole, so `[[folder/note]]`, `[[note#heading]]` and a name shared by two
  // notes all read as "nobody links here" -- and the tool archives what it
  // believes nobody links to.
  const fixture = makeFixture();
  writeNote(fixture.vault, '02-知识/shared/dup.md', { name: '知识版', body: 'knowledge dup' });
  writeNote(fixture.vault, '03-经验/dup.md', { name: '经验版', body: 'experience dup' });
  writeNote(fixture.vault, '01-项目/deep/anchored.md', { name: '带锚点', body: 'anchored body' });
  writeNote(fixture.vault, '01-项目/deep/pathy.md', { name: '带路径', body: 'pathy body' });
  // The referrer is recent, so it is not itself a candidate.
  const referrer = join(fixture.vault, '01-项目', 'index.md');
  writeFileSync(referrer,
    `# links\n\n- [[dup]]\n- [[anchored#some heading]]\n- [[deep/pathy|别名]]\n`, 'utf8');

  const run = runArchive(fixture, ['--json']);
  const report = JSON.parse(run.stdout);
  const flagged = report.candidates.map(c => c.vault_rel).sort();

  assert.deepEqual(flagged, [], `nothing linked-to may be a candidate, got: ${flagged.join(', ')}`);
});

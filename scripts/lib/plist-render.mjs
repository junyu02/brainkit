#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function canonicalPath(path, label = 'path') {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`${label} must be absolute`);
  if (existsSync(path)) return realpathSync(path);
  const parent = realpathSync(dirname(path));
  return join(parent, basename(path));
}

function validatePrivateStat(path, stat, { expectedUid = process.getuid?.(), mode = 0o600 } = {}) {
  if (!stat.isFile()) throw new Error(`${path} must be a regular non-symlink file`);
  if (expectedUid !== undefined && stat.uid !== expectedUid) throw new Error(`${path} owner mismatch`);
  if ((stat.mode & 0o777) !== mode) throw new Error(`${path} mode must be ${mode.toString(8).padStart(4, '0')}`);
  return stat;
}

function validatePrivateFile(path, options) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${path} must be a regular non-symlink file`);
  return validatePrivateStat(path, stat, options);
}

function readPrivateFile(path) {
  let fd;
  try {
    // O_NONBLOCK so a FIFO or device at this path is rejected by the
    // regular-file check below instead of blocking the open forever: a
    // read-only open of a writer-less FIFO never returns, so validatePrivateStat
    // was unreachable for exactly the file types it exists to refuse. POSIX
    // gives O_NONBLOCK no effect on regular files, and only regular files get
    // past the fstat, so reads of real config files are unchanged.
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`${path} must be a regular non-symlink file`);
    throw error;
  }
  try {
    validatePrivateStat(path, fstatSync(fd));
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function decodeEnvValue(raw, path, lineNumber) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw new Error(`unterminated double quote in ${path}:${lineNumber}`);
    try { return JSON.parse(value); }
    catch { throw new Error(`invalid double-quoted value in ${path}:${lineNumber}`); }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.slice(1, -1).includes("'")) {
      throw new Error(`invalid single-quoted value in ${path}:${lineNumber}`);
    }
    return value.slice(1, -1);
  }
  if (/\s/.test(value)) throw new Error(`unquoted whitespace in ${path}:${lineNumber}`);
  return value;
}

function parseEnvFile(path, { allowedKeys, requiredKeys = [] } = {}) {
  const allowed = new Set(allowedKeys || []);
  const required = new Set(requiredKeys);
  const values = {};
  const lines = readPrivateFile(path).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`invalid env assignment in ${path}:${index + 1}`);
    const [, key, rawValue] = match;
    if (!allowed.has(key)) throw new Error(`env key is not allowlisted in ${path}:${index + 1}: ${key}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate env key in ${path}:${index + 1}: ${key}`);
    values[key] = decodeEnvValue(rawValue, path, index + 1);
  }
  for (const key of required) {
    if (!values[key]) throw new Error(`${path} must define ${key}`);
  }
  return Object.freeze(values);
}

function clipEnvPath() {
  return resolve(process.env.BRAIN_CLIP_ENV_PATH || join(homedir(), '.config', 'second-brain', 'clip.env'));
}

function validateApiBase(value, { keyName = 'API_BASE', nodeEnv = process.env.NODE_ENV } = {}) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${keyName} must be a valid https URL`); }
  if (url.protocol === 'https:') return value;
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol === 'http:' && isLoopback && nodeEnv === 'test') return value;
  if (url.protocol === 'http:' && isLoopback) {
    throw new Error(`${keyName} permits loopback http only when NODE_ENV=test`);
  }
  throw new Error(`${keyName} must use https; external http is forbidden`);
}

function loadClipEnv(path = clipEnvPath()) {
  const values = parseEnvFile(path, {
    allowedKeys: ['DEEPSEEK_API_KEY', 'CLIP_VISION_MODEL', 'CLIP_TEXT_MODEL', 'CLIP_API_BASE'],
    requiredKeys: ['DEEPSEEK_API_KEY'],
  });
  if (values.CLIP_API_BASE) validateApiBase(values.CLIP_API_BASE, { keyName: 'CLIP_API_BASE' });
  return values;
}

function loadObserveEnv(path) {
  const values = parseEnvFile(path, {
    allowedKeys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OBSERVE_MODEL', 'HARVEST_JUDGE_MODEL'],
    requiredKeys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  });
  validateApiBase(values.OPENAI_BASE_URL, { keyName: 'OPENAI_BASE_URL' });
  return Object.freeze({ ...values, OBSERVE_MODEL: values.OBSERVE_MODEL || 'deepseek-v4-flash' });
}

function renderTemplate(template, variables) {
  const placeholders = [...template.matchAll(PLACEHOLDER_RE)].map(match => match[1]);
  const required = new Set(placeholders);
  for (const key of required) {
    if (!Object.hasOwn(variables, key)) throw new Error(`missing plist variable: ${key}`);
  }
  for (const key of Object.keys(variables)) {
    if (!required.has(key)) throw new Error(`unused plist variable: ${key}`);
  }
  return template.replace(PLACEHOLDER_RE, (_, key) => xmlEscape(canonicalPath(variables[key], key)));
}

function fsyncDirectory(path) {
  const fd = openSync(path, fsConstants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function renderPlist({ templatePath, outputPath, variables, plutilPath = '/usr/bin/plutil' }) {
  const templateReal = canonicalPath(templatePath, 'templatePath');
  if (existsSync(outputPath)) {
    const requestedOutputStat = lstatSync(outputPath);
    if (requestedOutputStat.isSymbolicLink()) throw new Error('outputPath must not be a symlink');
  }
  const output = canonicalPath(outputPath, 'outputPath');
  const templateStat = lstatSync(templateReal);
  if (!templateStat.isFile() || templateStat.isSymbolicLink()) throw new Error('templatePath must be a regular file');
  if (existsSync(output)) {
    const outputStat = lstatSync(output);
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) throw new Error('outputPath must be a regular file or absent');
  }

  const rendered = renderTemplate(readFileSync(templateReal, 'utf8'), variables);
  if (PLACEHOLDER_RE.test(rendered)) throw new Error('unresolved plist placeholder');
  const temp = join(dirname(output), `.${basename(output)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, rendered);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, 0o600);
  const lint = spawnSync(plutilPath, ['-lint', temp], { encoding: 'utf8' });
  if (lint.error || lint.status !== 0) {
    unlinkSync(temp);
    throw new Error(`plutil -lint failed: ${lint.error?.message || lint.stderr.trim() || lint.stdout.trim()}`);
  }
  renameSync(temp, output);
  chmodSync(output, 0o600);
  fsyncDirectory(dirname(output));
  return output;
}

function parseArgs(argv) {
  const parsed = { variables: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--template') parsed.templatePath = argv[++index];
    else if (arg === '--output') parsed.outputPath = argv[++index];
    else if (arg === '--var') {
      const assignment = argv[++index] || '';
      const split = assignment.indexOf('=');
      if (split < 1) throw new Error('--var requires NAME=/absolute/path');
      parsed.variables[assignment.slice(0, split)] = assignment.slice(split + 1);
    } else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write('Usage: plist-render.mjs --template FILE --output FILE --var NAME=/absolute/path [...]\n');
      return 0;
    }
    if (!args.templatePath || !args.outputPath) throw new Error('--template and --output are required');
    renderPlist(args);
    process.stdout.write(`${resolve(args.outputPath)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

// Is this module the program node was told to run? resolve() alone answers no
// whenever either side reaches the file through a symlink -- a symlink in
// ~/.local/bin, or a symlinked clone directory -- and the entry block then
// silently does nothing, so the CLI exits 0 having printed not one line.
// realpath on both sides is what makes the two spellings comparable; falling
// back to resolve keeps a deleted or unreadable path from throwing here.
function realpathOrSelf(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function isMain(importMetaUrl) {
  return Boolean(process.argv[1])
    && realpathOrSelf(process.argv[1]) === realpathOrSelf(fileURLToPath(importMetaUrl));
}

// launchctl unload, as an argv array. It used to be string-concatenated into a
// shell, which breaks on any HOME containing a space, and its failure was
// swallowed into a warning -- the command then printed "Daemon stopped." and
// exited 0 while the job was still loaded.
function daemonStop(plistPath) {
  if (!existsSync(plistPath)) {
    console.log('Daemon is not installed.');
    process.exit(1);
  }
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
  } catch (error) {
    const output = (error.stderr || error.stdout || '').toString().trim();
    console.error(output || error.message);
    process.exit(1);
  }
  console.log('Daemon stopped.');
}

// `launchctl list <label>` prints a plist dictionary, not a table. The old
// reader took the first word of line two, which is always a quoted key name
// and never "-", so every loaded-but-idle job read as RUNNING. The PID appears
// only as its own entry, and is absent entirely when the job is not running.
const LAUNCHCTL_PID_RE = /"PID"\s*=\s*(\d+)/;

function daemonStatus(label, logPath) {
  const printed = spawnSync('launchctl', ['list', label], { encoding: 'utf8', stdio: 'pipe' });
  const running = printed.status === 0 && LAUNCHCTL_PID_RE.test(String(printed.stdout || ''));
  console.log(`Status: ${running ? 'RUNNING' : 'STOPPED'}`);

  if (!existsSync(logPath)) {
    console.log('(no log file yet)');
    return;
  }
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(line => line.trim());
    console.log('\nLast 5 log lines:');
    for (const line of lines.slice(-5)) console.log('  ' + line);
  } catch {
    console.log('(could not read log file)');
  }
}

export {
  canonicalPath,
  clipEnvPath,
  daemonStatus,
  daemonStop,
  isMain,
  loadClipEnv,
  loadObserveEnv,
  parseEnvFile,
  renderPlist,
  renderTemplate,
  validateApiBase,
  validatePrivateFile,
  xmlEscape,
};

if (isMain(import.meta.url)) {
  process.exitCode = main();
}

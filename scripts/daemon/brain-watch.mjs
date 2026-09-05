#!/usr/bin/env node
// brain-watch.mjs — CLI control for the Second Brain background daemon
// Commands: stop | status  (both for hand troubleshooting only)
//
// install/start are gone, not merely refused. They were a second installer:
// they wrote process.execPath into the plist -- a versioned nvm path that
// vanishes on the next node upgrade -- skipped the wrapper-shim check, and
// took a watch root from an environment default instead of an explicit
// choice. Every path that built that plist is deleted with them, so there is
// nothing here to call by mistake. node install.mjs is the only installer.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { daemonStatus, daemonStop, isMain } from '../lib/plist-render.mjs';

const PLIST_LABEL = 'com.second-brain.watch';
const PLIST_PATH  = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const LOG_PATH    = join(homedir(), 'Library', 'Logs', 'second-brain', 'daemon.log');

// ─── help ───

function printHelp() {
  console.log('Usage: node brain-watch.mjs <command>');
  console.log('');
  console.log('Commands:');
  console.log('  stop      Unload daemon (plist stays installed)');
  console.log('  status    Show running state and last 5 log lines');
  console.log('');
  console.log('  stop and status are for hand troubleshooting only. The installer and');
  console.log('  publisher never consume their output: their service snapshots always come');
  console.log('  from launchctl print gui/$UID/<label> read live.');
  console.log('');
  console.log('  To install or start, run  node install.mjs install  from the brainkit clone.');
}

// ─── main ───

function main() {
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
      daemonStatus(PLIST_LABEL, LOG_PATH);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

// ─── Guard block ───

if (isMain(import.meta.url)) {
  main();
}

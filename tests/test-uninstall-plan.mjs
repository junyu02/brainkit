import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, main, createContext, readInstallState, writeInstallState, installStatePath, uninstallPlan, uninstallExecute } from '../install.mjs';

// A whole-HOME image, mtime included. managedSnapshot leaves mtime out on
// purpose (adding a directory entry changes its parent's), but "this command
// writes nothing" has to survive being read literally, and a rewrite that
// happens to produce the same bytes still moves mtime.
function image(root) {
  const out = [];
  const walk = path => {
    let stat;
    try { stat = lstatSync(path); } catch { return; }
    const meta = `mode=${(stat.mode & 0o7777).toString(8)} uid=${stat.uid} mtime=${stat.mtimeMs}`;
    if (stat.isSymbolicLink()) { out.push(`l ${path} ${meta} -> ${readlinkSync(path)}`); return; }
    if (stat.isFile()) { out.push(`f ${path} ${meta} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`); return; }
    if (!stat.isDirectory()) { out.push(`? ${path} ${meta}`); return; }
    out.push(`d ${path} ${meta}`);
    for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return out;
}

const FAKE_BIN = mkdtempSync(join(tmpdir(), 'uninstall-bin-'));
writeFileSync(join(FAKE_BIN, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

function machine({ components = 'core' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'uninstall-home-'));
  const vault = join(home, 'vault');
  mkdirSync(join(vault, '00-系统'), { recursive: true });
  writeFileSync(join(vault, 'note.md'), '# a note the user wrote\n');
  // watch needs a real fswatch on PATH and something to watch.
  const tools = mkdtempSync(join(tmpdir(), 'uninstall-tools-'));
  writeFileSync(join(tools, 'fswatch'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const watched = join(home, 'watched');
  mkdirSync(watched, { recursive: true });

  const run = (command, args = []) => {
    const argv = args.join(' ');
    if (argv.includes('publish.mjs')) {
      return { status: 0, stdout: `${JSON.stringify({ type: 'summary', state: 'clean', exitCode: 0 })}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('rev-parse')) {
      return { status: 0, stdout: args.includes('HEAD') ? `${'a'.repeat(40)}\n` : 'true\n', stderr: '' };
    }
    if (command === '/usr/bin/sw_vers') return { status: 0, stdout: '14.6\n', stderr: '' };
    if (command === '/bin/df') return { status: 0, stdout: 'F 1024-blocks Used Available Capacity\n/dev/disk1 100 10 900000 1%\n', stderr: '' };
    if (String(command).endsWith('brain-node') && args[0] === '--version') return { status: 0, stdout: 'v22.11.0\n', stderr: '' };
    // launchctl print for a service that is not loaded. An empty status-0
    // answer would now mean "loaded, but launchd named no plist", which
    // readService refuses -- correctly, and it is not what this fixture means.
    if (String(command).endsWith('launchctl') && args[0] === 'print') {
      return { status: 3, stdout: '', stderr: 'Could not find service\n' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const base = {
    home,
    repoRoot: new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v22.11.0',
    nodeTarget: process.execPath,
    pathEnv: tools,
    launchctlPath: join(FAKE_BIN, 'launchctl'),
    env: { PATH: '/usr/bin' },
    interactive: false,
    run,
    stdout: () => {},
  };
  let installOutput = '';
  base.stdout = chunk => { installOutput += chunk; };
  assert.equal(
    main([
      'install', '--vault', vault, '--vault-mode', 'existing', '--components', components,
      ...(components.includes('watch') ? ['--watch-root', watched] : []),
      '--non-interactive', '--yes',
    ], base),
    EXIT.OK,
    `the fixture install must succeed:\n${installOutput}`,
  );
  writeInstallState(home, { ...readInstallState(home), status: 'installed' });
  return { home, vault, base };
}

function plan(fixture, args = [], overrides = {}) {
  let output = '';
  const real = process.stderr.write;
  let stderr = '';
  process.stderr.write = chunk => { stderr += chunk; return true; };
  try {
    const code = main(['uninstall', ...args], {
      ...fixture.base, ...overrides, stdout: chunk => { output += chunk; },
    });
    return { code, output, stderr };
  } finally {
    process.stderr.write = real;
  }
}

// The execution half has no CLI entry any more: runUninstall stops at the plan.
// These gates drive uninstallExecute directly, the way the upgrade tests drive
// upgradeApply, so the disabled code goes on being checked rather than rotting.
// Same {code, output, stderr} shape as plan(), so a gate that used to go through
// main() reads the same afterwards.
function execute(fixture, args = [], overrides = {}) {
  const options = {
    purgeConfig: args.includes('--purge-config'),
    purgeLogs: args.includes('--purge-logs'),
    yes: args.includes('--yes'),
    nonInteractive: args.includes('--non-interactive'),
  };
  let output = '';
  const context = createContext({ ...fixture.base, ...overrides, stdout: chunk => { output += chunk; } });
  const state = readInstallState(fixture.home);
  const planned = uninstallPlan(context, state, options);
  try {
    return { code: uninstallExecute(context, state, options, planned), output, stderr: '' };
  } catch (error) {
    if (error?.name !== 'InstallError') throw error;
    return { code: error.exitCode, output, stderr: `${error.message}\n` };
  }
}

// The thrown InstallError itself, so a gate can assert on its exitCode as well
// as its message. assert.throws returns nothing, and the exit code is half of
// what these refusals promise.
function refusal(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail('expected a refusal, got a return');
}

// The lead's first probe: delete + keep must be exactly what the state claims.
// Missing a product is as wrong as deleting an extra one -- one silently
// becomes undeletable, the other is somebody's file.
// Written out by hand, and that is the point: computing it from
// declaredArtifacts -- the same enumeration the plan uses -- made this test
// self-referential. Dropping a line from that function moved both sides
// together and the gate stayed green while a whole class of product silently
// left the plan. This list is the second source: what a core install of this
// fixture actually puts on disk. It has to be edited deliberately when the
// install changes, which is the maintenance cost that buys the independence.
const CORE_INSTALL_PRODUCTS = [
  '.config/second-brain/brainkit.conf',
  '.config/second-brain/vault-routing.json',
  '.config/second-brain/install-state.json',
  '.local/bin/brain-node',
  'Library/Application Support/brainkit/memory/MEMORY.md',
  'Library/Application Support/brainkit/memory/MEMORY-knowledge.md',
  'Library/Application Support/brainkit/memory/MEMORY-experience.md',
  'Library/Application Support/brainkit/memory/MEMORY-project.md',
  'Library/Application Support/brainkit/memory/MEMORY-persona.md',
  'Library/Application Support/brainkit/memory/MEMORY-archive.md',
  'Library/Application Support/brainkit/memory/MEMORY-notes.md',
];

// The judgement is asserted on its rows, not on the printed report. Scraping
// stdout coupled these gates to the wording, and batch 2 changing "Would
// remove" to "Removed" turned six of them red for no reason at all.
function judge(fixture, options = {}) {
  const context = createContext({ ...fixture.base, stdout: () => {} });
  const rows = uninstallPlan(context, readInstallState(fixture.home), options);
  return {
    rows,
    removing: rows.filter(row => row.action === 'delete').map(row => row.path),
    keeping: new Map(rows.filter(row => row.action === 'keep').map(row => [row.path, row.why])),
  };
}

test('the plan accounts for every product the state claims, once each', () => {
  const fixture = machine();
  const claimed = new Set(CORE_INSTALL_PRODUCTS.map(path => join(fixture.home, path)));
  // The list is only a second source if it describes the same machine, so it
  // is checked against the disk before it is used to judge the plan.
  for (const path of claimed) assert.ok(lstatSync(path), `the fixture must actually have ${path}`);

  const { rows } = judge(fixture);
  const paths = rows.map(row => row.path);

  assert.deepEqual(new Set(paths), claimed);
  assert.equal(paths.length, new Set(paths).size, 'no path may appear twice');
});

// The lead's second probe, read literally.
test('planning writes nothing at all, mtime included', () => {
  const fixture = machine();
  const before = image(fixture.home);
  judge(fixture, { purgeConfig: true, purgeLogs: true });

  assert.deepEqual(image(fixture.home), before, 'the judgement is a report');
  // Including the lock: taking it is a write, so the judgement never takes it.
  assert.equal(readdirSync(join(fixture.home, '.config', 'second-brain')).includes('install.lock'), false);
});

test('a modified shim is kept and says why, and the rest of the plan continues', () => {
  const fixture = machine();
  const shim = join(fixture.home, '.local', 'bin', 'brain-node');
  writeFileSync(shim, `${readFileSync(shim, 'utf8')}# edited by hand\n`, { mode: 0o755 });

  const { removing, keeping } = judge(fixture);
  assert.match(keeping.get(shim) ?? '', /modified since this install wrote it/);
  assert.equal(removing.includes(shim), false, 'a drifted shim is not a removal target');
  assert.ok(removing.length > 0, 'and the rest of the plan still has targets');
});

test('a shim whose marker was stripped is kept even though its hash still agrees', () => {
  const fixture = machine();
  const shim = join(fixture.home, '.local', 'bin', 'brain-node');
  const stripped = readFileSync(shim, 'utf8').replace(/# brainkit[^\n]*\n/, '');
  writeFileSync(shim, stripped, { mode: 0o755 });
  // The recorded hash is moved to match, so the hash check passes and only the
  // marker check can object. Without this the two checks are indistinguishable:
  // editing a shim changes its bytes, so hash alone catches every case the test
  // could otherwise construct -- and "marker AND hash" would be untested.
  const state = readInstallState(fixture.home);
  writeInstallState(fixture.home, {
    ...state,
    shims: { ...state.shims, node: { ...state.shims.node, sha256: createHash('sha256').update(stripped).digest('hex') } },
  });

  const { removing, keeping } = judge(fixture);
  assert.match(keeping.get(shim) ?? '', /no longer carries the brainkit marker/);
  assert.equal(removing.includes(shim), false);
});

// A plist put straight into the state rather than installed: the judgement
// reads state.plists, so this exercises the real input without dragging a
// service install's prerequisites in.
function withPlist(fixture, { service = 'watch', label = 'com.second-brain.watch', log } = {}) {
  const agents = join(fixture.home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const path = join(agents, `com.second-brain.${service}.plist`);
  writeFileSync(path, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${label}</string>`,
    `<key>StandardOutPath</key><string>${log ?? join(fixture.home, 'Library', 'Logs', 'second-brain', 'daemon.log')}</string>`,
    '</dict></plist>',
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(path, 0o600);
  const state = readInstallState(fixture.home);
  writeInstallState(fixture.home, {
    ...state,
    // The component has to be selected too: managedShapes authorises the watch
    // plist only for an install that includes watch, so a core-only state
    // naming one is exactly the unauthorised-location case.
    components: [...new Set([...state.components, service])],
    plists: { ...state.plists, [service]: { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } },
  });
  return path;
}

test('a plist that is no longer ours is kept, and a service plist is otherwise removed', () => {
  const fixture = machine();
  const plist = withPlist(fixture);
  // Sanity: a plist this install wrote is a removal target at all. Without it
  // the drift assertion below could pass on a plan that removes no plists.
  assert.ok(judge(fixture).removing.includes(plist), 'the healthy plist is a target');

  // Edited in place, WITHOUT touching the recorded hash -- going through
  // withPlist again would move the baseline with the file and prove nothing.
  writeFileSync(plist, readFileSync(plist, 'utf8').replace('com.second-brain.watch', 'com.someone.else'), { mode: 0o600 });
  chmodSync(plist, 0o600);

  // The recorded hash is the authority now, so an edited plist is refused for
  // that rather than for the contract -- which is the point: the contract
  // passed files whose ProgramArguments had been rewritten.
  const { removing, keeping } = judge(fixture);
  assert.match(keeping.get(plist) ?? '', /has been modified since this install wrote it/);
  assert.equal(removing.includes(plist), false);
});

test('config is kept by default and only considered under --purge-config', () => {
  const fixture = machine();
  const conf = join(fixture.home, '.config', 'second-brain', 'brainkit.conf');

  assert.match(judge(fixture).keeping.get(conf) ?? '', /unless --purge-config/);
  assert.ok(judge(fixture, { purgeConfig: true }).removing.includes(conf));

  // Drift outranks the flag: a config the user edited is reported, not removed.
  writeFileSync(conf, `${readFileSync(conf, 'utf8')}# mine\n`, { mode: 0o600 });
  chmodSync(conf, 0o600);
  const drifted = judge(fixture, { purgeConfig: true });
  assert.match(drifted.keeping.get(conf) ?? '', /modified since this install wrote it/);
  assert.equal(drifted.removing.includes(conf), false);
});

test('--purge-logs only reaches the paths the plists themselves name', () => {
  const fixture = machine();
  withPlist(fixture);
  const logs = join(fixture.home, 'Library', 'Logs', 'second-brain');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'daemon.log'), 'ours\n');
  writeFileSync(join(logs, 'somebody-else.log'), 'not ours\n');

  const { removing } = judge(fixture, { purgeLogs: true });
  assert.ok(removing.includes(join(logs, 'daemon.log')), 'the declared target is in scope');
  assert.equal(removing.includes(join(logs, 'somebody-else.log')), false, 'a neighbour in the same directory is not');
  assert.equal(removing.includes(logs), false, 'and neither is the directory');
});

test('~/.local/bin is never a target and its third-party files are never named', () => {
  const fixture = machine();
  const bin = join(fixture.home, '.local', 'bin');
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n# somebody else\n', { mode: 0o755 });
  const theirs = image(join(bin, 'uv'));

  const paths = judge(fixture, { purgeConfig: true }).rows.map(row => row.path);
  assert.equal(paths.includes(bin), false, 'the shared directory is never a target');
  assert.equal(paths.includes(join(bin, 'uv')), false, 'and a third-party file is never named');
  assert.deepEqual(image(join(bin, 'uv')), theirs);
});

test('uninstall refuses on every non-terminal status and points at recover', () => {
  for (const status of ['installing', 'upgrading', 'recovery-required']) {
    const fixture = machine();
    writeInstallState(fixture.home, { ...readInstallState(fixture.home), status });
    const before = image(fixture.home);
    const { code, output, stderr } = plan(fixture);

    assert.equal(code, EXIT.UNSAFE, `${status} must be refused: ${output}`);
    assert.match(stderr, new RegExp(`status=${status}`), stderr);
    assert.match(stderr, /install\.mjs recover/, stderr);
    assert.equal(output.includes('Would remove'), false, `${status}: no plan is produced: ${output}`);
    assert.deepEqual(image(fixture.home), before, `${status}: refusing writes nothing`);
  }
});

test('uninstall through the CLI removes nothing at all', () => {
  // The degradation itself. A machine where every product is deletable -- the
  // case that used to exit 0 having removed the lot -- must come back with the
  // whole plan printed, the banner, and a HOME that is byte-for-byte what it
  // was, services included.
  const fixture = machine();
  const before = image(fixture.home);
  const bootouts = [];
  const { code, output } = plan(fixture, ['--purge-config', '--purge-logs', '--yes'], {
    run: (command, args = [], options) => {
      if (String(command).endsWith('launchctl') && args[0] === 'bootout') {
        bootouts.push(args[1]);
        return { status: 0, stdout: '', stderr: '' };
      }
      return fixture.base.run(command, args, options);
    },
  });

  assert.equal(code, EXIT.ACTIONABLE, output);
  assert.match(output, /does NOT remove anything: the execution half is disabled/, output);
  assert.deepEqual(bootouts, [], 'no service may be stopped');
  for (const relative of CORE_INSTALL_PRODUCTS) {
    assert.ok(existsSync(join(fixture.home, relative)), `${relative} is still on disk`);
  }
  assert.deepEqual(image(fixture.home), before, 'and nothing under HOME changed at all, mtime included');
});

// --- execution ---------------------------------------------------------------

test('a clean uninstall removes exactly the planned list and says what survived', () => {
  const fixture = machine();
  const shim = join(fixture.home, '.local', 'bin', 'brain-node');
  const { code, output } = execute(fixture);

  assert.equal(code, EXIT.OK, output);
  const removed = output.slice(output.indexOf('Removed'), output.indexOf('Kept'));
  for (const relative of CORE_INSTALL_PRODUCTS) {
    const path = join(fixture.home, relative);
    const planned = removed.includes(relative.split('/').pop());
    assert.equal(existsSync(path), !planned, `${relative}: on disk iff it was not in the removal list`);
  }
  assert.equal(existsSync(shim), false, 'the shim is gone');
  // §8.2 step 5's three notes.
  assert.match(output, /deployed code under 00-系统\/scripts\//, output);
  assert.match(output, /never rebuilt on its own/, output);
  assert.match(output, /straight to a check, because the manifest survived/, output);
});

test('the shared bin directory and its third-party files survive an uninstall', () => {
  const fixture = machine();
  const bin = join(fixture.home, '.local', 'bin');
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n# somebody else\n', { mode: 0o755 });
  const theirs = image(join(bin, 'uv'));

  execute(fixture);

  assert.ok(existsSync(bin), 'the directory itself is never removed');
  assert.deepEqual(image(join(bin, 'uv')), theirs, 'and nothing in it but our two names is touched');
});

test('a file that changes between the plan and the unlink is kept, not deleted', () => {
  // The window the lead named: the plan is printed, then the machine moves.
  // The re-judgement runs after bootout, so the shim is edited from inside the
  // launchctl seam -- which is the only thing that runs in between.
  const fixture = machine();
  const shim = join(fixture.home, '.local', 'bin', 'brain-node');
  // A recorded, authorised plist, so the service read actually happens -- that
  // launchctl call is the only thing running between the two judgements.
  const plist = withPlist(fixture);

  let edited = false;
  const { code, output } = execute(fixture, [], {
    run: (command, args = [], options) => {
      if (!edited && String(command).endsWith('launchctl')) {
        edited = true;
        writeFileSync(shim, `${readFileSync(shim, 'utf8')}# somebody edited this\n`, { mode: 0o755 });
      }
      return fixture.base.run(command, args, options);
    },
  });

  assert.ok(edited, 'the seam must actually have fired, or this proves nothing');
  assert.equal(code, EXIT.UNSAFE, output);
  assert.ok(existsSync(shim), 'a shim that changed under us is not deleted');
  assert.match(output, /changed while this uninstall was running/, output);
  // And the rest of the run still happened.
  assert.equal(existsSync(plist), false, 'the plist was still removed');
});

test('the install state is removed last, so a run that dies partway still has an account of itself', () => {
  // The removal list is printed in the order things were unlinked, so the
  // order is observable without a crash seam. If the state file went first, a
  // run that died in the middle would leave debris behind and no record that
  // this machine was ever installed -- which is the one shape recover cannot
  // diagnose.
  const fixture = machine();
  const { code, output } = execute(fixture);
  assert.equal(code, EXIT.OK, output);

  const removed = output.slice(output.indexOf('Removed'), output.indexOf('Kept'))
    .split('\n').filter(line => line.startsWith('  '));
  assert.ok(removed.length > 1, `more than one thing must have been removed: ${output}`);
  assert.match(removed.at(-1), /install-state\.json/, `the state file is removed last:\n${removed.join('\n')}`);
});

// One test per finding the independent review reproduced. The reviewer's own
// probes stay the hard criterion; these exist so the register has a gate in
// this repo that fails when each fix is withdrawn.
test('review findings F1, F2, F3, F5, F6 and F8', () => {
  // F1: the contract passes a plist whose ProgramArguments were rewritten, so
  // the recorded hash is the authority and a record without one deletes nothing.
  {
    const fixture = machine();
    const plist = withPlist(fixture);
    const state = readInstallState(fixture.home);
    writeInstallState(fixture.home, {
      ...state,
      plists: { ...state.plists, watch: { path: plist } },
    });
    const { removing, keeping } = judge(fixture);
    assert.equal(removing.includes(plist), false, 'a plist with no recorded hash is not deletable');
    assert.match(keeping.get(plist) ?? '', /no recorded content baseline/);
  }

  // F2: a plist judged keep must not name anything for deletion, and a log
  // target outside the installer's own log directory is not a target at all.
  {
    const fixture = machine();
    const victim = join(fixture.home, 'user-document.txt');
    writeFileSync(victim, 'not ours\n');
    const plist = withPlist(fixture, { label: 'com.someone.else', log: victim });
    assert.equal(judge(fixture, { purgeLogs: true }).removing.includes(victim), false,
      'a foreign plist authorises nothing');

    const ours = machine();
    withPlist(ours, { log: join(ours.home, 'user-document.txt') });
    writeFileSync(join(ours.home, 'user-document.txt'), 'not ours\n');
    assert.equal(judge(ours, { purgeLogs: true }).removing.includes(join(ours.home, 'user-document.txt')), false,
      'and a log path outside the log directory is refused even from a valid plist');
    assert.ok(plist, 'fixture built');

    // The two guards have to be told apart: a log INSIDE the log directory,
    // named by a plist that was judged keep. Only "the plist must itself be a
    // delete target" can refuse this one -- the location check would allow it.
    const inside = machine();
    const logs = join(inside.home, 'Library', 'Logs', 'second-brain');
    mkdirSync(logs, { recursive: true });
    const log = join(logs, 'daemon.log');
    writeFileSync(log, 'still wanted\n');
    const kept = withPlist(inside, { log });
    // Recorded first, then edited: the hash no longer matches, so the plist is
    // kept -- while still naming this log. Editing before the record would have
    // baked the change into the baseline and made it a delete target.
    writeFileSync(kept, `${readFileSync(kept, 'utf8')}<!-- theirs -->\n`, { mode: 0o600 });
    chmodSync(kept, 0o600);
    const verdict = judge(inside, { purgeLogs: true });
    assert.equal(verdict.removing.includes(kept), false, 'the plist itself is kept');
    assert.equal(verdict.removing.includes(log), false,
      'a kept plist names nothing for deletion, even in the right directory');
  }

  // F5: the real templates point several services at one daemon.log, and a
  // duplicate row deletes it once then reports the second attempt as failure.
  {
    const fixture = machine();
    const logs = join(fixture.home, 'Library', 'Logs', 'second-brain');
    mkdirSync(logs, { recursive: true });
    const log = join(logs, 'daemon.log');
    writeFileSync(log, 'shared\n');
    withPlist(fixture, { log });
    withPlist(fixture, { service: 'clip', label: 'com.second-brain.clip', log });
    const removing = judge(fixture, { purgeLogs: true }).removing;
    assert.equal(removing.filter(path => path === log).length, 1, `one row per path: ${removing}`);
  }

  // F6: state is an editable file, so a path it names is a claim. Location is
  // what confers ownership, and the shapes model already says which locations.
  {
    const fixture = machine();
    const victim = join(fixture.home, 'personal-note.md');
    writeFileSync(victim, 'mine\n');
    const state = readInstallState(fixture.home);
    writeInstallState(fixture.home, {
      ...state,
      managed_files: [...state.managed_files, { path: victim, sha256: createHash('sha256').update(readFileSync(victim)).digest('hex') }],
    });
    const { removing, keeping } = judge(fixture, { purgeConfig: true });
    assert.equal(removing.includes(victim), false, 'a hash match does not make somebody else\'s file ours');
    assert.match(keeping.get(victim) ?? '', /not one the installer creates/);
  }

  // F3 and F8 need the executing path.
  {
    // F3: the state swapped between the plan and the lock was never judged.
    // The window is between deciding the plan and taking the lock, so the swap
    // happens between those two calls -- which is what the caller does now that
    // runUninstall stops at the plan and the execution half is entered directly.
    const fixture = machine();
    const context = createContext({ ...fixture.base, stdout: () => {} });
    const state = readInstallState(fixture.home);
    const planned = uninstallPlan(context, state, {});
    writeInstallState(fixture.home, { ...readInstallState(fixture.home), installed_commit: 'b'.repeat(40) });

    const failure = refusal(() => uninstallExecute(context, state, {}, planned));
    assert.match(failure.message, /changed between the plan and the lock/);
    assert.equal(failure.exitCode, EXIT.UNSAFE, 'a state that changed under the plan is refused');
    assert.ok(existsSync(installStatePath(fixture.home)), 'and the replacement is not deleted');
  }
  {
    // F8: launchctl that cannot answer is not an answer.
    const fixture = machine();
    withPlist(fixture);
    const { code, stderr } = execute(fixture, [], {
      run: (command, args = [], options) => (String(command).endsWith('launchctl') && args[0] === 'print'
        ? { status: 1, stdout: '', stderr: 'Operation not permitted\n' }
        : fixture.base.run(command, args, options)),
    });
    assert.notEqual(code, EXIT.OK, 'an unknown service state stops the run');
    assert.match(stderr, /cannot determine whether/, stderr);
  }
});

test('a run that does not finish keeps the state file, so there is still an account', () => {
  // Ordering alone was not enough: state was last, but it was deleted anyway
  // even when earlier items had been kept or had failed. The one situation
  // that needs a record of what is still installed is the one that was losing
  // it.
  const fixture = machine();
  const shim = join(fixture.home, '.local', 'bin', 'brain-node');
  writeFileSync(shim, `${readFileSync(shim, 'utf8')}# edited by hand\n`, { mode: 0o755 });

  const { code, output } = execute(fixture);

  assert.equal(code, EXIT.UNSAFE, output);
  assert.ok(existsSync(shim), 'the drifted shim is kept');
  assert.ok(existsSync(installStatePath(fixture.home)), 'and so is the record that this machine is installed');
  assert.match(output, /only record of what is still here/, output);
});

test('a state whose only change is its status is still refused at the lock', () => {
  // sameStateIdentity exempts `status` -- correctly, for a transaction
  // rewriting its own field -- so on its own it calls this replacement the same
  // record. Only the explicit status comparison can refuse it, and uninstall
  // rejected every status but `installed` at the entrance, so that field is
  // part of what was judged.
  const fixture = machine();
  const shim = join(fixture.home, '.local', 'bin', 'brain-node');
  const conf = join(fixture.home, '.config', 'second-brain', 'brainkit.conf');
  const context = createContext({ ...fixture.base, stdout: () => {} });
  const state = readInstallState(fixture.home);
  const planned = uninstallPlan(context, state, {});
  // The window between deciding the plan and taking the lock.
  writeInstallState(fixture.home, { ...readInstallState(fixture.home), status: 'installing' });

  const failure = refusal(() => uninstallExecute(context, state, {}, planned));
    assert.match(failure.message, /changed between the plan and the lock/);
  assert.equal(failure.exitCode, EXIT.UNSAFE);
  assert.ok(existsSync(installStatePath(fixture.home)), 'the state is still there');
  assert.ok(existsSync(shim), 'and the shim');
  assert.ok(existsSync(conf), 'and the config');
});

test('every service is read before any is stopped', () => {
  // One label loaded from somewhere else means this machine has been misread,
  // and the report says so: "refusing to stop or remove anything". Reading and
  // stopping in one pass would make that sentence false -- the first service is
  // already down by the time the second one is found to be foreign.
  const fixture = machine();
  const clip = withPlist(fixture, { service: 'clip', label: 'com.second-brain.clip' });
  const watch = withPlist(fixture);
  const foreign = join(fixture.home, 'somebody-elses.plist');

  const bootouts = [];
  const { code, stderr } = execute(fixture, [], {
    run: (command, args = [], options) => {
      if (String(command).endsWith('launchctl')) {
        const [sub, target] = args;
        const label = String(target || '').split('/').pop();
        if (sub === 'bootout') { bootouts.push(label); return { status: 0, stdout: '', stderr: '' }; }
        if (sub === 'print') {
          // clip is ours; watch answers from a plist we never wrote. clip is
          // read first, so a stop-as-you-go loop stops it before reaching watch.
          const from = label === 'com.second-brain.watch' ? foreign : clip;
          return { status: 0, stdout: `gui/501/${label} = {\n\tpath = ${from}\n\tstate = running\n}\n`, stderr: '' };
        }
      }
      return fixture.base.run(command, args, options);
    },
  });

  assert.equal(code, EXIT.UNSAFE, stderr);
  assert.match(stderr, /refusing to stop or remove anything/, stderr);
  assert.deepEqual(bootouts, [], 'nothing may be stopped when any label is foreign');
  assert.ok(existsSync(clip), 'the plist that was ours is untouched');
  assert.ok(existsSync(watch), 'and so is the foreign one');
});

test('a declared log the service never created is listed, not counted as a failure', () => {
  // The other half of F5. withPlist names ~/Library/Logs/second-brain/daemon.log
  // and nothing creates it, which is what a service that was installed and never
  // ran actually looks like. The row still has to appear: "no longer a delete
  // target" and "gone from the report" are different outcomes, and only the
  // first one is the fix.
  const fixture = machine();
  withPlist(fixture);
  const log = join(fixture.home, 'Library', 'Logs', 'second-brain', 'daemon.log');

  const named = judge(fixture, { purgeLogs: true }).rows.filter(row => row.path === log);
  assert.equal(named.length, 1, `listed exactly once, not ${named.length} times`);
  assert.equal(named[0].action, 'keep', 'nothing to remove is not a removal');
  assert.match(named[0].why ?? '', /never created it/);

  const { code, output } = execute(fixture, ['--purge-logs', '--yes']);
  assert.equal(code, EXIT.OK, output);
  assert.equal(/could not be removed/.test(output), false, output);
  const kept = output.slice(output.lastIndexOf('Kept ('));
  assert.equal((kept.match(/daemon\.log/g) ?? []).length, 1, `once in the summary too:\n${kept}`);
});

test('the purge confirmation names every flag, and --non-interactive means nobody is asked', () => {
  // A TTY is present, so the question would otherwise be reachable; the flag is
  // what says there is nobody behind it. Both flags are on the command line, so
  // both have to appear in what the user is being told they authorised.
  const fixture = machine();
  const { code, stderr } = execute(fixture, ['--purge-config', '--purge-logs', '--non-interactive'], {
    interactive: true,
    tty: { ask: () => assert.fail('--non-interactive must not reach the question'), say() {} },
  });

  assert.notEqual(code, EXIT.OK);
  assert.match(stderr, /--purge-config and --purge-logs/, stderr);
  assert.ok(existsSync(join(fixture.home, '.config', 'second-brain', 'brainkit.conf')), 'and nothing was purged');
});

test('a plist recorded before the hash existed is still enumerated, and kept', () => {
  // Recording plists as { path, sha256 } is what gives F1 its authority, and it
  // changed the shape of a field older states already have on disk. Read as the
  // new shape, a bare-path record yields no path at all -- and a row with no
  // path leaves installedProducts, which makes the plist undeletable AND
  // invisible in the report. Kept-and-said-why is the floor; silence is not.
  const fixture = machine();
  const plist = withPlist(fixture);
  const state = readInstallState(fixture.home);
  writeInstallState(fixture.home, { ...state, plists: { ...state.plists, watch: plist } });

  const { removing, keeping } = judge(fixture);
  assert.equal(removing.includes(plist), false, 'no baseline, no deletion');
  assert.match(keeping.get(plist) ?? '', /no recorded content baseline/,
    `the old record must still appear in the report: ${[...keeping.keys()]}`);
});

test('the empty script directories go only under a corroborated vault root', () => {
  // §8.2 step 6 is the one place uninstall follows state.vault_root to a
  // filesystem call. The state is an editable file, so the root is corroborated
  // against brainkit.conf first -- otherwise a rewritten state points rmdir at
  // directories of somebody's choosing.
  const fixture = machine();
  const scripts = join(fixture.vault, '00-系统', 'scripts');
  for (const name of ['bin', 'cli', 'daemon', 'lib']) mkdirSync(join(scripts, name), { recursive: true });
  assert.equal(execute(fixture).code, EXIT.OK);
  for (const name of ['bin', 'cli', 'daemon', 'lib']) {
    assert.equal(existsSync(join(scripts, name)), false, `${name} was empty, so step 6 removes it`);
  }

  // Same shape, but the state names a root brainkit.conf does not.
  const other = machine();
  const elsewhere = join(other.home, 'not-the-vault');
  for (const name of ['bin', 'cli', 'daemon', 'lib']) mkdirSync(join(elsewhere, '00-系统', 'scripts', name), { recursive: true });
  writeInstallState(other.home, { ...readInstallState(other.home), vault_root: elsewhere });
  assert.equal(execute(other).code, EXIT.OK);
  for (const name of ['bin', 'cli', 'daemon', 'lib']) {
    assert.ok(existsSync(join(elsewhere, '00-系统', 'scripts', name)),
      `${name}: an uncorroborated root authorises nothing`);
  }
});

test('the adopted originals are named in the summary, not just implied', () => {
  const fixture = machine();
  const state = readInstallState(fixture.home);
  writeInstallState(fixture.home, {
    ...state,
    shims: { ...state.shims, node: { ...state.shims.node, adopted: true } },
  });

  const { output } = plan(fixture);
  assert.match(output, /--adopt-shims were never restored and never/, output);
  assert.match(output, new RegExp(`recovery/${state.last_txn}/`), `the path itself must be printed: ${output}`);
});

test('one removal failing does not abandon the rest', () => {
  const fixture = machine();
  const memory = join(fixture.home, 'Library', 'Application Support', 'brainkit', 'memory');
  const shim = join(fixture.home, '.local', 'bin', 'brain-node');
  chmodSync(memory, 0o500); // its files cannot be unlinked

  const { code, output } = execute(fixture, ['--purge-config', '--yes']);
  chmodSync(memory, 0o700);

  assert.equal(code, EXIT.UNSAFE, output);
  assert.match(output, /could not be removed/, output);
  assert.equal(existsSync(shim), false, 'work outside the failing directory still happened');
  assert.equal(existsSync(join(fixture.home, '.config', 'second-brain', 'brainkit.conf')), false,
    'and so did the purge the user asked for');
});

test('the purge flags need explicit authorization when nobody can be asked', () => {
  const fixture = machine();
  const { code, stderr } = execute(fixture, ['--purge-config']);

  assert.notEqual(code, EXIT.OK);
  assert.match(stderr, /re-run with --yes/, stderr);
  assert.ok(existsSync(join(fixture.home, '.config', 'second-brain', 'brainkit.conf')), 'and nothing was purged');
});

test('no install state is a refusal, not an empty plan', () => {
  const fixture = machine();
  rmSync(installStatePath(fixture.home));
  const { code, stderr } = plan(fixture);
  assert.notEqual(code, EXIT.OK);
  assert.match(stderr, /nothing to uninstall/, stderr);
});

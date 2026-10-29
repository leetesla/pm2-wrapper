#!/usr/bin/env node
'use strict';

// Real launchd/systemd integration. Uses an isolated PM2_HOME and service.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i]] = process.argv[i + 1];
if (!options['--runtime']) throw new Error('Usage: node scripts/test-startup.cjs --runtime DIR [--user USER]');
if (process.platform === 'linux' && process.getuid() !== 0) throw new Error('Linux integration requires root; --user selects the PM2 user');
if (process.platform === 'darwin' && process.getuid() === 0) throw new Error('Run macOS integration in the logged-in user session');
const source = __dirname;
const root = fs.realpathSync(fs.mkdtempSync('/tmp/pm2-startup-test-'));
const runtime = path.join(root, 'runtime');
const state = path.join(root, 'state');
const service = `pm2-wrapper-test-${process.pid}`;
const log = `${root}.log`;
const user = options['--user'] || os.userInfo().username;
const linux = process.platform === 'linux';
const account = user === os.userInfo().username ? { uid: process.getuid(), gid: process.getgid(), home: os.homedir() } : (() => {
  const p = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
  return { uid: Number(p[2]), gid: Number(p[3]), home: p[5] };
})();
fs.chmodSync(root, 0o755);
fs.mkdirSync(runtime);
for (const file of ['startup.cjs', 'lifecycle.cjs']) fs.copyFileSync(path.join(source, file), path.join(runtime, file));
fs.symlinkSync(path.resolve(options['--runtime'], 'node_modules'), path.join(runtime, 'node_modules'));
fs.mkdirSync(state, { mode: 0o700 });
if (process.getuid() === 0) fs.chownSync(state, account.uid, account.gid);
const cli = path.join(runtime, 'node_modules/pm2/bin/pm2');
const helper = path.join(runtime, 'startup.cjs');
const env = { HOME: account.home, PM2_HOME: state, USER: user, LOGNAME: user, LANG: 'C.UTF-8', TERM: 'xterm-256color',
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, NO_COLOR: '1', PM2_DISCRETE_MODE: 'true' };
const serviceFile = linux ? `/etc/systemd/system/${service}.service` : path.join(account.home, 'Library/LaunchAgents', `${service}.plist`);
const { context, readState, verifyApps } = require('./lifecycle.cjs');
function invoke(file, args, expected = 0, extra = {}) {
  const result = spawnSync(file, args, { env, cwd: account.home, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024, ...extra });
  fs.appendFileSync(log, `\n$ ${file} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}\nexit=${result.status}\n`);
  if (expected != null) assert.equal(result.status, expected, result.error?.message || (result.stdout || '') + (result.stderr || ''));
  return result;
}
function pm2(args, expected = 0) {
  const argv = [process.execPath, cli, ...args];
  return process.getuid() === 0 && account.uid !== 0 ? invoke('runuser', ['-u', user, '--', ...argv], expected) : invoke(argv[0], argv.slice(1), expected);
}
function lifecycle(action, yes = true, expected = 0) {
  return invoke(process.execPath, [helper, action, '--service-name', service, ...(linux ? ['-u', user] : []), ...(yes ? ['--yes'] : [])], expected);
}
function inspect() {
  const previous = process.env.PM2_HOME;
  process.env.PM2_HOME = state;
  try { return readState(context(['startup', '--service-name', service, ...(linux ? ['-u', user] : [])], runtime, {})); }
  finally { if (previous === undefined) delete process.env.PM2_HOME; else process.env.PM2_HOME = previous; }
}
function apps() {
  const args = [process.execPath, path.join(runtime, 'lifecycle.cjs'), '--read-apps'];
  const result = process.getuid() === 0 && account.uid !== 0 ? invoke('runuser', ['-u', user, '--', ...args]) : invoke(args[0], args.slice(1));
  return JSON.parse(result.stdout).filter(a => !a.pm2_env.pmx_module);
}
function interactive(action, answer, expected) {
  const argv = [process.execPath, helper, action, '--service-name', service, ...(linux ? ['-u', user] : [])];
  const python = `import os,pty,select,sys,time,json\npid,fd=pty.fork()\nif pid==0: os.execvpe(sys.argv[1],json.loads(sys.argv[2]),os.environ)\ndeadline=time.monotonic()+75;sent=False\nwhile time.monotonic()<deadline:\n ready,_,_=select.select([fd],[],[],0.2)\n if ready:\n  try: data=os.read(fd,65536)\n  except OSError: break\n  if not data: break\n  os.write(1,data)\n  if b'[Y/n]' in data and not sent: os.write(fd,sys.argv[3].encode());sent=True\n done,status=os.waitpid(pid,os.WNOHANG)\n if done: sys.exit(os.waitstatus_to_exitcode(status))\nelse:\n os.kill(pid,15);sys.exit(124)\n_,status=os.waitpid(pid,0);sys.exit(os.waitstatus_to_exitcode(status))\n`;
  invoke('python3', ['-c', python, process.execPath, JSON.stringify(argv), answer], expected);
}
let expectedApps;
try {
  assert.equal(fs.existsSync(serviceFile), false);
  lifecycle('startup', false, 1);
  assert.equal(fs.existsSync(serviceFile), false);
  console.log('PASS: noninteractive startup cancels without creating a service/daemon');
  const probe = path.join(root, 'probe.cjs');
  fs.writeFileSync(probe, 'setInterval(()=>{},1000);\n');
  for (const name of ['online', 'stopped']) pm2(['start', probe, '--name', name, '--interpreter', process.execPath]);
  pm2(['stop', 'stopped']);
  pm2(['save', '--force']);
  const oldDump = fs.readFileSync(path.join(state, 'dump.pm2'), 'utf8');
  pm2(['start', probe, '--name', 'unsaved', '--interpreter', process.execPath]);
  pm2(['start', probe, '--name', 'cluster', '--interpreter', process.execPath, '-i', '2']);
  expectedApps = apps();
  const standalone = inspect().daemon;
  assert.ok(standalone);
  interactive('startup', 'n\n', 1);
  assert.equal(inspect().daemon, standalone);
  assert.equal(fs.readFileSync(path.join(state, 'dump.pm2'), 'utf8'), oldDump);
  console.log('PASS: interactive refusal leaves daemon, applications and saved list unchanged');
  interactive('startup', '\n', 0);
  assert.equal(inspect().healthy, true);
  assert.notEqual(inspect().daemon, standalone);
  verifyApps(expectedApps, apps());
  const backups = fs.readdirSync(state).filter(name => name.startsWith('startup-backup-'));
  assert.ok(backups.some(name => fs.readFileSync(path.join(state, name, 'dump.pm2'), 'utf8') === oldDump));
  console.log('PASS: confirmed standalone handover saves unsaved apps, preserves stopped apps and backs up the previous dump');
  const managed = inspect().daemon;
  lifecycle('startup', false);
  assert.equal(inspect().daemon, managed);
  invoke(linux ? 'systemctl' : '/bin/launchctl', linux ? ['disable', `${service}.service`] : ['disable', `gui/${account.uid}/${service}`]);
  lifecycle('startup');
  assert.equal(inspect().daemon, managed);
  console.log('PASS: healthy startup and enable-only startup keep the same daemon PID');
  lifecycle('unstartup', false, 1);
  assert.equal(inspect().daemon, managed);
  interactive('unstartup', '\n', 0);
  assert.equal(inspect().daemon, 0);
  assert.equal(fs.existsSync(serviceFile), false);
  const saved = fs.readFileSync(path.join(state, 'dump.pm2'), 'utf8');
  pm2(['list']); // Empty standalone daemon; the nonempty saved dump must survive.
  assert.equal(apps().length, 0);
  lifecycle('startup');
  verifyApps(expectedApps, apps());
  assert.equal(fs.readFileSync(path.join(state, 'dump.pm2'), 'utf8'), saved);
  console.log('PASS: unstartup → empty standalone daemon → startup preserves and restores the nonempty dump');
  if (linux) {
    invoke('systemctl', ['stop', `${service}.service`]);
    pm2(['list']);
    const failed = invoke('systemctl', ['start', `${service}.service`], null);
    assert.notEqual(failed.status, 0, 'Expected real systemd PID handover failure');
  } else {
    invoke('/bin/launchctl', ['bootout', `gui/${account.uid}/${service}`]);
    invoke(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    const plist = JSON.parse(invoke('/usr/bin/plutil', ['-convert', 'json', '-o', '-', serviceFile]).stdout);
    plist.ProgramArguments = ['/usr/bin/false'];
    fs.writeFileSync(serviceFile, JSON.stringify(plist));
    invoke('/usr/bin/plutil', ['-convert', 'xml1', serviceFile]);
    invoke('/bin/launchctl', ['bootstrap', `gui/${account.uid}`, serviceFile]);
    pm2(['list']);
  }
  lifecycle('startup');
  assert.equal(inspect().healthy, true);
  verifyApps(expectedApps, apps());
  console.log(`PASS: recovery from real ${linux ? 'systemd PID/protocol failure' : 'launchd process failure'} with an independent daemon`);
  lifecycle('unstartup');
  assert.equal(fs.existsSync(serviceFile), false);
  assert.equal(inspect().daemon, 0);
  console.log(`PASS: ${process.platform} integration complete; test service and daemon removed. Log: ${log}`);
} catch (error) {
  console.error(error.stack);
  console.error(fs.readFileSync(log, 'utf8').slice(-18000));
  process.exitCode = 1;
} finally {
  if (fs.existsSync(serviceFile) || inspect().daemon) lifecycle('unstartup', true, null);
  if (inspect().daemon || fs.existsSync(serviceFile)) {
    console.error(`Cleanup incomplete; retained test state at ${root}`); process.exitCode = 1;
  } else fs.rmSync(root, { recursive: true, force: true });
}

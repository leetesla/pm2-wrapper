const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { parse, confirm, elevation, savedApplications, verifyApps, plan, approval, macPlist, mutate } = require('../lifecycle.cjs');
const app = (name, status = 'online', script = '/srv/app.cjs') => ({ name, pm2_env: { name, namespace: 'default', pm_exec_path: script, status } });
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-lifecycle-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('startup options normalize names, preserve overrides, and consume wrapper confirmation flags', () => {
  assert.deepEqual(parse(['startup', '--yes', '--service-name=custom.service', '-u', 'gituser', '--hp', '/srv/user', '--wait-ip'], { service: 'ignored' }), {
    action: 'startup', yes: true, service: 'custom', user: 'gituser', home: '/srv/user', waitIp: true,
  });
  assert.equal(parse(['unstartup'], { service: 'custom.plist' }).service, 'custom');
});
for (const args of [['startup', '--unknown'], ['startup', '--service-name'], ['startup', '--service-name', '-bad'], ['startup', '--service-name', '../other'], ['kill'], ['startup', 'systemv']]) {
  test(`invalid lifecycle options fail before execution: ${JSON.stringify(args)}`, () => assert.throws(() => parse(args)));
}
for (const [answer, expected] of [['y\n', true], ['YES\n', true], ['n\n', false], ['NO\n', false], ['\n', true], ['  \n', true], ['other\n', false]]) {
  test(`interactive confirmation ${JSON.stringify(answer)}`, async () => {
    const input = new PassThrough(), output = new PassThrough();
    input.isTTY = output.isTTY = true;
    const result = confirm('执行？', input, output);
    input.write(answer);
    assert.equal(await result, expected);
    input.destroy(); output.destroy();
  });
}
test('EOF cancels confirmation and noninteractive input never prompts', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  const result = confirm('执行？', input, output);
  input.end();
  assert.equal(await result, false);
  assert.equal(await confirm('执行？', { isTTY: false }, { isTTY: true }), false);
});

test('elevation survives shell quoting and pins Node, home, state and confirmed plan', t => {
  const root = temporary(t);
  const directory = path.join(root, "runtime 'quotes' $literal `value`");
  const bin = path.join(root, 'bin');
  fs.mkdirSync(directory); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(directory, 'startup.cjs'), 'console.log(JSON.stringify({node:process.execPath,home:process.env.HOME,state:process.env.PM2_HOME,token:process.env.PM2_WRAPPER_EXPECTED,args:process.argv.slice(2)}))');
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const c = { root: directory, user: 'gituser', home: '/srv/home with spaces', pm2Home: '/srv/state with spaces', node: process.execPath, env: { PATH: `${bin}:/usr/bin:/bin` } };
  const command = elevation(c, ['startup', '--service-name', 'custom'], 'confirmed-token');
  const result = spawnSync('/bin/sh', ['-c', command.display], { env: { ...process.env, PATH: c.env.PATH }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { node: process.execPath, home: c.home, state: c.pm2Home, token: 'confirmed-token', args: ['startup', '--service-name', 'custom', '--yes', '-u', 'gituser'] });
  assert.equal(elevation(c, ['startup', '--user=gituser', '--yes'], 'x').argv.filter(arg => arg === '--yes').length, 1);
});

test('saved app inspection preserves nonempty dumps and validates before mutation', t => {
  const root = temporary(t);
  const dump = JSON.stringify([app('saved').pm2_env]);
  fs.writeFileSync(path.join(root, 'dump.pm2'), dump);
  assert.equal(savedApplications({ pm2Home: root })[0].name, 'saved');
  assert.equal(fs.readFileSync(path.join(root, 'dump.pm2'), 'utf8'), dump);
  fs.renameSync(path.join(root, 'dump.pm2'), path.join(root, 'dump.pm2.bak'));
  assert.equal(savedApplications({ pm2Home: root }).length, 1);
  fs.writeFileSync(path.join(root, 'dump.pm2'), '{invalid');
  assert.throws(() => savedApplications({ pm2Home: root }));
  assert.equal(fs.readFileSync(path.join(root, 'dump.pm2'), 'utf8'), '{invalid');
});
test('app recovery checks identities, duplicate instances, missing apps and stopped status', () => {
  verifyApps([app('one'), app('one'), app('stopped', 'stopped')], [app('stopped', 'stopped'), app('one'), app('one')]);
  assert.throws(() => verifyApps([app('one'), app('one')], [app('one')]), /未恢复/);
  assert.throws(() => verifyApps([app('one')], [app('one', 'errored')]), /状态未恢复/);
  assert.throws(() => verifyApps([app('stopped', 'stopped')], [app('stopped')]), /状态未恢复/);
  assert.throws(() => verifyApps([app('one')], [app('one', 'online', '/different.cjs')]), /未恢复/);
  assert.throws(() => verifyApps([], [app('unexpected')]), /计划外/);
  assert.throws(() => verifyApps([app('one')], [{ ...app('one'), pid: 0 }], { runtime: true }), /PID 无效/);
  verifyApps([app('one')], [{ ...app('one'), pid: process.pid }], { runtime: true });
});
test('approval changes with daemon, configuration, application state or saved recovery list', () => {
  const initial = { pid: 1, daemon: 1, exists: true, p: { ExecStart: 'original', Environment: 'original' } };
  const token = approval(initial, [app('one')], [app('one')]);
  for (const [state, live, saved] of [
    [{ ...initial, daemon: 2 }, [app('one')], [app('one')]],
    [{ ...initial, p: { ...initial.p, ExecStart: 'changed' } }, [app('one')], [app('one')]],
    [initial, [app('one', 'stopped')], [app('one')]],
    [initial, [app('one')], [app('different')]],
  ]) assert.notEqual(approval(state, live, saved), token);
});
test('plans announce downtime for handover and avoid restarting healthy services', () => {
  assert.match(plan({ action: 'startup', platform: 'linux' }, { daemon: 123 }).join('\n'), /pm2 kill.*短暂停机/);
  assert.doesNotMatch(plan({ action: 'startup' }, { healthy: true }).join('\n'), /停止|kill/);
  assert.match(plan({ action: 'unstartup' }, {}).join('\n'), /保留恢复列表/);
});
test('save failures stop the lifecycle before daemon shutdown and retain backups', async t => {
  const root = temporary(t), cli = path.join(root, 'cli.cjs');
  const calls = path.join(root, 'calls');
  fs.writeFileSync(cli, `require('fs').appendFileSync(${JSON.stringify(calls)},process.argv.slice(2).join(' '));process.exit(9);`);
  const dump = JSON.stringify([app('online').pm2_env]);
  fs.writeFileSync(path.join(root, 'dump.pm2'), dump);
  const c = { action: 'startup', platform: 'darwin', node: process.execPath, cli, user: os.userInfo().username,
    uid: process.getuid(), gid: process.getgid(), home: root, pm2Home: root, file: '/unused.plist', env: { ...process.env, PM2_HOME: root } };
  const result = await mutate(c, { daemon: 123, healthy: false }, [app('online')], [app('online')]);
  assert.equal(result, 2);
  assert.equal(fs.readFileSync(calls, 'utf8'), 'save --force');
  assert.equal(fs.readFileSync(path.join(root, 'dump.pm2'), 'utf8'), dump);
  assert.equal(fs.readdirSync(root).filter(name => name.startsWith('startup-backup-')).length, 1);
});
test('macOS plist runs a pinned foreground daemon under the user launchd domain', t => {
  const root = temporary(t);
  const c = { node: process.execPath, root: '/runtime with & <quotes>', home: '/home/user', pm2Home: '/state', service: 'pm2-test', env: { PATH: '/node/bin:/usr/bin' } };
  const text = macPlist(c);
  assert.match(text, /--foreground/);
  assert.match(text, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(text, /LaunchOnlyOnce|sudo/);
  assert.match(text, /with &amp; &lt;quotes&gt;/);
  if (process.platform === 'darwin') {
    const file = path.join(root, 'test.plist'); fs.writeFileSync(file, text);
    const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).ProgramArguments, [c.node, path.join(c.root, 'lifecycle.cjs'), '--foreground']);
  }
});
test('failed sudo authentication leaves service and applications untouched', { skip: process.platform !== 'linux' || process.getuid() === 0 }, t => {
  const root = temporary(t), bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 77\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'node_modules/pm2/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/pm2/bin/pm2'), 'throw Error("must not execute");');
  for (const file of ['startup.cjs', 'lifecycle.cjs']) fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(root, file));
  const state = path.join(root, 'state');
  const result = spawnSync(process.execPath, [path.join(root, 'startup.cjs'), 'startup', '--yes', '--service-name', `pm2-auth-test-${process.pid}`], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PM2_HOME: state }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /sudo 认证失败/);
  assert.equal(fs.existsSync(state), false);
});

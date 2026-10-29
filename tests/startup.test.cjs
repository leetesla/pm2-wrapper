const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { words, resolveNode, macStatus, linuxConfig, linuxNode, show } = require('../startup.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-startup-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pm2 = path.join(root, 'pm2');
  fs.writeFileSync(pm2, '#!/usr/bin/env node\nthrow new Error("must never execute PM2");\n');
  return { root, pm2 };
}

test('startup interpreter follows service PATH rather than current shell', (t) => {
  const { root, pm2 } = fixture(t);
  const node = path.join(root, 'node');
  fs.symlinkSync(process.execPath, node);
  assert.equal(resolveNode(['/bin/sh', '-c', `'${pm2}' resurrect`], { PATH: `${root}:/usr/bin:/bin` }), node);
  assert.equal(resolveNode([process.execPath, pm2, 'resurrect'], {}), process.execPath);
  fs.writeFileSync(pm2, `#!${process.execPath}\n`);
  assert.equal(resolveNode([pm2, 'resurrect'], { PATH: root }), process.execPath);
});

test('startup checks reject ambiguous scripts and shell expressions without executing them', (t) => {
  const { root, pm2 } = fixture(t);
  for (const command of [`${pm2}; touch /tmp/should-not-exist`, `${pm2} $(node --version)`, `${pm2}\nnode`]) {
    assert.throws(() => resolveNode(['/bin/sh', '-c', command], { PATH: root }), /复核|复杂|替换/);
  }
  assert.throws(() => resolveNode([pm2], { PATH: `.:${root}` }), /绝对 PATH/);
  fs.writeFileSync(pm2, '#!/bin/sh\nexec node "$@"\n');
  assert.throws(() => resolveNode([pm2], { PATH: root }), /未知解释器/);
});

test('shell tokenizer preserves literal quoted paths and rejects expansions', () => {
  assert.deepEqual(words("'path with spaces' 'it'\\''s' plain\\ word"), ['path with spaces', "it's", 'plain word']);
  assert.throws(() => words('"$(whoami)"'), /替换/);
  assert.throws(() => words("'unfinished"), /引号/);
  assert.throws(() => words('unfinished\\'), /转义/);
});

test('systemd inspection reads effective unit properties and resolves Node', (t) => {
  const { root, pm2 } = fixture(t);
  fs.symlinkSync(process.execPath, path.join(root, 'node'));
  const calls = [];
  const query = (file, args) => {
    calls.push([file, args]);
    return { status: 0, stdout: args[0] === 'cat' ? '# unit contents\n' : [
      'LoadState=loaded', 'FragmentPath=/etc/systemd/system/custom.service', 'NeedDaemonReload=no',
      'EnvironmentFiles=', `Environment="PATH=${root}:/usr/bin:/bin" "PM2_HOME=/srv/pm2"`,
      `ExecStart={ path=${pm2} ; argv[]=${pm2} resurrect ; }`,
    ].join('\n') };
  };
  const definition = linuxConfig('custom', query);
  assert.equal(definition.unit, 'custom.service');
  assert.equal(definition.file, '/etc/systemd/system/custom.service');
  assert.equal(linuxNode(definition.config), path.join(root, 'node'));
  assert.deepEqual(calls.map((call) => call[1][0]), ['show', 'cat']);
  assert.throws(() => linuxNode({ ...definition.config, EnvironmentFiles: '/etc/secret.env' }), /人工复核/);
  assert.throws(() => linuxNode({ ...definition.config, NeedDaemonReload: 'yes' }), /人工复核/);
  assert.throws(() => linuxConfig('missing', () => ({ status: 0, stdout: 'LoadState=not-found' })), /未找到/);
});

test('launchd login enablement is independent of one-shot registration', (t) => {
  const { pm2: file } = fixture(t);
  const config = { Label: 'com.PM2', RunAtLoad: true, LaunchOnlyOnce: true };
  const calls = [];
  const query = (command, args) => {
    calls.push(args);
    return args[0] === 'print-disabled' ? { status: 0, stdout: 'disabled services = {\n}\n' } :
      { status: 113, stderr: 'Bad request.\nCould not find service "com.PM2" in domain', stdout: '' };
  };
  const result = macStatus(config, file, query);
  assert.match(result.enabled, /已启用/);
  assert.match(result.state, /一次性启动任务当前未注册/);
  assert.equal(result.uncertain, false);
  assert.deepEqual(calls.map((args) => args[0]), ['print-disabled', 'print', 'print', 'print']);
});

test('launchd disabled override takes precedence and unknown queries remain uncertain', (t) => {
  const { pm2: file } = fixture(t);
  const config = { Label: 'com.PM2', RunAtLoad: true };
  const missing = { status: 113, stderr: 'Could not find service "com.PM2" in domain', stdout: '' };
  const disabled = macStatus(config, file, (_, args) => args[0] === 'print-disabled' ?
    { status: 0, stdout: 'disabled services = {\n "com.PM2" => true\n}' } : missing);
  assert.equal(disabled.enabled, '已禁用');
  assert.equal(disabled.uncertain, false);
  const unknown = macStatus(config, file, () => ({ status: 1, stderr: 'Permission denied', stdout: '' }));
  assert.match(unknown.enabled, /无法确认/);
  assert.equal(unknown.uncertain, true);
  const spawnError = macStatus(config, file, () => ({ status: null, stdout: null, stderr: null, error: new Error('not found') }));
  assert.equal(spawnError.uncertain, true);
});

for (const version of [process.version, 'v0.0.0']) {
  test(`show startup compares against wrapper Node (${version}) using read-only calls`, () => {
    const output = [];
    const calls = [];
    const query = (command, args) => {
      calls.push([command, args]);
      if (command === process.execPath) return { status: 0, stdout: version + '\n' };
      assert.equal(command, 'systemctl');
      assert.equal(args[1], 'custom.service');
      if (args[0] === 'cat') return { status: 0, stdout: '# startup unit\n' };
      assert.equal(args[0], 'show');
      return { status: 0, stdout: [
        'LoadState=loaded', 'FragmentPath=/etc/systemd/system/custom.service', 'EnvironmentFiles=',
        'NeedDaemonReload=no', 'Environment=', `ExecStart={ path=${process.execPath} ; }`,
        'UnitFileState=enabled', 'ActiveState=inactive', 'SubState=dead', 'MainPID=0',
      ].join('\n') };
    };
    const code = show(['--service', 'custom'], { service: 'ignored' }, { platform: 'linux', query, log: (line) => output.push(line) });
    assert.equal(code, version === process.version ? 0 : 2);
    assert.match(output.join('\n'), version === process.version ? /启动 Node 版本与 wrapper 一致/ : /启动 Node 版本与 wrapper 不一致/);
    assert.match(output.join('\n'), /inactive\/dead/);
    assert.equal(calls.length, 3);
  });
}

test('show startup reports missing interpreter as unverifiable', () => {
  const output = [];
  const query = (_, args) => ({ status: 0, stdout: args[0] === 'cat' ? '# unit\n' : [
    'LoadState=loaded', 'EnvironmentFiles=', 'NeedDaemonReload=no', 'Environment=',
    'ExecStart={ path=/missing/node ; }', 'UnitFileState=enabled',
  ].join('\n') });
  assert.equal(show([], {}, { platform: 'linux', query, log: (line) => output.push(line) }), 2);
  assert.match(output.join('\n'), /启动 Node 未验证/);
});

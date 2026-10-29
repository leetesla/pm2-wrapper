const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pm2-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, 'runtime with spaces');
  const log = join(root, 'events');
  mkdirSync(join(root, 'scripts'));
  copyFileSync(resolve(__dirname, '../Makefile'), join(root, 'Makefile'));
  writeFileSync(join(root, '.nvmrc'), '22.21.1\n');
  writeFileSync(join(root, 'scripts/install.sh'), '#!/bin/sh\nexec "$TEST_NODE" "$TEST_INSTALL" "$@"\n', { mode: 0o755 });
  writeFileSync(join(root, 'install.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(['install', ...args]) + '\\n');
if (process.env.TEST_INSTALL_FAIL) process.exit(1);
const destination = args[args.indexOf('--dir') + 1];
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'pm2'), '#!/bin/sh\\nexec "$TEST_NODE" "$TEST_REFRESH" "$@"\\n', { mode: 0o755 });
`);
  writeFileSync(join(root, 'refresh.cjs'), `
require('node:fs').appendFileSync(process.env.TEST_LOG, JSON.stringify(['daemon', ...process.argv.slice(2)]) + '\\n');
if (process.env.TEST_REFRESH_FAIL) process.exit(1);
`);
  return {
    destination,
    events: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    run: (args = [], env = {}) => spawnSync('make', ['update', ...args, `INSTALL_DIR=${destination}`], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PM2_VERSION: '',
        TEST_NODE: process.execPath,
        TEST_INSTALL: join(root, 'install.cjs'),
        TEST_REFRESH: join(root, 'refresh.cjs'),
        TEST_LOG: log,
        ...env,
      },
    }),
  };
}

for (const [args, expected] of [
  [[], 'latest'],
  [['6.0.0'], '6.0.0'],
  [['latest'], 'latest'],
  [['PM2_VERSION=6.0.1'], '6.0.1'],
  [['6.0.0', 'PM2_VERSION=6.0.1'], '6.0.0'],
]) {
  test(`make update ${args.join(' ')} installs the requested version before updating the daemon`, t => {
    const f = fixture(t);
    const result = f.run([...args, 'NVM_DIR=/custom nvm']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.events(), [
      ['install', '--dir', f.destination, '--node-version', '22.21.1', '--pm2-version', expected, '--nvm-dir', '/custom nvm'],
      ['daemon', 'update'],
    ]);
  });
}

test('failed package installation does not update the daemon', t => {
  const f = fixture(t);
  const result = f.run([], { TEST_INSTALL_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(f.events().length, 1);
  assert.equal(f.events()[0][0], 'install');
});

test('daemon update failure is returned to make', t => {
  const f = fixture(t);
  assert.notEqual(f.run([], { TEST_REFRESH_FAIL: '1' }).status, 0);
  assert.equal(f.events().length, 2);
});

test('multiple version arguments are rejected before installation', t => {
  const f = fixture(t);
  const result = f.run(['6.0.0', '6.0.1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: make update/);
  assert.deepEqual(f.events(), []);
});

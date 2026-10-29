const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

function fixture(t, installed = false) {
  const root = mkdtempSync(join(tmpdir(), 'pm2-nvmrc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nvm = join(root, 'nvm with spaces');
  mkdirSync(nvm);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(resolve(__dirname, '../Makefile'), join(root, 'Makefile'));
  copyFileSync(resolve(__dirname, '../scripts/write-nvmrc.sh'), join(root, 'scripts/write-nvmrc.sh'));
  writeFileSync(join(root, '.nvmrc'), 'v18.0.0\n');
  if (installed) writeFileSync(join(nvm, 'installed'), '');
  writeFileSync(join(nvm, 'nvm.sh'), `
[ "$1" = --no-use ] || return 1
nvm() {
  printf '%s\\n' "$*" >> "$NVM_DIR/calls"
  case "$1" in
    version)
      if [ -f "$NVM_DIR/installed" ]; then printf 'v22.1.2\\n'; else printf 'N/A\\n'; return 3; fi
      ;;
    install)
      [ "\${TEST_INSTALL_FAIL:-}" != 1 ] || return 1
      touch "$NVM_DIR/installed"
      ;;
    *) return 1 ;;
  esac
}
`);
  return {
    root,
    nvm,
    version: () => readFileSync(join(root, '.nvmrc'), 'utf8'),
    calls: () => existsSync(join(nvm, 'calls')) ? readFileSync(join(nvm, 'calls'), 'utf8') : '',
    run: (args = ['22'], input = '', env = {}) => spawnSync('make', ['nvmrc', ...args], {
      cwd: root,
      input,
      encoding: 'utf8',
      env: { ...process.env, NVM_DIR: nvm, ...env },
    }),
  };
}

test('make nvmrc without a version records the current Node without nvm', (t) => {
  const f = fixture(t);
  const result = f.run([], '', { NVM_DIR: join(f.root, 'missing') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.version(), `${process.version}\n`);
  assert.equal(f.calls(), '');
});

for (const version of ['22', '22.1.2', 'lts/*']) {
  test(`make nvmrc ${version} resolves an installed version without prompting`, (t) => {
    const f = fixture(t, true);
    const result = f.run([version]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.version(), 'v22.1.2\n');
    assert.equal(f.calls(), `version ${version}\n`);
    assert.doesNotMatch(result.stderr, /Install with nvm/);
  });
}

for (const input of ['\n', 'y\n', 'Y\n', 'yes\n', 'YES\n', 'yEs\n', 'invalid\nY\n']) {
  test(`missing Node installs for ${JSON.stringify(input)}`, (t) => {
    const f = fixture(t);
    const result = f.run(['22'], input);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Install with nvm\? \[Y\/n\]/);
    assert.equal(f.calls(), 'version 22\ninstall 22\nversion 22\n');
    assert.equal(f.version(), 'v22.1.2\n');
    if (input.startsWith('invalid')) assert.match(result.stderr, /Please enter yes or no/);
  });
}

for (const input of ['n\n', 'N\n', 'no\n', 'NO\n', 'nO\n', '']) {
  test(`missing Node cancels for ${JSON.stringify(input)} without changing .nvmrc`, (t) => {
    const f = fixture(t);
    const result = f.run(['22'], input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cancelled/);
    assert.equal(f.calls(), 'version 22\n');
    assert.equal(f.version(), 'v18.0.0\n');
  });
}

test('failed installation preserves .nvmrc', (t) => {
  const f = fixture(t);
  const result = f.run(['22'], '\n', { TEST_INSTALL_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not install Node 22/);
  assert.equal(f.version(), 'v18.0.0\n');
});

test('missing nvm preserves .nvmrc', (t) => {
  const f = fixture(t);
  const result = f.run(['22'], '\n', { NVM_DIR: join(f.root, 'missing') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nvm.sh not found/);
  assert.equal(f.version(), 'v18.0.0\n');
});

test('multiple version arguments are rejected before writing .nvmrc', (t) => {
  const f = fixture(t);
  const result = f.run(['22', '24'], '\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: make nvmrc/);
  assert.equal(f.calls(), '');
  assert.equal(f.version(), 'v18.0.0\n');
});

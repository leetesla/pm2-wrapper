const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, symlinkSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join, dirname } = require('node:path');
const { test } = require('node:test');

const installer = resolve(__dirname, '../install.sh');
const uninstaller = resolve(__dirname, '../uninstall.sh');

function fixture(t, existing = true, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pm2-wrapper-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const nvm = join(root, 'nvm');
  const destination = join(root, options.directoryName || 'installation with spaces');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(nvm);
  mkdirSync(home);
  if (existing) writeFileSync(join(bin, 'pm2'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(nvm, 'nvm.sh'), `
nvm() {
  case "$1" in
    use) return 0 ;;
    which) printf '%s\\n' "$TEST_NODE" ;;
    *) return 1 ;;
  esac
}
`);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh
set -eu
mkdir -p "$3/node_modules/pm2/bin"
printf '%s\\n' '{"version":"1.2.3"}' > "$3/node_modules/pm2/package.json"
printf '%s\\n' '// test CLI' > "$3/node_modules/pm2/bin/pm2"
`, { mode: 0o755 });
  const run = (input, preview = false) => spawnSync('/bin/sh', [
    installer,
    ...(preview ? ['--preview'] : ['--dir', destination]),
    '--node-version', process.version,
    '--nvm-dir', nvm,
    ...(options.args || []),
  ], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      TEST_NODE: process.execPath,
      HOME: home,
      SHELL: '/bin/zsh',
      ZDOTDIR: '',
      ...options.env,
    },
  });
  const uninstall = (args = [], environment = {}) => spawnSync('/bin/sh', [uninstaller, '--dir', destination, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      ZDOTDIR: '',
      ...options.env,
      ...environment,
    },
  });
  return { root, bin, home, destination, run, uninstall };
}

for (const input of ['n\n', 'N\n', '\n', 'yes\n', 'invalid\n', '']) {
  test(`existing PM2 cancels for ${JSON.stringify(input)}`, (t) => {
    const { destination, bin, run } = fixture(t);
    const result = run(input);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(join(bin, 'pm2')));
    assert.match(result.stderr, /Continue installation\? \[y\/N\]/);
    assert.match(result.stderr, /Installation cancelled/);
    assert.equal(existsSync(destination), false);
  });
}

for (const input of ['y\n', 'Y\n']) {
  test(`existing PM2 continues for ${JSON.stringify(input)}`, (t) => {
    const { destination, run } = fixture(t);
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Continue installation\?/);
    assert.equal(existsSync(join(destination, 'pm2')), true);
    assert.equal(existsSync(join(destination, 'node_modules/pm2/package.json')), true);
  });
}

test('no existing PM2 installs without prompting', (t) => {
  const { destination, run } = fixture(t, false);
  const result = run('');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Continue installation\?/);
  assert.equal(existsSync(join(destination, 'pm2')), true);
  assert.equal(existsSync(join(destination, 'startup.cjs')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(destination, 'startup.json'), 'utf8')), { service: null });
});

test('reinstall preserves startup configuration', (t) => {
  const { destination, run } = fixture(t, false);
  assert.equal(run('').status, 0);
  const config = '{"service":"my-pm2"}\n';
  writeFileSync(join(destination, 'startup.json'), config);
  assert.equal(run('').status, 0);
  assert.equal(readFileSync(join(destination, 'startup.json'), 'utf8'), config);
});

test('startup command survives copying into a shell with another Node first in PATH', (t) => {
  const { destination, bin, home, run } = fixture(t, false, {
    directoryName: "runtime with spaces 'quoted' $literal `value`",
  });
  assert.equal(run('').status, 0);
  // First emulate PM2's unprivileged hint, then emulate the elevated startup
  // process. A fake sudo simply executes env; no privileges/services are used.
  writeFileSync(join(destination, 'node_modules/pm2/bin/pm2'), `
if (!process.argv.includes('-u')) {
  console.log('sudo env PATH=$PATH:/wrong/node/bin pm2 startup');
  console.error('original diagnostic');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({node: process.execPath, path: process.env.PATH, home: process.env.HOME, pm2Home: process.env.PM2_HOME, args: process.argv.slice(2)}));
}
`);
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho WRONG_NODE >&2\nexit 88\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, PM2_HOME: join(home, 'custom state') };
  const hint = spawnSync(join(destination, 'pm2'), ['startup', 'launchd', '--service-name', 'custom-pm2'], { env, encoding: 'utf8' });
  assert.equal(hint.status, 1, hint.stderr);
  assert.match(hint.stderr, /original diagnostic/);
  const result = spawnSync('/bin/sh', ['-c', hint.stdout.trim()], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.node, process.execPath);
  assert.equal(report.path.split(':')[0], dirname(process.execPath));
  assert.ok(report.path.includes(bin));
  assert.equal(report.home, home);
  assert.equal(report.pm2Home, env.PM2_HOME);
  assert.deepEqual(report.args.slice(0, 4), ['startup', 'launchd', '--service-name', 'custom-pm2']);
});

test('startup/unstartup prepend pinned Node and honor configured service', (t) => {
  const { destination, bin, home, run } = fixture(t, false);
  assert.equal(run('').status, 0);
  writeFileSync(join(destination, 'startup.json'), '{"service":"custom-pm2"}');
  writeFileSync(join(destination, 'node_modules/pm2/bin/pm2'), 'console.log(JSON.stringify({args:process.argv.slice(2),path:process.env.PATH}));');
  for (const command of ['startup', 'unstartup']) {
    const result = spawnSync(join(destination, 'pm2'), [command], { encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.args, [command, '--service-name', 'custom-pm2']);
    assert.equal(report.path.split(':')[0], dirname(process.execPath));
  }
  // Existing PM2 commands are forwarded without changing their arguments.
  const normal = spawnSync(join(destination, 'pm2'), ['show', 'my-app'], { encoding: 'utf8' });
  assert.equal(normal.status, 0, normal.stderr);
  assert.deepEqual(JSON.parse(normal.stdout).args, ['show', 'my-app']);
});

test('show startup works without PM2 installed and rejects invalid arguments', (t) => {
  const { destination, home, run } = fixture(t, false);
  assert.equal(run('').status, 0);
  rmSync(join(destination, 'node_modules'), { recursive: true });
  const result = spawnSync(join(destination, 'pm2'), ['show', 'startup', '--unknown'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /用法：pm2 show startup/);
  assert.doesNotMatch(result.stderr, /PM2 CLI/);
});

test('existing wrapper symlink does not prompt on reinstall', (t) => {
  const { destination, bin, run } = fixture(t, false);
  assert.equal(run('').status, 0);
  symlinkSync(join(destination, 'pm2'), join(bin, 'pm2'));
  const result = run('');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Continue installation\?/);
});

test('preview skips the prompt and npm installation', (t) => {
  const { root, bin, home, run } = fixture(t);
  const result = run('', true);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Continue installation\?/);
  assert.ok(result.stderr.includes(`Existing PM2 command found: ${join(bin, 'pm2')}`));
  assert.match(result.stderr, /Preview only; no confirmation required/);
  assert.doesNotMatch(result.stderr, /\x1b\[/);
  assert.match(result.stderr, /┌  pm2-wrapper · preview/);
  assert.match(result.stderr, /◇  Check existing PM2[\s\S]*◇  Resolve Node.js[\s\S]*◇  Generate wrapper[\s\S]*└  ✓ Generated wrapper preview/);
  assert.equal(existsSync(join(root, 'pm2')), true);
  assert.equal(existsSync(join(root, 'node_modules')), false);
  assert.equal(existsSync(join(root, '.nvmrc')), false);
  assert.equal(existsSync(join(home, '.zshrc')), false);
});

test('zsh setup preserves user content and repeated installs update one PATH block', (t) => {
  const { home, destination, run } = fixture(t, false);
  const file = join(home, '.zshrc');
  const original = '# existing config without a trailing newline';
  writeFileSync(file, original);
  assert.equal(run('').status, 0);
  const first = readFileSync(file, 'utf8');
  assert.ok(first.startsWith(original + '\n'));
  assert.ok(first.includes(destination));
  assert.equal(run('').status, 0);
  assert.equal(readFileSync(file, 'utf8'), first);
  // Reinstalling to a different destination replaces the old path.
  writeFileSync(file, first.replaceAll(destination, '/old/runtime'));
  assert.equal(run('').status, 0);
  assert.equal(readFileSync(file, 'utf8'), first);
});

for (const profile of ['.bash_profile', '.bash_login', '.profile', null]) {
  test(`bash configures interactive and login startup (${profile || 'new home'})`, (t) => {
    const { home, destination, run } = fixture(t, false, { env: { SHELL: '/bin/bash' } });
    if (profile) writeFileSync(join(home, profile), '# user profile\n');
    const result = run('');
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['.bashrc', profile || '.profile']) {
      assert.ok(readFileSync(join(home, name), 'utf8').includes(destination));
    }
    if (profile !== '.bash_profile') assert.equal(existsSync(join(home, '.bash_profile')), false);
    assert.equal(existsSync(join(home, '.zshrc')), false);
  });
}

test('bash uses the first existing login profile without changing the others', (t) => {
  const { home, run } = fixture(t, false, { env: { SHELL: '/bin/bash' } });
  for (const name of ['.bash_profile', '.bash_login', '.profile']) {
    writeFileSync(join(home, name), '# existing\n');
  }
  assert.equal(run('').status, 0);
  assert.match(readFileSync(join(home, '.bash_profile'), 'utf8'), /pm2-wrapper/);
  for (const name of ['.bash_login', '.profile']) {
    assert.equal(readFileSync(join(home, name), 'utf8'), '# existing\n');
  }
});

test('zsh honors ZDOTDIR', (t) => {
  const config = mkdtempSync(join(tmpdir(), 'pm2-wrapper-zdotdir-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const { home, run } = fixture(t, false, { env: { ZDOTDIR: config } });
  const result = run('');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(config, '.zshrc')), true);
  assert.equal(existsSync(join(home, '.zshrc')), false);
});

test('PATH setup can be disabled', (t) => {
  const { home, run } = fixture(t, false, { args: ['--no-modify-path'] });
  const result = run('');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(home, '.zshrc')), false);
  assert.doesNotMatch(result.stderr, /Configure PATH/);
});

test('unsupported shells receive a manual PATH command', (t) => {
  const { home, run } = fixture(t, false, { env: { SHELL: '/bin/fish' } });
  const result = run('');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /automatic PATH setup supports bash and zsh/);
  assert.match(result.stderr, /export PATH=/);
  assert.equal(existsSync(join(home, '.zshrc')), false);
});

for (const shell of ['/bin/bash', '/bin/zsh']) {
  test(`${shell} resolves the installed wrapper after loading generated config`, {
    skip: !existsSync(shell),
  }, (t) => {
    const { home, destination, run } = fixture(t, false, {
      env: { SHELL: shell },
      directoryName: "installation with spaces 'quoted' $literal `value`",
    });
    assert.equal(run('').status, 0);
    const name = shell.endsWith('bash') ? '.bashrc' : '.zshrc';
    // Exercise literal quoting without depending on global startup files.
    const result = spawnSync(shell, ['-c', '. "$HOME/$STARTUP"; . "$HOME/$STARTUP"; command -v pm2; printf "%s\\n" "$PATH"'], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin', STARTUP: name },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [
      join(destination, 'pm2'), `${destination}:/usr/bin:/bin`,
    ]);
  });
}

test('preview reports when no PM2 command exists without prompting', (t) => {
  const { root, run } = fixture(t, false);
  const result = run('', true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /No PM2 command found in PATH/);
  assert.doesNotMatch(result.stderr, /Continue installation\?/);
  assert.equal(existsSync(join(root, 'pm2')), true);
});

test('uninstall removes the runtime and zsh block, preserving config and PM2 state', (t) => {
  const { home, destination, run, uninstall } = fixture(t, false);
  const config = join(home, '.zshrc');
  writeFileSync(config, '# user config\n');
  mkdirSync(join(home, '.pm2'));
  writeFileSync(join(home, '.pm2', 'dump.pm2'), 'saved processes');
  assert.equal(run('').status, 0);
  const result = uninstall();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(config, 'utf8'), '# user config\n');
  assert.equal(readFileSync(join(home, '.pm2', 'dump.pm2'), 'utf8'), 'saved processes');
  assert.equal(uninstall().status, 0);
});

test('uninstall cleans bash config even if the current shell changed', (t) => {
  const { home, run, uninstall } = fixture(t, false, { env: { SHELL: '/bin/bash' } });
  assert.equal(run('').status, 0);
  const result = uninstall([], { SHELL: '/bin/zsh' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['.bashrc', '.profile']) {
    assert.equal(readFileSync(join(home, name), 'utf8'), '');
  }
});

test('uninstall matches PATH blocks containing literal shell characters', (t) => {
  const { home, destination, run, uninstall } = fixture(t, false, {
    directoryName: "runtime with spaces 'quoted' $literal `value`",
  });
  assert.equal(run('').status, 0);
  const config = join(home, '.zshrc');
  writeFileSync(config, readFileSync(config, 'utf8') + '# user settings after the block\n');
  const result = uninstall();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(config, 'utf8'), '# user settings after the block\n');
});

test('uninstall cleans custom ZDOTDIR and preserves startup file symlinks', (t) => {
  const configDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'pm2-wrapper-uninstall-zdotdir-')));
  t.after(() => rmSync(configDirectory, { recursive: true, force: true }));
  const { root, run, uninstall } = fixture(t, false, { env: { ZDOTDIR: configDirectory } });
  const target = join(root, 'actual-zshrc');
  writeFileSync(target, '# symlinked config\n');
  symlinkSync(target, join(configDirectory, '.zshrc'));
  assert.equal(run('').status, 0);
  const result = uninstall();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync(join(configDirectory, '.zshrc')), target);
  assert.equal(readFileSync(target, 'utf8'), '# symlinked config\n');
});

test('uninstall leaves PATH configuration for another installation intact', (t) => {
  const { home, destination, run, uninstall } = fixture(t, false);
  assert.equal(run('').status, 0);
  const config = join(home, '.zshrc');
  const content = readFileSync(config, 'utf8').replaceAll(destination, '/other/runtime');
  writeFileSync(config, content);
  assert.equal(uninstall().status, 0);
  assert.equal(readFileSync(config, 'utf8'), content);
});

test('uninstall preserves unrelated files in the runtime directory', (t) => {
  const { destination, run, uninstall } = fixture(t, false);
  assert.equal(run('').status, 0);
  writeFileSync(join(destination, 'my-notes.txt'), 'keep');
  const result = uninstall();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(destination, 'my-notes.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(join(destination, 'node_modules')), false);
  assert.equal(existsSync(join(destination, 'pm2')), false);
});

test('uninstall refuses a foreign directory before modifying shell configuration', (t) => {
  const { home, destination, run, uninstall } = fixture(t, false);
  assert.equal(run('').status, 0);
  const config = readFileSync(join(home, '.zshrc'), 'utf8');
  writeFileSync(join(destination, 'package.json'), '{"name":"another-project"}');
  const result = uninstall();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a managed pm2-wrapper runtime/);
  assert.equal(existsSync(join(destination, 'pm2')), true);
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), config);
});

test('uninstall can clean PATH after the runtime directory was already deleted', (t) => {
  const { home, destination, run, uninstall } = fixture(t, false);
  assert.equal(run('').status, 0);
  rmSync(destination, { recursive: true });
  const result = uninstall();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), '');
});

test('uninstall rejects an incomplete matching PATH block before deleting runtime files', (t) => {
  const { home, destination, run, uninstall } = fixture(t, false);
  assert.equal(run('').status, 0);
  const config = join(home, '.zshrc');
  const content = readFileSync(config, 'utf8').replace('# <<< pm2-wrapper <<<', '');
  writeFileSync(config, content);
  const result = uninstall();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Incomplete pm2-wrapper block/);
  assert.equal(existsSync(join(destination, 'pm2')), true);
  assert.equal(readFileSync(config, 'utf8'), content);
});

#!/usr/bin/env node
'use strict';

// Integration test against an existing PM2 command. No installation or nvm use.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

function executable(value, searchPath = process.env.PATH || '') {
  const candidates = value.includes('/') ? [path.resolve(value)] :
    searchPath.split(path.delimiter).map((entry) => path.resolve(entry, value));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`Executable not found: ${value}`);
}

function run(file, args, env = process.env) {
  const result = spawnSync(file, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')}: ${result.error?.message || result.stderr || result.stdout || result.signal}`);
  }
  return result.stdout;
}

async function main() {
  const options = { '--pm2': 'pm2', '--path-node': process.execPath };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (['--help', '-h'].includes(args[i])) {
      console.log('Usage: node scripts/test-interpreter.cjs [--pm2 PATH] [--path-node PATH] [--output FILE]\n\nUses an existing PM2 command, with an isolated PM2_HOME.\n--path-node defaults to this script\'s Node; its version must differ from PM2\'s Node.');
      return;
    }
    if (!['--pm2', '--path-node', '--output'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(`Unknown option or missing value: ${args[i]}`);
    }
    options[args[i]] = args[++i];
  }

  // Resolve PM2 before changing PATH. Always invoke this same existing command.
  const pm2 = executable(options['--pm2']);
  const pathNode = fs.realpathSync(executable(options['--path-node']));
  const pathVersion = run(pathNode, ['--version']).trim();
  // Short paths also fit macOS's Unix socket path limit.
  const root = fs.mkdtempSync('/tmp/pm2-interpreter-');
  const pm2Home = path.join(root, 'pm2');
  const env = {
    ...process.env,
    PATH: `${path.dirname(pathNode)}${path.delimiter}${process.env.PATH || ''}`,
    PM2_HOME: pm2Home,
    NO_COLOR: '1',
  };

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (fs.existsSync(path.join(pm2Home, 'pm2.pid'))) {
      try { run(pm2, ['kill'], env); }
      catch (error) {
        console.error(`Cleanup failed; retained diagnostics at ${root}: ${error.message}`);
        process.exitCode = 1;
        return;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  const onSignal = () => process.exit(130);
  process.once('exit', cleanup);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    assert.equal(fs.realpathSync(executable('node', env.PATH)), pathNode);
    const probe = path.join(root, 'app.js');
    fs.writeFileSync(probe, `
const fs = require('node:fs');
const destination = process.env.RUNTIME_RESULT_FILE;
fs.writeFileSync(destination + '.tmp', JSON.stringify({
  version: process.version, execPath: process.execPath,
  pid: process.pid, ppid: process.ppid
}));
fs.renameSync(destination + '.tmp', destination);
setInterval(() => {}, 1000);
`);
    const cases = ['fork', 'cluster'].flatMap((mode) =>
      ['default', 'pm2-node', 'path-node'].map((interpreter) => ({
        name: `${mode}-${interpreter}`, mode, interpreter,
        result: path.join(root, `${mode}-${interpreter}.json`),
      })));
    const cliFile = path.join(root, 'cli.json');
    const config = path.join(root, 'ecosystem.config.cjs');
    fs.writeFileSync(config, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(cliFile)}, JSON.stringify({version: process.version, execPath: process.execPath}));
if (process.version === ${JSON.stringify(pathVersion)}) {
  throw new Error('PM2 and PATH Node versions are equal; choose a different --path-node.');
}
module.exports = { apps: ${JSON.stringify(cases)}.map(test => ({
  name: test.name,
  script: ${JSON.stringify(probe)},
  exec_mode: test.mode,
  instances: 1,
  autorestart: false,
  env: { RUNTIME_RESULT_FILE: test.result },
  ...(test.interpreter === 'pm2-node' ? { interpreter: process.execPath } :
    test.interpreter === 'path-node' ? { interpreter: ${JSON.stringify(pathNode)} } : {})
})) };
`);

    console.log(`Existing PM2 command: ${pm2}\nPATH Node: ${pathVersion} (${pathNode})\nIsolated PM2_HOME: ${pm2Home}`);
    run(pm2, ['start', config], env);
    const cli = JSON.parse(fs.readFileSync(cliFile, 'utf8'));
    const pm2Version = run(pm2, ['--version'], env).trim();
    console.log(`PM2 version: ${pm2Version}\nPM2 CLI Node: ${cli.version} (${cli.execPath})`);
    const deadline = Date.now() + 15000;
    while (cases.some((test) => !fs.existsSync(test.result)) && Date.now() < deadline) await delay(100);
    const processes = JSON.parse(run(pm2, ['jlist'], env));
    const results = cases.map((test) => {
      const app = processes.find((item) => item.name === test.name);
      assert.ok(fs.existsSync(test.result), `${test.name} did not report its runtime; ${JSON.stringify(app)}`);
      return {
        mode: test.mode,
        interpreter: { default: '(omitted)', 'pm2-node': 'process.execPath', 'path-node': 'PATH Node absolute path' }[test.interpreter],
        configuredInterpreter: app?.pm2_env.exec_interpreter,
        status: app?.pm2_env.status,
        actualMode: app?.pm2_env.exec_mode,
        expectedVersion: test.mode === 'cluster' || test.interpreter === 'pm2-node' ? cli.version : pathVersion,
        expectedPath: test.mode === 'cluster' || test.interpreter === 'pm2-node' ? cli.execPath : pathNode,
        ...JSON.parse(fs.readFileSync(test.result, 'utf8')),
      };
    });
    console.table(results.map(({ mode, interpreter, configuredInterpreter, version, execPath }) =>
      ({ mode, interpreter, configuredInterpreter, version, execPath })));
    if (options['--output']) {
      const output = path.resolve(options['--output']);
      fs.writeFileSync(output, JSON.stringify({ pm2, pm2Version, cli, pathNode, pathVersion, results }, null, 2) + '\n');
      console.log(`Results: ${output}`);
    }
    for (const result of results) {
      assert.equal(result.status, 'online');
      assert.equal(result.actualMode, `${result.mode}_mode`);
      assert.equal(result.version, result.expectedVersion, JSON.stringify(result));
      assert.equal(fs.realpathSync(result.execPath), fs.realpathSync(result.expectedPath), JSON.stringify(result));
    }
    console.log('PASS: all 6 applications reported the expected Node version and executable.');
  } catch (error) {
    const log = path.join(pm2Home, 'pm2.log');
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-6000));
    throw error;
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

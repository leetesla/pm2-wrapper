'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { resolveNode, withNode } = require('../lib/ecosystem.cjs');

test('resolveNode accepts an explicit Node executable', () => {
  assert.equal(resolveNode(process.cwd(), { nodePath: process.execPath }), process.execPath);
});

test('withNode pins interpreter and prepends its bin directory to environment PATHs', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-wrapper-test-'));
  try {
    const app = withNode({
      name: 'test-app',
      cwd,
      script: 'server.js',
      env: { NODE_ENV: 'production', PATH: '/custom/bin:/usr/bin' },
      env_production: { LOG_LEVEL: 'info' }
    }, { nodePath: process.execPath });

    assert.equal(app.interpreter, process.execPath);
    assert.equal(app.cwd, cwd);
    assert.equal(app.name, 'test-app');
    assert.equal(app.env.NODE_ENV, 'production');
    assert.equal(app.env.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
    assert.equal(app.env_production.LOG_LEVEL, 'info');
    assert.equal(app.env_production.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('withNode creates env when one is not provided', () => {
  const app = withNode({
    name: 'test-app',
    script: 'server.js'
  }, { nodePath: process.execPath });

  assert.equal(app.env.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
});

test('withNode rejects a non-object app definition', () => {
  assert.throws(() => withNode(null, { nodePath: process.execPath }), /expects a PM2 application object/);
});

test('resolveNode reports a missing project .nvmrc', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-wrapper-test-'));
  try {
    assert.throws(
      () => resolveNode(cwd, { nvmDir: path.join(cwd, 'missing-nvm') }),
      /No .nvmrc found/
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

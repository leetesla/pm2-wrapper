'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function assertExecutable(filePath, label = 'Node executable') {
  if (!path.isAbsolute(filePath)) {
    throw new Error(label + ' must be an absolute path: ' + filePath);
  }

  try {
    fs.accessSync(filePath, fs.constants.X_OK);
  } catch {
    throw new Error(label + ' is missing or not executable: ' + filePath);
  }
}

function resolveWithNvm(cwd, options) {
  const nvmDir = options.nvmDir || process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  const nvmScript = path.join(nvmDir, 'nvm.sh');
  const versionFile = options.nodeVersionFile
    ? path.resolve(cwd, options.nodeVersionFile)
    : path.join(cwd, '.nvmrc');

  if (!fs.existsSync(versionFile)) {
    throw new Error(
      'No .nvmrc found for application directory ' + cwd +
      '. Add a project .nvmrc or pass { nodePath }.'
    );
  }

  if (!fs.existsSync(nvmScript)) {
    throw new Error(
      'nvm.sh not found at ' + nvmScript + '. Set NVM_DIR or pass { nodePath }.'
    );
  }

  const script = [
    'set -e',
    '. "$NVM_DIR/nvm.sh"',
    'cd "$1"',
    'nvm use --silent >/dev/null',
    'nvm which'
  ].join('\n');

  let output;
  try {
    output = execFileSync('/bin/bash', ['-c', script, 'pm2-wrapper', cwd], {
      encoding: 'utf8',
      env: { ...process.env, NVM_DIR: nvmDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(
      'Unable to resolve Node for ' + cwd + ' from ' + versionFile +
      ' using nvm. Ensure the version is installed. ' + detail
    );
  }

  const lines = output.trim().split(/\r?\n/);
  const nodePath = lines[lines.length - 1];
  assertExecutable(nodePath);
  return nodePath;
}

/**
 * Resolve the Node executable for an application directory.
 *
 * Options:
 *   - manager: currently "nvm" (default)
 *   - nvmDir: override NVM_DIR
 *   - nodeVersionFile: version file path relative to cwd
 *   - nodePath: use an explicit Node executable and skip version-manager lookup
 */
function resolveNode(cwd, options = {}) {
  const appDir = path.resolve(cwd || process.cwd());

  if (options.nodePath) {
    const nodePath = path.resolve(appDir, options.nodePath);
    assertExecutable(nodePath);
    return nodePath;
  }

  const manager = options.manager || process.env.PM2_WRAPPER_NODE_MANAGER || 'nvm';
  if (manager === 'nvm') {
    return resolveWithNvm(appDir, options);
  }

  throw new Error(
    'Unsupported Node version manager "' + manager +
    '". Use manager: "nvm" or pass nodePath.'
  );
}

function prependNodeBin(env, nodePath) {
  const currentPath = typeof env.PATH === 'string'
    ? env.PATH
    : (process.env.PATH || '');
  const nodeBin = path.dirname(nodePath);
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  const filtered = entries.filter(entry => path.resolve(entry) !== nodeBin);
  return [nodeBin, ...filtered].join(path.delimiter);
}

/**
 * Add an absolute interpreter to a PM2 app definition.
 *
 * Resolves Node from app.cwd (or options.cwd/current working directory), sets
 * interpreter, and prepends that Node's bin directory to every PM2 env block.
 */
function withNode(app, options = {}) {
  if (!app || typeof app !== 'object' || Array.isArray(app)) {
    throw new TypeError('withNode(app) expects a PM2 application object');
  }

  const cwd = path.resolve(options.cwd || app.cwd || process.cwd());
  const nodePath = resolveNode(cwd, options);
  const result = { ...app, cwd, interpreter: nodePath };

  for (const [key, value] of Object.entries(app)) {
    if ((key === 'env' || /^env_.+/.test(key)) && value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = {
        ...value,
        PATH: prependNodeBin(value, nodePath)
      };
    }
  }

  if (!result.env) {
    result.env = { PATH: prependNodeBin({}, nodePath) };
  }

  return result;
}

module.exports = {
  resolveNode,
  withNode
};

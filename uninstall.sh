#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  ./uninstall.sh [--dir DIR]

Options:
  --dir DIR     Installation directory (default: $HOME/.local/share/pm2-wrapper)
  -h, --help    Show this help

Removes the managed runtime files and matching bash/zsh PATH blocks.
Keeps PM2 state, running processes, Node.js, and unrelated files.
Requires node in PATH; does not load nvm.
USAGE
}

INSTALL_DIR=${HOME:?HOME is required}/.local/share/pm2-wrapper
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'pm2-wrapper: --dir requires a path\n' >&2; exit 1; }
      INSTALL_DIR=$2
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf 'pm2-wrapper: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

command -v node >/dev/null 2>&1 || {
  printf 'pm2-wrapper: Node.js must be available in PATH to uninstall.\n' >&2
  exit 1
}

node - "$INSTALL_DIR" <<'UNINSTALL'
const fs = require('node:fs');
const path = require('node:path');

try {
  const home = path.resolve(process.env.HOME);
  let directory = path.resolve(process.argv[2]);
  const exists = fs.existsSync(directory);
  if (exists) {
    if (fs.lstatSync(directory).isSymbolicLink()) {
      throw new Error('Use the real installation directory instead of a symlink');
    }
    directory = fs.realpathSync(directory);
  } else {
    // Resolve symlinked parent directories even after the runtime was removed.
    let parent = directory;
    const suffix = [];
    while (!fs.existsSync(parent)) {
      suffix.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
    directory = path.join(fs.realpathSync(parent), ...suffix);
  }
  if (directory === path.parse(directory).root || directory === fs.realpathSync(home)) {
    throw new Error('Refusing to uninstall from the filesystem root or home directory');
  }
  if (exists) {
    const manifest = path.join(directory, 'package.json');
    if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== 'pm2-wrapper-runtime') {
      throw new Error(`${directory} is not a managed pm2-wrapper runtime`);
    }
  }

  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const exportCommand = `export PATH=${quote(directory)}"\${PATH:+:$PATH}"`;
  const files = new Set([
    path.join(home, '.zshrc'),
    path.resolve(process.env.ZDOTDIR || home, '.zshrc'),
    ...['.bashrc', '.bash_profile', '.bash_login', '.profile'].map((name) => path.join(home, name)),
  ]);
  const updates = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    const updated = original.replace(
      /^# >>> pm2-wrapper >>>\r?\n[\s\S]*?^# <<< pm2-wrapper <<<(?:\r?\n|$)/gm,
      (block) => block.includes(exportCommand) ? '' : block,
    );
    if (updated.includes(exportCommand) && updated.includes('# >>> pm2-wrapper >>>')) {
      throw new Error(`Incomplete pm2-wrapper block in ${file}; repair it before uninstalling`);
    }
    if (updated !== original) updates.push([file, updated]);
  }

  console.error('\n┌  pm2-wrapper · uninstall');
  for (const [file, updated] of updates) {
    fs.writeFileSync(file, updated);
    console.error(`│  PATH cleaned: ${file}`);
  }
  if (exists) {
    for (const name of ['pm2', 'startup.cjs', 'lifecycle.cjs', 'startup.json', '.nvmrc', 'package.json', 'package-lock.json', 'node_modules']) {
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
    }
    if (fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
      console.error(`│  Removed: ${directory}`);
    } else {
      console.error(`│  Kept unrelated files in: ${directory}`);
    }
  } else {
    console.error(`│  Runtime already absent: ${directory}`);
  }
  console.error('│  PM2 state and running processes are preserved.');
  console.error('│  Open a new terminal to refresh PATH.');
  console.error('└  ✓ Uninstalled pm2-wrapper\n');
} catch (error) {
  console.error(`pm2-wrapper: ${error.message}`);
  process.exitCode = 1;
}
UNINSTALL

#!/bin/sh
set -eu

# Clack-style guide, matching unode's terminal output. Keep logs ANSI-free.
UI_CYAN= UI_YELLOW= UI_GREEN= UI_RED= UI_DIM= UI_RESET=
if [ -t 2 ] && [ "${TERM:-}" != dumb ] && [ "${NO_COLOR+x}" != x ]; then
  UI_CYAN=$(printf '\033[1;36m')
  UI_YELLOW=$(printf '\033[1;33m')
  UI_GREEN=$(printf '\033[1;32m')
  UI_RED=$(printf '\033[1;31m')
  UI_DIM=$(printf '\033[2m')
  UI_RESET=$(printf '\033[0m')
fi

highlight() {
  printf '%s%s%s' "${2:-$UI_CYAN}" "$1" "$UI_RESET"
}

ui() {
  printf '%s│%s  %s\n' "$UI_DIM" "$UI_RESET" "${1:-}" >&2
}

section() {
  ui
  printf '%s◇  %s%s\n' "$UI_CYAN" "$1" "$UI_RESET" >&2
  ui
}

outro() {
  ui
  printf '%s└  %s%s\n\n' "${2:-$UI_GREEN}" "$1" "$UI_RESET" >&2
}

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/install.sh --dir DIR [--node-version VERSION] [--pm2-version VERSION] [--nvm-dir DIR]
  ./scripts/install.sh --preview [--node-version VERSION] [--nvm-dir DIR]

Options:
  --dir DIR             Installation directory (required unless --preview)
  --node-version VER    Node version used by PM2
  --pm2-version VER     Install an exact PM2 version or npm dist-tag
  --nvm-dir DIR         nvm directory (default: $NVM_DIR or $HOME/.nvm)
  --preview             Generate ./pm2 here without installing PM2 or changing .nvmrc
  --no-modify-path      Do not update shell startup files
  -h, --help            Show this help

The selected Node version must already be installed. nvm is used only to
resolve the absolute Node executable path; the generated command does not use nvm.
USAGE
}

fail() {
  printf '%spm2-wrapper: %s%s\n' "$UI_RED" "$*" "$UI_RESET" >&2
  exit 1
}

# Keep the destination separate from PREFIX, which the sourced nvm.sh checks.
INSTALL_DIR=
SOURCE_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
NODE_VERSION=${PM2_WRAPPER_NODE_VERSION:-}
PM2_VERSION=
CUSTOM_NVM_DIR=
PREVIEW=0
MODIFY_PATH=1
# The installer runs under sh; SHELL identifies the user's configured shell.
USER_SHELL=${SHELL:-}
USER_SHELL=${USER_SHELL##*/}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || fail "--dir requires a path"
      INSTALL_DIR=$2
      shift 2
      ;;
    --node-version)
      [ "$#" -ge 2 ] || fail "--node-version requires a version"
      NODE_VERSION=$2
      shift 2
      ;;
    --pm2-version)
      [ "$#" -ge 2 ] || fail "--pm2-version requires a version"
      PM2_VERSION=$2
      shift 2
      ;;
    --nvm-dir)
      [ "$#" -ge 2 ] || fail "--nvm-dir requires a path"
      CUSTOM_NVM_DIR=$2
      shift 2
      ;;
    --preview)
      PREVIEW=1
      shift
      ;;
    --no-modify-path)
      MODIFY_PATH=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
done

if [ "$PREVIEW" -eq 1 ]; then
  [ -z "$INSTALL_DIR" ] || fail "--dir cannot be combined with --preview"
  INSTALL_DIR=$PWD
else
  [ -n "$INSTALL_DIR" ] || {
    usage >&2
    fail "--dir is required"
  }
fi

case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac

if [ "$PREVIEW" -eq 1 ]; then
  MODE=preview
else
  MODE=install
fi
printf '\n%s┌  pm2-wrapper · %s%s\n' "$UI_CYAN" "$MODE" "$UI_RESET" >&2

# Report before making any changes. Preview only reports; installation asks
# unless the command (including symlinks) already points to this wrapper.
section 'Check existing PM2'
EXISTING_PM2=$(command -v pm2 || true)
if [ -n "$EXISTING_PM2" ]; then
  if [ "$EXISTING_PM2" -ef "$INSTALL_DIR/pm2" ]; then
    ui "$(highlight 'Existing PM2 command is this installation wrapper.' "$UI_GREEN")"
    ui "Path: $(highlight "$EXISTING_PM2")"
  else
    ui "$(highlight "Existing PM2 command found: $EXISTING_PM2" "$UI_YELLOW")"
    ui "$(highlight 'Both commands use ~/.pm2 unless PM2_HOME is set.' "$UI_YELLOW")"
    if [ "$PREVIEW" -eq 0 ]; then
      printf '%s│%s  %sContinue installation? [y/N]%s ' "$UI_DIM" "$UI_RESET" "$UI_YELLOW" "$UI_RESET" >&2
      ANSWER=
      if ! IFS= read -r ANSWER; then
        ANSWER=
      fi
      if [ ! -t 0 ]; then printf '\n' >&2; fi
      case "$ANSWER" in
        y|Y) ;;
        *)
          outro 'Installation cancelled.' "$UI_YELLOW"
          exit 1
          ;;
      esac
    else
      ui 'Preview only; no confirmation required.'
    fi
  fi
else
  ui "$(highlight 'No PM2 command found in PATH.' "$UI_GREEN")"
fi

section 'Resolve Node.js'
mkdir -p "$INSTALL_DIR"
INSTALL_DIR=$(CDPATH= cd "$INSTALL_DIR" && pwd -P)

if [ -n "$CUSTOM_NVM_DIR" ]; then
  case "$CUSTOM_NVM_DIR" in
    /*) NVM_DIR=$CUSTOM_NVM_DIR ;;
    *) NVM_DIR="$PWD/$CUSTOM_NVM_DIR" ;;
  esac
else
  NVM_DIR=${NVM_DIR:-"$HOME/.nvm"}
fi
export NVM_DIR

[ -s "$NVM_DIR/nvm.sh" ] || fail "nvm.sh not found at $NVM_DIR/nvm.sh (use --nvm-dir to set the nvm directory)"
if [ -z "$NODE_VERSION" ] && [ ! -s "$INSTALL_DIR/.nvmrc" ]; then
  if [ "$PREVIEW" -eq 1 ]; then
    fail "no .nvmrc in the current directory; use: make preview NODE_VERSION=VERSION"
  fi
  fail "no $INSTALL_DIR/.nvmrc found; provide --node-version VERSION"
fi

# nvm is used only here to resolve the Node binary. The generated command
# contains the absolute path and does not source nvm at runtime.
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"
cd "$INSTALL_DIR"

if [ -n "$NODE_VERSION" ]; then
  if ! nvm use "$NODE_VERSION" --silent >/dev/null; then
    fail "Node version $NODE_VERSION is not available; install it first with: nvm install $NODE_VERSION"
  fi
elif ! nvm use --silent >/dev/null; then
  fail "Node version in $INSTALL_DIR/.nvmrc is not available; install it first with: nvm install"
fi

# Resolve the version selected above without re-reading .nvmrc or its status output.
NODE=$(nvm which current)
[ -x "$NODE" ] || fail "nvm returned a non-executable Node path: $NODE"
RESOLVED_VERSION=$("$NODE" --version)
ui "Node: $(highlight "$RESOLVED_VERSION")"
ui "Executable: $(highlight "$NODE")"

if [ "$PREVIEW" -eq 0 ]; then
  section 'Install PM2'
  if [ -f "$INSTALL_DIR/package.json" ]; then
    PACKAGE_NAME=$("$NODE" -e 'console.log(require(process.argv[1]).name || "")' "$INSTALL_DIR/package.json")
    [ "$PACKAGE_NAME" = "pm2-wrapper-runtime" ] || fail "$INSTALL_DIR/package.json belongs to '$PACKAGE_NAME'; use a dedicated installation directory"
  else
    cat > "$INSTALL_DIR/package.json" <<'PACKAGE'
{
  "name": "pm2-wrapper-runtime",
  "version": "0.0.0",
  "private": true,
  "description": "Private runtime directory managed by pm2-wrapper"
}
PACKAGE
  fi

  # Store an exact version, even if the input was an alias such as "22".
  printf '%s\n' "${RESOLVED_VERSION#v}" > "$INSTALL_DIR/.nvmrc"

  if [ -z "$PM2_VERSION" ] && [ -f "$INSTALL_DIR/node_modules/pm2/package.json" ]; then
    PM2_VERSION=$("$NODE" -e 'console.log(require(process.argv[1]).version)' "$INSTALL_DIR/node_modules/pm2/package.json")
  fi
  PM2_VERSION=${PM2_VERSION:-latest}
  ui "Directory: $(highlight "$INSTALL_DIR")"
  ui "PM2 version: $(highlight "$PM2_VERSION")"

  # nvm use prepends this Node installation to PATH, so npm runs under this Node.
  npm install --prefix "$INSTALL_DIR" --save-exact "pm2@$PM2_VERSION"
fi

section 'Generate wrapper'
# Quote a value for a POSIX shell single-quoted assignment.
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
NODE_QUOTED=$(shell_quote "$NODE")

# Keep startup support and its user-editable settings beside the wrapper.
if [ "$SOURCE_DIR" != "$INSTALL_DIR" ]; then
  cp "$SOURCE_DIR/startup.cjs" "$SOURCE_DIR/lifecycle.cjs" "$INSTALL_DIR/"
fi
if [ "$PREVIEW" -eq 0 ] && [ ! -e "$INSTALL_DIR/startup.json" ]; then
  printf '%s\n' '{"service": null}' > "$INSTALL_DIR/startup.json"
fi

{
  cat <<'WRAPPER_HEAD'
#!/bin/sh
set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
WRAPPER_HEAD
  printf 'NODE=%s\n' "$NODE_QUOTED"
  cat <<'WRAPPER_TAIL'

PM2_CLI="$ROOT/node_modules/pm2/bin/pm2"

if [ ! -x "$NODE" ]; then
  printf 'pm2-wrapper: configured Node executable is missing: %s\n' "$NODE" >&2
  printf 'Re-run scripts/install.sh after installing the desired Node version.\n' >&2
  exit 1
fi

case "${1-}" in
  startup|unstartup) exec "$NODE" "$ROOT/startup.cjs" "$@" ;;
  update|updatePM2)
    if [ "$(uname -s)" = Linux ]; then
      exec "$NODE" "$ROOT/startup.cjs" "$@"
    fi
    ;;
  show)
    if [ "${2-}" = startup ]; then
      exec "$NODE" "$ROOT/startup.cjs" "$@"
    fi
    ;;
esac

if [ ! -f "$PM2_CLI" ]; then
  printf 'pm2-wrapper: PM2 CLI not found: %s\n' "$PM2_CLI" >&2
  printf 'Re-run scripts/install.sh to repair the installation.\n' >&2
  exit 1
fi

# Use the normal PM2_HOME (~/.pm2) unless the caller explicitly overrides it.
exec "$NODE" "$PM2_CLI" "$@"
WRAPPER_TAIL
} > "$INSTALL_DIR/pm2"
chmod 755 "$INSTALL_DIR/pm2"
ui "Command: $(highlight "$INSTALL_DIR/pm2")"

if [ "$PREVIEW" -eq 1 ]; then
  ui 'Note: PM2 is not installed by preview mode.'
  outro '✓ Generated wrapper preview'
else
  ui "PM2 installed: $(highlight "$("$NODE" -e 'console.log(require(process.argv[1]).version)' "$INSTALL_DIR/node_modules/pm2/package.json")")"
  ui 'nvm is used only during installation.'
  if [ "$MODIFY_PATH" -eq 1 ]; then
    section 'Configure PATH'
    "$NODE" - "$INSTALL_DIR" "$USER_SHELL" <<'CONFIGURE_PATH'
const fs = require('node:fs');
const path = require('node:path');
const [directory, shell] = process.argv.slice(2);
const home = process.env.HOME;
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const exportCommand = `export PATH=${quote(directory)}"\${PATH:+:$PATH}"`;
const start = '# >>> pm2-wrapper >>>';
const end = '# <<< pm2-wrapper <<<';
const block = `${start}
case "\${PATH-}" in
  ${quote(directory)}|${quote(directory)}:*) ;;
  *) ${exportCommand} ;;
esac
${end}`;
let files;
if (!home) {
  throw new Error('HOME is required to configure PATH (use --no-modify-path to skip)');
} else if (shell === 'zsh') {
  files = [path.join(process.env.ZDOTDIR || home, '.zshrc')];
} else if (shell === 'bash') {
  const login = ['.bash_profile', '.bash_login', '.profile']
    .map((name) => path.join(home, name))
    .find((file) => fs.existsSync(file)) || path.join(home, '.profile');
  files = [path.join(home, '.bashrc'), login];
} else {
  console.error(`│  Shell ${shell || '(unknown)'}: automatic PATH setup supports bash and zsh.`);
  files = [];
}
for (const file of files) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // Replace only our complete block; preserve the rest of the user's file.
  const pattern = /^# >>> pm2-wrapper >>>\r?\n[\s\S]*?^# <<< pm2-wrapper <<<(?:\r?\n|$)/gm;
  const content = original.replace(pattern, '');
  if (content.includes(start) || content.includes(end)) {
    throw new Error(`Incomplete pm2-wrapper block in ${file}; repair it before reinstalling`);
  }
  const updated = content + (content && !content.endsWith('\n') ? '\n' : '') + block + '\n';
  if (updated !== original) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, updated);
  }
  console.error(`│  PATH configured: ${file}`);
}
console.error('│  Open a new terminal, or run in the current terminal:');
console.error(`│  ${exportCommand}`);
CONFIGURE_PATH
  fi
  outro '✓ Installed pm2-wrapper'
fi

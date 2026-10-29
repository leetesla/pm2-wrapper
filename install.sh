#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  ./install.sh --dir DIR [--node-version VERSION] [--pm2-version VERSION] [--nvm-dir DIR]

Options:
  --dir DIR             Installation directory (required)
  --node-version VER    Set the Node version used by PM2
  --pm2-version VER     Install an exact PM2 version or npm dist-tag
  --nvm-dir DIR         nvm directory (default: $NVM_DIR or $HOME/.nvm)
  -h, --help            Show this help

The selected Node version must already be installed. nvm is used only during
installation to resolve the absolute Node executable path.
USAGE
}

fail() {
  printf 'pm2-wrapper: %s\n' "$*" >&2
  exit 1
}

PREFIX=
NODE_VERSION=
PM2_VERSION=
CUSTOM_NVM_DIR=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || fail "--dir requires a path"
      PREFIX=$2
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

[ -n "$PREFIX" ] || {
  usage >&2
  fail "--dir is required"
}

case "$PREFIX" in
  /*) ;;
  *) PREFIX="$PWD/$PREFIX" ;;
esac
mkdir -p "$PREFIX"
PREFIX=$(CDPATH= cd "$PREFIX" && pwd -P)

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
if [ -z "$NODE_VERSION" ] && [ ! -s "$PREFIX/.nvmrc" ]; then
  fail "no $PREFIX/.nvmrc found; provide --node-version VERSION"
fi

# nvm is used here only to resolve the Node binary. The generated command
# contains the absolute path and does not source nvm at runtime.
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"
cd "$PREFIX"

if [ -n "$NODE_VERSION" ]; then
  if ! nvm use "$NODE_VERSION" --silent >/dev/null; then
    fail "Node version $NODE_VERSION is not available; install it first with: nvm install $NODE_VERSION"
  fi
elif ! nvm use --silent >/dev/null; then
  fail "Node version in $PREFIX/.nvmrc is not available; install it first with: nvm install"
fi

NODE=$(nvm which)
[ -x "$NODE" ] || fail "nvm returned a non-executable Node path: $NODE"
RESOLVED_VERSION=$("$NODE" --version)

if [ -f "$PREFIX/package.json" ]; then
  PACKAGE_NAME=$("$NODE" -e 'console.log(require(process.argv[1]).name || "")' "$PREFIX/package.json")
  [ "$PACKAGE_NAME" = "pm2-wrapper-runtime" ] || fail "$PREFIX/package.json belongs to '$PACKAGE_NAME'; use a dedicated installation directory"
else
  cat > "$PREFIX/package.json" <<'PACKAGE'
{
  "name": "pm2-wrapper-runtime",
  "version": "0.0.0",
  "private": true,
  "description": "Private runtime directory managed by pm2-wrapper"
}
PACKAGE
fi

# Store an exact version, even if the input was an alias such as "22".
printf '%s\n' "${RESOLVED_VERSION#v}" > "$PREFIX/.nvmrc"

if [ -z "$PM2_VERSION" ] && [ -f "$PREFIX/node_modules/pm2/package.json" ]; then
  PM2_VERSION=$("$NODE" -e 'console.log(require(process.argv[1]).version)' "$PREFIX/node_modules/pm2/package.json")
fi
PM2_VERSION=${PM2_VERSION:-latest}

# nvm use prepends this Node installation to PATH, so npm runs under this Node.
npm install --prefix "$PREFIX" --save-exact "pm2@$PM2_VERSION"

# Quote a value for a POSIX shell single-quoted assignment.
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
NODE_QUOTED=$(shell_quote "$NODE")

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
  printf 'Re-run install.sh after installing the desired Node version.\n' >&2
  exit 1
fi

if [ ! -f "$PM2_CLI" ]; then
  printf 'pm2-wrapper: PM2 CLI not found: %s\n' "$PM2_CLI" >&2
  printf 'Re-run install.sh to repair the installation.\n' >&2
  exit 1
fi

# Use the normal PM2_HOME (~/.pm2) unless the caller explicitly overrides it.
exec "$NODE" "$PM2_CLI" "$@"
WRAPPER_TAIL
} > "$PREFIX/pm2"
chmod 755 "$PREFIX/pm2"

printf '\nInstalled pm2-wrapper\n'
printf '  Directory: %s\n' "$PREFIX"
printf '  Node:      %s (%s)\n' "$NODE" "$RESOLVED_VERSION"
printf '  PM2:       %s\n' "$("$NODE" -e 'console.log(require(process.argv[1]).version)' "$PREFIX/node_modules/pm2/package.json")"
printf '  Command:   %s/pm2\n' "$PREFIX"
printf '  Runtime dependency: none (nvm is used only during installation)\n'

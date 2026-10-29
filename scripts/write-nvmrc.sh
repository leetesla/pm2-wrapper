#!/bin/sh
set -e

fail() {
  printf 'pm2-wrapper: %s\n' "$*" >&2
  exit 1
}

REQUESTED_VERSION=${1:-}
if [ -z "$REQUESTED_VERSION" ]; then
  RESOLVED_VERSION=$(node -v)
else
  NVM_DIR=${NVM_DIR:-"$HOME/.nvm"}
  export NVM_DIR
  [ -s "$NVM_DIR/nvm.sh" ] || fail "nvm.sh not found at $NVM_DIR/nvm.sh (set NVM_DIR to the nvm directory)"
  # Load nvm without selecting the version from the existing .nvmrc.
  # shellcheck disable=SC1090
  # dash ignores arguments after the dot command; set them explicitly.
  set -- --no-use
  . "$NVM_DIR/nvm.sh"

  RESOLVED_VERSION=$(nvm version "$REQUESTED_VERSION") || RESOLVED_VERSION=N/A
  if [ "$RESOLVED_VERSION" = N/A ] || [ -z "$RESOLVED_VERSION" ]; then
    while :; do
      printf 'Node %s is not installed. Install with nvm? [Y/n] ' "$REQUESTED_VERSION" >&2
      ANSWER=
      if ! IFS= read -r ANSWER; then
        printf '\n' >&2
        fail 'Installation cancelled (end of input); .nvmrc unchanged.'
      fi
      case "$ANSWER" in
        ''|[yY]|[yY][eE][sS]) break ;;
        [nN]|[nN][oO]) fail 'Installation cancelled; .nvmrc unchanged.' ;;
        *) printf 'Please enter yes or no.\n' >&2 ;;
      esac
    done
    nvm install "$REQUESTED_VERSION" || fail "Could not install Node $REQUESTED_VERSION; .nvmrc unchanged."
    RESOLVED_VERSION=$(nvm version "$REQUESTED_VERSION") || fail "Could not resolve Node $REQUESTED_VERSION; .nvmrc unchanged."
  fi

  # Resolve aliases such as `system` to an exact version as well.
  if [ "$RESOLVED_VERSION" = system ]; then
    NODE=$(nvm which system) || fail 'Could not locate system Node.'
    RESOLVED_VERSION=$("$NODE" -v)
  fi
fi

case "$RESOLVED_VERSION" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "Invalid Node version returned: $RESOLVED_VERSION; .nvmrc unchanged." ;;
esac
printf '%s\n' "$RESOLVED_VERSION" > .nvmrc
printf 'Wrote .nvmrc: %s\n' "$RESOLVED_VERSION"

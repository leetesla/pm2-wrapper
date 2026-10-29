INSTALL_DIR ?= $(HOME)/.local/share/pm2-wrapper
NODE_VERSION ?= $(shell cat .nvmrc 2>/dev/null)
PM2_VERSION ?=
NVM_DIR ?=

.PHONY: nvmrc install preview uninstall

# Record the Node.js version currently selected in this shell.
nvmrc:
	@node -v > .nvmrc
	@printf 'Wrote .nvmrc: '
	@cat .nvmrc

# Install PM2 into a dedicated directory.
# Defaults to the version recorded by make nvmrc.
install:
	@set -eu; \
	set -- --dir "$(INSTALL_DIR)"; \
	if [ -n "$(NODE_VERSION)" ]; then set -- "$$@" --node-version "$(NODE_VERSION)"; fi; \
	if [ -n "$(PM2_VERSION)" ]; then set -- "$$@" --pm2-version "$(PM2_VERSION)"; fi; \
	if [ -n "$(NVM_DIR)" ]; then set -- "$$@" --nvm-dir "$(NVM_DIR)"; fi; \
	exec ./install.sh "$$@"

# Generate ./pm2 for inspection. This does not install PM2 or modify .nvmrc.
preview:
	@PM2_WRAPPER_NODE_VERSION="$(NODE_VERSION)" NVM_DIR="$(NVM_DIR)" ./install.sh --preview

# Remove the runtime and its PATH configuration, preserving PM2 state.
uninstall:
	@./uninstall.sh --dir "$(INSTALL_DIR)"

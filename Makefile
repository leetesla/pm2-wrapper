INSTALL_DIR ?= $(HOME)/.local/share/pm2-wrapper
NODE_VERSION ?=
PM2_VERSION ?=
NVM_DIR ?=

.PHONY: install preview

# Install PM2 into a dedicated directory.
# Example: make install NODE_VERSION=22.21.1
install:
	@set -eu; \
	set -- --dir "$(INSTALL_DIR)"; \
	if [ -n "$(NODE_VERSION)" ]; then set -- "$$@" --node-version "$(NODE_VERSION)"; fi; \
	if [ -n "$(PM2_VERSION)" ]; then set -- "$$@" --pm2-version "$(PM2_VERSION)"; fi; \
	if [ -n "$(NVM_DIR)" ]; then set -- "$$@" --nvm-dir "$(NVM_DIR)"; fi; \
	exec ./install.sh "$$@"

# Generate ./pm2 for inspection. This does not install PM2 or modify .nvmrc.
# Example: make preview NODE_VERSION=22.21.1
preview:
	@PM2_WRAPPER_NODE_VERSION="$(NODE_VERSION)" NVM_DIR="$(NVM_DIR)" ./install.sh --preview

INSTALL_DIR ?= $(HOME)/.local/share/pm2-wrapper
NODE_VERSION ?= $(shell cat .nvmrc 2>/dev/null)
PM2_VERSION ?=
NVM_DIR ?=

.PHONY: nvmrc install update preview uninstall

# Treat the optional argument in `make nvmrc 22` as a version, not a target.
ifeq ($(firstword $(MAKECMDGOALS)),nvmrc)
ifneq ($(word 3,$(MAKECMDGOALS)),)
$(error Usage: make nvmrc [VERSION])
endif
NVMRC_VERSION := $(word 2,$(MAKECMDGOALS))
ifneq ($(NVMRC_VERSION),)
.PHONY: $(NVMRC_VERSION)
$(NVMRC_VERSION):
	@:
endif
endif

# Treat the optional argument in `make update 6.0.0` as a PM2 version.
ifeq ($(firstword $(MAKECMDGOALS)),update)
ifneq ($(word 3,$(MAKECMDGOALS)),)
$(error Usage: make update [VERSION])
endif
UPDATE_ARGUMENT := $(word 2,$(MAKECMDGOALS))
ifneq ($(UPDATE_ARGUMENT),)
.PHONY: $(UPDATE_ARGUMENT)
$(UPDATE_ARGUMENT):
	@:
endif
endif
UPDATE_VERSION = $(or $(UPDATE_ARGUMENT),$(strip $(PM2_VERSION)),latest)

# Record the current Node version, or resolve an explicit version with nvm.
nvmrc:
	@NVM_DIR="$(NVM_DIR)" sh ./scripts/write-nvmrc.sh '$(subst ','"'"',$(NVMRC_VERSION))'

# Install PM2 into a dedicated directory.
# Defaults to the version recorded by make nvmrc.
install:
	@set -eu; \
	set -- --dir "$(INSTALL_DIR)"; \
	if [ -n "$(NODE_VERSION)" ]; then set -- "$$@" --node-version "$(NODE_VERSION)"; fi; \
	if [ -n "$(PM2_VERSION)" ]; then set -- "$$@" --pm2-version "$(PM2_VERSION)"; fi; \
	if [ -n "$(NVM_DIR)" ]; then set -- "$$@" --nvm-dir "$(NVM_DIR)"; fi; \
	exec ./scripts/install.sh "$$@"

# Upgrade the package first, then refresh the daemon through this installation.
update:
	@$(MAKE) --no-print-directory install PM2_VERSION='$(subst ','"'"',$(UPDATE_VERSION))'
	@"$(INSTALL_DIR)/pm2" update

# Generate ./pm2 for inspection. This does not install PM2 or modify .nvmrc.
preview:
	@PM2_WRAPPER_NODE_VERSION="$(NODE_VERSION)" NVM_DIR="$(NVM_DIR)" ./scripts/install.sh --preview

# Remove the runtime and its PATH configuration, preserving PM2 state.
uninstall:
	@./scripts/uninstall.sh --dir "$(INSTALL_DIR)"

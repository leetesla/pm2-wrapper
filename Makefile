NODE_VERSION ?=
NVM_DIR ?=

.PHONY: preview

# Generate ./pm2 for inspection. This does not install PM2 or modify .nvmrc.
# Example: make preview NODE_VERSION=22.21.1
preview:
	@PM2_WRAPPER_NODE_VERSION="$(NODE_VERSION)" NVM_DIR="$(NVM_DIR)" ./install.sh --preview

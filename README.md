# pm2-wrapper

A small installer that creates a **single PM2 wrapper command** using a fixed Node.js executable. nvm is used only during installation or preview generation to resolve the Node path; the generated command does not call nvm.

## What it does

- Installs PM2 locally in a chosen directory.
- Reads a selected Node version and resolves its executable during installation.
- Generates a `pm2` command that invokes the local PM2 CLI with that absolute Node path.
- Does not change the calling shell's Node version.
- Uses the normal PM2 state directory (`~/.pm2`) unless `PM2_HOME` is explicitly set.

It does **not** manage the Node version of each application. Configure an application's `interpreter` separately if that application must use a different Node version.

## Requirements

- macOS or Linux.
- nvm installed, and the selected Node version already installed.
- The selected Node installation's npm available through nvm.

nvm is required only while installing or regenerating the wrapper. Running the generated `pm2` command does not source `nvm.sh`.

## Select and record a Node version

Use nvm to select the version you want this wrapper to pin, then record the active `node` version:

```sh
nvm use 22.21.1
make nvmrc
```

The `nvmrc` target runs `node -v > .nvmrc`. The resulting `.nvmrc` is local machine configuration and is intentionally ignored by Git, so it will not be committed.

You can also run `node -v > .nvmrc` directly if you prefer.

## Preview the generated wrapper

Generate a preview script named `./pm2` in the current repository directory:

```sh
make preview
```

By default, preview uses the version in the local `.nvmrc`. You can override it explicitly:

```sh
make preview NODE_VERSION=22.21.1
```

Preview mode only resolves the Node executable and writes the wrapper script. It does not install PM2 or modify `.nvmrc` or package files. The generated root-level `pm2` file is also ignored by Git. It will not run successfully from the repository unless PM2 is installed under that directory's `node_modules`.

## Install

After creating `.nvmrc`, install into the default directory `$HOME/.local/share/pm2-wrapper`:

```sh
make install
```

Or specify the Node version directly without first creating `.nvmrc`:

```sh
make install NODE_VERSION=22.21.1
```

Choose another destination:

```sh
make install INSTALL_DIR="$HOME/services/pm2-runtime"
```

Choose a PM2 version or a non-default nvm directory:

```sh
make install PM2_VERSION=6.0.0
make install NODE_VERSION=22.21.1 NVM_DIR="$HOME/.nvm"
```

The PM2 version above is an example. Use a version appropriate for your environment. The selected Node version must already be installed with nvm; the installer does not download Node automatically.

You can also invoke the installer directly:

```sh
./install.sh --dir "$HOME/.local/share/pm2-wrapper" --node-version 22.21.1
```

If PM2 is already installed in the destination and no PM2 version is specified, the installer preserves the installed PM2 version. On a first install, it installs the current PM2 release.

## Result

The installation directory contains the wrapper-specific files plus local npm package files:

```text
pm2-wrapper/
├── .nvmrc
├── package.json
├── package-lock.json
├── node_modules/
│   └── pm2/
└── pm2
```

- `.nvmrc` records the exact Node version resolved at install time.
- `node_modules/pm2` is the local PM2 installation.
- `pm2` is the generated wrapper command.

No `bin/`, `lib/`, ecosystem helper, alias command, or per-installation `.pm2/` directory is created.

## Use

```sh
"$HOME/.local/share/pm2-wrapper/pm2" --version
"$HOME/.local/share/pm2-wrapper/pm2" list
"$HOME/.local/share/pm2-wrapper/pm2" start ecosystem.config.js
```

Optionally add the installation directory to `PATH`:

```sh
export PATH="$HOME/.local/share/pm2-wrapper:$PATH"
```

Ensure this directory precedes any global PM2 executable in `PATH`.

## Change Node versions

Select a new Node version, regenerate the local `.nvmrc`, and rerun installation:

```sh
nvm install 22.22.0
nvm use 22.22.0
make nvmrc
make install
```

The generated wrapper embeds the absolute Node executable path. Editing `.nvmrc` alone does not change that path; rerun `make install` to regenerate it. A running PM2 daemon does not change its runtime merely because the wrapper is regenerated. Plan a controlled daemon restart/migration before relying on the new runtime.

## Tests

```sh
sh -n install.sh
./install.sh --help
make -n nvmrc
make -n preview
make -n install
npm test
```

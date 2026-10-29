# pm2-wrapper

A small installer that creates a **single PM2 wrapper command** using a fixed Node.js executable. nvm is used only during installation or preview generation to resolve the Node path; the generated command does not call nvm.

## What it does

- Installs PM2 locally in a chosen directory.
- Reads that directory's `.nvmrc` (or accepts `--node-version`) and resolves the selected Node executable during installation.
- Generates a `pm2` command that invokes the local PM2 CLI with that absolute Node path.
- Does not change the calling shell's Node version.
- Uses the normal PM2 state directory (`~/.pm2`) unless `PM2_HOME` is explicitly set.

It does **not** manage the Node version of each application. Configure an application's `interpreter` separately if that application must use a different Node version.

## Requirements

- macOS or Linux.
- nvm installed, and the selected Node version already installed.
- The selected Node installation's npm available through nvm.

nvm is required only while installing or regenerating the wrapper. Running the generated `pm2` command does not source `nvm.sh`.

## Preview the generated wrapper

To generate a preview script named `./pm2` in the current repository directory:

```sh
make preview NODE_VERSION=22.21.1
```

Replace the version with one already installed in nvm. If the current directory has a suitable `.nvmrc`, you can run `make preview` without specifying `NODE_VERSION`. To use a non-default nvm installation:

```sh
make preview NODE_VERSION=22.21.1 NVM_DIR="$HOME/.nvm"
```

Preview mode only resolves the Node executable and writes the wrapper script. It does not install PM2, modify `.nvmrc`, or change package files. The generated root-level `pm2` file is listed in `.gitignore`, so it will not be committed accidentally. It is for inspecting the generated script; it will not run successfully from the repository unless PM2 is installed under that directory's `node_modules`.

## Install

Clone the repository, then install into any dedicated directory:

```sh
git clone https://github.com/leetesla/pm2-wrapper.git
cd pm2-wrapper

nvm install 22.21.1
./install.sh --dir "$HOME/.local/share/pm2-wrapper" --node-version 22.21.1
```

You can also put a `.nvmrc` in the target directory first and omit `--node-version`:

```sh
mkdir -p "$HOME/.local/share/pm2-wrapper"
printf '22.21.1\n' > "$HOME/.local/share/pm2-wrapper/.nvmrc"
./install.sh --dir "$HOME/.local/share/pm2-wrapper"
```

If PM2 is already installed in that directory and `--pm2-version` is omitted, the installer preserves the installed PM2 version. On a first install, it installs the current PM2 release. To intentionally change PM2:

```sh
./install.sh --dir "$HOME/.local/share/pm2-wrapper" --pm2-version 6.0.0
```

The version above is an example. Use a PM2 version appropriate for your environment.

## Result

The installation directory contains only the wrapper-specific files plus the local npm package files:

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

Then the wrapper can be invoked as `pm2`. Ensure this directory precedes any global PM2 executable in `PATH`.

## Change Node versions

The generated wrapper embeds the absolute Node executable path. Editing `.nvmrc` alone does not change that path. To switch the PM2 runtime, install the desired Node version and rerun the installer:

```sh
nvm install 22.22.0
./install.sh --dir "$HOME/.local/share/pm2-wrapper" --node-version 22.22.0
```

A running PM2 daemon does not change its runtime merely because the wrapper is regenerated. Plan a controlled daemon restart/migration to make the new runtime active. Check your saved process list and service startup configuration before stopping the existing daemon.

## Tests

```sh
sh -n install.sh
./install.sh --help
make -n preview NODE_VERSION=22.21.1
npm test
```

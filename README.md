# pm2-wrapper

A small installer that creates a **single PM2 wrapper command** using a fixed Node.js executable. nvm is used only during installation or preview generation to resolve the Node path; the generated command does not call nvm.

## What it does

- Installs PM2 locally in a chosen directory.
- Reads a selected Node version and resolves its executable during installation.
- Generates a `pm2` command that invokes the local PM2 CLI with that absolute Node path.
- Pins Node in startup commands and checks existing startup configuration with `pm2 show startup`.
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

Preview mode resolves the Node executable and writes the wrapper script, copying `startup.cjs` beside it when previewing outside the repository. It does not install PM2 or modify `.nvmrc`, `startup.json`, or package files. The generated root-level `pm2` file is also ignored by Git. Normal PM2 commands require PM2 under that directory's `node_modules`; `show startup` can run without it.

Preview reports whether a `pm2` command exists in `PATH` and shows its path
when found, without asking for confirmation. Preview and installation use
separate step headings and highlighted status messages in the terminal.
Colors are disabled for redirected output, `TERM=dumb`, or when `NO_COLOR` is set.

## Install

After creating `.nvmrc`, install into the default directory `$HOME/.local/share/pm2-wrapper`:

```sh
make install
```

If a `pm2` command already exists in `PATH` and does not point to this
installation's wrapper, the installer shows its path and asks
`Continue installation? [y/N]` before creating or changing installation files.
Only `y` or `Y` continues; `n`, `N`, Enter, any other input, or end-of-input
cancels with a nonzero exit status. Preview reports the result without asking.
The existing executable is not overwritten, but the wrapper takes precedence
after the generated PATH configuration is loaded. Both commands use `~/.pm2`
unless `PM2_HOME` is explicitly set.

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
├── startup.cjs
├── startup.json
├── package.json
├── package-lock.json
├── node_modules/
│   └── pm2/
└── pm2
```

- `.nvmrc` records the exact Node version resolved at install time.
- `node_modules/pm2` is the local PM2 installation.
- `pm2` is the generated wrapper command.
- `startup.cjs` implements startup handling and read-only inspection.
- `startup.json` holds user-editable startup settings; reinstalling preserves it.

No `bin/`, `lib/`, ecosystem helper, alias command, or per-installation `.pm2/` directory is created.

## Use

```sh
"$HOME/.local/share/pm2-wrapper/pm2" --version
"$HOME/.local/share/pm2-wrapper/pm2" list
"$HOME/.local/share/pm2-wrapper/pm2" start ecosystem.config.js
```

Installation automatically configures `PATH` for the shell identified by `$SHELL`
on macOS and Linux:

- zsh: `${ZDOTDIR:-$HOME}/.zshrc`.
- bash: `~/.bashrc` and the first existing login file in the order
  `~/.bash_profile`, `~/.bash_login`, `~/.profile`. If none exists, it creates
  `~/.profile`, so it does not mask an existing login file.

The installer preserves other settings and maintains one marked `pm2-wrapper`
block in each file. Reinstalling updates that block for the selected installation
directory. The wrapper directory is prepended to `PATH` when the configuration
loads; loading it again does not duplicate an entry already at the front.
Preview mode never edits shell startup files.

Open a new terminal after installation. An installer cannot change its parent
shell's environment, so to use `pm2` in the current terminal, run the command
printed by the installer. For the default directory:

```sh
export PATH="$HOME/.local/share/pm2-wrapper:$PATH"
```

To manage PATH yourself, skip automatic configuration:

```sh
./install.sh --dir "$HOME/.local/share/pm2-wrapper" --node-version 22.21.1 --no-modify-path
```

Other shells receive manual PATH instructions instead of startup file changes.

## Startup configuration

```sh
pm2 startup
# Copy and execute the sudo command printed above.
pm2 show startup
pm2 show startup --service my-pm2
```

`startup` and `unstartup` put the wrapper's fixed Node `bin` directory first in
their child process's PATH. Other PATH entries remain available. The printed
sudo command also puts it first and explicitly runs the installed startup helper
with the fixed Node, preserving HOME and PM2_HOME. This prevents a different
Node in the calling terminal from being selected when the command is copied.
Other PM2 commands continue to be passed directly to the local CLI. Put
`startup`, `unstartup`, or `show startup` before their options.

Startup settings live in the installation directory, by default
`~/.local/share/pm2-wrapper/startup.json`:

```json
{
  "service": null
}
```

`null` uses PM2's default service name (`pm2.USER.plist` on macOS and
`pm2-USER.service` on Linux). Set `service` to a custom name such as `my-pm2`
to use it for both startup generation and inspection. An explicit
`startup --service-name NAME` or `show startup --service NAME` overrides this
setting for that invocation. `show` accepts the `.plist` or `.service` suffix;
the configuration accepts either form too. These overrides are not saved.

Following [unode's startup inspection](https://github.com/leetesla/unode#开机启动),
`show startup` prints the existing definition, resolves its Node through its
command/shebang and saved PATH, and compares its version and path against the
wrapper's fixed Node. It displays autostart enablement separately from current
service registration/state. macOS inspection handles the PM2 template's
`LaunchOnlyOnce=true`: an unregistered one-shot job does not prove PM2 stopped.
Linux inspection reads the effective systemd properties and displays unit
contents, including drop-ins. Complex launch commands, unknown interpreters,
EnvironmentFile, pending daemon-reload, or failed status queries are reported
as requiring review. Exit code is 2 for a Node mismatch or an unverifiable
configuration/state, and 0 when inspection succeeds; a disabled or inactive
service is displayed as such, independently of the Node comparison.

Inspection does not run the PM2 CLI, start its daemon, load services, or write
files. It compares against this wrapper, without reading unode's installation
history. System registration files still live in `~/Library/LaunchAgents/` or
the systemd unit directory; `startup.json` does not move those files. Startup
generation delegates to PM2 and can load a service; changing the wrapper alone
does not migrate a running daemon. `show` reserves the app name `startup`;
use the local PM2 CLI directly if you need to inspect an app with that name.

## Uninstall

From this repository, run:

```sh
make uninstall
```

For a custom installation directory:

```sh
make uninstall INSTALL_DIR="$HOME/services/pm2-runtime"
```

Or run `./uninstall.sh --dir DIR` directly. Node.js must be available in PATH;
uninstall does not load nvm.

Uninstall removes the managed runtime files (including `startup.cjs` and
`startup.json`) and matching `pm2-wrapper` PATH
blocks from bash and zsh startup files, including the current `ZDOTDIR` when set.
It preserves other shell settings, unrelated files, Node.js, PM2 state
(`~/.pm2` or `PM2_HOME`), and running processes. A PATH block for another
installation directory is retained. Open a new terminal afterward to refresh PATH.

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

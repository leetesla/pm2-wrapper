
# pm2-wrapper

A lightweight wrapper for PM2 with a dedicated Node.js runtime and per-project Node.js selection.

**Current scope:** macOS/Linux, nvm, and a locally installed PM2. Runtime selection is kept behind a small resolver so other Node version managers or an explicit Node executable can be added later.

## Why

- Run a local PM2 installation without depending on a globally installed PM2.
- Pin the Node.js runtime used to launch PM2 with the installation directory's **.nvmrc**.
- Select each application's Node.js executable from that application's own **.nvmrc**.
- Keep runtime selection inside the wrapper process; invoking it does not change the calling shell's Node version.
- Use a dedicated PM2_HOME by default so this installation does not accidentally attach to a daemon started by another PM2 installation.

## Requirements

- Node.js installed through nvm for the version you want to use.
- nvm installed at **$NVM_DIR/nvm.sh** (defaults to **$HOME/.nvm/nvm.sh**).
- macOS or Linux with **sh** and **bash**.

The installer does not download Node.js automatically. Install the selected version first with **nvm install VERSION**.

## Install

Clone this repository, then install into a dedicated directory. The path is configurable; the example below uses **$HOME/.local/share/pm2-wrapper**.

    git clone https://github.com/leetesla/pm2-wrapper.git
    cd pm2-wrapper

    # The selected Node.js version must already be installed.
    ./install.sh --dir "$HOME/.local/share/pm2-wrapper" --node-version 22.21.1

If the target directory already contains a **.nvmrc**, it is used unless **--node-version** is provided. The installer resolves the selected version and writes its exact version number back to **.nvmrc**, so aliases such as **22** become a reproducible pin. If PM2 is already installed in the target directory and **--pm2-version** is omitted, the installer keeps that PM2 version. On a first install, it uses the current PM2 release.

Optional custom nvm directory:

    ./install.sh --dir "$HOME/.local/share/pm2-wrapper" \
      --node-version 22.21.1 \
      --nvm-dir "$HOME/.nvm"

The installation directory is managed by this tool. Do not point **--dir** at an application directory or a directory whose **package.json** belongs to another project.

## Run PM2

The installer creates:

- **<dir>/bin/pm2** — the wrapper command.
- **<dir>/bin/pm2-wrapper** — an explicit alias for the same command.
- **<dir>/lib/ecosystem.cjs** — the per-application runtime helper.
- **<dir>/.nvmrc** — the Node version used to run PM2.
- **<dir>/.pm2/** — the default PM2 daemon state directory.

Use the wrapper's absolute path:

    "$HOME/.local/share/pm2-wrapper/bin/pm2" --version
    "$HOME/.local/share/pm2-wrapper/bin/pm2" start ecosystem.config.cjs
    "$HOME/.local/share/pm2-wrapper/bin/pm2" list

Or add its **bin** directory to your **PATH**. Put it before any global PM2 directory if you want the command name **pm2** to resolve to this wrapper.

PM2_HOME defaults to **<dir>/.pm2**, but an explicitly exported **PM2_HOME** is respected. This isolates the default daemon state from other PM2 installations. The wrapper sources nvm.sh and selects the runtime in a child process; it does not modify the parent terminal's PATH.

## Per-project Node.js version

Require the helper by its installed absolute path in each application's ecosystem file:

    // /path/to/project/ecosystem.config.cjs
    const { withNode } = require(
      '/Users/you/.local/share/pm2-wrapper/lib/ecosystem.cjs'
    );

    module.exports = {
      apps: [
        withNode({
          name: 'api',
          cwd: __dirname,
          script: './server.js',
          env: {
            NODE_ENV: 'production'
          }
        })
      ]
    };

The project directory should contain its own **.nvmrc**, for example:

    22.21.1

withNode() resolves the project's Node executable when the ecosystem file is loaded, sets PM2's **interpreter** to that absolute path, and prepends its **bin** directory to the app's **PATH**. This also helps child processes that invoke **node** by name. The helper supports **env** and named environments such as **env_production**.

Use an exact version in **.nvmrc** when reproducibility matters. The selected Node version must already be installed with nvm.

### Use an explicit Node executable

If a project does not use nvm, you can bypass version-manager resolution:

    withNode({
      name: 'worker',
      cwd: __dirname,
      script: './worker.js'
    }, {
      nodePath: '/opt/node-v22.21.1/bin/node'
    })

This option is intended for explicit runtime paths. Support for additional version managers can be added as resolver adapters without changing the ecosystem API.

## Changing versions

- **PM2 runtime:** update the installation directory's **.nvmrc** to an installed version, then restart the PM2 daemon deliberately. A running daemon does not change Node versions just because the wrapper is invoked again.
- **Application runtime:** update the application's **.nvmrc** and reload/restart the application so PM2 reloads the ecosystem configuration and resolves the new interpreter.
- **PM2 package:** rerun **install.sh --dir DIR --pm2-version VERSION** to install a specific PM2 version. Omitting **--pm2-version** preserves the currently installed PM2 version on subsequent installs.

For a controlled daemon migration, save the process list first, then stop and resurrect it using the same wrapper and PM2_HOME:

    /path/to/pm2-wrapper/bin/pm2 save
    /path/to/pm2-wrapper/bin/pm2 kill
    /path/to/pm2-wrapper/bin/pm2 resurrect

Run these commands during a maintenance window: **pm2 kill** stops the applications managed by that daemon.

## Tests

    npm test
    sh -n install.sh
    sh -n bin/pm2

## Limitations

- The built-in version manager adapter currently supports nvm.
- The helper resolves the application runtime when PM2 loads the ecosystem configuration; changing **.nvmrc** alone does not update an already-running process.
- The installer intentionally does not run **nvm install** or modify shell startup files.

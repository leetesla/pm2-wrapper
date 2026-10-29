# pm2-wrapper

一个小型安装工具，用固定的 Node.js 可执行文件生成**统一的 PM2 包装命令**。nvm 仅在安装或生成预览时用于解析 Node 路径，生成的命令运行时不会调用 nvm。

## 功能

- 将 PM2 安装到指定目录。
- 在安装时读取选定的 Node 版本，并解析其可执行文件路径。
- 生成 `pm2` 命令，使用 Node 的绝对路径调用本地 PM2 CLI。
- 在自启命令中固定 Node，并通过 `pm2 show startup` 检查现有自启配置。
- 不改变调用它的 shell 所使用的 Node 版本。
- 默认使用 PM2 的常规状态目录（`~/.pm2`），除非显式设置了 `PM2_HOME`。

本工具**不管理各个应用的 Node 版本**。如果某个应用需要使用不同的 Node 版本，请单独配置该应用的 `interpreter`。

## 环境要求

- macOS 或 Linux。
- 已安装 nvm，以及准备使用的 Node 版本。
- 可以通过 nvm 使用所选 Node 版本附带的 npm。

只有安装或重新生成包装脚本时才需要 nvm。运行生成的 `pm2` 命令不会加载 `nvm.sh`。

## 选择并记录 Node 版本

使用 nvm 选择包装脚本要固定的版本，然后记录当前 `node` 的版本：

```sh
nvm use 22.21.1
make nvmrc
```

不带版本时，`make nvmrc` 记录当前 `node -v`。也可以直接指定版本，由 nvm 解析并写入完整版本号：

```sh
make nvmrc 22
make nvmrc 22.21.1
make nvmrc 22 NVM_DIR="$HOME/.nvm"
```

如果指定版本尚未安装，会询问 `Install with nvm? [Y/n]`。直接回车默认安装，也接受 `y`、`yes`、`n`、`no`，不区分大小写；其他输入会重新询问。取消、输入结束或安装失败时，原 `.nvmrc` 保持不变。已有匹配版本时，使用 nvm 解析到的本地版本。

生成的 `.nvmrc` 属于本机配置，已被 Git 忽略，不会提交到仓库。

也可以直接执行 `node -v > .nvmrc`。

## 预览生成的包装脚本

在当前仓库目录中生成名为 `./pm2` 的预览脚本：

```sh
make preview
```

默认使用本地 `.nvmrc` 中的版本，也可以显式指定：

```sh
make preview NODE_VERSION=22.21.1
```

预览模式会解析 Node 可执行文件并写入包装脚本；在仓库外生成预览时，还会将 `startup.cjs` 复制到脚本所在目录。它不会安装 PM2，也不会修改 `.nvmrc`、`startup.json` 或 npm 包配置文件。仓库根目录中生成的 `pm2` 文件也已被 Git 忽略。普通 PM2 命令需要该目录的 `node_modules` 中已安装 PM2；`show startup` 无需安装 PM2 即可运行。

预览会检查 `PATH` 中是否已有 `pm2` 命令，找到时显示其路径，不要求确认。预览和安装会在终端中显示各步骤标题，并高亮状态信息。输出被重定向、`TERM=dumb` 或设置了 `NO_COLOR` 时，不使用颜色。

## 安装

创建 `.nvmrc` 后，安装到默认目录 `$HOME/.local/share/pm2-wrapper`：

```sh
make install
```

如果 `PATH` 中已有 `pm2` 命令，且它不指向本次安装的包装脚本，安装器会显示其路径，并在创建或修改安装文件前询问 `Continue installation? [y/N]`（是否继续安装）。只有输入 `y` 或 `Y` 才会继续；输入 `n`、`N`、直接回车、其他内容或遇到输入结束，都会取消安装并以非零状态码退出。预览模式只显示检查结果，不要求确认。

已有的可执行文件不会被覆盖，但加载生成的 PATH 配置后，会优先使用本工具的包装命令。两个命令默认都使用 `~/.pm2`，除非显式设置了 `PM2_HOME`。

也可以直接指定 Node 版本，无需预先创建 `.nvmrc`：

```sh
make install NODE_VERSION=22.21.1
```

指定其他安装目录：

```sh
make install INSTALL_DIR="$HOME/services/pm2-runtime"
```

指定 PM2 版本或非默认的 nvm 目录：

```sh
make install PM2_VERSION=6.0.0
make install NODE_VERSION=22.21.1 NVM_DIR="$HOME/.nvm"
```

上述 PM2 版本仅为示例，请根据自己的环境选择合适版本。所选 Node 版本必须已通过 nvm 安装；安装器不会自动下载 Node。

也可以直接调用安装脚本：

```sh
./install.sh --dir "$HOME/.local/share/pm2-wrapper" --node-version 22.21.1
```

如果目标目录中已安装 PM2，且本次未指定 PM2 版本，安装器会保留现有版本。首次安装且未指定版本时，会安装当前发布的 PM2 版本。

## 安装结果

安装目录包含包装脚本相关文件和本地 npm 包文件：

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

- `.nvmrc`：记录安装时解析得到的确切 Node 版本。
- `node_modules/pm2`：本地安装的 PM2。
- `pm2`：生成的包装命令。
- `startup.cjs`：实现自启命令处理和只读检查。
- `startup.json`：保存可由用户编辑的自启设置，重新安装时会保留。

安装器不会创建 `bin/`、`lib/`、ecosystem 辅助脚本、别名命令或每个安装目录独立的 `.pm2/` 状态目录。

## 使用

```sh
"$HOME/.local/share/pm2-wrapper/pm2" --version
"$HOME/.local/share/pm2-wrapper/pm2" list
"$HOME/.local/share/pm2-wrapper/pm2" start ecosystem.config.js
```

在 macOS 和 Linux 上，安装器会根据 `$SHELL` 识别用户的 shell，并自动配置 `PATH`：

- zsh：写入 `${ZDOTDIR:-$HOME}/.zshrc`。
- bash：写入 `~/.bashrc`，并按 `~/.bash_profile`、`~/.bash_login`、`~/.profile` 的顺序选择第一个已存在的登录配置文件。如果都不存在，则创建 `~/.profile`，避免遮蔽已有的登录配置文件。

安装器会保留其他设置，并在每个文件中维护一个带有 `pm2-wrapper` 标记的配置块。重新安装时，会根据所选安装目录更新该配置块。加载配置时，包装脚本所在目录会被放到 `PATH` 最前面；如果它已位于最前面，再次加载不会重复添加。预览模式不会修改 shell 启动配置文件。

安装后请打开新终端。安装器无法修改父 shell 的环境；如果要在当前终端立即使用 `pm2`，请执行安装器打印的命令。默认安装目录对应的命令为：

```sh
export PATH="$HOME/.local/share/pm2-wrapper:$PATH"
```

如果希望自行管理 PATH，可以跳过自动配置：

```sh
./install.sh --dir "$HOME/.local/share/pm2-wrapper" --node-version 22.21.1 --no-modify-path
```

对于其他 shell，安装器只提供手动配置 PATH 的说明，不修改其启动配置文件。

## 自启配置

```sh
pm2 startup
# 复制并执行上一步打印的 sudo 命令；Linux systemd 下会启用并立即启动服务。
pm2 show startup
pm2 show startup --service my-pm2
```

`startup` 和 `unstartup` 会将包装脚本固定的 Node 所在 `bin` 目录放到子进程 PATH 的最前面，同时保留其他 PATH 条目。打印的 sudo 命令也会优先使用该目录，并显式使用固定的 Node 运行已安装的自启辅助脚本，同时保留 HOME 和 PM2_HOME。这样，将命令复制到其他终端执行时，就不会误用该终端中的另一个 Node。

其他 PM2 命令仍直接透传给本地 CLI。使用时，请将 `startup`、`unstartup` 或 `show startup` 放在选项之前。

自启设置保存在安装目录中，默认路径为 `~/.local/share/pm2-wrapper/startup.json`：

```json
{
  "service": null
}
```

`null` 表示使用 PM2 的默认服务名：macOS 为 `pm2.USER.plist`，Linux 为 `pm2-USER.service`。将 `service` 设置为 `my-pm2` 等自定义名称后，生成自启配置和检查自启配置时都会使用该名称。

显式传入 `startup --service-name NAME` 或 `show startup --service NAME`，可以仅在本次调用中覆盖该设置。`show` 接受带有 `.plist` 或 `.service` 后缀的名称，配置文件中的服务名也可以带或不带后缀。这些临时覆盖不会保存到配置文件。

参考 [unode 的自启检查](https://github.com/leetesla/unode#开机启动)，`show startup` 会打印现有自启配置，根据启动命令、shebang 和保存的 PATH 解析其 Node，并将版本和路径与包装脚本固定的 Node 比较。自启是否启用与服务当前是否注册、运行会分别显示。

macOS 检查会处理 PM2 模板中的 `LaunchOnlyOnce=true`：一次性任务当前未注册，并不能证明 PM2 已停止。Linux 检查会读取实际生效的 systemd 属性，并显示单元配置内容，包括 drop-in 覆盖配置。

遇到复杂启动命令、未知解释器、EnvironmentFile、待执行 daemon-reload 或状态查询失败时，会提示需要人工复核。Node 不匹配，或无法验证配置、状态时，退出码为 2；检查成功时为 0。服务被禁用或未运行时，会单独显示对应状态，不影响 Node 比较本身的结果。

检查过程不会运行 PM2 CLI、启动其 daemon、加载服务或写入文件。比较基准是当前包装脚本，不会读取 unode 的安装历史。系统服务注册文件仍位于 `~/Library/LaunchAgents/` 或 systemd 单元目录中，`startup.json` 不会移动这些文件。

自启配置生成由 PM2 执行。在 Linux systemd 下，提权命令成功生成配置后，包装脚本会执行 `daemon-reload`、`start` 并检查服务为 `active/running` 且 MainPID 非零；启动失败或无法确认运行状态时返回非零退出码。已运行的服务不会被重启。应用列表仍需执行 `pm2 save` 保存，才能在服务启动时恢复。`show startup` 会高亮自启与运行状态：正常为绿色、未运行或禁用为黄色、失败为红色；无颜色时仍保留文字与状态标记。重定向输出、`TERM=dumb` 或设置 `NO_COLOR` 时不使用颜色。仅修改包装脚本不会迁移已运行的 daemon。`show` 将应用名 `startup` 保留给自启检查；如需查看同名应用，请直接调用本地 PM2 CLI。

## 卸载

在本仓库中执行：

```sh
make uninstall
```

如果使用了自定义安装目录：

```sh
make uninstall INSTALL_DIR="$HOME/services/pm2-runtime"
```

也可以直接执行 `./uninstall.sh --dir DIR`。卸载时要求 PATH 中有可用的 Node.js，不会加载 nvm。

卸载会移除本工具管理的运行时文件（包括 `startup.cjs` 和 `startup.json`），并从 bash、zsh 启动配置文件中移除与该安装目录匹配的 `pm2-wrapper` PATH 配置块。如果设置了 `ZDOTDIR`，也会检查该目录下的配置文件。

其他 shell 设置、无关文件、Node.js、PM2 状态（`~/.pm2` 或 `PM2_HOME`）以及正在运行的进程都会保留。指向其他安装目录的 PATH 配置块也会保留。卸载后请打开新终端，以刷新 PATH。

## 更换 Node 版本

选择新的 Node 版本，重新生成本地 `.nvmrc`，然后重新安装：

```sh
nvm install 22.22.0
nvm use 22.22.0
make nvmrc
make install
```

生成的包装脚本中写入了 Node 可执行文件的绝对路径。仅编辑 `.nvmrc` 不会改变该路径，必须重新执行 `make install` 才会重新生成。已运行的 PM2 daemon 不会因为包装脚本重新生成而自动更换运行时。在依赖新运行时之前，请安排可控的 daemon 重启或迁移。

## 测试

```sh
sh -n install.sh
./install.sh --help
make -n nvmrc
make -n preview
make -n install
npm test
```

使用**现有的 PM2 命令**测试应用实际使用的 Node：

```sh
npm run test:interpreter
```

此集成测试使用当前 PATH 中的 `pm2`，不会安装 PM2 或更改其配置的 Node。测试会将运行测试脚本的 Node 所在目录放到子命令 PATH 的最前面；该 Node 的版本必须与 PM2 使用的版本不同。也可以显式指定两个可执行文件，并保存实测结果：

```sh
npm run test:interpreter -- \
  --pm2 "$HOME/.local/share/pm2-wrapper/pm2" \
  --path-node "$HOME/.nvm/versions/node/v22.23.4/bin/node" \
  --output /tmp/pm2-interpreter-results.json
```

请使用本机已安装的 Node 版本。测试会运行六个应用，分别在 fork 和 cluster 模式下使用以下三种配置：不指定 `interpreter`、设置 `interpreter: process.execPath`、设置另一个 Node 的绝对路径。

每个应用都会报告实际的 `process.version` 和 `process.execPath`。脚本会同时检查这两项以及实际运行模式；配置文件还会记录现有 PM2 CLI 所使用的 Node。

对于 fork 模式下的 `.js` 应用，不指定 `interpreter` 时会使用应用 PATH 中的 `node`；在 ecosystem 配置中指定 `process.execPath` 时，会使用 PM2 CLI 的 Node。cluster 模式的工作进程使用 daemon 的 Node，即使配置中指定了其他 Node 路径也是如此。

测试使用临时 `PM2_HOME`，退出时会清理测试应用及其 daemon，不会连接常规 PM2 daemon 或修改其进程列表。

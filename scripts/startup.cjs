'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const run = (file, args, timeout = 10000) => spawnSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
const useColor = () => Boolean(process.stdout.isTTY && process.env.TERM !== 'dumb' && !('NO_COLOR' in process.env));
const highlight = (text, tone, color) => color ? `\x1b[1;${tone}m${text}\x1b[0m` : text;
function checked(result) {
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() || `命令退出码 ${result.status}`);
  }
  return result.stdout;
}

function settings(root) {
  const file = path.join(root, 'startup.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.service != null && (typeof config.service !== 'string' || !/^[\w.@:-]+$/.test(config.service)))) {
    throw new Error(`无效的 service 配置：${file}`);
  }
  return config;
}

// Tokenize the small shell subset used by PM2 templates. Never evaluate config.
function words(text) {
  const result = [];
  let value = '', mode = '', active = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (mode === "'") {
      if (c === "'") mode = ''; else value += c;
    } else if (mode === '"') {
      if (c === '"') mode = '';
      else if (c === '$' || c === '`') throw new Error('启动命令包含变量或命令替换，需人工复核');
      else if (c === '\\') { if (++i === text.length) throw new Error('启动命令转义不完整'); value += text[i]; }
      else value += c;
    } else if (c === "'" || c === '"') { mode = c; active = true; }
    else if (/\s/.test(c)) { if (active) { result.push(value); value = ''; active = false; } }
    else if (/[\$`;|&<>()[\]{}*?!#~]/.test(c)) throw new Error('复杂启动命令需人工复核');
    else if (c === '\\') { if (++i === text.length) throw new Error('启动命令转义不完整'); value += text[i]; active = true; }
    else { value += c; active = true; }
  }
  if (mode) throw new Error('启动命令引号不完整');
  if (active) result.push(value);
  return result;
}

function resolveNode(arguments_, environment) {
  let args = [...arguments_];
  if (['/bin/sh', '/bin/bash', '/bin/zsh'].includes(args[0])) {
    if (args.length !== 3 || args[1] !== '-c' || /[\r\n]/.test(args[2])) throw new Error('自定义 shell 启动命令需人工复核');
    args = words(args[2]);
  }
  function locate(name) {
    if (!name) throw new Error('启动命令为空');
    if (path.isAbsolute(name)) return name;
    const entries = (environment.PATH || '').split(path.delimiter);
    if (name.includes('/') || entries.some((entry) => !path.isAbsolute(entry))) throw new Error('启动配置缺少可确定的绝对 PATH');
    for (const entry of entries) {
      const file = path.join(entry, name);
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
    }
    throw new Error(`启动配置 PATH 找不到 ${name}`);
  }
  const executable = locate(args[0]);
  if (path.basename(executable) === 'node') return executable;
  if (path.basename(executable) !== 'pm2') throw new Error(`无法识别启动程序：${executable}`);
  const fd = fs.openSync(executable, 'r');
  const buffer = Buffer.alloc(4096);
  let first;
  try { first = buffer.subarray(0, fs.readSync(fd, buffer)).toString('utf8').split('\n')[0]; }
  finally { fs.closeSync(fd); }
  if (!first.startsWith('#!')) throw new Error('PM2 启动文件不是可识别的 shebang 脚本');
  let interpreter = words(first.slice(2));
  if (interpreter[0] === '/usr/bin/env') {
    interpreter.shift();
    if (interpreter[0] === '-S') interpreter.shift();
  }
  if (interpreter.length !== 1 || path.basename(interpreter[0]) !== 'node') throw new Error('PM2 使用未知解释器，需人工复核');
  return locate(interpreter[0]);
}

function macConfig(service, home) {
  const name = service.endsWith('.plist') ? service : service + '.plist';
  const file = path.join(home, 'Library/LaunchAgents', name);
  if (!fs.existsSync(file)) throw new Error(`未找到启动配置：${file}`);
  const raw = checked(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]));
  const config = JSON.parse(raw);
  if (typeof config.Label !== 'string' || !/^[\w.@:-]+$/.test(config.Label)) throw new Error('plist Label 无效');
  return { file, config, raw: fs.readFileSync(file).subarray(0, 6).toString() === 'bplist' ? raw : fs.readFileSync(file, 'utf8') };
}

function macStatus(config, file, query = run) {
  const uid = process.getuid();
  const domain = `gui/${uid}`;
  const disabled = query('/bin/launchctl', ['print-disabled', domain]);
  let enabled = '无法确认', uncertain = false;
  try {
    const output = checked(disabled).match(/^\s*disabled services = \{([\s\S]*?)\}\s*$/);
    if (!output) throw new Error('无法识别启用状态输出');
    const overrides = new Map();
    for (const line of output[1].split('\n').filter((line) => line.trim())) {
      const entry = line.match(/^\s*"([^"\n]+)"\s*=>\s*(true|false|enabled|disabled)\s*;?\s*$/);
      if (!entry || overrides.has(entry[1])) throw new Error('无法识别启用状态条目');
      overrides.set(entry[1], ['true', 'disabled'].includes(entry[2]));
    }
    if (config.Disabled != null && typeof config.Disabled !== 'boolean') throw new Error('Disabled 格式无效');
    const info = fs.statSync(file);
    const sessions = config.LimitLoadToSessionType;
    if (![0, uid].includes(info.uid) || (info.mode & 0o022) ||
        (sessions != null && !(Array.isArray(sessions) ? sessions : [sessions]).includes('Aqua')) ||
        config.LimitLoadToHardware || config.LimitLoadFromHardware) throw new Error('权限或登录会话限制需人工复核');
    enabled = (overrides.get(config.Label) ?? config.Disabled ?? false) ? '已禁用' :
      (config.RunAtLoad === true || config.KeepAlive === true || config.OnDemand === false) ? '已启用（当前用户登录后触发）' : '未配置登录时立即启动';
  } catch (error) { enabled += `：${error.message}`; uncertain = true; }
  const states = [];
  let loaded = false;
  let running = false, failed = false;
  for (const scope of [domain, `user/${uid}`, 'system']) {
    const result = query('/bin/launchctl', ['print', `${scope}/${config.Label}`]);
    if (result.status === 0) {
      loaded = true;
      const state = result.stdout.match(/^\s*state = (.+)$/m)?.[1] || '已注册';
      const pid = result.stdout.match(/^\s*pid = (\d+)/m)?.[1] || '0';
      const exit = result.stdout.match(/^\s*last exit code = (\d+)/m)?.[1];
      running ||= state === 'running' && pid !== '0';
      failed ||= Boolean(exit && exit !== '0' && state !== 'running');
      states.push(`${scope}：${state}；MainPID=${pid}${exit ? `；LastExitCode=${exit}` : ''}`);
    }
    else if (!`${result.stderr || ''}${result.stdout || ''}`.includes(`Could not find service "${config.Label}" in domain`)) {
      states.push(`${scope} 查询失败：${result.error?.message || result.stderr || result.stdout}`); uncertain = true;
    }
  }
  if (!loaded) states.push(config.LaunchOnlyOnce === true ? '一次性启动任务当前未注册；不能据此判断 PM2 后台已停止。' : '当前未加载。');
  return { enabled, state: states.join('\n'), stateTone: running ? 32 : failed ? 31 : 33, uncertain };
}

function linuxConfig(service, query = run) {
  const unit = service.endsWith('.service') ? service : service + '.service';
  const properties = ['LoadState', 'FragmentPath', 'Environment', 'EnvironmentFiles', 'ExecStart', 'NeedDaemonReload', 'UnitFileState', 'ActiveState', 'SubState', 'MainPID'];
  const output = checked(query('systemctl', ['show', unit, ...properties.map((key) => `--property=${key}`)]));
  const config = Object.fromEntries(output.trim().split('\n').map((line) => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (config.LoadState === 'not-found') throw new Error(`未找到启动服务：${unit}`);
  const raw = checked(query('systemctl', ['cat', unit]));
  return { unit, config, file: config.FragmentPath || unit, raw };
}

function linuxNode(config) {
  if (config.LoadState !== 'loaded' || config.NeedDaemonReload !== 'no' || config.EnvironmentFiles) {
    throw new Error('服务未加载、使用 EnvironmentFile 或需要 daemon-reload，需人工复核');
  }
  const executables = [...config.ExecStart.matchAll(/(?:^|[ {])path=(.*?)\s*;/g)];
  if (executables.length !== 1) throw new Error('无法确定 systemd ExecStart');
  const environment = Object.fromEntries(words(config.Environment).map((item) => {
    const i = item.indexOf('='); if (i < 1) throw new Error('Environment 格式异常');
    return [item.slice(0, i), item.slice(i + 1)];
  }));
  return resolveNode([executables[0][1]], environment);
}

function show(args, config, { platform = process.platform, home = os.homedir(), query = run, log = console.log, color = useColor() } = {}) {
  let service = config.service;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--service' && args[i + 1]) service = args[++i];
    else throw new Error('用法：pm2 show startup [--service NAME]');
  }
  service ||= platform === 'darwin' ? `pm2.${os.userInfo().username}` : `pm2-${os.userInfo().username}`;
  if (!/^[\w.@:-]+$/.test(service)) throw new Error('服务名称无效');
  let definition, status, node;
  if (platform === 'darwin') {
    definition = macConfig(service, home);
    status = macStatus(definition.config, definition.file, query);
    node = () => resolveNode(definition.config.Program ? [definition.config.Program] : definition.config.ProgramArguments, definition.config.EnvironmentVariables || {});
  } else if (platform === 'linux') {
    definition = linuxConfig(service, query);
    const c = definition.config;
    const running = c.ActiveState === 'active' && c.SubState === 'running' && /^[1-9]\d*$/.test(c.MainPID || '');
    status = {
      enabled: c.UnitFileState || '无法确认',
      state: `${running ? '✓' : '!'} ${c.ActiveState || '未知'}/${c.SubState || '未知'}；MainPID=${c.MainPID || '未知'}`,
      enabledTone: ['enabled', 'enabled-runtime'].includes(c.UnitFileState) ? 32 : 33,
      stateTone: running ? 32 : c.ActiveState === 'failed' ? 31 : 33,
      uncertain: !c.UnitFileState || !c.ActiveState || !c.SubState || !/^\d+$/.test(c.MainPID || ''),
    };
    node = () => linuxNode(c);
  } else throw new Error('show startup 支持 macOS launchd 和 Linux systemd');

  log(`\n┌  pm2-wrapper · show startup\n│\n◇  启动配置\n│\n${definition.file}\n${definition.raw}`);
  log(`\n◇  启动配置 Node 版本\n│\n│  wrapper Node：${process.version}\n│  wrapper Node 路径：${process.execPath}`);
  let code = status.uncertain ? 2 : 0;
  try {
    const binary = node();
    const version = checked(query(binary, ['--version'])).trim();
    if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('Node 版本输出无法识别');
    const match = version === process.version;
    const samePath = fs.realpathSync(binary) === fs.realpathSync(process.execPath);
    const message = match ? '✓ 启动 Node 版本与 wrapper 一致' : '! 启动 Node 版本与 wrapper 不一致';
    log(`│  启动配置 Node：${version}\n│  启动 Node 路径：${binary}\n│  ${highlight(message, match ? 32 : 31, color)}`);
    if (!samePath) log('│  ! 启动 Node 路径与 wrapper 不同');
    if (!match || !samePath) code = 2;
  } catch (error) { log(`│  ! 启动 Node 未验证：${error.message}`); code = 2; }
  log(`│\n◇  自启与服务状态\n│\n│  开机自启：${highlight(status.enabled, status.enabledTone || (status.enabled.startsWith('已启用') ? 32 : 33), color)}\n│  服务状态：${highlight(status.state, status.stateTone || 33, color)}\n\n└  只读检查完成；配置检查不代表已验证重启恢复。\n`);
  return code;
}

function main(args) {
  const root = __dirname;
  const config = settings(root);
  if (args[0] === 'show' && args[1] === 'startup') return show(args.slice(2), config);
  if (['startup', 'unstartup', 'update', 'updatePM2'].includes(args[0])) return require('./lifecycle.cjs').lifecycle(args, root, config);
  throw new Error('用法：pm2 startup | pm2 unstartup | pm2 show startup');
}

module.exports = { words, resolveNode, macStatus, linuxConfig, linuxNode, show };
if (require.main === module) {
  Promise.resolve().then(() => main(process.argv.slice(2))).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`pm2-wrapper: ${error.message}`); process.exitCode = 2;
  });
}

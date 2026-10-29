'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createInterface } = require('node:readline/promises');
const { show, linuxNode, words } = require('./startup.cjs');

const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const properties = text => Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
}));
function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')}: ${result.error?.message || result.stderr || result.stdout || result.signal || result.status}`);
  }
  return result.stdout || '';
}
function parse(args, config = {}) {
  const result = { action: args[0], yes: false, service: config.service };
  if (!['startup', 'unstartup'].includes(result.action)) throw new Error('用法：pm2 startup|unstartup [--yes] [--service-name NAME]');
  for (let i = 1; i < args.length; i++) {
    let item = args[i];
    if (item === '--yes') { result.yes = true; continue; }
    if (item === '--wait-ip') { result.waitIp = true; continue; }
    if (['systemd', 'launchd', 'darwin', 'macos', 'ubuntu', 'centos', 'arch', 'oracle'].includes(item) && !result.init) {
      result.init = item; continue;
    }
    const equal = item.indexOf('=');
    let value;
    if (equal > 0) { value = item.slice(equal + 1); item = item.slice(0, equal); }
    else { value = args[++i]; }
    const key = { '--service-name': 'service', '-u': 'user', '--user': 'user', '--hp': 'home' }[item];
    if (!key || !value || value.startsWith('-')) throw new Error(`无效参数或缺少值：${item}`);
    result[key] = value;
  }
  if (result.service != null) {
    result.service = result.service.replace(/\.(service|plist)$/, '');
    if (!/^[\w.@:-]+$/.test(result.service) || result.service.startsWith('-')) throw new Error('服务名称无效');
  }
  return result;
}
function context(args, root, config, platform = process.platform) {
  const c = { ...parse(args, config), root, platform, node: process.execPath };
  if (!['linux', 'darwin'].includes(platform)) throw new Error('自启封装支持 macOS launchd 和 Linux systemd');
  if (c.init && (platform === 'linux' ? ['launchd', 'darwin', 'macos'].includes(c.init) : !['launchd', 'darwin', 'macos'].includes(c.init))) {
    throw new Error('启动平台与当前系统不一致');
  }
  const current = os.userInfo();
  c.user ||= current.username;
  if (!/^[\w.-]+$/.test(c.user) || c.user.startsWith('-')) throw new Error('用户名称无效');
  let account = { uid: current.uid, gid: current.gid, home: current.homedir };
  if (c.user !== current.username) {
    if (platform !== 'linux') throw new Error('macOS 请在目标用户的登录会话中执行，不要使用 sudo');
    const entry = command('getent', ['passwd', c.user]).trim().split(':');
    account = { uid: Number(entry[2]), gid: Number(entry[3]), home: entry[5] };
  }
  c.uid = account.uid; c.gid = account.gid;
  c.home ||= c.user === current.username ? process.env.HOME || account.home : account.home;
  if (!path.isAbsolute(c.home) || /[\r\n]/.test(c.home)) throw new Error('HOME 必须是绝对路径');
  c.pm2Home = path.resolve(parse(args, config).home ? path.join(c.home, '.pm2') : process.env.PM2_HOME || path.join(c.home, '.pm2'));
  if (/[\r\n]/.test(c.pm2Home)) throw new Error('PM2_HOME 包含换行');
  c.service ||= platform === 'linux' ? `pm2-${c.user}` : `pm2.${c.user}`;
  c.unit = `${c.service}.service`;
  c.file = platform === 'linux' ? `/etc/systemd/system/${c.unit}` : path.join(c.home, 'Library/LaunchAgents', `${c.service}.plist`);
  c.cli = path.join(root, 'node_modules/pm2/bin/pm2');
  fs.accessSync(c.cli, fs.constants.R_OK);
  c.env = { ...process.env, HOME: c.home, PM2_HOME: c.pm2Home, USER: c.user, LOGNAME: c.user,
    PATH: `${path.dirname(c.node)}:${process.env.PATH || '/usr/bin:/bin'}`, PM2_DISCRETE_MODE: 'true' };
  c.domain = `gui/${c.uid}`;
  if (platform === 'darwin') {
    if (current.uid === 0) throw new Error('macOS 请以目标用户执行，不要使用 sudo');
    command('/bin/launchctl', ['print', c.domain]);
  }
  return c;
}
const canonical = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
function daemons(c) {
  return command('ps', ['-ax', '-o', 'pid=,uid=,command=']).split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+PM2 v[^:]+: God Daemon \((.*)\)\s*$/);
    return m && Number(m[2]) === c.uid && canonical(m[3]) === canonical(c.pm2Home) ? [Number(m[1])] : [];
  });
}
function daemonNode(c, pid) {
  if (c.platform === 'linux') return fs.realpathSync(`/proc/${pid}/exe`);
  const output = command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
  const binary = output.split('\n').find(line => line.startsWith('n/') && path.basename(line.slice(1)) === 'node');
  if (!binary) throw new Error(`无法确定 daemon ${pid} 的 Node`);
  return fs.realpathSync(binary.slice(1));
}
function readState(c) {
  let s;
  if (c.platform === 'linux') {
    const fields = ['LoadState', 'FragmentPath', 'User', 'Environment', 'EnvironmentFiles', 'ExecStart', 'NeedDaemonReload', 'UnitFileState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'NRestarts', 'Result'];
    const result = spawnSync('systemctl', ['show', c.unit, ...fields.map(key => `--property=${key}`)], { encoding: 'utf8', timeout: 10000 });
    const p = properties(result.stdout || '');
    if (result.error || (result.status !== 0 && p.LoadState !== 'not-found')) throw new Error(result.error?.message || result.stderr || '无法查询 systemd');
    s = { exists: p.LoadState !== 'not-found', enabled: p.UnitFileState === 'enabled', active: p.ActiveState === 'active' && p.SubState === 'running', pid: Number(p.MainPID || 0), label: c.service, p };
    if (s.exists) {
      if (p.FragmentPath !== c.file) throw new Error(`服务配置不在受管理目录：${p.FragmentPath}`);
      if (p.User !== c.user) throw new Error(`服务属于其他用户：${p.User}`);
      const env = Object.fromEntries(words(p.Environment || '').map(item => { const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]; }));
      if (!env.PM2_HOME || canonical(env.PM2_HOME) !== canonical(c.pm2Home)) throw new Error('服务使用了其他 PM2_HOME，拒绝修改');
      s.matches = false;
      try { s.matches = canonical(linuxNode(p)) === canonical(c.node) && canonical(p.ExecStart.match(/(?:^|[ {])path=(.*?)\s*;/)?.[1] || '') === canonical(c.cli) && !p.EnvironmentFiles; } catch {}
    }
  } else {
    const exists = fs.existsSync(c.file);
    const plist = exists ? JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', c.file])) : null;
    const label = plist?.Label || c.service;
    if (!/^[\w.@:-]+$/.test(label)) throw new Error('无效的 launchd Label');
    if (plist && canonical(plist.EnvironmentVariables?.PM2_HOME || '') !== canonical(c.pm2Home)) throw new Error('LaunchAgent 使用了其他 PM2_HOME，拒绝修改');
    const result = spawnSync('/bin/launchctl', ['print', `${c.domain}/${label}`], { encoding: 'utf8', timeout: 10000 });
    if (result.error || (result.status !== 0 && !`${result.stderr}${result.stdout}`.includes('Could not find service'))) throw new Error(result.error?.message || result.stderr || '无法查询 launchd');
    const output = result.stdout || '';
    if (result.status === 0 && canonical(output.match(/^\s*path = (.+)$/m)?.[1] || '') !== canonical(c.file)) throw new Error('相同 launchd Label 已由其他配置文件注册');
    const disabled = command('/bin/launchctl', ['print-disabled', c.domain]);
    const overrides = new Map([...disabled.matchAll(/"([^"\n]+)"\s*=>\s*(true|false|disabled|enabled)/g)].map(m => [m[1], ['true', 'disabled'].includes(m[2])]));
    s = { exists, label, plist, registered: result.status === 0, enabled: exists && !(overrides.get(label) ?? plist.Disabled ?? false) && plist.RunAtLoad === true,
      active: /^\s*state = running\s*$/m.test(output), pid: Number(output.match(/^\s*pid = (\d+)/m)?.[1] || 0), output };
    s.matches = Boolean(plist && JSON.stringify(plist.ProgramArguments) === JSON.stringify([c.node, path.join(c.root, 'lifecycle.cjs'), '--foreground']) && plist.KeepAlive === true && !plist.LaunchOnlyOnce);
  }
  s.daemons = daemons(c);
  if (s.daemons.length > 1) throw new Error('同一 PM2_HOME 存在多个 daemon，需人工复核');
  s.daemon = s.daemons[0] || 0;
  if (s.daemon) s.node = daemonNode(c, s.daemon);
  s.managed = Boolean(s.active && s.pid === s.daemon && s.daemon);
  if (s.managed && c.platform === 'linux') {
    s.managed = Boolean(s.p.ControlGroup && fs.readFileSync(`/proc/${s.pid}/cgroup`, 'utf8').split('\n').some(line => line.endsWith(`:${s.p.ControlGroup}`)));
  }
  s.healthy = s.managed && s.matches && canonical(s.node) === canonical(c.node);
  return s;
}
function asUser(c, args) {
  const target = [c.node, ...args];
  return process.getuid() === 0 && c.uid !== 0 ? command('runuser', ['-u', c.user, '--', ...target], { env: c.env, cwd: c.home, timeout: 30000 }) :
    command(target[0], target.slice(1), { env: c.env, cwd: c.home, timeout: 30000 });
}
function applications(c) {
  const apps = JSON.parse(asUser(c, [path.join(c.root, 'lifecycle.cjs'), '--read-apps']));
  if (!Array.isArray(apps)) throw new Error('应用列表格式无效');
  return apps.filter(app => !app.pm2_env?.pmx_module);
}
function savedApplications(c) {
  if (process.getuid() === 0 && c.uid != null && c.uid !== 0) {
    return JSON.parse(asUser(c, [path.join(c.root, 'lifecycle.cjs'), '--read-saved']));
  }
  for (const name of ['dump.pm2', 'dump.pm2.bak']) {
    const file = path.join(c.pm2Home, name);
    if (!fs.existsSync(file)) continue;
    const apps = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(apps)) throw new Error(`恢复列表格式无效：${file}`);
    return apps.map(pm2_env => ({ name: pm2_env.name, pm2_env }));
  }
  return [];
}
const identity = app => JSON.stringify([app.name || app.pm2_env.name, app.pm2_env.namespace || 'default', app.pm2_env.pm_exec_path]);
function verifyApps(expected, actual, { runtime = false } = {}) {
  const pending = [...actual];
  for (const app of expected) {
    const index = pending.findIndex(other => identity(other) === identity(app));
    if (index < 0) throw new Error(`应用未恢复：${app.name || app.pm2_env.name}`);
    const restored = pending.splice(index, 1)[0];
    const stopped = ['stopped', 'stopping'].includes(app.pm2_env.status);
    if (restored.pm2_env.status !== (stopped ? 'stopped' : 'online')) throw new Error(`应用状态未恢复：${restored.name}=${restored.pm2_env.status}`);
    if (runtime && !stopped) {
      if (!Number.isInteger(restored.pid) || restored.pid < 1) throw new Error(`应用 PID 无效：${restored.name}`);
      try { process.kill(restored.pid, 0); } catch { throw new Error(`应用进程不存在或无法验证：${restored.name}`); }
    }
  }
  if (pending.length) throw new Error('恢复后出现了计划外的应用，需人工复核');
}
async function confirm(question, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) return false;
  const reader = createInterface({ input, output });
  const closed = new Promise(resolve => reader.once('close', () => resolve(null)));
  try {
    const answer = await Promise.race([reader.question(`${question} [Y/n] `), closed]);
    return answer !== null && /^(y(es)?)?$/i.test(answer.trim());
  }
  catch { return false; }
  finally { reader.close(); }
}
function summary(c, s, log = console.log) {
  log(`\n◇ ${c.action} · ${c.platform === 'linux' ? 'systemd' : 'launchd'}\n  用户：${c.user}\n  服务：${c.service}\n  PM2_HOME：${c.pm2Home}\n  Node：${c.node}\n  开机自启：${s.enabled ? 'enabled' : 'disabled/未配置'}\n  服务状态：${s.active ? 'active/running' : c.platform === 'linux' ? `${s.p.ActiveState || '未配置'}/${s.p.SubState || '未知'}` : '未运行'}；MainPID=${s.pid}\n  daemon：${s.daemon || '无'}${s.daemon ? s.managed ? '（服务管理）' : '（独立运行）' : ''}`);
}
function diagnostics(c, log = console.error) {
  try {
    if (c.platform === 'linux') log(command('journalctl', ['-u', c.unit, '-n', '35', '--no-pager']));
    else {
      log(`LaunchAgent：${c.file}`);
      const file = path.join(c.pm2Home, 'wrapper-launchd.log');
      if (fs.existsSync(file)) log(fs.readFileSync(file, 'utf8').slice(-12000));
    }
  } catch (error) { log(`日志查询失败：${error.message}`); }
}
function plan(c, s) {
  if (c.action === 'unstartup') return ['保存并备份应用列表', '停止 daemon（运行中的应用将短暂停机）', '禁用自启并移除服务配置', '验证服务和 daemon 已停止；保留恢复列表'];
  if (s.healthy) return ['启用开机自启', '验证服务、Node 和应用状态（不重启）'];
  return [s.daemon ? '保存并备份应用列表' : '保留已有应用恢复列表',
    ...(s.daemon ? [`${s.managed ? '停止服务' : 'pm2 kill 停止独立 daemon'}（运行中的应用将短暂停机）`] : []),
    '生成并启用服务配置', ...(c.platform === 'linux' ? ['必要时清除失败限流，由 systemd 启动'] : ['由 launchd 启动并持续管理 daemon']), '检查稳定运行、实际 Node 和应用恢复状态'];
}
function backup(c) {
  if (process.getuid() === 0 && c.uid !== 0) {
    console.log(asUser(c, [path.join(c.root, 'lifecycle.cjs'), '--backup']));
    return;
  }
  const files = ['dump.pm2', 'dump.pm2.bak'].filter(name => fs.existsSync(path.join(c.pm2Home, name)));
  if (!files.length) return;
  const directory = fs.mkdtempSync(path.join(c.pm2Home, 'startup-backup-'));
  fs.chmodSync(directory, 0o700);
  if (process.getuid() === 0) fs.chownSync(directory, c.uid, c.gid);
  for (const name of files) {
    const file = path.join(directory, name);
    fs.copyFileSync(path.join(c.pm2Home, name), file); fs.chmodSync(file, 0o600);
    if (process.getuid() === 0) fs.chownSync(file, c.uid, c.gid);
  }
  console.log(`  恢复列表备份：${directory}`);
}
async function waitFor(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try { return await check(); } catch (e) { error = e; }
    await delay(300);
  } while (Date.now() < deadline);
  throw new Error(`${description}：${error?.message}`);
}
function xml(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function macPlist(c) {
  const string = value => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key>${string(c.service)}<key>ProgramArguments</key><array>${[c.node, path.join(c.root, 'lifecycle.cjs'), '--foreground'].map(string).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer>
<key>WorkingDirectory</key>${string(c.home)}<key>EnvironmentVariables</key><dict><key>HOME</key>${string(c.home)}<key>PM2_HOME</key>${string(c.pm2Home)}<key>PATH</key>${string(c.env.PATH)}</dict>
<key>StandardOutPath</key>${string(path.join(c.pm2Home, 'wrapper-launchd.log'))}<key>StandardErrorPath</key>${string(path.join(c.pm2Home, 'wrapper-launchd.log'))}
</dict></plist>\n`;
}
async function stop(c, s) {
  // stop also cancels pending starts/restart jobs after a protocol failure.
  if (c.platform === 'linux' && s.exists) command('systemctl', ['stop', c.unit], { timeout: 120000 });
  if (c.platform === 'darwin' && s.registered) {
    command('/bin/launchctl', ['bootout', `${c.domain}/${s.label}`], { timeout: 40000 });
    // bootout acknowledges before launchd has finished releasing the job.
    await delay(500);
  }
  if (s.managed) {
    await waitFor(() => { if (daemons(c).length) throw new Error('daemon 尚未停止'); }, '服务停止失败', 35000);
  }
  // Native one-shot LaunchAgents can leave a detached daemon after bootout.
  if (daemons(c).length) {
    console.log(asUser(c, [c.cli, 'kill']));
  }
  await waitFor(() => { if (daemons(c).length) throw new Error('daemon 尚未停止'); }, '停止失败');
}
async function mutate(c, initial, expected, live = []) {
  let step = '保存应用列表';
  try {
    const changesRuntime = c.action === 'unstartup' || !initial.healthy;
    if (changesRuntime) {
      backup(c);
      if (initial.daemon && live.length) {
        console.log(asUser(c, [c.cli, 'save', '--force']));
        verifyApps(live, savedApplications(c));
      }
      step = '停止现有 daemon'; await stop(c, initial);
    }
    step = '生成或移除服务配置';
    if (c.platform === 'linux') {
      if (c.action === 'unstartup') {
        if (initial.exists) {
          command('systemctl', ['reset-failed', c.unit]);
          command('systemctl', ['disable', c.unit]);
        }
        if (fs.existsSync(c.file)) fs.unlinkSync(c.file);
        command('systemctl', ['daemon-reload']);
      } else {
        if (!initial.healthy) console.log(asRootPM2(c));
        command('systemctl', ['daemon-reload']);
        command('systemctl', ['enable', c.unit]);
        const p = readState(c).p;
        if (!initial.healthy || p.ActiveState === 'failed' || p.Result === 'start-limit-hit') command('systemctl', ['reset-failed', c.unit]);
        step = '启动服务'; command('systemctl', ['start', c.unit], { timeout: 120000 });
      }
    } else if (c.action === 'unstartup') {
      command('/bin/launchctl', ['disable', `${c.domain}/${initial.label}`]);
      if (fs.existsSync(c.file)) fs.unlinkSync(c.file);
    } else {
      if (!initial.healthy) {
        fs.mkdirSync(path.dirname(c.file), { recursive: true });
        fs.mkdirSync(c.pm2Home, { recursive: true, mode: 0o700 });
        fs.writeFileSync(c.file, macPlist(c), { mode: 0o600 }); fs.chmodSync(c.file, 0o600);
      }
      command('/bin/launchctl', ['enable', `${c.domain}/${c.service}`]);
      if (!initial.healthy) {
        step = '启动服务';
        await waitFor(() => command('/bin/launchctl', ['bootstrap', c.domain, c.file]), 'launchd 注册失败', 5000);
      }
    }
    step = '验证最终状态';
    if (c.action === 'unstartup') {
      const state = readState(c);
      if (state.enabled || state.active || state.daemon || state.exists) throw new Error('服务或 daemon 未完全移除');
      console.log('✓ 自启配置已移除，daemon 已停止，应用恢复列表已保留');
      return 0;
    }
    const verify = () => {
      const state = readState(c);
      if (!state.healthy || !state.enabled) throw new Error('服务、PID、归属、Node 或自启状态不符合预期');
      verifyApps(expected, applications(c), { runtime: true });
      return state;
    };
    const first = await waitFor(verify, '启动验证失败');
    await delay(2000);
    const last = verify();
    if (first.daemon !== last.daemon || (c.platform === 'linux' && first.p.NRestarts !== last.p.NRestarts)) throw new Error('观察期间服务发生重启');
    if (show(['--service', c.service], {}, { home: c.home }) !== 0) throw new Error('自启配置只读检查未通过');
    console.log(`✓ 服务和应用恢复检查通过；daemon PID=${last.daemon}；Node=${last.node}`);
    return 0;
  } catch (error) {
    console.error(`✗ ${step}失败：${error.message}\n应用恢复列表和备份已保留。`);
    diagnostics(c);
    return 2;
  }
}
function asRootPM2(c) {
  // PM2's startup command does not connect to or create a daemon.
  const args = ['startup', 'systemd', '-u', c.user, '--service-name', c.service];
  if (c.waitIp) args.push('--wait-ip');
  return command(c.node, [c.cli, ...args], { env: c.env, cwd: c.home, timeout: 30000 });
}
const fingerprint = (s, apps) => JSON.stringify([s.exists, s.enabled, s.active, s.pid, s.daemon, s.matches,
  s.p?.ExecStart?.split('start_time=')[0], s.p?.Environment, s.p?.NeedDaemonReload, s.plist, apps.map(a => [identity(a), a.pm2_env.status])]);
const approval = (s, apps, expected) => crypto.createHash('sha256').update(JSON.stringify([fingerprint(s, apps), expected.map(a => [identity(a), a.pm2_env.status])])).digest('hex');
function elevation(c, args, token) {
  const helperArgs = [path.join(c.root, 'startup.cjs'), ...args.filter(arg => arg !== '--yes'), '--yes'];
  if (!args.some(arg => ['-u', '--user'].includes(arg) || arg.startsWith('--user='))) helperArgs.push('-u', c.user);
  const argv = ['env', `PATH=${c.env.PATH}`, `HOME=${c.home}`, `PM2_HOME=${c.pm2Home}`, `PM2_WRAPPER_EXPECTED=${token}`, c.node, ...helperArgs];
  return { argv, display: `sudo ${argv.map(quote).join(' ')}` };
}
async function lifecycle(args, root, config) {
  const c = context(args, root, config);
  const state = readState(c);
  const live = state.daemon ? applications(c) : [];
  const expected = live.length || (state.healthy && c.action === 'startup') ? live : savedApplications(c);
  const token = approval(state, live, expected);
  if (process.env.PM2_WRAPPER_EXPECTED && process.env.PM2_WRAPPER_EXPECTED !== token) throw new Error('提权期间状态发生变化，请重新检查并确认操作计划');
  summary(c, state);
  if (c.action === 'startup' && state.healthy && state.enabled) {
    verifyApps(expected, live, { runtime: true });
    if (show(['--service', c.service], {}, { home: c.home }) !== 0) throw new Error('自启配置只读检查未通过');
    console.log('✓ 服务已正常运行，无需重启'); return 0;
  }
  if (c.action === 'unstartup' && !state.exists && !state.daemon) { console.log('✓ 自启配置不存在，daemon 未运行'); return 0; }
  if (c.platform === 'linux' && state.p.ActiveState === 'failed') diagnostics(c, console.log);
  console.log(`\n即将执行：\n${plan(c, state).map((line, i) => `  ${i + 1}. ${line}`).join('\n')}\n  当前应用：${live.length}；预期恢复：${expected.length}`);
  const elevate = c.platform === 'linux' && process.getuid() !== 0;
  const elevated = elevation(c, args, token);
  if (elevate) console.log(`\n提权命令：\n${elevated.display}\n`);
  if (!c.yes && !await confirm('是否继续执行以上操作？')) { console.log('已取消；没有修改服务或应用。非交互执行请显式使用 --yes。'); return 1; }
  if (elevate) {
    const auth = spawnSync('sudo', [process.stdin.isTTY ? '-v' : '-n', ...(process.stdin.isTTY ? [] : ['true'])], { stdio: 'inherit' });
    if (auth.status !== 0) throw new Error('sudo 认证失败，服务和应用未修改；请在终端执行或预先完成 sudo 认证');
    const result = spawnSync('sudo', elevated.argv, { stdio: 'inherit' });
    return result.status ?? 2;
  }
  const lock = path.join(os.tmpdir(), `pm2-wrapper-${crypto.createHash('sha256').update(`${c.uid}:${canonical(c.pm2Home)}`).digest('hex').slice(0, 24)}.lock`);
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error(`另一个自启操作可能正在执行：${lock}；确认无操作运行后才能移除遗留锁`); }
  try {
    const latest = readState(c), apps = latest.daemon ? applications(c) : [];
    const latestExpected = apps.length || (latest.healthy && c.action === 'startup') ? apps : savedApplications(c);
    if (token !== approval(latest, apps, latestExpected)) throw new Error('确认期间状态发生变化，请重新执行以检查新计划');
    return await mutate(c, latest, expected, live);
  } finally { fs.rmdirSync(lock); }
}

// Connect directly to an existing RPC endpoint. Never call PM2.connect here:
// its normal client API starts a new daemon when no server is reachable.
function readApps(root) {
  const PM2 = require(path.join(root, 'node_modules/pm2/lib/API.js'));
  const api = new PM2();
  const timer = setTimeout(() => { console.error('现有 daemon RPC 查询超时'); process.exit(2); }, 8000);
  api.Client.launchRPC(error => {
    if (error) { console.error(error.message); process.exit(2); }
    api.Client.executeRemote('getMonitorData', {}, (err, apps) => {
      clearTimeout(timer);
      if (err) { console.error(err.message); process.exit(2); }
      // Lifecycle checks need identity and status, never application secrets.
      process.stdout.write(JSON.stringify(apps.map(app => ({ pid: app.pid, name: app.name,
        pm2_env: Object.fromEntries(['name', 'namespace', 'pm_exec_path', 'status', 'pmx_module'].map(key => [key, app.pm2_env[key]])) }))),
      () => api.Client.disconnectRPC(() => process.exit(0)));
    });
  });
}
function metadata(apps) {
  return apps.map(app => ({ name: app.name, pm2_env: Object.fromEntries(['name', 'namespace', 'pm_exec_path', 'status', 'pmx_module'].map(key => [key, app.pm2_env[key]])) }));
}
function foreground(root) {
  const PM2 = require(path.join(root, 'node_modules/pm2/lib/API.js'));
  const version = require(path.join(root, 'node_modules/pm2/package.json')).version;
  process.title = `PM2 v${version}: God Daemon (${process.env.PM2_HOME})`;
  const api = new PM2({ daemon_mode: false });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    api.killDaemon(() => process.exit(0));
    setTimeout(() => process.exit(2), 25000).unref();
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  api.connect((error, meta) => {
    if (error || !meta?.new_pm2_instance) { console.error(error || '拒绝接管已有独立 daemon'); process.exit(2); }
    const dump = path.join(process.env.PM2_HOME, 'dump.pm2');
    if (fs.existsSync(dump) || fs.existsSync(`${dump}.bak`)) api.resurrect(err => { if (err) { console.error(err); shutdown(); } });
  });
}
module.exports = { parse, context, readState, daemons, verifyApps, savedApplications, confirm, plan, macPlist, lifecycle, mutate, fingerprint, approval, elevation };
if (require.main === module) {
  if (process.argv[2] === '--read-apps') readApps(__dirname);
  else if (process.argv[2] === '--foreground') foreground(__dirname);
  else if (process.argv[2] === '--read-saved') {
    process.stdout.write(JSON.stringify(metadata(savedApplications({ pm2Home: process.env.PM2_HOME }))));
  } else if (process.argv[2] === '--backup') {
    backup({ pm2Home: process.env.PM2_HOME, uid: process.getuid(), gid: process.getgid() });
  }
  else { console.error('内部命令用法无效'); process.exitCode = 2; }
}

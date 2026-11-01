'use strict';
/**
 * YouTube 下载器 - 本地服务端
 * 依赖：bin/yt-dlp.exe、bin/ffmpeg.exe（随程序自带）
 * 运行：node server.js
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');

const ROOT = __dirname;
const BIN_DIR = path.join(ROOT, 'bin');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PORT = Number(process.env.PORT || 8808);

/**
 * 选择 yt-dlp 的调用方式。
 *
 * 三种形态差异很大：
 *  - 独立 exe（bin/yt-dlp.exe）：单文件、免环境，但**不加载外部插件**，
 *    拿不到 PO Token，YouTube 会返回 403；
 *  - pip 版 + venv（runtime/venv）：能加载 yt_dlp_plugins，但 venv 里的
 *    `yt-dlp.exe` 是 pip 生成的启动器，**硬编码了创建时的 python.exe 绝对路径**
 *    （以及 pyvenv.cfg 里指向宿主 Python 的 home），**整个目录拷到别的电脑就跑不起来**；
 *  - pip 版 + **随包独立 Python**（runtime/python）：用
 *    `python.exe -m yt_dlp` 启动，路径完全跟随目录，拷到哪都能跑。
 *
 * 所以优先级：随包独立 Python > venv > 独立 exe。
 * 直接双击启动器使用本机安装时走 venv，打包发给别人时走 runtime/python。
 */
const PY_EXE = path.join(ROOT, 'runtime', 'python', 'python.exe');

const PY_HAS_YTDLP = (() => {
  try {
    return fs.existsSync(PY_EXE) && fs.existsSync(path.join(
      ROOT, 'runtime', 'python', 'Lib', 'site-packages', 'yt_dlp', '__init__.py'));
  } catch (e) {
    return false;
  }
})();

const YTDLP_CANDIDATES = [
  process.env.YTDLP_PATH,
  path.join(ROOT, 'runtime', 'venv', 'Scripts', 'yt-dlp.exe'),
  path.join(BIN_DIR, 'yt-dlp.exe')
].filter(Boolean);

function resolveYtdlp() {
  for (const p of YTDLP_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return path.join(BIN_DIR, 'yt-dlp.exe');
}

const YTDLP = PY_HAS_YTDLP ? PY_EXE : resolveYtdlp();
/** 用自带 Python 时要额外带上 `-m yt_dlp`（所有调用点统一走 runYtdlp） */
const YTDLP_PREFIX = PY_HAS_YTDLP ? ['-m', 'yt_dlp'] : [];

// 只有 pip 版才能加载插件、用上 PO Token；独立 exe 版没有插件目录
const YTDLP_HAS_PLUGIN = (() => {
  if (PY_HAS_YTDLP) {
    try {
      return fs.existsSync(path.join(
        ROOT, 'runtime', 'python', 'Lib', 'site-packages', 'yt_dlp_plugins'));
    } catch (e) {}
  }
  return /venv/i.test(YTDLP);
})();

/**
 * 自带 node 的位置。放一份在 runtime/node 下有两个好处：
 *  1. 不依赖用户机器装了 Node，换台电脑拷过去就能跑；
 *  2. 避开宿主环境的 node 包装（某些沙箱会把 node 换成代理程序，
 *     导致 YouTube 的 JS 挑战解密失败）。
 */
const NODE_DIR = (() => {
  const bundled = path.join(ROOT, 'runtime', 'node');
  try {
    if (fs.existsSync(path.join(bundled, 'node.exe'))) return bundled;
  } catch (e) {}
  return '';
})();

function bundledNodeExe() {
  if (!NODE_DIR) return '';
  const p = path.join(NODE_DIR, 'node.exe');
  try { return fs.existsSync(p) ? p : ''; } catch (e) { return ''; }
}

// ---------------------------------------------------------------- 配置

const DEFAULT_CONFIG = {
  downloadDir: path.join(ROOT, 'downloads'),
  proxy: '',
  preferHighQuality: false,   // false = 优先 H.264（兼容性最好）
  mergeContainer: 'mp4',      // mp4 | mkv
  embedMetadata: true,
  writeThumbnail: false,
  embedThumbnail: false,
  writeSubtitles: false,
  subtitleLangs: 'zh-Hans,zh-CN,zh,en',
  cookiesFromBrowser: '',
  concurrency: 2,
  filenameTemplate: '%(title).120B [%(id)s].%(ext)s',
  allowPlaylist: false,
  rateLimit: '',
  // YouTube 反爬：PO Token 服务地址（由 pot-server 提供，默认端口 4416）
  potProviderUrl: 'http://127.0.0.1:4416',
  // 浏览器标识，配合 cookies 使用可显著降低被风控概率
  userAgent: '',
  // 向 YouTube 声明的客户端类型（--extractor-args youtube:player_client=...）。
  //
  // 默认**留空**＝不声明，交给 yt-dlp 自己挑。它每个版本都会跟着 YouTube 调这个
  // 客户端列表，跟着它走比自己写死一套稳。
  //
  // 这里以前写死的是 'tv,web_safari,mweb'，注释说「多客户端能同时拿到有效流与匹配的
  // PO Token」。2026-10 之后这套组合反而成了故障源，实测同一条视频：
  //   · tv          → 直接 UNPLAYABLE（"The page needs to be reloaded."）
  //   · web_safari  → 被强制 SABR 流（格式没有可用 URL）
  //   · mweb        → 同上，偶尔解析出 1080p，一取流就 403
  // 于是「解析正常、下载到 20 MB 突然 403」；把 player_client 去掉后同一条视频
  // 1080p60 H.264 全程 418 MB 正常下完。改回写死值之前请先想清楚这一点。
  playerClient: ''
};

let CONFIG = null;

/**
 * 老版本写死过的「客户端组合」默认值。
 *
 * 这些值已经落进了用户的 config.json（第一次启动就会写一份），光改 DEFAULT_CONFIG
 * 是不够的 —— 老用户永远不会被重置。所以加载配置时做一次等比迁移：
 * **只认集合完全相同**（顺序、空格、大小写都不计较），用户在界面上自己填的组合一律不动。
 */
const LEGACY_CLIENT_LISTS = [
  ['mweb', 'tv', 'web_safari']   // 2026-10 之前的默认值，现已稳定导致取流 403
];

function clientListKey(v) {
  return String(v || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

function migrateConfig(c) {
  const key = clientListKey(c.playerClient);
  if (key) {
    const legacy = LEGACY_CLIENT_LISTS.some(list => clientListKey(list.join(',')) === key);
    if (legacy) {
      console.log('[配置] 检测到已知会导致 403 的客户端组合 "' + c.playerClient + '"，已重置为「交给 yt-dlp 自选」');
      c.playerClient = '';
    }
  }
  return c;
}

function loadConfig() {
  if (CONFIG) return CONFIG;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    CONFIG = migrateConfig(Object.assign({}, DEFAULT_CONFIG, raw));
  } catch (e) {
    CONFIG = Object.assign({}, DEFAULT_CONFIG);
  }
  return CONFIG;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function ensureDirs() {
  const c = loadConfig();
  for (const d of [BIN_DIR, PUBLIC_DIR, c.downloadDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  }
}

// ---------------------------------------------------------------- 子进程工具

/**
 * 构造子进程环境。
 * 关键点：若用户没有在界面里配置代理，就彻底清掉继承来的 HTTP_PROXY/HTTPS_PROXY 等变量。
 * 否则从某些宿主环境（IDE、打包器）启动时，会带上一个不可用的本地代理，
 * 导致 yt-dlp 所有请求都走它而失败。
 */
function childEnv() {
  const c = loadConfig();
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });

  /*
   * 代理环境变量：这里同时要照顾两类子进程。
   *
   *  - yt-dlp 本身：我们是用 --proxy 参数显式告诉它的，不看环境变量；
   *  - **PO Token 的本地生成脚本（node 程序）**：它只认环境变量，
   *    完全不认 yt-dlp 的 --proxy。实测在直连被墙的环境里，
   *    不设这几个变量时它会一直卡住（>30 秒也出不来令牌），
   *    设了 HTTPS_PROXY 后 16 秒就返回令牌。
   *
   *  所以：有代理时必须把环境变量也设上，并且用 NO_PROXY 把回环地址排除掉
   *  （否则连本地 POT 服务都要走代理，反而取不到东西）。
   */
  const proxy = c.proxy || AUTO_PROXY;
  if (!proxy) {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      delete env[k];
    }
  } else {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.ALL_PROXY = proxy;
    env.NO_PROXY = '127.0.0.1,localhost,::1';
    env.no_proxy = env.NO_PROXY;
  }

  /**
   * 清掉宿主环境注入的 node 指向变量。
   *
   * 用 DSH / 各类 IDE 之类的宿主启动本程序时，环境里可能带着
   * NODE_OPTIONS、NODE_PATH 这类变量，把 node 指到一个
   * 包装程序上。yt-dlp 解密 YouTube 的 JS 挑战时会去调 node，
   * 一旦命中的是包装程序就会报 ERR_ACCESS_DENIED 而解密失败，
   * 表现是「分辨率列不出来 / 一堆格式 403」。
   * 这些变量与本程序无关，直接清掉最省事。
   */
  for (const k of ['NODE_OPTIONS', 'NODE_PATH']) {
    delete env[k];
  }

  /**
   * 把自带的 node 目录放到 PATH 最前面。
   *
   * 用途一：PO Token 的 script 模式会用 PATH 查找 node 来跑生成脚本；
   * 用途二：避免命中宿主环境里可能存在的 node 包装程序。
   * 程序自带的这份是原版 node，最稳妥。
   */
  const nodeDir = NODE_DIR;
  if (nodeDir) {
    const sep = process.platform === 'win32' ? ';' : ':';
    const cur = env.PATH || env.Path || '';
    const parts = cur.split(sep).filter(Boolean);
    const already = parts.some(p => p.toLowerCase() === nodeDir.toLowerCase());
    if (!already) env.PATH = nodeDir + sep + cur;
  }
  return env;
}

function runCapture(cmd, args, timeoutMs, envOverride) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawn(cmd, args, {
      cwd: ROOT,
      windowsHide: true,
      env: envOverride || childEnv()
    });
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill(); } catch (e) {} resolve({ code: -1, stdout: out, stderr: err, timeout: true }); }
    }, timeoutMs || 60000);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => {
      if (!done) { done = true; clearTimeout(timer); resolve({ code: -2, stdout: out, stderr: String(e && e.message || e) }); }
    });
    child.on('close', code => {
      if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); }
    });
  });
}

/**
 * 统一的 yt-dlp 调用入口。
 *
 * 用随包 Python 时实际命令是 `python.exe -m yt_dlp ...`，
 * 用 venv / 独立 exe 时是 `yt-dlp.exe ...`。
 * 所有调用点都走这里，避免某处漏掉 `-m yt_dlp` 前缀。
 */
function runYtdlp(args, timeoutMs, envOverride) {
  return runCapture(YTDLP, [...YTDLP_PREFIX, ...args], timeoutMs, envOverride);
}

// ---------------------------------------------------------------- 环境探测

let envCache = { at: 0, data: null };
let SUPPORTS_JS_RUNTIME = null;   // 探测 yt-dlp 是否支持 --js-runtimes

/**
 * YouTube 会下发混淆过的签名，需要 JavaScript 运行时来解密。
 * 没有 JS 运行时时 yt-dlp 仍能列出格式，但拿到的下载地址是无效的，必然 403。
 * 本程序自身就跑在 Node 上，于是直接把它交给 yt-dlp 用，零额外依赖。
 */
function jsRuntimeArgs() {
  if (SUPPORTS_JS_RUNTIME === false) return [];
  // 优先用随程序自带的 node（纯净、换机可用），没有才退回当前进程的 node
  const candidates = [bundledNodeExe(), process.execPath];
  for (const exe of candidates) {
    if (!exe) continue;
    if (!/node(\.exe)?$/i.test(exe)) continue;
    try { if (!fs.existsSync(exe)) continue; } catch (e) { continue; }
    return ['--js-runtimes', 'node:' + exe];
  }
  return [];
}

let POT_AVAILABLE = null;   // 本机是否跑着 PO Token 服务

/**
 * YouTube 用 PO Token 校验请求来源，缺少它时视频流会返回 403（网页信息仍能正常解析）。
 * 外部插件 bgutil-ytdlp-pot-provider 会在本地起一个 HTTP 服务提供 token。
 * 这里先探测该服务是否存活，活着才传参，避免无谓报错。
 */
async function potAlive() {
  const c = loadConfig();
  if (!c.potProviderUrl) return false;
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    let u;
    try { u = new URL('/ping', c.potProviderUrl); } catch (e) { return done(false); }
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET', timeout: 1500
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => done(res.statusCode === 200 || /pong|ok/i.test(body)));
    });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
    req.end();
  });
}

/** POT 服务所在目录（script 模式需要），随程序自带 */
const POT_SERVER_HOME = [
  path.join(ROOT, 'runtime', 'pot-server'),
  path.join(ROOT, 'pot-server')
].find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || '';

/**
 * 生成 PO Token 相关参数。
 *
 * 有两种取 token 的方式：
 *
 *  A. HTTP 模式（youtubepot-bgutilhttp）：向本地 POT 服务的 /ping、/get_pot 发请求。
 *     缺点：这些请求走 yt-dlp 自己的网络栈，一旦设置了 --proxy，
 *     连 127.0.0.1 都会被代理拦截（代理软件默认不转发本地回环地址），
 *     token 就取不到了。这也是「挂了 VPN 反而更差」的原因。
 *
 *  B. script 模式（youtubepot-bgutilscript）：直接 fork 本地 node 脚本生成 token，
 *     全程不经过网络，因此**完全不受代理影响**。
 *
 * 所以策略是：优先 script 模式（更稳），脚本不存在时再退回 HTTP 模式。
 * 两者都需要 pip 版 yt-dlp —— 独立 exe 版不加载插件。
 */
function potArgs() {
  const c = loadConfig();
  if (!YTDLP_HAS_PLUGIN) return [];

  // B：script 模式，不依赖网络，代理环境下最可靠
  const serverHome = POT_SERVER_HOME;
  if (serverHome && fs.existsSync(path.join(serverHome, 'build', 'generate_once.js'))) {
    return ['--extractor-args', `youtubepot-bgutilscript:server_home=${serverHome}`];
  }

  // A：退回 HTTP 模式
  if (!c.potProviderUrl) return [];
  const base = c.potProviderUrl.replace(/\/+$/, '');
  return ['--extractor-args', `youtubepot-bgutilhttp:base_url=${base}`];
}

/** script 模式是否就绪：只要本地生成脚本在，就与任何网络服务无关 */
function potScriptReady() {
  if (!YTDLP_HAS_PLUGIN || !POT_SERVER_HOME) return false;
  try {
    return fs.existsSync(path.join(POT_SERVER_HOME, 'build', 'generate_once.js'));
  } catch (e) {
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 取 PO Token 参数的**统一入口**。
 *
 * ⚠️ 这里曾经写成「先 await potAlive()，服务活着才把参数加上」——那是错的，
 * 而且正是「有时候只解析出最低画质」的元凶：
 *   script 模式是在本地 fork node 脚本生成令牌，**根本不需要** 4416 上的 HTTP 服务。
 *   拿 HTTP 探测当开关，POT 服务冷启动 / 繁忙时那 1.5 秒探测会超时 → 参数被整个丢掉
 *   → YouTube 只回一条 360p 合并流（format 18）→ 界面显示「仅 1 档 / 最高 360p」。
 * 所以判定顺序改成：script 就绪就用（不探网络），否则才看 HTTP 服务活不活。
 */
async function potArgList() {
  if (!YTDLP_HAS_PLUGIN) return [];
  if (potScriptReady()) return potArgs();     // 首选：本地脚本，不受代理与网络影响
  if (await potAlive()) return potArgs();     // 退路：HTTP 服务确认活着才用
  return [];
}

/**
 * 保底自愈：本地 POT 服务没在跑就把它拉起来。
 *
 * 防的是「启动器漏拉 POT」「POT 进程中途崩了」「先开服务后开 POT」这几类情况 ——
 * 以前一旦如此，解析会**静默**降级到 360p，用户完全看不出哪里不对。
 * 注意：script 模式已就绪时无需该服务，直接返回。
 */
async function ensurePotService() {
  if (potScriptReady()) return true;
  if (await potAlive()) return true;
  const main = POT_SERVER_HOME ? path.join(POT_SERVER_HOME, 'build', 'main.js') : '';
  try {
    if (!main || !fs.existsSync(main)) return false;
  } catch (e) {
    return false;
  }
  const nodeExe = bundledNodeExe() || process.execPath;
  try {
    const p = spawn(nodeExe, [main, '--port', '4416'], {
      cwd: POT_SERVER_HOME, env: childEnv(), detached: true,
      stdio: 'ignore', windowsHide: true
    });
    p.on('error', () => {});
    p.unref();
  } catch (e) {
    return false;
  }
  for (let i = 0; i < 16; i++) {          // 最多等 8 秒
    await sleep(500);
    if (await potAlive()) return true;
  }
  return false;
}

/**
 * 客户端选择参数。
 *
 * 默认返回空数组＝不声明客户端，交给 yt-dlp 用它自己的默认列表。
 *
 * 历史坑（别再踩）：以前这里默认给人 'tv,web_safari,mweb'，理由是「多客户端组合
 * 能同时拿到有效流与匹配的 PO Token」。但 YouTube 是逐个把客户端搞坏的 ——
 * tv 变成 UNPLAYABLE、web_safari / mweb 被强制 SABR 没有直链，写死这套组合的结果
 * 是「解析出 1080p、一取流就 403，常常下到几十 MB 才断」。这类列表的正确维护者是
 * yt-dlp（它随版本更新），不是我们。
 *
 * 设置里仍可手填组合；只有当用户明确填写时才传参。
 */
function clientArgs() {
  const c = loadConfig();
  const list = String(c.playerClient || '').trim();
  if (!list) return [];
  return ['--extractor-args', `youtube:player_client=${list}`];
}

async function getEnv(force) {
  if (!force && envCache.data && Date.now() - envCache.at < 60000) return envCache.data;
  const c = loadConfig();

  const ytv = await runYtdlp(['--version'], 20000);
  const ffv = await runCapture(path.join(BIN_DIR, 'ffmpeg.exe'), ['-version'], 20000);
  if (SUPPORTS_JS_RUNTIME === null) {
    const help = await runYtdlp(['--help'], 30000);
    SUPPORTS_JS_RUNTIME = /--js-runtimes/.test((help.stdout || '') + (help.stderr || ''));
  }

  const ytVersion = (ytv.stdout || '').trim().split(/\r?\n/)[0] || '';
  const ffLine = (ffv.stdout || '').split(/\r?\n/)[0] || '';
  const ffM = ffLine.match(/ffmpeg version (\S+)/);
  const pot = await potAlive();
  POT_AVAILABLE = pot;
  const potScriptReady = !!(POT_SERVER_HOME && fs.existsSync(path.join(POT_SERVER_HOME, 'build', 'generate_once.js')));

  const data = {
    ytdlp: {
      ok: !!ytVersion,
      version: ytVersion,
      /*
       * yt-dlp 的版本号就是发布日期（2026.08.19）。
       * YouTube 改版频繁，版本一旦太旧就会出现「解析被要求登录」这类怪现象
       * （2026-10 实测：7 月版必挂，升到 8 月版立刻恢复）。
       * 这里把"多久没更新"算出来，让界面能主动提醒，而不是等用户踩坑。
       */
      ageDays: (() => {
        const m = ytVersion.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
        if (!m) return null;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
      })(),
      path: YTDLP,
      plugin: YTDLP_HAS_PLUGIN,
      jsRuntime: SUPPORTS_JS_RUNTIME ? ('node ' + process.version) : ''
    },
    pot: {
      // script 模式不依赖网络服务，只要脚本在就算可用
      ok: potScriptReady || pot,
      mode: potScriptReady ? 'script' : (pot ? 'http' : ''),
      url: c.potProviderUrl,
      hint: potScriptReady
        ? '防 403 已就绪（本地生成令牌，不受代理影响）'
        : (pot ? '防 403 已就绪（本地服务，需保证代理放行 127.0.0.1）'
               : '未启用：YouTube 高清格式可能返回 403')
    },
    ffmpeg: {
      ok: !!ffM,
      version: ffM ? ffM[1] : '',
      path: path.join(BIN_DIR, 'ffmpeg.exe')
    },
    downloadDir: c.downloadDir,
    proxy: c.proxy,
    node: process.version,
    platform: process.platform
  };
  envCache = { at: Date.now(), data };
  return data;
}

// 探测本机常见代理端口
function portOpen(port, host) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let settled = false;
    const finish = v => { if (!settled) { settled = true; try { sock.destroy(); } catch (e) {} resolve(v); } };
    sock.setTimeout(600);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
    sock.connect(port, host || '127.0.0.1');
  });
}

async function probeProxies() {
  const ports = [7890, 7897, 7898, 10809, 10808, 1080, 1081, 2080, 2081, 8080, 8888, 1087, 20171, 33210, 4780, 7078, 9910, 10090, 10091, 10080, 2334];
  const found = [];
  await Promise.all(ports.map(async p => {
    if (await portOpen(p)) found.push(p);
  }));
  found.sort((a, b) => a - b);
  return found.map(p => ({ port: p, http: `http://127.0.0.1:${p}`, socks5: `socks5://127.0.0.1:${p}` }));
}

// ---------------------------------------------------------------- 网络体检

/**
 * 本次运行"自动挑中"的代理（用户没在设置里填代理时）。
 *
 * 场景：国内直连 YouTube 必然是黑洞 —— 连接既不拒绝也不返回，
 * yt-dlp 只能一路等到 socket 超时，表现就是「解析半天出不来」。
 * 用户本机明明开着代理软件，却忘了在设置里填端口，程序就该自己找出来。
 */
let AUTO_PROXY = '';

/** TCP 可达性探测（不涉及代理），用于判断能否直连 */
function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let settled = false;
    const finish = v => { if (!settled) { settled = true; try { sock.destroy(); } catch (e) {} resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * 判断某个 HTTP 代理是否真能穿到目标站点。
 *
 * 只探端口是不是开着是不够的（代理软件常常监听但没连上节点）。
 * 这里发一个 CONNECT 请求，拿到 `200 Connection established` 才算通 ——
 * 不需要 TLS 握手，几百毫秒就能出结果。
 */
function proxyTunnelOk(proxyUrl, host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(proxyUrl); } catch (e) { return resolve(false); }
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.request({
        host: u.hostname, port: Number(u.port) || 80,
        method: 'CONNECT', path: host + ':' + port, timeout: timeoutMs
      });
    } catch (e) {
      return finish(false);
    }
    req.on('connect', (res, socket) => {
      try { socket.destroy(); } catch (e) {}
      finish(res.statusCode === 200);
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish(false); });
    req.on('error', () => finish(false));
    req.end();
  });
}

/**
 * 决定这次任务该走哪个代理。
 *
 * 优先级：用户显式配置 > 直连可行 > 本机自动探测 > 判定网络不可用。
 * 返回 { proxy, auto, direct, unreachable, candidates }
 */
async function resolveProxy() {
  const c = loadConfig();

  // 1) 用户配了就用用户的，不做可达性判断（免得把用户的配置"判"掉）
  if (c.proxy) {
    AUTO_PROXY = '';
    return { proxy: c.proxy, auto: false, direct: false };
  }

  // 2) 没配代理：先看直连通不通（有些用户开着 TUN/全局模式，直连就够）
  if (await tcpReachable('www.youtube.com', 443, 3000)) {
    AUTO_PROXY = '';
    return { proxy: '', auto: false, direct: true };
  }

  // 3) 直连不通 → 找本机正在跑的代理（端口开着 + CONNECT 能穿）
  const cands = await probeProxies();
  for (const cand of cands) {
    if (await proxyTunnelOk(cand.http, 'www.youtube.com', 443, 4000)) {
      AUTO_PROXY = cand.http;
      console.log(`[网络] 直连不可用，已自动改用本机代理 ${cand.http}`);
      return { proxy: cand.http, auto: true, candidates: cands.map(x => x.port) };
    }
  }

  // 4) 都不行
  AUTO_PROXY = '';
  return { proxy: '', auto: false, unreachable: true, candidates: cands.map(x => x.port) };
}

// ---------------------------------------------------------------- 更新 yt-dlp

/**
 * 更新源（2026-10 实测，别改回只用镜像）：
 *
 * - 阿里云 / 腾讯云 / 华为云镜像的 **稳定版会明显滞后**：官方已经发布
 *   2026.10.21 时，镜像上最新稳定版还停在 2026.08.19（只有 nightly 的
 *   dev 版在动）。旧版接口只查镜像，于是永远回答「已是最新」，
 *   顶部「68 天未更新」也就永远消不掉 —— 用户会以为按钮坏了。
 * - 官方 pypi.org 才有最新稳定版；国内访问要走用户配置的 HTTP 代理。
 *
 * 顺序：官方 PyPI（带代理）→ 本机自动探测到的代理再试一次 → 国内镜像兜底。
 */
const PYPI_JSON = 'https://pypi.org/pypi/yt-dlp/json';
const PYPI_INDEX = 'https://pypi.org/simple';
const MIRROR_INDEX = 'https://mirrors.aliyun.com/pypi/simple/';
const UPDATE_PYPI_TIMEOUT = 8000;

/** yt-dlp 的版本号就是发布日期，例如 2026.10.21 */
function isStableVersion(v) {
  return /^\d{4}\.\d{1,2}\.\d{1,2}$/.test(String(v || ''));
}

function cmpVersion(a, b) {
  if (!isStableVersion(a) || !isStableVersion(b)) return 0;
  const A = a.split('.').map(Number);
  const B = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  }
  return 0;
}

function versionAgeDays(v) {
  const m = String(v || '').match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

/**
 * 极简 HTTPS GET：支持 HTTP 代理（CONNECT 隧道），不引入第三方库。
 * PyPI 的 JSON 接口和镜像索引都只需要 GET，够用。
 */
function httpGetText(url, { proxy = '', timeoutMs = UPDATE_PYPI_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('无效地址')); }
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port) || (isHttps ? 443 : 80);
    let settled = false;
    let reqRef = null;
    let hardTimer = null;

    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { if (reqRef) reqRef.destroy(); } catch (e) {}
      fn(v);
    };
    /*
     * 硬超时：代理偶发「接受 TCP 连接但不回数据」，socket timeout 不一定触发。
     * 整体兜底保证接口一定会返回，不会把 UI 卡在「检查中」。
     */
    hardTimer = setTimeout(() => done(reject, new Error('请求超时')), timeoutMs + 1500);

    const headers = {
      'User-Agent': 'YouTubeDownloader-GUI/1.0',
      'Accept': '*/*',
      'Connection': 'close'
    };

    const onResponse = res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => {
        body += d;
        if (body.length > 8e6) done(reject, new Error('响应过大'));
      });
      res.on('end', () => done(resolve, { status: res.statusCode, body }));
    };

    let pu = null;
    try { pu = proxy ? new URL(proxy) : null; } catch (e) { pu = null; }
    const useProxy = !!(pu && /^https?:$/.test(pu.protocol));

    if (!isHttps) {
      // 本项目用到的都是 HTTPS；HTTP 只做直连，简化处理
      reqRef = http.request({
        host: u.hostname, port, path: u.pathname + u.search,
        method: 'GET', headers, agent: false
      }, onResponse);
      reqRef.setTimeout(timeoutMs, () => { try { reqRef.destroy(new Error('请求超时')); } catch (e) {} });
      reqRef.on('error', e => done(reject, e));
      return reqRef.end();
    }

    let agent = false;
    if (useProxy) {
      /*
       * 关键：HTTPS over CONNECT 必须自己完成 TLS 握手，再把 TLS socket 交给 Agent。
       * 直接把裸 socket 塞给 https.request / createConnection 会一直挂住
       * （实测 CONNECT 成功后请求永不返回，界面就会卡在「检查中」）。
       */
      agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = (opts, cb) => {
        let called = false;
        const finish = (err, sock) => {
          if (called) return;
          called = true;
          cb(err, sock);
        };
        const pheaders = { Host: `${u.hostname}:${port}` };
        if (pu.username) {
          pheaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(
            decodeURIComponent(pu.username) + ':' + decodeURIComponent(pu.password || '')
          ).toString('base64');
        }
        const preq = http.request({
          host: pu.hostname,
          port: Number(pu.port) || 80,
          method: 'CONNECT',
          path: `${u.hostname}:${port}`,
          headers: pheaders,
          agent: false
        });
        preq.setTimeout(timeoutMs, () => { try { preq.destroy(new Error('代理连接超时')); } catch (e) {} });
        preq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            try { socket.destroy(); } catch (e) {}
            return finish(new Error('代理连接失败（HTTP ' + res.statusCode + '）'));
          }
          const t = tls.connect({ socket, servername: u.hostname }, () => finish(null, t));
          t.on('error', err => finish(err));
        });
        preq.on('error', err => finish(err));
        preq.end();
      };
    }

    reqRef = https.request({
      host: u.hostname, port, path: u.pathname + u.search,
      method: 'GET', headers, agent
    }, onResponse);
    reqRef.setTimeout(timeoutMs, () => { try { reqRef.destroy(new Error('请求超时')); } catch (e) {} });
    reqRef.on('error', e => done(reject, e));
    reqRef.end();
  });
}

async function fetchLatestFromPypi(proxy) {
  const r = await httpGetText(PYPI_JSON, { proxy, timeoutMs: UPDATE_PYPI_TIMEOUT });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  let j;
  try { j = JSON.parse(r.body); } catch (e) { throw new Error('返回内容不是有效 JSON'); }
  let latest = '';
  for (const [v, files] of Object.entries(j.releases || {})) {
    if (!isStableVersion(v)) continue;
    if (!Array.isArray(files) || !files.length) continue;
    if (files.every(f => f && f.yanked)) continue;
    if (!latest || cmpVersion(v, latest) > 0) latest = v;
  }
  // info.version 在极端情况下可能指向 pre-release，只在没有稳定版列表时兜底
  if (!latest && isStableVersion(j.info && j.info.version)) latest = j.info.version;
  if (!latest) throw new Error('没有找到稳定版');
  return { latest, source: 'pypi', sourceName: '官方 PyPI' };
}

async function fetchLatestFromMirror() {
  const r = await httpGetText(MIRROR_INDEX + 'yt-dlp/', { timeoutMs: UPDATE_PYPI_TIMEOUT });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const re = /yt_dlp-(\d{4}\.\d{1,2}\.\d{1,2})-py3-none-any\.whl/g;
  let m, latest = '';
  while ((m = re.exec(r.body))) {
    if (!latest || cmpVersion(m[1], latest) > 0) latest = m[1];
  }
  if (!latest) throw new Error('镜像上没有稳定版');
  return { latest, source: 'mirror', sourceName: '阿里云镜像' };
}

async function currentYtdlpVersion() {
  try {
    const r = await runYtdlp(['--version'], 20000);
    return (r.stdout || '').trim().split(/\r?\n/)[0] || '';
  } catch (e) { return ''; }
}

/**
 * 查询最新稳定版。返回 { ok, current, latest, hasUpdate, ageDays, sourceName, error }
 * 不抛异常 —— 前端始终能拿到可显示的状态。
 *
 * 并发合并 + 2 分钟缓存：页面初始化、打开设置、手动点检查很容易同时发三个请求，
 * 每个都去建代理隧道会把接口拖到几十秒（实测 45s）。这里让它们共享同一个结果。
 */
let updateCheckCache = { at: 0, data: null };
let updateCheckInFlight = null;

async function checkYtdlpUpdate(force) {
  if (!force && updateCheckCache.data && Date.now() - updateCheckCache.at < 120000) {
    return updateCheckCache.data;
  }
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = (async () => {
    const data = await doCheckYtdlpUpdate();
    updateCheckCache = { at: Date.now(), data };
    return data;
  })();
  try {
    return await updateCheckInFlight;
  } finally {
    updateCheckInFlight = null;
  }
}

async function doCheckYtdlpUpdate() {
  const current = await currentYtdlpVersion();
  const ageDays = versionAgeDays(current);
  const errors = [];
  let proxy = loadConfig().proxy || AUTO_PROXY || '';

  const pack = (info, note) => ({
    ok: true, current, ageDays,
    latest: info.latest,
    latestAgeDays: versionAgeDays(info.latest),
    hasUpdate: cmpVersion(info.latest, current) > 0,
    source: info.source,
    sourceName: info.sourceName + (note || ''),
    viaProxy: !!proxy && info.source === 'pypi',
    warning: info.source === 'mirror' ? '国内镜像同步可能滞后，结果仅供参考' : ''
  });

  /*
   * 官方源和镜像并行查：官方通常 0.5 秒就回，镜像慢一点也无所谓；
   * 串行等待会在官方连不上时白白多花一倍时间（实测 8s + 3s）。
   */
  const [pypiRes, mirrorRes] = await Promise.allSettled([
    fetchLatestFromPypi(proxy),
    fetchLatestFromMirror()
  ]);

  if (pypiRes.status === 'fulfilled') return pack(pypiRes.value, proxy ? '' : '');
  errors.push('官方源：' + ((pypiRes.reason && pypiRes.reason.message) || pypiRes.reason));

  // 没配代理时很常见：用户开着代理软件但忘了填。这里自动探一次再试官方源。
  if (!proxy) {
    try {
      const r = await resolveProxy();
      if (r.proxy) {
        proxy = r.proxy;
        try {
          return pack(await fetchLatestFromPypi(proxy), '（自动代理）');
        } catch (e) { errors.push('官方源（自动代理）：' + (e.message || e)); }
      }
    } catch (e) {}
  }

  // 镜像兜底：能连，但稳定版可能滞后，前端会显示 warning
  if (mirrorRes.status === 'fulfilled') return pack(mirrorRes.value, '');
  errors.push('镜像：' + ((mirrorRes.reason && mirrorRes.reason.message) || mirrorRes.reason));

  return {
    ok: false, current, ageDays,
    latest: '', hasUpdate: false,
    error: errors.join('；') || '无法连接更新服务器'
  };
}

/** 这台机器上真正在用的 Python（更新 pip 必须装到同一个解释器里） */
function pipPython() {
  if (PY_HAS_YTDLP) return PY_EXE;
  const venvPy = path.join(ROOT, 'runtime', 'venv', 'Scripts', 'python.exe');
  try { if (fs.existsSync(venvPy)) return venvPy; } catch (e) {}
  return '';
}

function envWithoutProxy() {
  const e = childEnv();
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
                   'http_proxy', 'https_proxy', 'all_proxy']) {
    delete e[k];
  }
  delete e.NO_PROXY;
  delete e.no_proxy;
  return e;
}

async function pipInstallYtdlp(target, { useProxy, useOfficial }) {
  const py = pipPython();
  if (!py) {
    return {
      code: -3, stdout: '', stderr: '没有可用的 pip 版 Python',
      sourceName: '无'
    };
  }
  const args = ['-m', 'pip', 'install', '--upgrade',
                '--disable-pip-version-check', '--no-input'];
  args.push(target ? `yt-dlp==${target}` : 'yt-dlp');
  args.push('bgutil-ytdlp-pot-provider');
  args.push('-i', useOfficial ? PYPI_INDEX : MIRROR_INDEX);
  const env = useProxy ? childEnv() : envWithoutProxy();
  const r = await runCapture(py, args, 420000, env);
  return Object.assign(r, {
    sourceName: (useOfficial ? '官方 PyPI' : '阿里云镜像') + (useProxy ? '（经代理）' : '')
  });
}

/**
 * 更新 yt-dlp。
 *
 * 关键点：
 *  1. 装到「程序实际调用的那个 Python」里（runtime/python 优先），
 *     否则更新完版本号还是旧的；
 *  2. 官方 PyPI 优先（镜像稳定版滞后，见顶部注释），失败再退镜像；
 *  3. 装完必须重新跑一次 `--version` 做**真实校验**，
 *     pip 退出码为 0 不代表版本真的变了。
 */
async function updateYtdlp(target) {
  const before = await currentYtdlpVersion();
  const attempts = [];
  const proxy = loadConfig().proxy || AUTO_PROXY || '';

  // 1) 官方 PyPI：有代理就带着代理；没代理也先试直连
  attempts.push(await pipInstallYtdlp(target, { useProxy: !!proxy, useOfficial: true }));

  const first = attempts[0];
  const firstOk = first.code === 0 && !/ERROR:|Could not find a version|No matching distribution/i.test(
    (first.stdout || '') + (first.stderr || ''));

  // 2) 官方失败 → 镜像兜底（镜像走直连，国内更快；不再带代理）
  if (!firstOk) {
    attempts.push(await pipInstallYtdlp(target, { useProxy: false, useOfficial: false }));
  }

  envCache.at = 0;
  updateCheckCache = { at: 0, data: null };   // 版本已变，下一次检查必须重新问源
  const after = await currentYtdlpVersion();

  const anyOk = attempts.some(a =>
    a.code === 0 && !/ERROR:|Could not find a version|No matching distribution/i
      .test((a.stdout || '') + (a.stderr || '')));
  const updated = !!after && after !== before;

  const output = attempts.map(a => {
    const body = ((a.stdout || '') + (a.stderr || '')).split(/\r?\n/).filter(Boolean);
    const tail = body.slice(-12).join('\n');
    return `── ${a.sourceName} ──\n` + (tail || (a.timeout ? '超时' : `退出码 ${a.code}`));
  }).join('\n');

  return {
    ok: !!after && (updated || anyOk),
    updated,
    previous: before,
    version: after || before,
    latest: target || '',
    source: attempts[attempts.length - 1].sourceName,
    output
  };
}

/**
 * 判断 yt-dlp 的报错是不是"换策略也没用"的错误。
 *
 * 分两类，共同点是**三种客户端策略会一模一样地失败**：
 *   ① 网络类：连不上代理/超时/DNS 失败；
 *   ② 内容类：链接格式不对、视频被删/私享/地区限制。
 * 再重试两轮只是把用户的等待时间乘三倍 —— 必须立刻停下来报错。
 */
function isFatalError(msg) {
  const s = String(msg || '');

  /*
   * 例外：PO Token 生成脚本相关的报错属于"工具链抖动"，不算致命。
   * 它是个会联网的 node 脚本，偶尔慢/超时，换一次策略重跑往往就好了。
   * 若把它也判成致命错误，就会因为一次抖动直接告诉用户「解析失败」。
   */
  if (/generate_once|bgutil|youtubepot/i.test(s)) return false;

  return /getaddrinfo|name resolution|unable to download webpage|unable to connect|connection refused|connection reset|connection aborted|timed out|timeout|proxy|tunnel|ssl|certificate|remote end closed|network is unreachable|no route to host|unsupported url|is not a valid url|incomplete youtube id|unavailable|not available|private video|members-only|ineligible/i.test(s);
}

/** 命中 YouTube 的「机器人验证 / 要求登录」风控 */
function isBotCheck(msg) {
  return /sign in to confirm|not a bot|confirm you.{0,3}re not a bot/i.test(String(msg || ''));
}

/**
 * 把 yt-dlp 的原始报错翻译成「人话 + 下一步该干什么」。
 *
 * yt-dlp 的报错非常技术化（比如那句 Sign in to confirm you're not a bot
 * 后面还跟着一串 GitHub 链接），直接丢给用户等于没说。
 * 这里只做「归类 + 给动作」，原始报错仍然保留在界面上供排查。
 */
function friendlyError(raw) {
  const s = String(raw || '');
  if (isBotCheck(s)) {
    return 'YouTube 要求登录验证（机器人风控）。\n'
      + '· **先到「设置」里点「更新 yt-dlp」** —— 版本旧最容易被这样拦\n'
      + '  （实测：7 月的版本必挂，升到 8 月版后同一条链接立刻正常）；\n'
      + '· 程序本身也会自动等待后重试几次，不用你手动点；\n'
      + '· 更新后仍反复失败，多半是代理出口 IP 被 Google 标记，换个节点；\n'
      + '· 最后手段：到「设置 → 从浏览器读取 cookies」选一个已登录 YouTube 的浏览器\n'
      + '  （Chrome / Edge 正在运行时可能读不到，需要先完全退出浏览器）。';
  }
  if (/\b403\b|forbidden/i.test(s)) {
    /*
     * 以前这里一口咬定「防 403 组件没生效」，让用户去查 pot-server 目录 ——
     * 2026-10-31 的现场证明这个引导是错的：令牌生成得好好的，是**客户端组合**
     * 让 YouTube 只给了单条受限流（web_safari/mweb 被强制 SABR）。
     * 现在的文案按真实原因给动作，顺序就是修复优先级。
     */
    return '取流被拒绝（403）：YouTube 只肯给一部分视频流，真去下载时被挡了。\n'
      + '程序已自动换成「交给 yt-dlp 自选客户端」重试过，仍失败的话这样处理：\n'
      + '· 到「设置 → YouTube 客户端组合」**清空**它（推荐，也是 403 的头号原因）：\n'
      + '  YouTube 会逐个客户端改限制，写死列表（如 tv,web_safari,mweb）迟早全部失效，\n'
      + '  tv 现在直接不可用，web_safari / mweb 被强制 SABR 没有直链；\n'
      + '· 换一个代理节点：出口 IP 被 Google 限制时表现完全一样；\n'
      + '· 到「设置」点「更新 yt-dlp」—— 版本旧了最容易取流失败。';
  }
  if (/unsupported url|is not a valid url|incomplete youtube id/i.test(s)) {
    return '链接格式不对：看起来不是有效的视频地址，请复制完整链接再试。';
  }
  if (/video unavailable|this video is unavailable|private video|members-only|ineligible|not available/i.test(s)) {
    return '这个视频当前不可下载：可能已被删除、设为私享、或限制地区 / 会员观看。';
  }
  if (/timed out|unable to download webpage|unable to connect|proxy|tunnel|getaddrinfo|connection/i.test(s)) {
    return '网络连不上 YouTube。\n'
      + '· 先确认代理软件在运行、节点是通的；\n'
      + '· 再到「设置 → 代理地址」点「自动探测」。';
  }
  return '';
}

// ---------------------------------------------------------------- 格式整理

function pickNum(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return null;
}

function slimFormat(f) {
  return {
    format_id: f.format_id,
    ext: f.ext,
    height: f.height || null,
    width: f.width || null,
    fps: f.fps || null,
    vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : null,
    acodec: f.acodec && f.acodec !== 'none' ? f.acodec : null,
    tbr: pickNum(f.tbr),
    vbr: pickNum(f.vbr),
    abr: pickNum(f.abr),
    asr: f.asr || null,
    audio_channels: f.audio_channels || null,
    filesize: pickNum(f.filesize, f.filesize_approx),
    filesize_exact: !!f.filesize,
    format_note: f.format_note || '',
    dynamic_range: f.dynamic_range || null,
    language: f.language || null,
    protocol: f.protocol || '',
    container: f.container || null
  };
}

function codecShort(v) {
  if (!v) return '';
  const s = String(v).toLowerCase();
  if (s.startsWith('avc') || s.startsWith('h264')) return 'H.264';
  if (s.startsWith('vp9') || s.startsWith('vp09')) return 'VP9';
  if (s.startsWith('av01') || s.startsWith('av1')) return 'AV1';
  if (s.startsWith('hev') || s.startsWith('h265')) return 'HEVC';
  if (s.startsWith('vp8')) return 'VP8';
  return String(v).split('.')[0].toUpperCase();
}

function codecRank(vcodec, preferHigh) {
  const c = codecShort(vcodec);
  if (preferHigh) {
    const order = { 'AV1': 0, 'VP9': 1, 'H.264': 2, 'HEVC': 3 };
    return order[c] !== undefined ? order[c] : 9;
  }
  const order = { 'H.264': 0, 'HEVC': 1, 'VP9': 2, 'AV1': 3 };
  return order[c] !== undefined ? order[c] : 9;
}

function buildFormatList(info) {
  const c = loadConfig();
  const raw = (info.formats || []).filter(f => f.ext !== 'mhtml' && !String(f.format_note || '').toLowerCase().includes('storyboard'));
  const all = raw.map(slimFormat);

  // 有音有画（可直接播）
  const progressive = all.filter(f => f.vcodec && f.acodec);
  // 仅画面
  const videoOnly = all.filter(f => f.vcodec && !f.acodec);
  // 仅音频
  const audioOnly = all.filter(f => !f.vcodec && f.acodec);

  // 按分辨率分组（视频）
  const byHeight = new Map();
  const groupVideo = (arr) => {
    for (const f of arr) {
      const key = f.height || 0;
      if (!byHeight.has(key)) byHeight.set(key, []);
      byHeight.get(key).push(f);
    }
  };
  groupVideo(videoOnly);
  groupVideo(progressive);

  const groups = [];
  for (const [height, list] of byHeight.entries()) {
    list.sort((a, b) => {
      const r = codecRank(a.vcodec, c.preferHighQuality) - codecRank(b.vcodec, c.preferHighQuality);
      if (r !== 0) return r;
      return (b.tbr || 0) - (a.tbr || 0);
    });
    const hasAudio = list.some(f => f.acodec);
    const fpsMax = Math.max(...list.map(f => f.fps || 0));
    const hdr = list.some(f => f.dynamic_range && f.dynamic_range !== 'SDR');
    groups.push({ height, fpsMax, hasAudio, hdr, formats: list });
  }
  groups.sort((a, b) => b.height - a.height);
  // 每个高度组：拆出"含音轨"与"仅画面"两个标签
  for (const g of groups) {
    g.withAudio = g.formats.filter(f => f.acodec);
    g.videoOnly = g.formats.filter(f => !f.acodec);
  }

  audioOnly.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

  return { groups, audioOnly };
}

// ---------------------------------------------------------------- 任务

const tasks = new Map();
const taskOrder = [];
const queue = [];
let running = 0;
const sseClients = new Set();

function broadcast(type, payload) {
  const msg = `data: ${JSON.stringify({ type, payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (e) {}
  }
}

function publicTask(t) {
  return {
    id: t.id,
    url: t.url,
    title: t.title,
    uploader: t.uploader,
    thumbnail: t.thumbnail,
    qualityLabel: t.qualityLabel,
    kind: t.kind,
    formatSelector: t.formatSelector,
    wantThumbnail: t.wantThumbnail,
    thumbnailPath: t.thumbnailPath,
    status: t.status,
    stage: t.stage,
    percent: t.percent,
    speed: t.speed,
    eta: t.eta,
    downloaded: t.downloaded,
    total: t.total,
    filepath: t.filepath,
    error: t.error,
    errorHint: t.errorHint || '',
    botRetries: t.botRetries || 0,
    forbiddenRetries: t.forbiddenRetries || 0,
    createdAt: t.createdAt,
    finishedAt: t.finishedAt,
    logTail: t.logs.slice(-40)
  };
}

function pushTask(t, force) {
  const now = Date.now();
  if (!force && t._lastPush && now - t._lastPush < 400) return;
  t._lastPush = now;
  broadcast('task-update', publicTask(t));
}

function createTask(opts) {
  const id = crypto.randomBytes(6).toString('hex');
  const t = {
    id,
    url: opts.url,
    title: opts.title || opts.url,
    uploader: opts.uploader || '',
    thumbnail: opts.thumbnail || '',
    qualityLabel: opts.qualityLabel || '',
    kind: opts.kind || 'video',
    formatSelector: opts.formatSelector || 'bv*+ba/b',
    // 封面：wantThumbnail=null 表示跟随全局设置，true/false 表示本次下载单独指定
    wantThumbnail: typeof opts.wantThumbnail === 'boolean' ? opts.wantThumbnail : null,
    thumbnailPath: '',
    status: 'queued',
    stage: '排队中',
    percent: 0,
    speed: null,
    eta: null,
    downloaded: 0,
    total: 0,
    filepath: '',
    error: '',
    createdAt: Date.now(),
    finishedAt: 0,
    proc: null,
    canceled: false,
    logs: []
  };
  tasks.set(id, t);
  taskOrder.push(id);
  broadcast('task-add', publicTask(t));
  queue.push(t);
  pump();
  return t;
}

function pump() {
  const c = loadConfig();
  const max = Math.max(1, Number(c.concurrency) || 2);
  while (running < max && queue.length) {
    const t = queue.shift();
    if (t.canceled) continue;
    startTask(t);
  }
}

const HUMAN = { percent: null };

function parseSize(str) {
  if (!str) return 0;
  const m = String(str).match(/([\d.]+)\s*([KMGT]?)i?B/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toUpperCase();
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit] || 1;
  return Math.round(n * mult);
}

function fmtOf(t) {
  return t;
}

function handleLine(t, line) {
  if (!line) return;
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (clean.trim()) {
    t.logs.push(clean);
    if (t.logs.length > 400) t.logs.splice(0, t.logs.length - 400);
  }

  // 1) 进度模板
  if (clean.startsWith('DL:')) {
    const parts = clean.slice(3).split('|');
    const status = parts[0];
    const dl = parseFloat(parts[1]);
    const tot = parseFloat(parts[2]);
    const totEst = parseFloat(parts[3]);
    const spd = parseFloat(parts[4]);
    const eta = parseFloat(parts[5]);
    const total = isFinite(tot) && tot > 0 ? tot : (isFinite(totEst) && totEst > 0 ? totEst : 0);
    if (isFinite(dl) && dl >= 0) t.downloaded = dl;
    if (total > 0) t.total = total;
    if (total > 0 && isFinite(dl)) t.percent = Math.min(99.9, (dl / total) * 100);
    if (isFinite(spd) && spd > 0) t.speed = spd;
    if (isFinite(eta) && eta >= 0) t.eta = eta;
    if (status === 'finished') { t.percent = 100; }
    t.stage = '下载中';
    pushTask(t);
    return;
  }

  // 2) 标准进度行（回退）
  let m = clean.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[KMGT]?i?B)(?:\s+at\s+([\d.]+\s*[KMGT]?i?B\/s|Unknown B\/s))?(?:\s+ETA\s+([\d:]+|Unknown))?/i);
  if (m) {
    t.percent = Math.min(99.9, parseFloat(m[1]));
    t.total = parseSize(m[2]);
    if (m[3] && !/unknown/i.test(m[3])) t.speed = parseSize(m[3]);
    if (m[4] && m[4] !== 'Unknown') {
      const seg = m[4].split(':').map(Number);
      t.eta = seg.length === 3 ? seg[0] * 3600 + seg[1] * 60 + seg[2] : seg[0] * 60 + (seg[1] || 0);
    }
    t.stage = '下载中';
    pushTask(t);
    return;
  }

  // 3) 已下载过
  if (/has already been downloaded/i.test(clean)) {
    t.percent = 100; t.stage = '已存在，跳过'; pushTask(t); return;
  }

  // 4) 合并 / 转码阶段
  if (/^\[Merger\]/.test(clean) || /^\[VideoConvertor\]/.test(clean) || /^\[ExtractAudio\]/.test(clean) || /^\[Fixup/.test(clean) || /^\[EmbedThumbnail\]/.test(clean) || /^\[Metadata\]/.test(clean) || /^\[SubtitlesConvertor\]/.test(clean)) {
    t.stage = '合并处理中…';
    t.percent = Math.max(t.percent, 99);
    const mm = clean.match(/into "(.+)"\s*$/);
    if (mm) t.filepath = mm[1];
    pushTask(t, true);
    return;
  }

  // 5) 目标文件
  if (clean.startsWith('[download] Destination:')) {
    t.filepath = clean.replace('[download] Destination:', '').trim();
    return;
  }
  if (/^\[download\]\s+(.+)\s+has already been downloaded/i.test(clean)) {
    const mm = clean.match(/^\[download\]\s+(.+)\s+has already been downloaded/i);
    if (mm) t.filepath = mm[1];
    return;
  }

  // 6) 错误
  if (/^ERROR:/.test(clean)) {
    let msg = clean.replace(/^ERROR:\s*/, '');
    if (/HTTP Error 403|403: Forbidden/i.test(msg)) {
      msg += '\n\n┌─ 403 常见原因 ─────────────\n'
        + '│ 1. 当前网络无法正常访问 YouTube 视频流\n'
        + '│    → 在「设置」里填入代理，再点「测试网络连通」\n'
        + '│ 2. 触发了 YouTube 风控（需要登录态）\n'
        + '│    → 在「设置 → 高级选项」里选择浏览器登录信息\n'
        + '│ 3. yt-dlp 版本过旧\n'
        + '│    → 点「更新 yt-dlp」\n'
        + '└────────────────────────────';
    }
    t.error = msg;
    return;
  }
}

const MEDIA_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.ts',
  '.mp3', '.m4a', '.opus', '.flac', '.wav', '.aac', '.ogg']);

/**
 * 兜底：扫描下载目录，找出本次任务刚产生的成品文件。
 * 用途：yt-dlp 偶尔会因为「清理临时文件失败」「后处理警告」等原因返回非 0 退出码，
 * 但成品其实已经完整落地。此时若判为失败会误报，故用文件时间与命名规则反查。
 */
function findProducedFile(t) {
  const c = loadConfig();
  let best = null, bestTime = 0;
  let names;
  try { names = fs.readdirSync(c.downloadDir); } catch (e) { return null; }
  for (const name of names) {
    const full = path.join(c.downloadDir, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (st.mtimeMs < t.createdAt - 120000) continue;          // 明显早于本任务的忽略
    const ext = path.extname(name).toLowerCase();
    if (!MEDIA_EXT.has(ext)) continue;
    /*
     * 排除 yt-dlp 的中间分流文件，形如 `标题 [id].f160.mp4` / `标题 [id].f140-19.m4a`。
     * 注意格式 id 里可能带 `-`/`_`/`+`（实测遇到过 `f140-19`），
     * 只匹配纯数字的写法会漏掉，导致把音频分流误当成成品上报给用户。
     */
    if (/\.f[0-9A-Za-z_+\-]+\.[A-Za-z0-9]+$/.test(name)) continue;
    if (/\.part$/i.test(name)) continue;
    if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = full; }
  }
  return best;
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * 找出本次任务刚下载的封面文件。
 * 命名规则：与成品视频同名，扩展名换成图片格式（yt-dlp 的 --write-thumbnail 行为）。
 * 优先用成品文件的 basename 精确匹配；匹配不到再退化为「按时间找最新的图片」。
 */
function findProducedThumbnail(t) {
  const c = loadConfig();
  let names;
  try { names = fs.readdirSync(c.downloadDir); } catch (e) { return ''; }

  const cand = [];
  for (const name of names) {
    const full = path.join(c.downloadDir, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (st.mtimeMs < t.createdAt - 120000) continue;
    if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) continue;
    cand.push({ full, name, mtime: st.mtimeMs });
  }
  if (!cand.length) return '';

  // 1) 与成品视频同名（换扩展名）的优先
  if (t.filepath) {
    const base = path.basename(t.filepath, path.extname(t.filepath));
    const hit = cand.find(x => path.basename(x.name, path.extname(x.name)) === base);
    if (hit) return hit.full;
  }
  // 2) 退化：取最新的一个
  cand.sort((a, b) => b.mtime - a.mtime);
  return cand[0].full;
}

function buildArgs(t) {
  const c = loadConfig();
  const args = [
    '--newline',
    '--no-colors',
    '--progress',
    '--progress-template',
    'download:DL:%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--ffmpeg-location', BIN_DIR,
    '--paths', c.downloadDir,
    '--output', c.filenameTemplate,
    '--retries', '10',
    '--fragment-retries', '10',
    '--socket-timeout', '20',
    '--no-mtime',
    '--windows-filenames',
    '--no-simulate'
  ];

  args.push(...jsRuntimeArgs());
  /*
   * 客户端：支持任务级覆盖。
   * 用途：命中 YouTube「机器人验证」时换一套客户端再试 —— 风控常常是按客户端/会话判的。
   */
  if (t.noClientArgs) {
    /*
     * 任务级「彻底不声明客户端」。
     * 取流 403 重试时会用到：设置里若留着某个旧的自定义组合，光靠 clientOverride=''
     * 是清不掉的（空串会被当成"没设"而回落到设置值），必须有一个显式开关。
     */
  } else if (t.clientOverride) {
    args.push('--extractor-args', 'youtube:player_client=' + t.clientOverride);
  } else {
    args.push(...clientArgs());
  }
  /*
   * PO Token：script 模式是纯本地判定（看脚本在不在），所以这里同步判断即可；
   * 只有退到 HTTP 模式时才依赖 POT_AVAILABLE（由 getEnv 探测写入）。
   * 之前只写 `if (POT_AVAILABLE)`，而该值可能还是 null（从未探测过）→ 参数被丢掉。
   */
  if (potScriptReady() || POT_AVAILABLE) args.push(...potArgs());

  if (!c.allowPlaylist) args.push('--no-playlist');
  /*
   * 代理：用户配置优先；没配置就用解析阶段自动探测到的那个。
   * 否则会出现「解析能用（自动走了代理）但下载卡死」的怪现象 ——
   * 因为下载这里是另一条独立路径，必须同样带上。
   */
  const useProxy = c.proxy || AUTO_PROXY;
  if (useProxy) args.push('--proxy', useProxy);
  if (c.rateLimit) args.push('--limit-rate', c.rateLimit);
  // cookies：任务级覆盖优先（风控重试时会用它换一种身份再试）
  const cookieBrowser = (t.cookieOverride !== undefined) ? t.cookieOverride : c.cookiesFromBrowser;
  if (cookieBrowser) args.push('--cookies-from-browser', cookieBrowser);
  if (c.embedMetadata) args.push('--embed-metadata');

  /*
   * 封面下载。
   *  - 任务级开关优先：t.wantThumbnail 为 true/false 时覆盖全局设置，null 则跟随全局。
   *  - `--convert-thumbnails jpg` 很关键：YouTube 现在多数封面是 .webp，
   *    很多看图软件/剪辑软件不认，统一转成 jpg 才通用。转换用的是 YT-DLP 自带的
   *    thumbnail 转换器（纯 JS，不需要 ffmpeg，属可选依赖模块）。
   *  - 音频转 mp3 的分支里如果嵌封面，也必须先把封面转好，否则 --embed-thumbnail 会失败。
   */
  const wantThumb = (t.wantThumbnail === null || t.wantThumbnail === undefined)
    ? !!c.writeThumbnail
    : !!t.wantThumbnail;
  if (wantThumb) {
    args.push('--write-thumbnail');
    args.push('--convert-thumbnails', 'jpg');
  }
  if (c.embedThumbnail) {
    // 嵌入封面也需要封面文件存在，且必须是可嵌入的格式
    if (!wantThumb) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
    args.push('--embed-thumbnail');
  }
  if (c.writeSubtitles) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', c.subtitleLangs || 'zh-Hans,zh-CN,zh,en', '--convert-subs', 'srt');
  }

  const sel = String(t.formatSelector || 'bv*+ba/b');
  const heightMatch = sel.match(/HEIGHT:(\d+)/);
  if (heightMatch) {
    const H = heightMatch[1];
    const wantAudio = sel.includes('AUDIO');
    const prefH264 = !c.preferHighQuality;
    const sortParts = [`res:${H}`];
    if (prefH264) sortParts.push('vcodec:h264');
    /*
     * 「原声优先」——2026-10-27 音轨串台 Bug 的修复，勿删。
     *
     * 现象：成品画面是原片，声音却是别的语言（如乌克兰语配音）。
     * 根因：YouTube 现在会为视频下发几十条「自动配音」音轨（ar/uk/ja/...），
     *      配音轨码率和原声轨几乎一样（实测原声 129.476k、uk 配音 129.477k）。
     *      而 yt-dlp 的排序会把用户 -S 给的字段排在默认排序（含 lang）之前，
     *      所以旧代码 `-S ...,acodec:aac,br` 里 br 先做决定 → 稳定挑中码率
     *      最高的那条配音轨（差别只有 1bps，但足以恒定选中它）。
     *
     * 修法：把 yt-dlp 的 `lang` 排序键放到 acodec/br 之前。
     *      `lang` 映射到 format.language_preference，YouTube 提取器的取值是
     *      原声 10 / 默认轨 5 / 普通配音 -1 / 描述性配音 -10（见
     *      yt_dlp/extractor/youtube/_video.py 的 get_language_code_and_preference），
     *      与具体语种无关，不用写死 en，任何语种的源视频都优先取原声。
     */
    sortParts.push('lang', 'acodec:aac', 'br');
    /*
     * 视频那一半必须用 `bv`（纯视频格式），不能用 `bv*`——这是音轨串台的第二个坑：
     * YouTube 那条 360p 合流格式 `18` 自带一条**自动配音**音轨（实测 language='ar'，
     * 即阿拉伯语配音），它的 tbr(427) 远高于同分辨率的纯视频格式，一旦 `-S` 里出现
     * br/tbr 类排序键，`bv*` 就会把这条合流选成"最佳视频"，配音音轨随画面一起进来，
     * 再合并原声音轨也没用（成品是 double audio / 或者干脆只剩配音）。
     * 用 `bv` 彻底排除合流格式；老视频只有合流时由末尾的 `b[height<=H]` 兜底。
     */
    if (wantAudio) {
      /*
       * 双保险：格式选择器里直接只保留「原声/默认」音频轨（language_preference>0），
       * 万一 YouTube 没给原声打标（老视频、单音轨视频），再退回原来的选择器。
       * 只取音轨（wantAudio=false）的纯视频下载不受影响。
       */
      args.push('-f', `bv[height<=${H}]+ba[language_preference>0]/bv[height<=${H}]+ba/b[height<=${H}]`);
    } else {
      args.push('-f', `bv[height<=${H}]/b[height<=${H}]`);
    }
    args.push('-S', sortParts.join(','));
    if (wantAudio) args.push('--merge-output-format', c.mergeContainer === 'mkv' ? 'mkv' : 'mp4');
  } else if (sel === 'AUDIO-MP3' || sel === 'AUDIO-NATIVE') {
    // 纯音频下载同样只取原声轨（同上：language_preference>0 才是原声/默认轨，
    // 配音轨是 -1；默认排序虽然也看 lang，但显式过滤可避免版本差异带来的不确定）
    args.push('-f', 'ba[language_preference>0]/ba/b');
    if (sel === 'AUDIO-MP3') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    // 封面参数已在上面统一处理，这里不再重复添加
  } else {
    // 原始选择器
    if (!/^[0-9A-Za-z_\-\+\.\[\]=<>:,\/ ]+$/.test(sel)) {
      args.push('-f', 'bv*+ba/b');
    } else {
      args.push('-f', sel);
      if (sel.includes('+')) args.push('--merge-output-format', c.mergeContainer === 'mkv' ? 'mkv' : 'mp4');
    }
  }

  args.push('--print', 'after_move:FILEPATH:%(filepath)s');
  args.push(t.url);
  return args;
}

async function startTask(t) {
  running++;
  t.status = 'running';
  t.stage = '启动中';
  // 重跑时清掉上一轮的报错与提示，否则重试成功后会残留旧提示
  t.error = '';
  t.errorHint = '';
  pushTask(t, true);

  /*
   * 下载路径必须自己保证代理可用，不能依赖"解析先跑过"。
   *
   * AUTO_PROXY 原本只在解析（probeVideo）里才会被探测出来；
   * 如果用户直接建任务、或解析之后重启过服务，它就是空的 →
   * buildArgs 不带 --proxy → 裸连 YouTube → 一路等到超时（实测拖了 162 秒）。
   * 这里补一次体检，顺带在真的不可达时快速失败，别让任务空转。
   */
  const cfg0 = loadConfig();
  if (!cfg0.proxy && !AUTO_PROXY) {
    t.stage = '检查网络';
    pushTask(t, true);
    const net = await resolveProxy().catch(() => null);
    if (net && net.unreachable) {
      running--;
      t.status = 'error';
      t.stage = '失败';
      t.error = '网络无法访问 YouTube：直连被阻断，也没找到可用的本机代理。\n'
        + '请先启动代理软件（Clash / v2rayN 等）并确认节点连通，\n'
        + '再到「设置 → 代理地址」点「自动探测」选一个填入。';
      t.finishedAt = Date.now();
      pushTask(t, true);
      broadcast('task-done', publicTask(t));
      pump();
      return;
    }
  }

  const args = buildArgs(t);
  t.logs.push('> yt-dlp ' + args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
  broadcast('task-log', { id: t.id, line: t.logs[t.logs.length - 1] });

  let child;
  try {
    child = spawn(YTDLP, [...YTDLP_PREFIX, ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: childEnv()
    });
  } catch (e) {
    running--;
    t.status = 'error';
    t.error = '无法启动 yt-dlp：' + (e && e.message);
    t.finishedAt = Date.now();
    pushTask(t, true);
    pump();
    return;
  }
  t.proc = child;

  let buf = '';
  const onData = d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      handleLine(t, line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', e => {
    t.error = String(e && e.message || e);
  });

  child.on('close', code => {
    if (buf.trim()) handleLine(t, buf.trim());
    running--;
    t.proc = null;
    t.finishedAt = Date.now();
    const produced = findProducedFile(t);

    if (t.canceled) {
      t.status = 'canceled';
      t.stage = '已取消';
    } else if (code === 0) {
      t.status = 'done';
      t.stage = '已完成';
      t.percent = 100;
      if (produced) t.filepath = produced;
    } else if (produced) {
      // 成品已落地，只是 yt-dlp 收尾时出了问题（清理临时文件失败、元数据写入警告等）
      t.status = 'done';
      t.stage = '已完成（收尾时有过警告，不影响播放）';
      t.percent = 100;
      t.filepath = produced;
      t.error = '';
    } else {
      t.status = 'error';
      t.stage = '失败';
      if (!t.error) {
        const errLine = t.logs.slice().reverse().find(l => /^ERROR:/.test(l));
        t.error = errLine ? errLine.replace(/^ERROR:\s*/, '') : `yt-dlp 退出码 ${code}`;
      }

      /*
       * ① YouTube 的「机器人验证」= 间歇性风控，不能直接判死。
       *
       * 实测（2026-10-16）：同一条链接、同一套参数，
       * 20 分钟前所有客户端组合全部报「Sign in to confirm you're not a bot」，
       * 20 分钟后再跑全部成功 —— 典型的按 IP / 会话做的临时风控。
       * 所以退避等待后自动重试，并顺手换一套客户端身份，命中概率更高。
       */
      if (isBotCheck(t.error) && (t.botRetries || 0) < 2) {
        t.botRetries = (t.botRetries || 0) + 1;
        const waitMs = t.botRetries === 1 ? 30000 : 75000;
        t.clientOverride = t.botRetries === 1 ? 'default' : 'tv_embedded,web_embedded';
        const secs = Math.round(waitMs / 1000);
        const msg = `[重试] 命中 YouTube 机器人验证（间歇性风控），已换客户端，${secs} 秒后自动重试（第 ${t.botRetries} 次）`;
        t.logs.push(msg);
        broadcast('task-log', { id: t.id, line: msg });
        t.status = 'queued';
        t.stage = `等待自动重试（YouTube 风控，约 ${secs} 秒）`;
        t.error = '';
        pushTask(t, true);
        setTimeout(() => { if (!t.canceled) startTask(t); }, waitMs);
        pump();
        return;
      }

      /*
       * ② 取流被拒绝（403）。
       *
       * 症状（2026-10-31 现场）：解析一切正常、1080p 也列得出来，
       * 下载开始几十秒、到 20 MB 左右突然 "HTTP Error 403"；
       * 也有人一开始连就 403（establish_connection 阶段）。
       *
       * 根因是**客户端组合与 PO Token 对不上**，而不是"防 403 组件没装好"。
       * 实测同一条视频：
       *   player_client=tv,web_safari,mweb → 取流 403（tv 已 UNPLAYABLE，
       *                                      web_safari/mweb 被强制 SABR）
       *   不声明客户端                     → 1080p60 H.264 418 MB 完整下完
       * 所以重试的动作就是「把客户端声明清掉」；重跑会重新解析、重新生成令牌。
       */
      // 失败现场的日志尾巴（剔掉命令行那一行，否则会误命中 youtubepot 关键字）
      const errTail = t.logs.filter(l => !l.startsWith('> yt-dlp')).slice(-8).join(' ');
      const forbidden = /\b403\b|forbidden|unable to download video data/i
        .test((t.error || '') + ' ' + errTail);
      if (forbidden && (t.forbiddenRetries || 0) < 2) {
        t.forbiddenRetries = (t.forbiddenRetries || 0) + 1;
        const n = t.forbiddenRetries;
        t.noClientArgs = true;        // 关键：连设置里的组合也一并忽略
        t.clientOverride = '';
        const waitMs = n === 1 ? 2000 : 8000;
        const msg = n === 1
          ? '[重试] 取流被拒（403）：多半是设置里的客户端组合已被 YouTube 限制，'
            + '改用 yt-dlp 自选客户端，2 秒后重试…'
          : '[重试] 仍然 403：按纯网络抖动处理，等待 8 秒后重跑最后一次…';
        t.logs.push(msg);
        broadcast('task-log', { id: t.id, line: msg });
        t.status = 'queued';
        t.stage = n === 1 ? '等待重试（已换用 yt-dlp 自选客户端）' : '等待重试（网络抖动兜底）';
        t.error = '';
        pushTask(t, true);
        setTimeout(() => { if (!t.canceled) startTask(t); }, waitMs);
        pump();
        return;
      }

      /*
       * ③ PO Token 生成脚本偶发超时 → 整条下载跟着失败。
       *
       * 实测原因：script 模式每跑一次 yt-dlp 都要冷启动一个 node 进程去执行
       * generate_once.js。如果那堆 node_modules 恰好是"冷"的
       * （首次读取、或杀毒软件在扫描），启动耗时会超过插件写死的 15 秒上限。
       * 这种失败纯粹是抖动，重跑一次基本必成 —— 所以自动重试。
       * （解析那条路本来就有多策略重试兜着，这里补上才对称。）
       *
       * ⚠ 判定用的 errTail 已经剔掉了命令行那一行：t.logs 第一条是整条 yt-dlp 命令，
       * 里面必然带 youtubepot-bgutilscript:server_home=...。若失败来得很快
       * （进度行还没把命令行挤出日志尾巴），直接匹配 /youtubepot/ 会**永远命中** ——
       * 任何失败都被当成「防 403 组件抖动」白重试两次，还附上错误的解释。
       * 2026-10-31 那次 403 就是被这个误导的。
       */
      const potFlaky = /generate_once|bgutil|youtubepot|Failed to check script version/i
        .test((t.error || '') + ' ' + errTail);
      if (potFlaky && (t.retries || 0) < 2) {
        t.retries = (t.retries || 0) + 1;
        const msg = `[重试] 防 403 组件启动超时（属抖动），自动重跑第 ${t.retries} 次…`;
        t.logs.push(msg);
        broadcast('task-log', { id: t.id, line: msg });
        t.status = 'queued';
        t.stage = '等待自动重试（防 403 组件抖动）';
        setTimeout(() => { if (!t.canceled) startTask(t); }, 1500);
        pushTask(t, true);
        pump();
        return;
      }

      // ④ 重试用尽 → 除了原始报错，再给一段「人话 + 怎么办」
      const hint = friendlyError(t.error);
      if (hint) t.errorHint = hint;
    }

    // 成功的任务顺手定位封面文件，供界面提供「打开封面」入口
    if (t.status === 'done') {
      const thumb = findProducedThumbnail(t);
      if (thumb) {
        t.thumbnailPath = thumb;
        t.logs.push('[封面] ' + thumb);
      }
    }

    pushTask(t, true);
    broadcast('task-done', publicTask(t));
    pump();
  });
}

// ---------------------------------------------------------------- 解析视频

const probing = new Map();

/**
 * 判断一次解析结果是否「被降级」。
 *
 * 症状：界面上只剩 1 个档位 / 1 个编码，最高 360p（就是那条 format 18 合并流）。
 * 成因：YouTube 在拿不到有效 PO Token（或客户端组合不被接受）时，
 *       会退回「受限格式列表」——只给一条 360p 有音有画的单流。
 *
 * 判定依据：**一个"纯视频"分离流都没拿到**，且最高的档位不超过 360p。
 * 正常视频哪怕只有 360p，也会同时给出 DASH 的 360p 纯视频流。
 */
function assessQuality(info, groups) {
  const fmts = info.formats || [];
  const videoOnly = fmts.filter(f =>
    f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
  const heights = groups.map(g => g.height || 0);
  const maxH = heights.length ? Math.max(...heights) : 0;
  const videoCount = groups.reduce((a, g) => a + g.formats.filter(f => f.vcodec).length, 0);
  const degraded = videoOnly.length === 0 && maxH > 0 && maxH <= 360;
  return { degraded, maxH, videoCount, videoOnlyCount: videoOnly.length };
}

/** 跑一次解析，返回原始 info + 分档结果 */
async function probeOnce(rawUrl, opts) {
  const c = loadConfig();
  const args = [
    '-J', '--no-warnings', '--no-playlist',
    '--ffmpeg-location', BIN_DIR,
    '--socket-timeout', '10',
    '--retries', '2'
  ];
  args.push(...jsRuntimeArgs());

  // 客户端策略：要么用配置值，要么显式指定，要么完全交给 yt-dlp 自己挑
  if (opts.clientOverride) {
    args.push('--extractor-args', 'youtube:player_client=' + opts.clientOverride);
  } else if (!opts.noClientArgs) {
    args.push(...clientArgs());
  }

  if (opts.withPot !== false) args.push(...await potArgList());

  // 代理：本次体检的结果优先（可能是自动探测出来的），其次才是配置
  const px = (opts.proxy !== undefined) ? opts.proxy : (c.proxy || AUTO_PROXY);
  if (px) args.push('--proxy', px);

  if (c.cookiesFromBrowser) args.push('--cookies-from-browser', c.cookiesFromBrowser);
  args.push(rawUrl);

  const r = await runYtdlp(args, opts.timeout || 90000);

  if (r.timeout) {
    const e = new Error('解析超时：连不上 YouTube。多半是没配代理、或代理软件没在运行。');
    e.fatal = true;                       // 换客户端策略也一样连不上，别重试
    throw e;
  }
  if (r.code !== 0 || !r.stdout.trim()) {
    const msg = (r.stderr || '').split(/\r?\n/).filter(l => /^ERROR/i.test(l)).join(' ');
    const clean = msg ? msg.replace(/^ERROR:\s*/i, '') : '';
    const e = new Error(clean || '解析失败，请检查链接是否正确、网络是否可达。');
    e.fatal = isFatalError(clean || (r.stderr || ''));
    throw e;
  }

  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error('解析返回内容异常，无法读取视频信息。');
  }

  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const first = (info.entries || []).filter(Boolean)[0];
    if (!first) throw new Error('这是播放列表，但其中没有可下载的视频。');
    info = first;
    info._isPlaylistItem = true;
  }

  const { groups, audioOnly } = buildFormatList(info);
  return { info, groups, audioOnly };
}

async function probeVideo(rawUrl) {
  await getEnv();                              // 确保 JS 运行时能力已探测
  await ensurePotService().catch(() => {});    // 防 403 能力就绪（缺了就自动拉起）

  /*
   * 先做一次「网络体检」—— 这是本次修复的关键。
   *
   * 国内直连 YouTube 是黑洞：连接既不拒绝也不返回，yt-dlp 只能干等到超时。
   * 以前没有任何前置检查，用户看到的就是「解析半天出不来」；
   * 而下面是三种策略依次重试，等待时间还要再乘三倍。
   *
   * 体检只需几百毫秒~3 秒：
   *   直连通 → 直连；直连不通但本机有代理 → 自动用上；都不行 → 立刻报错。
   */
  const net = await resolveProxy();
  if (net.unreachable) {
    const extra = (net.candidates && net.candidates.length)
      ? `检测到本机这些端口在监听：${net.candidates.join(', ')}，但都穿不出去。`
      : '本机没有检测到正在运行的代理软件。';
    const err = new Error('网络无法访问 YouTube：直连被阻断，也没有可用的本机代理。\n'
      + '请先启动代理软件（Clash / v2rayN 等）并确认节点连通，\n'
      + '再到「设置 → 代理地址」点「自动探测」选一个填入。\n' + extra);
    err.fatal = true;
    throw err;
  }

  /**
   * 多策略解析。
   *
   * 为什么需要：YouTube 偶尔会对某个客户端组合返回受限格式列表（只剩 360p），
   * 或者令牌/JS 挑战瞬时失败。每次尝试都是**全新的 yt-dlp 进程**，
   * 换一套客户端策略往往立刻恢复正常 —— 比让用户自己反复点「解析」靠谱得多。
   *
   * 2026-10-31 调整：原来第三档是「去掉 mweb 客户端」（clientOverride: 'tv,web_safari'）。
   * 这一档现在只会稳定失败 —— tv 对该类视频直接 UNPLAYABLE，web_safari 被强制 SABR
   * 没有可用 URL —— 白白多等一分钟，因此在设置里没填客户端时不再保留它。
   * 设置里填了自定义组合的用户，第一档仍按他们的值来，第二档负责兜底。
   */
  const cfgClient = String(loadConfig().playerClient || '').trim();
  const strategies = [];
  if (cfgClient) {
    strategies.push({ note: '按设置里的客户端组合（' + cfgClient + '）', timeout: 90000 });
  }
  strategies.push({ note: '交给 yt-dlp 自选客户端', noClientArgs: true, timeout: 60000 });

  /*
   * 总时间预算：无论怎么重试，整个解析不超过这个时长。
   * 免得"重试"本身变成新的等待地狱。
   */
  const BUDGET_MS = 150000;
  const t0 = Date.now();

  let best = null;
  let firstErr = null;
  let tried = 0;

  /*
   * 最多跑两轮：第一轮立刻试；若全部命中「机器人验证」（间歇性风控），
   * 等 20 秒再试一轮。
   *
   * 实测风控窗口常常几分钟就过去，而解析往往是用户的第一步 ——
   * 直接甩个失败，用户只会以为程序坏了。程序自己等一下更省事。
   */
  for (let round = 0; round < 2; round++) {
    let sawBotCheck = false;

    for (const st of strategies) {
      if (Date.now() - t0 > BUDGET_MS) {
        console.log('[解析] 已超出时间预算，停止重试');
        break;
      }
      tried++;
      let got;
      try {
        got = await probeOnce(rawUrl, Object.assign({ withPot: true, proxy: net.proxy }, st));
      } catch (e) {
        if (!firstErr) firstErr = e;
        if (isBotCheck(e.message)) sawBotCheck = true;
        console.log(`[解析] 「${st.note}」失败：${e.message}`);
        if (e.fatal) {
          // 网络类错误：换个客户端策略也一样连不上，立刻停，别让用户白等
          console.log('[解析] 属网络类错误，换策略也无济于事，停止重试');
          break;
        }
        continue;
      }
      const q = assessQuality(got.info, got.groups);
      console.log(`[解析] 「${st.note}」→ ${q.maxH}p / ${q.videoCount} 个视频格式`
        + `${q.degraded ? '（降级）' : ''}`);

      if (!best) {
        best = { got, q, note: st.note };
      } else {
        const better =
          (best.q.degraded && !q.degraded) ||
          (best.q.degraded === q.degraded && q.maxH > best.q.maxH) ||
          (best.q.degraded === q.degraded && q.maxH === best.q.maxH &&
           q.videoCount > best.q.videoCount);
        if (better) best = { got, q, note: st.note };
      }
      if (!q.degraded) break;                  // 拿到完整列表，不必再试
    }

    if (best) break;                           // 已经有结果了
    if (!sawBotCheck) break;                   // 不是风控，再试也没意义
    if (round === 0 && (BUDGET_MS - (Date.now() - t0)) > 40000) {
      console.log('[解析] 全部命中机器人验证（间歇性风控），等 20 秒后再试一轮');
      await sleep(20000);
    } else {
      break;
    }
  }

  if (!best) throw (firstErr || new Error('解析失败，请检查链接是否正确、网络是否可达。'));

  const { info, groups, audioOnly } = best.got;
  const degraded = best.q.degraded;

  return {
    id: info.id,
    title: info.title,
    uploader: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : ''),
    uploadDate: info.upload_date || '',
    viewCount: info.view_count || 0,
    description: (info.description || '').slice(0, 500),
    webpage_url: info.webpage_url || rawUrl,
    isLive: !!(info.is_live),
    groups,
    audioOnly: audioOnly.slice(0, 30),
    bestHeight: groups.length ? Math.max(...groups.map(g => g.height)) : 0,
    // 降级信息：交给前端给出「可操作」的提示，而不是让用户以为视频本身就只有 360p
    degraded,
    degradedReason: degraded
      ? 'YouTube 只返回了受限格式列表（一条 360p 合并流），说明防 403 的令牌没生效。'
      : '',
    attempts: tried,
    attemptNote: best.note
  };
}

// ---------------------------------------------------------------- 打开文件夹

/**
 * 在资源管理器中打开目录（可选选中某个文件）。
 *
 * 为什么不能只写 `spawn('explorer.exe', [dir])`：
 *  explorer.exe 在以下情况会**静默失败**（退出码 1，什么都不弹）——
 *   - 路径经 spawn 数组传递时对中文/空格的处理不稳；
 *   - `windowsHide: true` 会让部分系统上的窗口不出现；
 *   - detached 且未设 stdio 时句柄继承异常。
 *  实测对比（本机）：`explorer.exe <dir>` → 退出码 1；
 *  `cmd /c start "" <dir>` → 退出码 0 且窗口正常弹出。
 *  所以这里依次尝试多种方式，只要有一种成功即返回。
 */
function openFolder(dir, selectFile) {
  const attempts = [
    // 1) start 命令，最稳。目录用 explorer 打开；有文件则用 /select 高亮
    () => {
      const args = selectFile
        ? ['/c', 'start', '', 'explorer.exe', '/select,' + selectFile]
        : ['/c', 'start', '', dir];
      const p = spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: false });
      p.on('error', () => {});
      p.unref();
    },
    // 2) 直接 explorer.exe（去掉 windowsHide）
    () => {
      const args = selectFile ? ['/select,' + selectFile] : [dir];
      const p = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    },
    // 3) 用 rundll32 调 shell32 打开目录
    () => {
      const p = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', dir], { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    },
    // 4) PowerShell 兜底
    () => {
      const p = spawn('powershell.exe',
        ['-NoProfile', '-Command', `Start-Process explorer.exe -ArgumentList '${dir.replace(/'/g, "''")}'`],
        { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => {});
      p.unref();
    }
  ];

  const tried = [];
  for (let i = 0; i < attempts.length; i++) {
    try {
      attempts[i]();
      tried.push(i + 1);
      // 首个方式成功触发即认为已处理（explorer 是 fire-and-forget，拿不到确定结果）
      return { ok: true, dir, method: i + 1 };
    } catch (e) {
      tried.push(`#${i + 1} 失败: ${e.message}`);
    }
  }
  return { ok: false, dir, tried: tried.join(' | '), error: '无法打开资源管理器，请手动打开该目录' };
}

/**
 * 用系统默认程序打开一个文件（如双击封面图片用看图软件打开）。
 * 与 openFolder 同理：优先走 `cmd /c start "" <file>`，绕开 explorer 的坑。
 */
function openFile(file) {
  const attempts = [
    () => {
      const p = spawn('cmd.exe', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    },
    () => {
      const p = spawn('rundll32.exe', ['shell32.dll,ShellExec_RunDLL', file], { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    },
    () => {
      const q = String(file).replace(/'/g, "''");
      const p = spawn('powershell.exe',
        ['-NoProfile', '-Command', `Start-Process -FilePath '${q}'`],
        { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => {});
      p.unref();
    }
  ];
  for (let i = 0; i < attempts.length; i++) {
    try { attempts[i](); return { ok: true, method: i + 1 }; } catch (e) {}
  }
  return { ok: false, error: '无法打开该文件' };
}

// ---------------------------------------------------------------- HTTP

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', d => {
      data += d;
      if (data.length > 2e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  try {
    // ---- 静态资源
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      let rel = p === '/' ? '/index.html' : p;
      const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([\\/])+/, ''));
      if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }

    // ---- SSE
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    // ---- 环境
    if (req.method === 'GET' && p === '/api/env') {
      return json(res, 200, await getEnv(u.searchParams.get('force') === '1'));
    }

    // ---- 检查 yt-dlp 是否有新版本
    if (req.method === 'GET' && p === '/api/check-update') {
      return json(res, 200, await checkYtdlpUpdate(u.searchParams.get('force') === '1'));
    }

    // ---- 配置
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, loadConfig());
    }
    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req) || '{}');
      const c = loadConfig();
      const allowed = ['downloadDir', 'proxy', 'preferHighQuality', 'mergeContainer', 'embedMetadata',
        'writeThumbnail', 'embedThumbnail', 'writeSubtitles', 'subtitleLangs', 'cookiesFromBrowser',
        'concurrency', 'filenameTemplate', 'allowPlaylist', 'rateLimit', 'potProviderUrl', 'userAgent', 'playerClient'];
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(body, k)) c[k] = body[k];
      }
      c.concurrency = Math.max(1, Math.min(6, Number(c.concurrency) || 2));
      ensureDirs();
      saveConfig();
      envCache.at = 0;
      return json(res, 200, { ok: true, config: c });
    }

    // ---- 代理探测
    if (req.method === 'GET' && p === '/api/probe-proxy') {
      return json(res, 200, { candidates: await probeProxies() });
    }

    // ---- 测试网络 / 代理是否可用
    if (req.method === 'POST' && p === '/api/test-network') {
      const body = JSON.parse(await readBody(req) || '{}');
      const proxy = body.proxy || '';
      const args = ['--simulate', '--no-warnings', '--no-playlist', '--socket-timeout', '12',
        '--print', '%(title)s'];
      args.push(...jsRuntimeArgs());
      args.push(...await potArgList());
      if (proxy) args.unshift('--proxy', proxy);
      args.push('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
      const r = await runYtdlp(args, 45000);
      if (r.code === 0 && r.stdout.trim()) {
        return json(res, 200, { ok: true, message: '连接正常，可以访问 YouTube', sample: r.stdout.trim().split(/\r?\n/)[0] });
      }
      const err = (r.stderr || '').split(/\r?\n/).find(l => /ERROR/i.test(l)) || '无法访问 YouTube';
      return json(res, 200, { ok: false, message: err.replace(/^ERROR:\s*/i, '') });
    }

    // ---- 解析
    if (req.method === 'POST' && p === '/api/probe') {
      const body = JSON.parse(await readBody(req) || '{}');
      const target = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: '请输入以 http(s):// 开头的链接' });
      const key = target;
      if (probing.has(key)) return json(res, 200, await probing.get(key));
      const prom = probeVideo(target)
        .then(d => { probing.delete(key); return d; })
        .catch(e => { probing.delete(key); throw e; });
      probing.set(key, prom);
      try {
        return json(res, 200, await prom);
      } catch (e) {
        const msg = e.message || String(e);
        return json(res, 200, { error: msg, hint: friendlyError(msg) });
      }
    }

    // ---- 创建下载
    if (req.method === 'POST' && p === '/api/download') {
      const body = JSON.parse(await readBody(req) || '{}');
      const items = Array.isArray(body.items) ? body.items : [body];
      const created = [];
      const c = loadConfig();
      for (const it of items) {
        if (!it || !/^https?:\/\//i.test(String(it.url || ''))) continue;
        const t = createTask({
          url: String(it.url),
          title: it.title || String(it.url),
          uploader: it.uploader || '',
          thumbnail: it.thumbnail || '',
          qualityLabel: it.qualityLabel || '',
          kind: it.kind || 'video',
          formatSelector: it.formatSelector || 'bv*+ba/b',
          wantThumbnail: typeof it.wantThumbnail === 'boolean' ? it.wantThumbnail : null
        });
        created.push(publicTask(t));
      }
      return json(res, 200, { ok: true, count: created.length, tasks: created, downloadDir: c.downloadDir });
    }

    // ---- 任务列表
    if (req.method === 'GET' && p === '/api/tasks') {
      return json(res, 200, { tasks: taskOrder.map(id => publicTask(tasks.get(id))).filter(Boolean) });
    }

    // ---- 任务详情
    if (req.method === 'GET' && p === '/api/task') {
      const id = u.searchParams.get('id');
      const t = tasks.get(id);
      if (!t) return json(res, 404, { error: '任务不存在' });
      return json(res, 200, Object.assign(publicTask(t), { logs: t.logs.slice(-200) }));
    }

    // ---- 取消
    if (req.method === 'POST' && p === '/api/cancel') {
      const body = JSON.parse(await readBody(req) || '{}');
      const t = tasks.get(body.id);
      if (!t) return json(res, 404, { error: '任务不存在' });
      t.canceled = true;
      if (t.proc) { try { t.proc.kill(); } catch (e) {} }
      else {
        const qi = queue.indexOf(t);
        if (qi >= 0) queue.splice(qi, 1);
        t.status = 'canceled'; t.stage = '已取消';
        pushTask(t, true);
      }
      return json(res, 200, { ok: true });
    }

    // ---- 重试
    if (req.method === 'POST' && p === '/api/retry') {
      const body = JSON.parse(await readBody(req) || '{}');
      const old = tasks.get(body.id);
      if (!old) return json(res, 404, { error: '任务不存在' });
      const t = createTask({
        url: old.url, title: old.title, uploader: old.uploader, thumbnail: old.thumbnail,
        qualityLabel: old.qualityLabel, kind: old.kind, formatSelector: old.formatSelector
      });
      return json(res, 200, publicTask(t));
    }

    // ---- 删除记录
    if (req.method === 'POST' && p === '/api/remove') {
      const body = JSON.parse(await readBody(req) || '{}');
      const t = tasks.get(body.id);
      if (t && t.proc) return json(res, 400, { error: '任务进行中，请先取消' });
      tasks.delete(body.id);
      const i = taskOrder.indexOf(body.id);
      if (i >= 0) taskOrder.splice(i, 1);
      broadcast('task-remove', { id: body.id });
      return json(res, 200, { ok: true });
    }

    // ---- 清空已完成
    if (req.method === 'POST' && p === '/api/clear-finished') {
      for (const id of taskOrder.slice()) {
        const t = tasks.get(id);
        if (t && (t.status === 'done' || t.status === 'canceled' || t.status === 'error')) {
          tasks.delete(id);
          taskOrder.splice(taskOrder.indexOf(id), 1);
          broadcast('task-remove', { id });
        }
      }
      return json(res, 200, { ok: true });
    }

    // ---- 打开文件夹 / 文件
    if (req.method === 'POST' && p === '/api/reveal') {
      const body = JSON.parse(await readBody(req) || '{}');
      const c = loadConfig();
      let target = c.downloadDir;
      const t = body.id ? tasks.get(body.id) : null;
      let selectFile = '';
      // which='thumb' 时定位封面文件，否则定位成品视频
      if (t && body.which === 'thumb' && t.thumbnailPath && fs.existsSync(t.thumbnailPath)) {
        selectFile = path.normalize(t.thumbnailPath);
        target = path.dirname(selectFile);
      } else if (t && t.filepath && fs.existsSync(t.filepath)) {
        selectFile = path.normalize(t.filepath);
        target = path.dirname(selectFile);
      } else {
        if (body.dir && fs.existsSync(body.dir)) target = body.dir;
        try { fs.mkdirSync(target, { recursive: true }); } catch (e) {}
      }
      const r = openFolder(target, selectFile);
      return json(res, 200, r);
    }

    // ---- 用默认程序直接打开文件（如封面图片）
    if (req.method === 'POST' && p === '/api/open-file') {
      const body = JSON.parse(await readBody(req) || '{}');
      const t = body.id ? tasks.get(body.id) : null;
      const which = body.which || 'video';
      const target = t ? (which === 'thumb' ? t.thumbnailPath : t.filepath) : '';
      if (!target || !fs.existsSync(target)) {
        return json(res, 404, { ok: false, error: '文件不存在' });
      }
      const r = openFile(target);
      return json(res, 200, Object.assign({ file: target }, r));
    }

    // ---- 更新 yt-dlp
    if (req.method === 'POST' && p === '/api/update-ytdlp') {
      /*
       * pip 版 yt-dlp 用 `-U` 是没用的（只打印一句"请用 pip 更新"却退出 0），
       * 必须走 pip，而且必须装到**程序实际调用的那个 Python** 里。
       *
       * 更新源：官方 PyPI 优先（镜像的稳定版会滞后，见 checkYtdlpUpdate 注释），
       * 官方连不上再退阿里云镜像。装完用 `--version` 真实校验，不迷信退出码。
       */
      const body = JSON.parse(await readBody(req) || '{}');
      let target = String(body.target || '').trim();
      if (target && !isStableVersion(target)) target = '';

      // 后端自己再确认一次最新版，避免前端拿到过期信息后钉错版本
      const info = await checkYtdlpUpdate();
      if (info.ok && info.hasUpdate) target = info.latest;

      if (pipPython()) {
        const r = await updateYtdlp(target);
        return json(res, 200, Object.assign({}, r, {
          latest: info.ok ? info.latest : (target || ''),
          checkError: info.ok ? '' : info.error
        }));
      }

      // 独立 exe 版：`-U` 对它有效
      const before = await currentYtdlpVersion();
      const r = await runYtdlp(['-U'], 180000);
      envCache.at = 0;
      const after = await currentYtdlpVersion();
      const lines = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter(Boolean);
      return json(res, 200, {
        ok: r.code === 0 && !!after,
        updated: !!after && after !== before,
        previous: before,
        version: after || before,
        latest: info.ok ? info.latest : '',
        source: 'yt-dlp -U',
        output: lines.slice(-14).join('\n') || '已是最新版本',
        checkError: info.ok ? '' : info.error
      });
    }

    // ---- 选择目录（调用系统对话框，失败则返回提示）
    if (req.method === 'POST' && p === '/api/pick-dir') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择下载保存目录'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }`;
      const r = await runCapture('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], 120000);
      const picked = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      if (picked && fs.existsSync(picked)) {
        const c = loadConfig();
        c.downloadDir = picked;
        saveConfig();
        return json(res, 200, { ok: true, dir: picked });
      }
      return json(res, 200, { ok: false, dir: '' });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    try { json(res, 500, { error: e && e.message || String(e) }); } catch (err) {}
  }
});

server.on('error', e => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n[!] 端口 ${PORT} 已被占用。可能是本程序已在运行。`);
    console.error(`    请打开浏览器访问 http://127.0.0.1:${PORT}/`);
    console.error(`    或设置环境变量 PORT 换一个端口启动。\n`);
  } else {
    console.error('[!] 服务启动失败：', e && e.message);
  }
  process.exit(1);
});

ensureDirs();
server.listen(PORT, '127.0.0.1', async () => {
  /*
   * 启动时就把防 403 的能力备好。
   * script 模式就绪时这一步是零开销的本地判断；只有 HTTP 服务真没在跑才会
   * 去把它拉起来 —— 免得用户先点了「解析」才发现被降级成 360p。
   */
  const potReady = await ensurePotService().catch(() => false);

  /*
   * 预热 PO Token 生成脚本。
   *
   * script 模式每次都要起一个 node 去跑 generate_once.js；那堆 node_modules
   * 若是"冷"的（首次读取 / 杀毒扫描），启动会超过插件写死的 15 秒上限 → 任务失败。
   * 在这里先空跑一次 `--version`，把文件缓存热起来，
   * 用户第一次点解析/下载时就不会卡在这个自检上。
   */
  try {
    const gen = POT_SERVER_HOME ? path.join(POT_SERVER_HOME, 'build', 'generate_once.js') : '';
    if (gen && fs.existsSync(gen)) {
      const p = spawn(bundledNodeExe() || process.execPath, [gen, '--version'], {
        cwd: POT_SERVER_HOME, env: childEnv(), windowsHide: true, stdio: 'ignore'
      });
      p.on('error', () => {});
      p.unref();
    }
  } catch (e) {}

  const env = await getEnv(true);
  const line = '─'.repeat(56);
  console.log(`\n${line}`);
  console.log('  YouTube 下载器  已启动');
  console.log(line);
  console.log(`  地址      http://127.0.0.1:${PORT}/`);
  console.log(`  yt-dlp    ${env.ytdlp.ok ? env.ytdlp.version : '未找到（缺少 bin/yt-dlp.exe）'}`);
  console.log(`  ffmpeg    ${env.ffmpeg.ok ? env.ffmpeg.version : '未找到（缺少 bin/ffmpeg.exe）'}`);
  console.log(`  防 403    ${env.pot.ok
      ? (env.pot.mode === 'script' ? '已就绪（本地生成令牌，不受代理影响）' : '已就绪（本地服务）')
      : '未就绪！YouTube 可能只给 360p'}`);
  console.log(`  代理      ${env.proxy || '未设置（国内网络需配置代理才能访问 YouTube）'}`);
  console.log(`  保存到    ${env.downloadDir}`);
  console.log(`${line}\n`);
  console.log('  按 Ctrl+C 可停止服务。\n');

  if (!process.argv.includes('--no-open')) {
    try {
      spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}/`], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    } catch (e) {}
  }
});

process.on('SIGINT', () => {
  console.log('\n正在停止服务…');
  for (const t of tasks.values()) { if (t.proc) { try { t.proc.kill(); } catch (e) {} } }
  process.exit(0);
});

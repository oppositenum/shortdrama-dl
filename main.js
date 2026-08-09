/**
 * main.js —— Electron 主进程
 *
 * 职责：
 *   1. 创建窗口、管理生命周期
 *   2. 通过 Playwright 打开红果短剧播放页，拦截网络请求捕获真实视频源（m3u8 / mp4）
 *   3. 通过系统 FFmpeg 下载并合并 HLS/DASH 为 MP4
 *   4. 与渲染进程通过 IPC 双向通信（进度 / 日志 / 状态 / 结果）
 *
 * 安全说明：渲染进程禁用 nodeIntegration、启用 contextIsolation，
 *          所有能力通过 preload.js 的白名单 API 暴露。
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { safeUrlForLog, startFfmpegDownload } = require('./ffmpeg-runner');
const { appGrabRange, normalizeEpisodeCount } = require('./series-workflow');
const {
  androidBootstrapSpec,
  dependencyInstaller,
  hostPlatform,
  platformLabel,
  runtimeFfmpegPath,
  windowsPythonCandidates,
  windowsRuntimeDirs,
  windowsSdkRoot,
} = require('./runtime-platform');
const { describeBarkTarget, normalizeBarkBase, sendBark } = require('./notify');
const {
  consumeJsonLines,
  describeGrabEvent,
  pickStderrLines,
} = require('./grab-protocol');
const {
  REFERER,
  buildFfmpegHeaders,
  buildFileName,
  filterBrowserHeaders,
  formatElapsed,
  getSeriesIdFromUrl,
  isSeriesListUrl,
  isSeriesUrl,
  isValidUrl,
  sanitizeName,
} = require('./url-utils');
const { createSeriesFiles } = require('./series-files');
const { createWebCapture } = require('./web-capture');


// 分类批量收尾时，对仍有缺集的剧目再跑的补漏轮数
const SERIES_RETRY_ROUNDS = 2;

// ---------------------------------------------------------------------------
// 网页 HLS/DASH 使用系统 FFmpeg。首次需要时会按 macOS/Windows 路径检查并征求安装确认；
// Homebrew/WinGet 会为 Intel、Apple Silicon 或 Windows x64 安装对应架构，避免跨架构错包。
// ---------------------------------------------------------------------------
let webFfmpegPath = runtimeFfmpegPath({
  env: process.env,
});

// ---------------------------------------------------------------------------
// 浏览器内核：打包后如果 resources/ms-playwright 存在（旧版全量包），保留兜底能力。
// 具体的启动策略和网页抓取都在 web-capture.js 里。
// ---------------------------------------------------------------------------
if (app.isPackaged) {
  const bundledBrowsers = path.join(process.resourcesPath, 'ms-playwright');
  if (fs.existsSync(bundledBrowsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
  }
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
let mainWindow = null;
let currentCommand = null;   // 当前 ffmpeg 命令（便于取消时 kill）
let currentAbort = null;     // 当前 Node 下载的 AbortController（便于取消）
let currentGrab = null;      // 当前 App 抓取的 Python 子进程（便于取消时 SIGTERM）
let currentGrabSetup = null; // 当前 App 环境准备进程（Python venv / AVD）
let activeOutputPath = null; // 当前正在写入的目标文件（取消时清理残留）
let isCanceled = false;      // 用户取消标志（立即停止：杀进程、抛 __CANCELED__）
// 温和停止：抓完当前这一部再结束。【绝不能】顺手把 isCanceled 也设上——那会立刻 kill
// 正在跑的 Python 抓取和 ffmpeg，正在抓的这一部就废了，与这个功能的意图正好相反。
let stopAfterSeries = false;
let envCheckBusy = false;    // 「环境检查」面板自动检查/重新检查/修复缺失项，三者互斥

// ===========================================================================
// 工具函数
// ===========================================================================


/** 向渲染进程发送消息（窗口可能已关闭，做保护） */
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** 发送一条日志 */
function log(message, level = 'info') {
  send('download:log', {
    level, // info | success | warn | error
    message,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  });
  if (level === 'error') notifyError(message);
}

// ---------------------------------------------------------------------------
// 网页取数（分类页 / 详情页 / 单播放页）——浏览器实例的生命周期归它管
// ---------------------------------------------------------------------------
const {
  captureVideoSource,
  closeBrowser,
  extractCategorySeries,
  extractSeriesInfo,
} = createWebCapture({
  log: (message, level) => log(message, level),
  setStatus: (text) => setStatus(text),
  installBrowser: () =>
    installHostDependency(
      'browser',
      '网页抓取需要 Chrome 或 Edge',
      process.platform === 'win32'
        ? '检测到 Windows，将使用 WinGet 安装 Google Chrome。'
        : '检测到 macOS，将使用 Homebrew 安装 Google Chrome。',
      '正在安装 Google Chrome…'
    ),
});

// ---------------------------------------------------------------------------
// 剧目文件夹产物（完成标记 / 已有分集 / 封面 / 简介）——日志出口注入进去
// ---------------------------------------------------------------------------
const {
  countExistingEpisodes,
  downloadCover,
  hasCompleteMarker,
  syncCompleteMarker,
  writeSeriesIntro,
} = createSeriesFiles({ log: (message, level) => log(message, level) });

// ===========================================================================
// Bark 推送
//
// 只在用户配了地址时才推。两个场景：一部剧完整抓完、以及跑的过程中出错。
// 推送失败一律吞掉——通知是附带功能，不该把下载带崩，也不该反过来刷屏日志。
// ===========================================================================
// 出错时不能一条一条推：一次分类批量几百部剧，风控起来错误是成串的。
// 第一条立刻推，之后 5 分钟内的先攒着，等窗口过了或任务收尾时合并成一条。
const ERROR_NOTIFY_WINDOW_MS = 5 * 60 * 1000;
let lastErrorNotifyAt = 0;
let suppressedErrorCount = 0;
let lastSuppressedError = '';
let notifyingError = false;

/** 读当前配置的 Bark 地址；没配或不合法返回 null。 */
function barkBase() {
  try {
    return normalizeBarkBase(loadUiSettings().barkUrl);
  } catch {
    return null;
  }
}

/** 发一条推送，失败只在日志里留一行（且不带 key）。 */
async function pushBark(title, body) {
  const base = barkBase();
  if (!base) return { ok: false, error: 'not_configured' };
  const r = await sendBark(base, title, body);
  if (!r.ok && r.error !== 'not_configured') {
    // 用 send 而不是 log：log 里的 error 分支会再触发一次推送，直接绕回来。
    send('download:log', {
      level: 'warn',
      message: `Bark 通知发送失败（${describeBarkTarget(base)}）：${r.error || r.status}`,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    });
  }
  return r;
}

/** 一部剧完整抓完。 */
function notifySeriesComplete({ seriesName, total, dir, elapsedText }) {
  if (!barkBase()) return;
  const parts = [`共 ${total} 集`];
  if (elapsedText) parts.push(`耗时 ${elapsedText}`);
  if (dir) parts.push(dir);
  void pushBark(`《${seriesName}》已抓完`, parts.join(' · '));
}

/** 出错。窗口内的重复错误先攒着，避免一次风控刷出几十条推送。 */
function notifyError(message) {
  if (isCanceled) return;          // 用户自己按的取消，不算故障
  if (notifyingError) return;      // 防止推送自身失败时递归
  if (!barkBase()) return;

  const now = Date.now();
  if (lastErrorNotifyAt && now - lastErrorNotifyAt < ERROR_NOTIFY_WINDOW_MS) {
    suppressedErrorCount++;
    lastSuppressedError = message;
    return;
  }
  lastErrorNotifyAt = now;
  const extra = suppressedErrorCount ? `（另有 ${suppressedErrorCount} 条错误已合并）` : '';
  suppressedErrorCount = 0;
  lastSuppressedError = '';
  notifyingError = true;
  void pushBark('红果短剧下载器出错', `${message}${extra}`).finally(() => {
    notifyingError = false;
  });
}

/** 任务收尾时把攒下的错误补一条，别让它们烂在窗口里。 */
function flushSuppressedErrors() {
  if (!suppressedErrorCount || !barkBase()) {
    suppressedErrorCount = 0;
    lastSuppressedError = '';
    return;
  }
  const count = suppressedErrorCount;
  const last = lastSuppressedError;
  suppressedErrorCount = 0;
  lastSuppressedError = '';
  lastErrorNotifyAt = Date.now();
  void pushBark('红果短剧下载器出错', `本次另有 ${count} 条错误，最后一条：${last}`);
}

/** 发送状态文案 */
function setStatus(text) {
  send('download:status', text);
}

// ===========================================================================
// 核心二：用 ffmpeg 下载并合并为 MP4
// ===========================================================================
function downloadWithFfmpeg(media, outputPath) {
  // 真实请求头只作为 spawn 参数传递，不拼接 shell，也不写入 UI 日志。
  const { headers, userAgent } = buildFfmpegHeaders(media.headers);
  const task = startFfmpegDownload({
    ffmpegPath: webFfmpegPath,
    media,
    outputPath,
    headers,
    userAgent,
    isCanceled: () => isCanceled,
    onDuration: (duration) => log(`视频总时长：${duration}`),
    onProgress: (progress) => send('download:progress', progress),
    onDiagnostic: (line) => log(line, 'warn'),
  });
  currentCommand = task.child;
  setStatus('正在下载并合并视频…');
  log(`ffmpeg 开始下载：${safeUrlForLog(media.url)}`);
  return task.promise.finally(() => {
    if (currentCommand === task.child) currentCommand = null;
  });
}

/** 终止当前 ffmpeg 任务 */
function killFfmpeg() {
  if (currentCommand) {
    try {
      currentCommand.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
    currentCommand = null;
  }
}

// ===========================================================================
// 核心二·B：用 Node 内置 fetch 直接下载（用于直连 MP4）
//
// 为什么不用 ffmpeg 下载 mp4：部分 macOS FFmpeg 构建使用 SecureTransport，在某些
// CDN（如红果的抖音系 CDN）上握手会被拒（报 -9806 / Invalid argument）。
// Node 24 内置 fetch 使用现代 TLS 栈（与 curl / yt-dlp 同级），可正常连接，
// 且无需额外二进制、天然跨平台。直连 mp4 本身也不需要转封装。
// ===========================================================================
async function downloadDirect(media, outputPath) {
  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');

  const reqHeaders = filterBrowserHeaders(media.headers);
  const controller = new AbortController();
  currentAbort = controller;

  setStatus('正在下载视频…');
  log('使用内置下载器下载 MP4（Node fetch）…');

  let res;
  try {
    res = await fetch(media.url, {
      headers: reqHeaders,
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    if (isCanceled || controller.signal.aborted) throw new Error('__CANCELED__');
    throw new Error(`连接失败：${err.message}`);
  }

  if (!res.ok && res.status !== 206) {
    throw new Error(`服务器返回 ${res.status} ${res.statusText}`);
  }
  if (!res.body) throw new Error('响应无内容，可能视频地址已失效');

  const total = Number(res.headers.get('content-length')) || 0;
  if (total) log(`文件大小：${(total / 1024 / 1024).toFixed(1)} MB`);

  const fileStream = fs.createWriteStream(outputPath);
  const nodeStream = Readable.fromWeb(res.body);

  let downloaded = 0;
  let lastBytes = 0;
  let lastTick = Date.now();

  nodeStream.on('data', (chunk) => {
    downloaded += chunk.length;
    const now = Date.now();
    if (now - lastTick >= 400) {
      const speed = (downloaded - lastBytes) / ((now - lastTick) / 1000);
      send('download:progress', {
        percent: total ? (downloaded / total) * 100 : 0,
        timemark: '',
        speed: `${(speed / 1024 / 1024).toFixed(2)} MB/s`,
      });
      lastTick = now;
      lastBytes = downloaded;
    }
  });

  try {
    await pipeline(nodeStream, fileStream);
  } catch (err) {
    if (isCanceled || controller.signal.aborted) throw new Error('__CANCELED__');
    throw err;
  } finally {
    currentAbort = null;
  }

  send('download:progress', { percent: 100, timemark: '', speed: '' });
  return outputPath;
}

/** 终止当前 Node 下载 */
function abortDirect() {
  if (currentAbort) {
    try {
      currentAbort.abort();
    } catch {
      /* 忽略 */
    }
    currentAbort = null;
  }
}

/**
 * 下载分流：直连 mp4 走 Node 内置下载器；流媒体（hls/dash）走 ffmpeg 合并。
 * 记录 activeOutputPath 以便取消时清理未完成的残留文件。
 */
async function downloadOne(media, outputPath) {
  activeOutputPath = outputPath;
  if (media.type === 'hls' || media.type === 'dash') {
    const mediaEnv = buildGrabEnv();
    const ready = await ensureSystemMediaTools(mediaEnv, {
      requireProbe: false,
      purpose: '网页 HLS/DASH 下载',
    });
    if (!ready) throw new Error('网页流媒体下载需要 ffmpeg，用户取消了环境安装');
    webFfmpegPath = runtimeFfmpegPath({ env: buildGrabEnv() });
    await downloadWithFfmpeg(media, outputPath);
  } else {
    await downloadDirect(media, outputPath);
  }
  activeOutputPath = null;
  return outputPath;
}

// ===========================================================================
// IPC：开始下载（整体流程编排）
// ===========================================================================
/** 归一化抓取方式：'offline' | 'app' | 'api' | 'none'。兼容旧字段 appGrab。 */
function normalizeGrabMode(payload = {}) {
  const mode = payload.grabMode;
  if (mode === 'offline' || mode === 'app' || mode === 'api' || mode === 'none') return mode;
  // 旧版只传 appGrab 布尔值
  if (payload.appGrab === false) return 'none';
  return 'app';
}

function grabModeLabel(mode) {
  if (mode === 'offline') return '本机签名纯协议';
  if (mode === 'api') return '纯协议下载';
  if (mode === 'app') return 'App 抓取';
  return '仅保存封面';
}

async function handleStartDownload(_event, payload) {
  const { url, outputDir, grabDir, introDetailed } = payload || {};
  isCanceled = false;
  stopAfterSeries = false;
  activeOutputPath = null;
  // grabMode: offline（本机签名纯协议）| api（纯协议+可设备回退）| app | none
  // 简介默认走简洁模式（只有剧名和简介），显式传 true 才写详细版
  const grabMode = normalizeGrabMode(payload);
  const opts = {
    grabMode,
    appGrab: grabMode === 'app', // 兼容 downloadSeriesCore 内部旧逻辑
    grabDir: grabDir || null,
    introDetailed: introDetailed === true,
  };

  // 1) 校验链接
  if (!isValidUrl(url)) {
    log('链接无效：请输入以 http(s):// 开头的红果短剧链接', 'error');
    send('download:error', '链接无效，请检查后重试');
    return { ok: false, error: 'invalid_url' };
  }

  // 2) 校验/准备保存目录
  let saveDir = outputDir;
  if (!saveDir || !fs.existsSync(saveDir)) {
    saveDir = app.getPath('downloads');
    log(`未指定有效目录，使用默认下载目录：${saveDir}`, 'warn');
  }

  // 3) 分发：分类/角色聚合页（一页多部剧）→ 批量；详情页 → 保存封面并抓全集；单集播放页 → 网页下载单个
  try {
    if (isSeriesListUrl(url)) {
      return await downloadCategory(url, saveDir, opts);
    }
    if (isSeriesUrl(url)) {
      return await downloadSeries(url, saveDir, opts);
    }
    return await downloadSingle(url, saveDir);
  } catch (err) {
    await closeBrowser();
    killFfmpeg();
    abortDirect();
    killGrab();

    if (err.message === '__CANCELED__') {
      log('已取消下载', 'warn');
      setStatus('已取消');
      // 清理未完成的残留文件
      try {
        if (activeOutputPath && fs.existsSync(activeOutputPath)) fs.unlinkSync(activeOutputPath);
      } catch {}
      activeOutputPath = null;
      send('download:canceled');
      return { ok: false, error: 'canceled' };
    }

    log(`下载失败：${err.message}`, 'error');
    setStatus('下载失败 ❌');
    send('download:error', err.message);
    return { ok: false, error: err.message };
  } finally {
    currentCommand = null;
    flushSuppressedErrors(); // 攒在合并窗口里的错误别烂在这儿
  }
}

/** 单集下载（播放页链接） */
async function downloadSingle(url, saveDir) {
  const outputPath = path.join(saveDir, `${buildFileName(url)}.mp4`);

  const media = await captureVideoSource(url);
  if (isCanceled) throw new Error('__CANCELED__');
  log(`视频源类型：${media.type}`);
  log(`视频源地址：${safeUrlForLog(media.url)}`);

  await downloadOne(media, outputPath);
  if (isCanceled) throw new Error('__CANCELED__');

  log(`下载完成：${outputPath}`, 'success');
  setStatus('下载完成 ✅');
  send('download:progress', { percent: 100, timemark: '', speed: '' });
  send('download:done', { filePath: outputPath });
  shell.showItemInFolder(outputPath);

  return { ok: true, filePath: outputPath };
}

/** 剧目文件夹内的"整剧已完成"标记文件名 */
// ===========================================================================
// 核心三：调用 Python 工具（hongguo_grab.py）从红果 App 抓取全集
//
// Python 工具位于统一项目的 python/ 目录，需要一台已 root 的安卓设备 + frida + adb。
// 契约见 docs/ARCHITECTURE.md：stdout 每行一个 JSON 进度事件，退出码区分成败。
// 这里把 Python 的事件映射到本应用既有的 download:* 通道，UI 无需感知来源。
// ===========================================================================
const GRAB_SCRIPT = 'hongguo_grab.py';
const API_GRAB_SCRIPT = 'api_grab.py';

/**
 * 解析 Python 组件目录，按优先级依次探测：
 *   1) 界面传入的路径（保留现有覆盖能力）
 *   2) 环境变量 HONGGUO_GRAB_DIR
 *   3) 统一项目内置目录：开发态用 <project>/python，打包态用 <resources>/python
 * 校验目录下存在 requiredScript，返回可用绝对路径；不可用返回 null。
 */
function resolvePythonDir(configured, requiredScript) {
  const candidates = [];
  if (configured && String(configured).trim()) candidates.push(String(configured).trim());

  const fromEnv = process.env.HONGGUO_GRAB_DIR;
  if (fromEnv && fromEnv.trim()) candidates.push(fromEnv.trim());

  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'python'));
  } else {
    candidates.push(path.join(__dirname, 'python'));
  }

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, requiredScript))) return path.resolve(dir);
    } catch {
      /* 忽略无权限等异常，试下一个 */
    }
  }
  return null;
}

/** App 抓取：目录内须有 hongguo_grab.py */
function resolveGrabDir(configured) {
  return resolvePythonDir(configured, GRAB_SCRIPT);
}

/** 纯协议抓取：目录内须有 api_grab.py */
function resolveApiGrabDir(configured) {
  return resolvePythonDir(configured, API_GRAB_SCRIPT);
}

/**
 * 找一个真正能跑的 JDK（macOS）。
 *
 * 背景：Android cmdline-tools 的 sdkmanager 只认 JAVA_HOME 和 PATH 上的 java。
 * macOS 自带的 /usr/bin/java 只是个占位程序，没装 JDK 时执行会打印
 * "Unable to locate a Java Runtime" 并返回非零；sdkmanager 拿不到版本号，
 * 就会在自己脚本里对空字符串做整数比较，报出与 Java 毫无关系的
 * "test: : integer expression expected"。而 Homebrew 的 openjdk 是 keg-only，
 * 既不进 /usr/local/bin 也不注册到 java_home，机器上明明有 JDK 也用不上。
 *
 * 所以这里直接按目录找 JDK Home：Homebrew 的 keg 目录 + 系统/用户 JVM 目录。
 * 找到就返回 Home 路径（内含 bin/java），没有返回 null。
 */
let cachedMacJavaHome;
function resolveMacJavaHome() {
  if (cachedMacJavaHome !== undefined) return cachedMacJavaHome;

  const hasJava = (home) => {
    try {
      return !!home && fs.existsSync(path.join(home, 'bin', 'java'));
    } catch {
      return false;
    }
  };

  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME.trim());
  for (const brewPrefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
    // openjdk 无后缀的是当前主版本；@版本 的是并存的旧版本，新到旧排。
    for (const formula of ['openjdk', 'openjdk@25', 'openjdk@21', 'openjdk@17']) {
      candidates.push(path.join(brewPrefix, formula, 'libexec', 'openjdk.jdk', 'Contents', 'Home'));
    }
  }
  // /Library/... 是 Temurin/Oracle 这类标准安装位置，java_home 找的也是这里；
  // 目录名带版本号，倒序排一遍优先拿新的。
  for (const root of [
    '/Library/Java/JavaVirtualMachines',
    path.join(app.getPath('home'), 'Library', 'Java', 'JavaVirtualMachines'),
  ]) {
    let entries = [];
    try {
      entries = fs.readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const entry of entries) {
      candidates.push(path.join(root, entry, 'Contents', 'Home'));
    }
  }

  cachedMacJavaHome = candidates.find(hasJava) || null;
  return cachedMacJavaHome;
}

/**
 * 构造供 Python 子进程使用的 PATH。
 *
 * 背景：macOS 从 Finder/DMG 启动的 GUI 应用只有最小 PATH
 * （/usr/bin:/bin:/usr/sbin:/sbin），不继承登录 shell 的 PATH。
 * 于是 hongguo_grab.py 内部 spawn 的 `adb` / `ffmpeg` 会 FileNotFoundError。
 * `npm start` 从终端启动则继承了完整 PATH，所以开发态无此问题。
 *
 * 这里按当前系统补充常见的第三方 bin 目录和 Android SDK 工具目录；目录去重
 * 后追加在原 PATH 之后，不覆盖用户环境。ANDROID_HOME、ANDROID_SDK_ROOT 和
 * SHORTDRAMA_SDK_ROOT 都可以指向自定义 SDK。
 */
function buildGrabEnv({ pythonBin = null, serial = null, extra = {} } = {}) {
  // Python 端的 stdout 必须是 UTF-8。进度协议和日志都是中文，而 Windows 上 Python
  // 给管道挑的是系统 ANSI 代码页（cp1252 之类），第一条中文日志就会 UnicodeEncodeError
  // 把抓取整个打死。脚本自己也会 reconfigure，这里再设一层，兼容旧解释器。
  const home = app.getPath('home');
  const platform = hostPlatform();
  const sdkRoots = [
    process.env.SHORTDRAMA_SDK_ROOT,
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
  ].filter((x) => x && x.trim()).map((x) => x.trim());
  const extras = [];
  // JDK 的 bin 必须排在最前面：/usr/bin 一直在 PATH 里，追加在后面永远抢不过
  // 那个只会报 "Unable to locate a Java Runtime" 的 /usr/bin/java 占位程序。
  const leading = [];
  let javaHome = null;

  if (platform === 'macos') {
    javaHome = resolveMacJavaHome();
    if (javaHome) leading.push(path.join(javaHome, 'bin'));
    extras.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/local/bin'
    );
    sdkRoots.push(path.join(home, 'Library', 'Android', 'sdk'));
  } else if (platform === 'windows') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    extras.push(
      ...windowsRuntimeDirs(process.env),
      path.join(localAppData, 'Programs', 'Python', 'Launcher')
    );
    for (const candidate of windowsPythonCandidates()) {
      if (!path.isAbsolute(candidate)) continue;
      extras.push(path.dirname(candidate), path.join(path.dirname(candidate), 'Scripts'));
    }
    sdkRoots.push(windowsSdkRoot(process.env) || path.join(localAppData, 'Android', 'Sdk'));
  } else {
    extras.push('/usr/local/bin');
    sdkRoots.push(path.join(home, 'Android', 'Sdk'));
  }

  for (const base of [...new Set(sdkRoots)]) {
    if (base && base.trim()) {
      extras.push(path.join(base.trim(), 'platform-tools'));
      extras.push(path.join(base.trim(), 'emulator'));
      extras.push(path.join(base.trim(), 'cmdline-tools', 'latest', 'bin'));
    }
  }

  const sep = path.delimiter;
  const current = process.env.PATH ? process.env.PATH.split(sep) : [];
  const pythonDir = pythonBin && (path.isAbsolute(pythonBin) || pythonBin.includes(path.sep))
    ? path.dirname(pythonBin)
    : null;
  const merged = pythonDir ? [pythonDir, ...leading, ...current] : [...leading, ...current];
  for (const dir of extras) {
    if (!merged.includes(dir)) merged.push(dir);
  }
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    // sdkmanager 优先读 JAVA_HOME；Homebrew 的 openjdk 是 keg-only，不设这个就找不到。
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    ...extra,
    PATH: [...new Set(merged)].join(sep),
  };
  const inheritedPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
  if (inheritedPathKey && inheritedPathKey !== 'PATH') env[inheritedPathKey] = env.PATH;
  if (serial) env.ANDROID_SERIAL = serial;
  return env;
}

/** 运行环境准备命令；输出可选地转发到 Electron 日志。 */
function runSetupProcess(command, args, { cwd, env, showOutput = false, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutLine = '';
    let stderrLine = '';
    const child = spawn(command, args, { cwd, env: env || buildGrabEnv() });
    currentGrabSetup = child;

    const consume = (chunk, isErr) => {
      const text = String(chunk);
      if (isErr) stderr += text;
      else stdout += text;
      if (!showOutput) return;

      let buf = (isErr ? stderrLine : stdoutLine) + text;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      if (isErr) stderrLine = buf;
      else stdoutLine = buf;
      for (const line of lines) {
        const t = line.trim();
        if (t) log(`[环境] ${t}`, isErr ? 'warn' : 'info');
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => consume(chunk, false));
    child.stderr.on('data', (chunk) => consume(chunk, true));

    // 只用于探测一台可能已经卡死的设备(adb shell 命令);不传就和以前完全一样、不设时限。
    let timedOut = false;
    let timeoutTimer = null;
    let killTimer = null;
    if (timeoutMs) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
      }, timeoutMs);
    }
    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      currentGrabSetup = null;
      resolve({ code: 127, signal: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      currentGrabSetup = null;
      if (showOutput) {
        if (stdoutLine.trim()) log(`[环境] ${stdoutLine.trim()}`);
        if (stderrLine.trim()) log(`[环境] ${stderrLine.trim()}`, 'warn');
      }
      if (timedOut) {
        resolve({ code: 124, signal, stdout, stderr: stderr || '超时' });
        return;
      }
      resolve({ code: code == null ? 1 : code, signal, stdout, stderr });
    });
  });
}

async function commandSucceeds(command, args, env) {
  const r = await runSetupProcess(command, args, { env, showOutput: false });
  return r.code === 0;
}

async function confirmEnvironmentInstall(message, detail, cancelLabel = '本次只保存封面') {
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: '准备运行环境',
    message,
    detail,
    buttons: ['安装并继续', cancelLabel],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return r.response === 0;
}

function packageManagerRequirement() {
  if (process.platform === 'win32') {
    return '当前 Windows 没有可用的 WinGet；请先从 Microsoft Store 安装“应用安装程序”(App Installer)';
  }
  if (process.platform === 'darwin') {
    return '当前 macOS 没有可用的 Homebrew；请先安装 Homebrew';
  }
  return `暂不支持在 ${platformLabel()} 上自动安装该依赖`;
}

async function installHostDependency(kind, message, detail, status) {
  const installer = dependencyInstaller(kind, process.platform);
  if (!installer) throw new Error(packageManagerRequirement());
  const env = buildGrabEnv();
  if (!await commandSucceeds(installer.managerCheck.command, installer.managerCheck.args, env)) {
    throw new Error(packageManagerRequirement());
  }
  const install = await confirmEnvironmentInstall(
    message,
    detail,
    kind === 'browser' ? '取消下载' : '本次只保存封面'
  );
  if (isCanceled) throw new Error('__CANCELED__');
  if (!install) return false;
  setStatus(status);
  log(`检测到 ${platformLabel()}，使用 ${process.platform === 'win32' ? 'WinGet' : 'Homebrew'} 安装运行依赖`);
  const result = await runSetupProcess(installer.command, installer.args, { env, showOutput: true });
  if (isCanceled || result.signal === 'SIGTERM') throw new Error('__CANCELED__');
  if (result.code !== 0) {
    throw new Error(`安装失败：${result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`}`);
  }
  return true;
}

// 与 python/requirements.txt 同步。升级时必须同步改校验常量、文档与 frida-server 期望版本。
const FRIDA_VERSION = '17.16.4';
// 纯协议遇 110001 想借模拟器 App 签名时，ttnet_signer 需要 frida-tools 自带的
// Java bridge（frida_tools/bridges/java.js）。只装 frida 是不够的。
const FRIDA_TOOLS_VERSION = '14.10.4';
// frida >= 17.16 需要 typing.NotRequired(Python 3.11+)；也避开 macOS 系统自带 3.9。
const MIN_PYTHON = [3, 11];
// 与 python/hongguo_grab.py 里的 PKG 保持一致，供环境检查面板直接 adb 探测用。
const HONGGUO_PKG = 'com.phoenix.read';

function venvPython(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python3');
}

function systemPythonCandidates() {
  if (hostPlatform() !== 'windows') {
    // 优先绝对路径：Homebrew / MacPorts，避免 PATH 末尾的 /usr/bin/python3(常为 3.9)抢先。
    return [
      process.env.SHORTDRAMA_PYTHON,
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/opt/local/bin/python3',
      'python3',
      'python',
    ].filter(Boolean);
  }
  return [
    process.env.SHORTDRAMA_PYTHON,
    ...windowsPythonCandidates(),
    'python.exe',
    'python3.exe',
    'python',
    'python3',
  ].filter(Boolean);
}

function pythonVersionCheckArgs(minVersion = MIN_PYTHON) {
  const [major, minor] = minVersion;
  return [
    '-c',
    `import sys; raise SystemExit(0 if sys.version_info >= (${major}, ${minor}) else 1)`,
  ];
}

/** 纯协议模式：只需 cryptography（AES 解密）。 */
function cryptoValidationArgs() {
  return [
    '-c',
    [
      'from importlib.metadata import version',
      'import cryptography',
      'assert tuple(int(x) for x in version("cryptography").split(".")[:2]) >= (41, 0)',
    ].join('; '),
  ];
}

/** App 抓取：Frida 锁版本 + cryptography。 */
function fridaValidationArgs() {
  return [
    '-c',
    [
      'from importlib.metadata import version',
      'import frida, cryptography',
      `assert version("frida") == "${FRIDA_VERSION}"`,
      'assert tuple(int(x) for x in version("cryptography").split(".")[:2]) >= (41, 0)',
    ].join('; '),
  ];
}

function summarizeProcessFailure(result, maxLines = 8) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  if (!text) return `退出码 ${result.code == null ? '?' : result.code}`;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines)
    .join(' | ');
}

/**
 * 校验解释器依赖。
 * @param {{ requireFrida?: boolean }} opts  纯协议 requireFrida=false，仅校验 cryptography
 */
async function pythonRuntimeOk(pythonBin, env, opts = {}) {
  const requireFrida = opts.requireFrida !== false;
  const args = requireFrida ? fridaValidationArgs() : cryptoValidationArgs();
  const r = await runSetupProcess(pythonBin, args, { env, showOutput: false });
  if (r.code === 0) return true;
  const need = requireFrida ? `frida==${FRIDA_VERSION}+cryptography` : 'cryptography>=41';
  log(`Python 依赖校验未通过（${pythonBin}，需要 ${need}）：${summarizeProcessFailure(r)}`, 'warn');
  return false;
}

async function resolveWindowsPyExecutable(env, minVersion = MIN_PYTHON) {
  if (hostPlatform() !== 'windows') return null;
  // 优先 3.12/3.11，再退回满足最低版本的 py -3。
  const versionSelectors = ['-3.12', '-3.11', '-3'];
  for (const selector of versionSelectors) {
    if (isCanceled) throw new Error('__CANCELED__');
    const r = await runSetupProcess(
      'py',
      [selector, '-c', 'import sys; print(sys.executable)'],
      { env, showOutput: false }
    );
    if (r.code !== 0) continue;
    const candidate = r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
    if (!candidate) continue;
    if (await commandSucceeds(candidate, pythonVersionCheckArgs(minVersion), buildGrabEnv({ pythonBin: candidate }))) {
      return candidate;
    }
  }
  return null;
}

async function findBasePython(versionCheck) {
  for (const candidate of [...new Set(systemPythonCandidates())]) {
    if (isCanceled) throw new Error('__CANCELED__');
    if (await commandSucceeds(candidate, versionCheck, buildGrabEnv({ pythonBin: candidate }))) {
      return { command: candidate, prefixArgs: [] };
    }
  }
  if (hostPlatform() === 'windows') {
    for (const selector of ['-3.12', '-3.11', '-3']) {
      if (isCanceled) throw new Error('__CANCELED__');
      if (await commandSucceeds('py', [selector, ...versionCheck], buildGrabEnv())) {
        return { command: 'py', prefixArgs: [selector] };
      }
    }
  }
  return null;
}

function removeManagedVenv(managedVenv) {
  try {
    if (fs.existsSync(managedVenv)) {
      fs.rmSync(managedVenv, { recursive: true, force: true });
      log(`已清除不可用的隔离 Python 环境：${managedVenv}`);
    }
  } catch (err) {
    log(`清除隔离 Python 环境失败（将尝试 --clear 重建）：${err.message}`, 'warn');
  }
}

/**
 * 只探测本机已有的可用 Python(env 覆盖 / 已建好的 venv / 系统 python / Windows py launcher)，
 * 全程零副作用(不装任何东西、不弹确认框)。找到就返回可执行文件路径,找不到返回 null。
 * 供「环境检查」面板的只读探测，以及 ensurePythonRuntime 在真正走安装流程前先尝试复用本机环境。
 */
/**
 * @param {string} grabDir
 * @param {{ requireFrida?: boolean }} [opts]
 */
async function probeExistingPython(grabDir, opts = {}) {
  const requireFrida = opts.requireFrida !== false;
  if (isCanceled) throw new Error('__CANCELED__');
  const platform = hostPlatform();
  if (platform === 'unsupported') {
    throw new Error(`抓取环境自动准备仅支持 macOS 和 Windows（当前：${process.platform}）`);
  }
  const managedVenv = app.isPackaged
    ? path.join(app.getPath('userData'), 'runtime', 'python')
    : path.join(__dirname, '.venv');
  const preferred = [
    process.env.SHORTDRAMA_PYTHON,
    venvPython(managedVenv),
    venvPython(path.join(path.dirname(grabDir), '.venv')),
    venvPython(path.join(grabDir, '.venv')),
    ...systemPythonCandidates(),
  ].filter(Boolean);

  for (const candidate of [...new Set(preferred)]) {
    if (isCanceled) throw new Error('__CANCELED__');
    if (await pythonRuntimeOk(candidate, buildGrabEnv({ pythonBin: candidate }), { requireFrida })) {
      return candidate;
    }
  }

  const launcherPython = await resolveWindowsPyExecutable(buildGrabEnv());
  if (launcherPython &&
      await pythonRuntimeOk(launcherPython, buildGrabEnv({ pythonBin: launcherPython }), { requireFrida })) {
    return launcherPython;
  }
  return null;
}

/**
 * @param {string} grabDir
 * @param {{ requireFrida?: boolean }} [opts]
 *   requireFrida=false：纯协议，装 cryptography 即可；true：App 抓取，装完整 requirements（含 Frida）
 */
async function ensurePythonRuntime(grabDir, opts = {}) {
  const requireFrida = opts.requireFrida !== false;
  const found = await probeExistingPython(grabDir, { requireFrida });
  if (found) return found;

  const platform = hostPlatform();
  const minPythonLabel = MIN_PYTHON.join('.');
  const managedVenv = app.isPackaged
    ? path.join(app.getPath('userData'), 'runtime', 'python')
    : path.join(__dirname, '.venv');
  const versionCheck = pythonVersionCheckArgs(MIN_PYTHON);
  let basePython = await findBasePython(versionCheck);
  const purpose = requireFrida ? 'App 抓取' : '纯协议下载';

  if (!basePython && platform === 'macos' && await commandSucceeds('brew', ['--version'], buildGrabEnv())) {
    const install = await confirmEnvironmentInstall(
      `${purpose}需要 Python ${minPythonLabel} 或更高版本`,
      `将使用 Homebrew 安装 Python（≥${minPythonLabel}），并在应用专用目录创建隔离环境。\n` +
        (requireFrida
          ? '说明：Frida 17.16+ 需要 Python 3.11+；macOS 自带的 3.9 无法使用。'
          : '说明：纯协议只需 Python + cryptography；推荐 3.11+。')
    );
    if (isCanceled) throw new Error('__CANCELED__');
    if (!install) return null;
    setStatus('正在安装 Python…');
    const r = await runSetupProcess('brew', ['install', 'python'], { env: buildGrabEnv(), showOutput: true });
    if (isCanceled || r.signal === 'SIGTERM') throw new Error('__CANCELED__');
    if (r.code !== 0) throw new Error(`Homebrew 安装 Python 失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
    basePython = await findBasePython(versionCheck);
  } else if (!basePython && platform === 'windows') {
    const wingetEnv = buildGrabEnv();
    if (!await commandSucceeds('winget.exe', ['--version'], wingetEnv)) {
      throw new Error(
        `Windows 缺少 Python ${minPythonLabel}+，且未找到 winget；请先安装 Microsoft App Installer 后重试`
      );
    }
    const install = await confirmEnvironmentInstall(
      `${purpose}需要 Python ${minPythonLabel} 或更高版本`,
      '将使用 Windows Package Manager (winget) 安装 Python 3.12，并在应用专用目录创建隔离环境。'
    );
    if (isCanceled) throw new Error('__CANCELED__');
    if (!install) return null;
    setStatus('正在安装 Python…');
    const r = await runSetupProcess('winget.exe', [
      'install', '--id', 'Python.Python.3.12', '-e', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements',
      '--silent', '--disable-interactivity',
    ], { env: wingetEnv, showOutput: true });
    if (isCanceled || r.signal === 'SIGTERM') throw new Error('__CANCELED__');
    if (r.code !== 0) throw new Error(`winget 安装 Python 失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
    basePython = await findBasePython(versionCheck);
  }
  if (!basePython) {
    const installer = platform === 'macos'
      ? `未找到可用的 Python ${minPythonLabel}+；请先安装 Homebrew，或设置 SHORTDRAMA_PYTHON 指向 Python ${minPythonLabel}+`
      : `Python 安装结束后仍未找到 Python ${minPythonLabel}+；可设置 SHORTDRAMA_PYTHON 指向 python.exe`;
    throw new Error(installer);
  }

  setStatus('正在准备 Python 依赖…');
  log(
    requireFrida
      ? `准备隔离 Python 环境（Frida ${FRIDA_VERSION} / Python ≥${minPythonLabel}）并安装依赖`
      : `准备隔离 Python 环境（cryptography / Python ≥${minPythonLabel}，纯协议）并安装依赖`
  );
  // 旧 venv 可能装过 17.15.x 或错误架构的原生扩展；不 --clear 会 already satisfied 后继续失败。
  removeManagedVenv(managedVenv);
  fs.mkdirSync(path.dirname(managedVenv), { recursive: true });
  let r = await runSetupProcess(
    basePython.command,
    [...basePython.prefixArgs, '-m', 'venv', '--clear', managedVenv],
    {
      env: buildGrabEnv(),
      showOutput: true,
    }
  );
  if (isCanceled || r.signal === 'SIGTERM') throw new Error('__CANCELED__');
  if (r.code !== 0) throw new Error(`创建 Python 虚拟环境失败：${r.stderr.trim() || `退出码 ${r.code}`}`);

  const pythonBin = venvPython(managedVenv);
  r = await runSetupProcess(pythonBin, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
    env: buildGrabEnv({ pythonBin }),
    showOutput: true,
  });
  if (isCanceled || r.signal === 'SIGTERM') throw new Error('__CANCELED__');
  if (r.code !== 0) throw new Error(`升级 pip 失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
  // App：完整 requirements。纯协议：cryptography 必装；frida + frida-tools 顺带装，
  // 供 110001 自动签名回退——bridge 在 frida-tools 里，少装它签名一定挂不上。
  const pipArgs = requireFrida
    ? ['-m', 'pip', 'install', '-r', path.join(grabDir, 'requirements.txt')]
    : ['-m', 'pip', 'install', 'cryptography>=41', `frida==${FRIDA_VERSION}`,
       `frida-tools==${FRIDA_TOOLS_VERSION}`];
  r = await runSetupProcess(pythonBin, pipArgs, {
    env: buildGrabEnv({ pythonBin }),
    showOutput: true,
  });
  if (isCanceled || r.signal === 'SIGTERM') throw new Error('__CANCELED__');
  if (r.code !== 0) {
    // 纯协议允许 Frida 装失败，只要 cryptography 可用即可继续裸请求
    if (requireFrida) {
      throw new Error(`安装 Python 依赖失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
    }
    log('完整依赖安装未成功，回退为仅 cryptography…', 'warn');
    r = await runSetupProcess(
      pythonBin,
      ['-m', 'pip', 'install', 'cryptography>=41'],
      { env: buildGrabEnv({ pythonBin }), showOutput: true }
    );
    if (isCanceled || r.signal === 'SIGTERM') throw new Error('__CANCELED__');
    if (r.code !== 0) throw new Error(`安装 cryptography 失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
  }
  if (!await pythonRuntimeOk(pythonBin, buildGrabEnv({ pythonBin }), { requireFrida })) {
    throw new Error(
      requireFrida
        ? `Python 依赖安装结束，但 Frida/cryptography 校验失败（需要 frida==${FRIDA_VERSION} 且可 import；` +
          '详见上方「Python 依赖校验未通过」日志）'
        : 'Python 依赖安装结束，但 cryptography 校验失败（需要 cryptography>=41；详见上方日志）'
    );
  }
  return pythonBin;
}

async function ensureSystemMediaTools(env, options = {}) {
  const requireProbe = options.requireProbe !== false;
  const purpose = options.purpose || 'App 抓取';
  const toolsLabel = requireProbe ? 'ffmpeg/ffprobe' : 'ffmpeg';
  if (isCanceled) throw new Error('__CANCELED__');
  const ffmpegOk = await commandSucceeds('ffmpeg', ['-version'], env);
  const ffprobeOk = !requireProbe || await commandSucceeds('ffprobe', ['-version'], env);
  if (ffmpegOk && ffprobeOk) return true;

  const platform = hostPlatform();
  let command;
  let args;
  let detail;
  if (platform === 'macos') {
    if (!await commandSucceeds('brew', ['--version'], env)) {
      throw new Error(`macOS 缺少 ${toolsLabel}，且未找到 Homebrew；请先安装 Homebrew 后重试`);
    }
    command = 'brew';
    args = ['install', 'ffmpeg'];
    detail = `将使用 Homebrew 安装当前 Mac 架构的 ffmpeg。此工具用于${purpose}${requireProbe ? '、MP4 重封装和时长核对' : ''}。`;
  } else if (platform === 'windows') {
    if (!await commandSucceeds('winget.exe', ['--version'], env)) {
      throw new Error(`Windows 缺少 ${toolsLabel}，且未找到 winget；请先安装 Microsoft App Installer 后重试`);
    }
    command = 'winget.exe';
    args = [
      'install', '--id', 'Gyan.FFmpeg', '-e', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements',
      '--silent', '--disable-interactivity',
    ];
    detail = `将使用 Windows Package Manager (winget) 安装 Windows x64 Gyan FFmpeg，用于${purpose}${requireProbe ? '、MP4 重封装和时长核对' : ''}。`;
  } else {
    throw new Error(`${purpose}自动环境准备仅支持 macOS 和 Windows`);
  }
  const install = await confirmEnvironmentInstall(
    `${purpose}需要 ${requireProbe ? 'ffmpeg 和 ffprobe' : 'ffmpeg'}`,
    detail
  );
  if (isCanceled) throw new Error('__CANCELED__');
  if (!install) return false;
  setStatus('正在安装 ffmpeg…');
  const r = await runSetupProcess(command, args, { env, showOutput: true });
  if (isCanceled || r.signal === 'SIGTERM') throw new Error('__CANCELED__');
  if (r.code !== 0) throw new Error(`安装 ffmpeg 失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
  const refreshedEnv = buildGrabEnv();
  if (!await commandSucceeds('ffmpeg', ['-version'], refreshedEnv) ||
      (requireProbe && !await commandSucceeds('ffprobe', ['-version'], refreshedEnv))) {
    throw new Error(`ffmpeg 安装命令已结束，但 ${toolsLabel} 版本校验仍未通过`);
  }
  return true;
}

function runtimeState(output) {
  const line = String(output || '').split('\n').find((x) => x.startsWith('__SHORTDRAMA_STATE__')) || '';
  const stateMatch = line.match(/\bstate=([^\s]+)/);
  const serialMatch = line.match(/\bserial=([^\s]+)/);
  return {
    state: stateMatch ? stateMatch[1] : '',
    serial: serialMatch ? serialMatch[1] : '',
  };
}

async function ensureAndroidDevice(grabDir, env, { interactive = true } = {}) {
  const platform = hostPlatform();
  const checkInvocation = androidBootstrapSpec(grabDir, 'check', false, {
    platform: process.platform,
    env,
  });
  if (!fs.existsSync(checkInvocation.script)) {
    throw new Error(`缺少 ${platform === 'windows' ? 'Windows' : 'macOS'} 模拟器启动脚本：${checkInvocation.script}`);
  }

  setStatus('正在检查 Android 环境…');
  const check = await runSetupProcess(checkInvocation.command, checkInvocation.args, { cwd: grabDir, env });
  if (isCanceled) throw new Error('__CANCELED__');
  let installMissing = false;

  if (check.code === 11 || check.code === 12) {
    // 只探测模式(环境检查面板自动检查):AVD/SDK 缺失需要下载数 GB,不属于"唤醒已装好的东西",
    // 绝不在这里弹确认框或自动装,只报状态,交给用户手动点「修复缺失项」再走下面的交互式安装。
    if (!interactive) {
      return { state: 'not_set_up', code: check.code, serial: null };
    }
    installMissing = await confirmEnvironmentInstall(
      '未找到可用的红果 Android 模拟器',
      platform === 'windows'
        ? 'Windows 将通过 PowerShell 安装所需的 Java 17、Google Android command-line tools、platform-tools、Emulator 和 API 34 x86_64 Google APIs 系统镜像，并创建 hongguo AVD。自动创建当前支持 Windows x64；其他 CPU 架构会明确停止。Google 工具下载会校验官方校验和。系统镜像为数 GB。'
        : 'macOS 将安装 Android platform-tools、Emulator 和适配当前 CPU 的 API 34 Google APIs 系统镜像，并创建 hongguo AVD。系统镜像为数 GB。Google Play 镜像不支持 adb root，不能用于此功能。'
    );
    if (isCanceled) throw new Error('__CANCELED__');
    if (!installMissing) return null;
  } else if (check.code !== 0 && check.code !== 10) {
    throw new Error(check.stderr.trim() || check.stdout.trim() || `Android 环境检查失败（退出码 ${check.code}）`);
  }

  setStatus(
    installMissing
      ? '正在安装并启动 Android 模拟器…'
      : check.code === 0
        ? '正在确认 Android root 环境…'
        : '正在启动 Android 模拟器…'
  );
  const startInvocation = androidBootstrapSpec(grabDir, 'ensure', installMissing, {
    platform: process.platform,
    env,
  });
  const start = await runSetupProcess(startInvocation.command, startInvocation.args, {
    cwd: grabDir,
    env,
    showOutput: true,
  });
  if (isCanceled || start.signal === 'SIGTERM') throw new Error('__CANCELED__');
  if (start.code !== 0) {
    throw new Error(start.stderr.trim() || start.stdout.trim() || `Android 模拟器准备失败（退出码 ${start.code}）`);
  }
  const result = runtimeState(start.stdout);
  if (!result.serial) throw new Error('Android 模拟器已启动，但没有返回设备序列号');
  return result;
}

// 「开始下载」的正式流程和「环境检查」面板都会走到 Android 设备准备这一步，而它内部会
// adb root(打断正在进行的 frida 会话)、可能拉起模拟器进程——start_avd.sh/.ps1 自己没有并发锁，
// 两边同时各发起一次会互相打架(重复开模拟器 / root 打断正在抓取的会话)。用进行中的 Promise
// 做去重，让两个调用方汇合到同一次真实操作上。
let androidEnsureInFlight = null;
function ensureAndroidDeviceShared(grabDir, env, opts) {
  if (androidEnsureInFlight) return androidEnsureInFlight;
  androidEnsureInFlight = ensureAndroidDevice(grabDir, env, opts).finally(() => {
    androidEnsureInFlight = null;
  });
  return androidEnsureInFlight;
}

async function ensureAppGrabEnvironment(grabDir) {
  log(`检测到运行系统：${platformLabel()}，将使用对应平台的环境安装流程`);
  const pythonBin = await ensurePythonRuntime(grabDir);
  if (!pythonBin) return null;
  let env = buildGrabEnv({ pythonBin });
  if (!await ensureSystemMediaTools(env)) return null;
  env = buildGrabEnv({ pythonBin });
  const device = await ensureAndroidDeviceShared(grabDir, env, { interactive: true });
  if (!device || !device.serial) return null;
  const runtimeDir = path.join(app.getPath('userData'), 'runtime', 'android');
  fs.mkdirSync(runtimeDir, { recursive: true });
  env = buildGrabEnv({
    pythonBin,
    serial: device.serial,
    extra: { HONGGUO_RUNTIME_DIR: runtimeDir },
  });
  log(`App 抓取环境就绪：${device.serial}`, 'success');
  return { pythonBin, env };
}

/**
 * 纯协议下载环境：Python + cryptography + ffmpeg，不需要安卓设备 / Frida。
 * 与 App 模式可共用 venv；纯协议校验不强制 Frida。运行缓存写入 runtime/api。
 */
/**
 * 补齐 110001 签名回退需要的 frida-tools（bridge 在它里面）。
 *
 * 纯协议的必需依赖只有 cryptography，解释器校验也只查 cryptography——这是故意的：
 * frida 装不上也不该拖垮裸请求主路径。但正因为校验不查 frida-tools，早先建好的
 * venv 不会因为缺它而重建，于是风控回退会一直挂不上签名。这里在准备环境时补一次，
 * 装不上只警告，不影响下载。
 */
async function ensureSignFallbackDeps(pythonBin, env) {
  const probe = await runSetupProcess(pythonBin, ['-c', 'import frida_tools'], {
    env,
    showOutput: false,
  });
  if (probe.code === 0) return true;
  if (isCanceled) throw new Error('__CANCELED__');

  log('补装 frida-tools（纯协议遇风控时借模拟器 App 签名要用它的 Java bridge）…');
  const r = await runSetupProcess(
    pythonBin,
    ['-m', 'pip', 'install', `frida==${FRIDA_VERSION}`, `frida-tools==${FRIDA_TOOLS_VERSION}`],
    { env, showOutput: true }
  );
  if (isCanceled || r.signal === 'SIGTERM') throw new Error('__CANCELED__');
  if (r.code !== 0) {
    log('frida-tools 补装失败：遇 110001 只能冷却+轮换身份，裸请求下载不受影响', 'warn');
    return false;
  }
  return true;
}

async function ensureApiGrabEnvironment(grabDir) {
  log(`检测到运行系统：${platformLabel()}，准备纯协议下载环境（无需安卓）`);
  const pythonBin = await ensurePythonRuntime(grabDir, { requireFrida: false });
  if (!pythonBin) return null;
  let env = buildGrabEnv({ pythonBin });
  await ensureSignFallbackDeps(pythonBin, env);
  if (!await ensureSystemMediaTools(env, { purpose: '纯协议下载' })) return null;
  env = buildGrabEnv({ pythonBin });
  const runtimeDir = path.join(app.getPath('userData'), 'runtime', 'api');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const keyCache = path.join(runtimeDir, 'key_cache.json');
  env = buildGrabEnv({
    pythonBin,
    extra: {
      HONGGUO_RUNTIME_DIR: runtimeDir,
      SHORTDRAMA_KEY_CACHE: keyCache,
    },
  });
  log('纯协议下载环境就绪', 'success');
  return { pythonBin, env, keyCache };
}

/**
 * 只读探测红果 App 是否已安装、设备端 frida-server 状态；纯 adb shell，不装不改任何东西。
 * 版本不对/未运行时不在这里现场修——那是 python/hongguo_grab.py 的 main() 里
 * ensure_frida_server() 在真正开始抓取时才做的事，这里只报状态。
 */
async function probeHongguoAndFrida(env, serial) {
  const pm = await runSetupProcess('adb', ['-s', serial, 'shell', 'pm', 'list', 'packages'], {
    env, timeoutMs: 10000,
  });
  const installed = pm.code === 0 && pm.stdout.includes(HONGGUO_PKG);
  send('env:item', {
    id: 'hongguo_app',
    state: installed ? 'ok' : 'missing',
    message: installed ? '已安装' : `未安装（${HONGGUO_PKG}），请先在模拟器里手动安装红果 App`,
  });
  if (!installed) {
    send('env:item', { id: 'frida_server', state: 'blocked', message: '待红果 App 安装后再检查' });
    return;
  }

  const pidof = await runSetupProcess('adb', ['-s', serial, 'shell', 'pidof', 'frida-server'], {
    env, timeoutMs: 10000,
  });
  const running = pidof.code === 0 && pidof.stdout.trim().length > 0;
  if (!running) {
    send('env:item', { id: 'frida_server', state: 'warn', message: '未运行，将在下次开始下载时自动启动' });
    return;
  }
  const ver = await runSetupProcess(
    'adb', ['-s', serial, 'shell', '/data/local/tmp/frida-server', '--version'],
    { env, timeoutMs: 10000 }
  );
  const deviceVersion = ver.stdout.trim();
  if (deviceVersion === FRIDA_VERSION) {
    send('env:item', { id: 'frida_server', state: 'ok', message: `运行中 v${deviceVersion}` });
  } else {
    send('env:item', {
      id: 'frida_server',
      state: 'warn',
      message: `版本不一致（设备 ${deviceVersion || '未知'} / 需要 ${FRIDA_VERSION}），将在下次开始下载时自动更新`,
    });
  }
}

/**
 * 「环境检查」面板的编排：5 步顺序探测（不用 Promise.all——多路 adb/runSetupProcess 同时跑会抢
 * 同一个 currentGrabSetup 追踪变量，顺序执行天然避免，也避免多路 adb 命令同时怼同一台设备）。
 * interactive=false 是软件启动/「重新检查」走的只读探测：不装、不下载、不弹确认框；
 * interactive=true 是「修复缺失项」走的原有交互式安装流程。红果 App / Frida Server 两项
 * 永远是只读探测（没有对应的"修复"动作），不受 interactive 影响。
 */
/**
 * @param {string|null|undefined} grabDirConfigured
 * @param {{ interactive: boolean, grabMode?: 'offline'|'app'|'api'|'none' }} opts
 */
async function runEnvironmentCheck(grabDirConfigured, { interactive, grabMode = 'offline' }) {
  if (envCheckBusy) return;
  envCheckBusy = true;
  send('env:begin');
  try {
    const mode =
      grabMode === 'offline' || grabMode === 'api' || grabMode === 'none' ? grabMode : 'app';
    const needAndroid = mode === 'app';
    const requireFrida = needAndroid;
    const grabDir = needAndroid
      ? (resolveGrabDir(grabDirConfigured) || resolveApiGrabDir(grabDirConfigured))
      : (resolveApiGrabDir(grabDirConfigured) || resolveGrabDir(grabDirConfigured));
    if (!grabDir) {
      const message = '未找到 Python 组件目录（需含 hongguo_grab.py 或 api_grab.py）';
      for (const id of ['python', 'ffmpeg', 'android', 'hongguo_app', 'frida_server']) {
        send('env:item', { id, state: 'error', message });
      }
      return;
    }

    if (mode === 'none') {
      send('env:item', { id: 'python', state: 'ok', message: '仅封面模式不需要' });
      send('env:item', { id: 'ffmpeg', state: 'ok', message: '仅封面模式不需要' });
      send('env:item', { id: 'android', state: 'ok', message: '仅封面模式不需要' });
      send('env:item', { id: 'hongguo_app', state: 'ok', message: '仅封面模式不需要' });
      send('env:item', { id: 'frida_server', state: 'ok', message: '仅封面模式不需要' });
      return;
    }

    let pythonBin = null;
    try {
      pythonBin = interactive
        ? await ensurePythonRuntime(grabDir, { requireFrida })
        : await probeExistingPython(grabDir, { requireFrida });
      send('env:item', {
        id: 'python',
        state: pythonBin ? 'ok' : 'missing',
        message: pythonBin
          || (requireFrida
            ? '未找到可用的 Python（需 frida + cryptography）'
            : '未找到可用的 Python（需 cryptography，纯协议/本机签名）'),
      });
    } catch (e) {
      send('env:item', { id: 'python', state: 'error', message: e.message });
    }

    try {
      const mediaEnv = buildGrabEnv({ pythonBin });
      const purpose = needAndroid
        ? 'App 抓取'
        : mode === 'offline'
          ? '本机签名纯协议'
          : '纯协议下载';
      const ffmpegOk = interactive
        ? await ensureSystemMediaTools(mediaEnv, { purpose })
        : (await commandSucceeds('ffmpeg', ['-version'], mediaEnv)
          && await commandSucceeds('ffprobe', ['-version'], mediaEnv));
      send('env:item', {
        id: 'ffmpeg',
        state: ffmpegOk ? 'ok' : 'missing',
        message: ffmpegOk ? '就绪' : '未找到 ffmpeg/ffprobe',
      });
    } catch (e) {
      send('env:item', { id: 'ffmpeg', state: 'error', message: e.message });
    }

    if (!needAndroid) {
      const skipMsg =
        mode === 'offline' ? '本机签名模式不需要' : '纯协议模式不需要';
      send('env:item', { id: 'android', state: 'ok', message: skipMsg });
      send('env:item', { id: 'hongguo_app', state: 'ok', message: skipMsg });
      send('env:item', { id: 'frida_server', state: 'ok', message: skipMsg });
      // 本机签名模式额外确认 metasec_offline 是否在组件目录
      if (mode === 'offline' && grabDir) {
        const offlinePy = path.join(grabDir, 'metasec_offline.py');
        if (!fs.existsSync(offlinePy)) {
          send('env:item', {
            id: 'python',
            state: 'missing',
            message: '缺少 metasec_offline.py（本机签名组件）',
          });
        }
      }
      return;
    }

    let serial = null;
    try {
      const androidEnv = buildGrabEnv({ pythonBin });
      const device = await ensureAndroidDeviceShared(grabDir, androidEnv, { interactive });
      if (device && device.serial) {
        serial = device.serial;
        send('env:item', { id: 'android', state: 'ok', message: `已就绪：${serial}` });
      } else if (device && device.state === 'not_set_up') {
        send('env:item', {
          id: 'android',
          state: 'missing',
          message: device.code === 11 ? 'AVD 未创建' : '缺少 Android 命令行工具',
        });
      } else {
        send('env:item', { id: 'android', state: 'missing', message: '未连接可用的模拟器/设备' });
      }
    } catch (e) {
      send('env:item', { id: 'android', state: 'error', message: e.message });
    }

    if (serial) {
      try {
        await probeHongguoAndFrida(buildGrabEnv({ serial }), serial);
      } catch (e) {
        send('env:item', { id: 'hongguo_app', state: 'error', message: e.message });
        send('env:item', { id: 'frida_server', state: 'error', message: e.message });
      }
    } else {
      send('env:item', { id: 'hongguo_app', state: 'blocked', message: '待设备就绪后再检查' });
      send('env:item', { id: 'frida_server', state: 'blocked', message: '待设备就绪后再检查' });
    }
  } finally {
    envCheckBusy = false;
    send('env:done');
  }
}

/**
 * 调用 Python 工具抓取 [startEp, endEp] 区间的 App 剧集，写入 seriesDir。
 * 逐行解析子进程 stdout 的 JSON 事件，转发到既有 download:* 通道。
 *
 * @returns {Promise<{code:number, ok:number, failed:number[]}>}
 *   code: 0 全成功 / 2 部分失败 / 3 环境不可用（已降级为 warn）
 * @throws Error('__CANCELED__') 当收到取消（退出码 130 或运行中被 kill）
 */
/**
 * 接管一个已经起好的抓取子进程：读 stdout 的 JSON Lines 事件转成界面动作，
 * 过滤 stderr，处理取消和退出码。App 抓取和纯协议共用这一套——两边的事件协议
 * 本来就是同一个，只有文案和退出码解释不同，都由参数传进来。
 *
 * @param {import('child_process').ChildProcess} child
 * @param {object} opts
 * @param {string} opts.label      模式名，进日志和状态栏（"App 抓取" / "本机签名"）
 * @param {string} opts.logTag     Python 侧日志的前缀（"App" / "API"）
 * @param {number} opts.total      该剧总集数，进度显示用
 * @param {boolean} [opts.showDevice]      就绪行里报不报设备（只有 App 抓取有设备）
 * @param {RegExp} [opts.stderrExtra]      额外算作"值得看"的 stderr 模式
 * @param {(code: number) => string|null} [opts.explainExit] 非零退出码的人话解释
 * @param {number} [opts.expectedEpisodes] 事件里没给总数时的兜底
 * @returns {Promise<{code: number, ok: number, failed: number[]}>}
 */
function runGrabChild(child, {
  label,
  logTag,
  total,
  showDevice = false,
  stderrExtra = null,
  explainExit = null,
  expectedEpisodes = 0,
}) {
  return new Promise((resolve, reject) => {
    currentGrab = child;

    let okCount = 0;
    let failedEps = [];
    let stdoutRest = '';

    const applyEvent = (event) => {
      const act = describeGrabEvent(event, {
        label,
        logTag,
        total,
        showDevice,
        fallbackTotal: expectedEpisodes,
      });
      for (const line of act.logs) log(line.message, line.level);
      if (act.status) setStatus(act.status);
      if (act.episode) send('download:episode', act.episode);
      if (act.progress) {
        send('download:progress', { percent: act.progress.percent, timemark: '', speed: '' });
      }
      if (act.okDelta) okCount += act.okDelta;
      if (typeof act.ok === 'number') okCount = act.ok;
      if (Array.isArray(act.failed)) failedEps = act.failed;
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutRest = consumeJsonLines(stdoutRest + chunk, applyEvent);
    });

    // stderr 是调试噪声，仅挑真正的错误行降级为 warn
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of pickStderrLines(chunk, stderrExtra)) {
        log(`[${logTag}-stderr] ${line}`, 'warn');
      }
    });

    child.on('error', (err) => {
      currentGrab = null;
      // 子进程起不来：降级为环境不可用，不中断整体流程
      log(`无法启动${label}工具：${err.message}（请检查应用准备的 Python 环境）`, 'warn');
      resolve({ code: 3, ok: 0, failed: [] });
    });

    child.on('close', (code, signal) => {
      currentGrab = null;
      if (code === 130 || isCanceled || signal === 'SIGTERM') {
        reject(new Error('__CANCELED__'));
        return;
      }
      const explained = explainExit ? explainExit(code) : null;
      if (explained) log(explained, 'warn');
      resolve({ code, ok: okCount, failed: failedEps });
    });
  });
}

function grabWithApp({ seriesName, startEp, endEp, seriesDir, total, grabDir, pythonBin, grabEnv }) {
  setStatus('正在用 App 抓取全集…');
  log(`调用 App 抓取工具：第 ${startEp}–${endEp} 集`);

  const child = spawn(
    pythonBin,
    [
      GRAB_SCRIPT,
      '--series-name', seriesName,
      '--start-ep', String(startEp),
      '--end-ep', String(endEp),
      '--output-dir', seriesDir,
    ],
    { cwd: grabDir, env: grabEnv }
  );

  return runGrabChild(child, {
    label: 'App 抓取',
    logTag: 'App',
    total,
    showDevice: true,
    expectedEpisodes: endEp - startEp + 1,
    explainExit: (code) =>
      code === 3 ? 'App 抓取环境不可用（无设备 / 未装 App / 缺依赖），本次只保存封面' : null,
  });
}

/**
 * 调用纯协议工具 api_grab.py 抓取 [startEp, endEp]，写入 seriesDir。
 * stdout JSON 事件协议与 hongguo_grab 子集一致，转发到同一 download:* 通道。
 *
 * @param {'offline'|'api'} signMode
 *   - offline：本机 Python 自签 Khronos+Gorgon，不挂设备签名（下载仍需联网）
 *   - api：纯协议；默认可借已运行的模拟器做 device-sign-auto 回退
 */
function grabWithApi({
  seriesId,
  seriesName,
  startEp,
  endEp,
  seriesDir,
  total,
  grabDir,
  pythonBin,
  grabEnv,
  keyCache,
  signMode = 'api',
}) {
  const offlineOnly = signMode === 'offline';
  const modeTag = offlineOnly ? '本机签' : '纯协议';
  setStatus(`正在用${modeTag}下载全集…`);
  log(`调用${modeTag}下载：series_id=${seriesId}，第 ${startEp}–${endEp} 集`);

  const args = [
    API_GRAB_SCRIPT,
    '--series-id', String(seriesId),
    '--start-ep', String(startEp),
    '--end-ep', String(endEp),
    '--output-dir', seriesDir,
    // 分集间隔，降低连打 video_model 触发 110001 的概率
    '--interval', String(process.env.SHORTDRAMA_API_INTERVAL || '1.2'),
    '--risk-cooldown', String(process.env.SHORTDRAMA_RISK_COOLDOWN || '45'),
  ];

  // 签名策略：
  // - offline：--offline-sign，关闭 device-sign-auto（绝不碰模拟器）
  // - api：允许本机签（Python 默认）+ 可选 device-sign-auto（旧行为保留）
  let deviceSignAuto = false;
  if (offlineOnly) {
    args.push('--offline-sign');
    log('签名：本机 Python 生成 Khronos+Gorgon（无需模拟器；下载仍走网络）');
  } else {
    // 纯协议模式仍可用本机签；遇风控再借设备（SHORTDRAMA_API_DEVICE_SIGN=0 关闭）
    deviceSignAuto = process.env.SHORTDRAMA_API_DEVICE_SIGN !== '0';
    if (deviceSignAuto) {
      args.push('--device-sign-auto');
    } else {
      log('已关闭纯协议的模拟器签名回退（SHORTDRAMA_API_DEVICE_SIGN=0），遇风控只冷却重试');
    }
  }

  if (seriesName) args.push('--series-name', seriesName);
  if (keyCache) args.push('--key-cache', keyCache);
  const adbDevice =
    process.env.SHORTDRAMA_ADB_DEVICE ||
    process.env.ANDROID_SERIAL ||
    'emulator-5554';
  if (!offlineOnly) {
    args.push('--adb-device', String(adbDevice));
  }

  // api_grab.py 自己也默认开启签名回退，只靠不传参数关不掉，必须把环境变量也带上。
  const childEnv = {
    ...grabEnv,
    SHORTDRAMA_DEVICE_SIGN_AUTO: deviceSignAuto ? (grabEnv.SHORTDRAMA_DEVICE_SIGN_AUTO || '1') : '0',
    SHORTDRAMA_OFFLINE_SIGN: offlineOnly ? '1' : (grabEnv.SHORTDRAMA_OFFLINE_SIGN || '1'),
  };
  if (offlineOnly) {
    childEnv.SHORTDRAMA_DEVICE_SIGN = '0';
  }
  const child = spawn(pythonBin, args, { cwd: grabDir, env: childEnv });

  return runGrabChild(child, {
    label: modeTag,
    logTag: 'API',
    total,
    // 纯协议的致命错误常常只带一个业务码，noise 正则里没有 110001
    stderrExtra: /110001/,
    expectedEpisodes: endEp - startEp + 1,
    explainExit: (code) => {
      if (code === 3) return `${modeTag}环境或参数不可用，本次只保存封面`;
      if (code === 4) {
        return offlineOnly
          ? '本机签名仍被业务 API 拒绝（110001）。可稍后重试，或改用「纯协议下载 / App 抓取」'
          : '纯协议被业务 API 拒绝（常见 110001 风控/频控）。本地环境正常；请稍后重试或改用「App 抓取」';
      }
      return null;
    },
  });
}

/** 终止当前 App 抓取子进程（发 SIGTERM，Python 会清理半截文件并恢复网络） */
function killGrab() {
  if (currentGrabSetup) {
    try {
      currentGrabSetup.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
    currentGrabSetup = null;
  }
  if (currentGrab) {
    try {
      currentGrab.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
    currentGrab = null;
  }
}


/**
 * 整剧下载核心：网页只解析详情和保存封面；视频由所选模式抓取：
 *   grabMode=offline → api_grab.py + 本机签名（无模拟器；下载需联网）
 *   grabMode=api     → api_grab.py（纯协议，可 device-sign-auto 回退）
 *   grabMode=app     → hongguo_grab.py（安卓 App + Frida）
 *   grabMode=none    → 仅封面/简介
 * 不发送最终 done 事件、不打开文件夹——由 downloadSeries / downloadCategory 收尾。
 * Python 会跳过已存在且非空的分集文件，因此中断后重跑仍可续传。
 */
async function downloadSeriesCore(url, saveDir, opts = {}) {
  // 计时起点放在解析详情之前：耗时统计覆盖「这部剧开始处理 → 抓取收尾」的完整过程
  const startedAt = Date.now();
  const grabMode = opts.grabMode || (opts.appGrab === false ? 'none' : 'app');
  const { grabDir = null, introDetailed = false } = opts;
  const info = await extractSeriesInfo(url);
  if (isCanceled) throw new Error('__CANCELED__');

  const seriesId = info.seriesId || getSeriesIdFromUrl(url);
  if (!seriesId) throw new Error('无法确定 series_id');

  const totalCnt = normalizeEpisodeCount(info.episodeCnt, info.vidList.length);
  const range = appGrabRange(totalCnt);
  if (!range) throw new Error('未能从详情页确定总集数');

  const modeLabel = grabModeLabel(grabMode);
  log(
    `剧名：《${info.seriesName}》，共 ${totalCnt} 集；模式：${modeLabel}` +
      (grabMode === 'none' ? '' : `，第 1–${totalCnt} 集`),
    'success'
  );

  // 为该剧建子文件夹
  const seriesDir = path.join(saveDir, sanitizeName(info.seriesName) || `series_${seriesId}`);
  try {
    fs.mkdirSync(seriesDir, { recursive: true });
  } catch (e) {
    throw new Error(`创建目录失败：${e.message}`);
  }

  // 网页整剧流程只落两样东西：封面和简介，不打开任何分集播放器。
  await downloadCover(info.cover, seriesDir);
  writeSeriesIntro(info, seriesDir, { detailed: introDetailed, sourceUrl: url });

  const beforeCount = countExistingEpisodes(seriesDir, totalCnt);
  let grabOk = 0;
  let grabAttempted = false;
  let grabLabel = '';

  if (beforeCount >= totalCnt) {
    log(`检测到本地已有完整 ${beforeCount}/${totalCnt} 集，跳过视频抓取`, 'success');
  } else if ((grabMode === 'api' || grabMode === 'offline') && !isCanceled) {
    const signMode = grabMode === 'offline' ? 'offline' : 'api';
    grabLabel = grabMode === 'offline' ? '本机签' : '纯协议';
    const resolvedApiDir = resolveApiGrabDir(grabDir);
    if (!resolvedApiDir) {
      log(`未找到${grabLabel}组件（python/${API_GRAB_SCRIPT}），本次只保存封面；请配置工具目录`, 'warn');
    } else if (signMode === 'offline' && !fs.existsSync(path.join(resolvedApiDir, 'metasec_offline.py'))) {
      log('未找到 metasec_offline.py（本机签名组件），本次只保存封面', 'warn');
    } else {
      try {
        const runtime = await ensureApiGrabEnvironment(resolvedApiDir);
        if (!runtime) {
          log(`已取消${grabLabel}环境安装，本次只保存封面`, 'warn');
        } else {
          grabAttempted = true;
          const r = await grabWithApi({
            seriesId,
            seriesName: info.seriesName,
            startEp: range.startEp,
            endEp: range.endEp,
            seriesDir,
            total: totalCnt,
            grabDir: resolvedApiDir,
            pythonBin: runtime.pythonBin,
            grabEnv: runtime.env,
            keyCache: runtime.keyCache,
            signMode,
          });
          grabOk = r.ok || 0;
          if (r.code === 0) {
            log(`${grabLabel}完成：已处理第 ${range.startEp}–${range.endEp} 集`, 'success');
          } else if (r.code === 2) {
            const failedTxt = (r.failed || []).length ? `（缺 第 ${r.failed.join('、')} 集）` : '';
            log(`${grabLabel}部分完成：成功 ${grabOk} 集${failedTxt}`, 'warn');
          }
        }
      } catch (err) {
        if (err.message === '__CANCELED__') throw err;
        log(`${grabLabel}异常：${err.message}（本次只保存封面和已完成分集）`, 'warn');
      }
    }
  } else if (grabMode === 'app' && !isCanceled) {
    grabLabel = 'App';
    const resolvedGrabDir = resolveGrabDir(grabDir);
    if (!resolvedGrabDir) {
      log(`未找到 App 抓取组件（python/${GRAB_SCRIPT}），本次只保存封面；请配置工具目录`, 'warn');
    } else {
      try {
        const runtime = await ensureAppGrabEnvironment(resolvedGrabDir);
        if (!runtime) {
          log('已取消 App 环境安装，本次只保存封面', 'warn');
        } else {
          grabAttempted = true;
          const r = await grabWithApp({
            seriesName: info.seriesName,
            startEp: range.startEp,
            endEp: range.endEp,
            seriesDir,
            total: totalCnt,
            grabDir: resolvedGrabDir,
            pythonBin: runtime.pythonBin,
            grabEnv: runtime.env,
          });
          grabOk = r.ok || 0;
          if (r.code === 0) {
            log(`App 抓取完成：已处理第 ${range.startEp}–${range.endEp} 集`, 'success');
          } else if (r.code === 2) {
            const failedTxt = (r.failed || []).length ? `（缺 第 ${r.failed.join('、')} 集）` : '';
            log(`App 抓取部分完成：成功 ${grabOk} 集${failedTxt}`, 'warn');
          }
        }
      } catch (err) {
        if (err.message === '__CANCELED__') throw err;
        log(`App 抓取异常：${err.message}（本次只保存封面和已完成分集）`, 'warn');
      }
    }
  } else if (grabMode === 'none') {
    log('未选择视频抓取方式，本次只保存封面，不下载分集', 'warn');
  }

  // Python 的 done.ok 只统计本轮新生成文件，断点续传跳过的文件不计入，因此必须按磁盘实数判定全集。
  const grabbedTotal = countExistingEpisodes(seriesDir, totalCnt);
  const fullyComplete = grabbedTotal >= totalCnt;
  syncCompleteMarker(seriesDir, grabbedTotal, totalCnt);

  const elapsedMs = Date.now() - startedAt;
  // 只有真的凑齐全集才推：批量跑几百部时，这条通知就是"这部可以看了"的信号。
  if (fullyComplete) {
    notifySeriesComplete({
      seriesName: info.seriesName,
      total: totalCnt,
      dir: seriesDir,
      elapsedText: formatElapsed(elapsedMs),
    });
  }
  log(
    `《${info.seriesName}》结束：网页视频 0 集，当前全集 ${grabbedTotal}/${totalCnt} 集` +
      (grabAttempted ? `（本轮 ${grabLabel} 成功 ${grabOk} 集）` : '') +
      `，耗时 ${formatElapsed(elapsedMs)}` +
      `，封面和视频目录：${seriesDir}`,
    fullyComplete ? 'success' : 'warn'
  );
  return {
    dir: seriesDir,
    elapsed_ms: elapsedMs,
    seriesName: info.seriesName,
    ok_count: grabbedTotal,
    total: totalCnt,
    web_ok: 0,
    web_total: 0,
    app_ok: grabMode === 'app' ? grabOk : 0,
    app_attempted: grabMode === 'app' && grabAttempted,
    api_ok: grabMode === 'api' || grabMode === 'offline' ? grabOk : 0,
    api_attempted: (grabMode === 'api' || grabMode === 'offline') && grabAttempted,
    grab_mode: grabMode,
    complete: fullyComplete,
  };
}

/** 整剧下载（详情页链接）：网页保存封面，按 grabMode 抓全集 */
async function downloadSeries(url, saveDir, opts = {}) {
  const r = await downloadSeriesCore(url, saveDir, opts);

  setStatus(
    r.complete
      ? `全集完成：成功 ${r.ok_count}/${r.total} 集 ✅`
      : `任务结束：当前 ${r.ok_count}/${r.total} 集`
  );
  send('download:progress', { percent: 100, timemark: '', speed: '' });
  send('download:done', {
    filePath: r.dir,
    complete: r.complete,
    okCount: r.ok_count,
    total: r.total,
    coverOnly: r.ok_count === 0,
  });
  shell.openPath(r.dir);

  return { ok: true, dir: r.dir, ok_count: r.ok_count, total: r.total, complete: r.complete };
}

/** 列表页（分类/角色聚合页）批量下载：解析全部剧目，逐部保存封面并按 grabMode 抓全集 */
async function downloadCategory(url, saveDir, opts = {}) {
  const list = await extractCategorySeries(url);
  if (isCanceled) throw new Error('__CANCELED__');

  const mode = opts.grabMode || (opts.appGrab === false ? 'none' : 'app');
  const modeTxt =
    mode === 'offline' ? '本机签' : mode === 'api' ? '纯协议' : mode === 'app' ? 'App' : '仅封面';
  log(`列表页共解析到 ${list.length} 部剧；模式：${modeTxt}…`, 'success');

  let okSeries = 0;
  let skipped = 0;
  let stoppedEarly = false;   // 用户按了"抓完本部再停"，批量提前收工
  // 解析失败或有缺集的剧目，主循环结束后统一补漏
  let pending = [];

  for (let i = 0; i < list.length; i++) {
    if (isCanceled) throw new Error('__CANCELED__');
    // 检查点放在每部剧【开始之前】：上一部已经完整跑完，这一部还没开工，是最干净的断点。
    // 放到循环末尾就会漏掉"已下载过，跳过"那条 continue 分支。
    if (stopAfterSeries) {
      stoppedEarly = true;
      log(
        `已按要求停止开新的剧：完成 ${i}/${list.length} 部，剩余 ${list.length - i} 部不再开始`,
        'warn'
      );
      break;
    }

    const { seriesId, title } = list[i];
    const label = title || seriesId;
    send('download:series', { current: i + 1, total: list.length, title: label });

    // 去重：剧名目录里已有完成标记（此前整剧下载完毕）则直接跳过，不再打开浏览器
    // 目录存在但无标记（历史下载 / 中途中断）仍会进入，由分集级跳过快速续传补齐
    if (title) {
      const dir = path.join(saveDir, sanitizeName(title));
      if (hasCompleteMarker(dir)) {
        okSeries++;
        skipped++;
        log(`[${i + 1}/${list.length}] 《${label}》已下载过，跳过`);
        continue;
      }
    }

    log(`========== [${i + 1}/${list.length}] 《${label}》 ==========`);

    try {
      const r = await downloadSeriesCore(`${REFERER}/detail?series_id=${seriesId}`, saveDir, opts);
      if (r.complete) {
        okSeries++;
      } else {
        pending.push({ seriesId, title: label });
        log(`《${label}》有 ${r.total - r.ok_count} 集未成功，稍后统一补漏`, 'warn');
      }
    } catch (err) {
      if (err.message === '__CANCELED__') throw err;
      // 单部剧失败不影响后续剧目
      pending.push({ seriesId, title: label });
      log(`《${label}》下载失败：${err.message}（稍后统一补漏）`, 'error');
      await closeBrowser();
    }
  }

  // 收尾补漏：对失败/缺集的剧目再跑若干轮；已下好的分集会自动跳过，只补缺失部分。
  //
  // 【温和停止不跳过这里】。"抓完本部再停"的含义是"不再从清单里开新的剧",
  // 而已经跑过的那些剧留下的缺集仍然要补完——不然停在第 200 部时，前面攒下的
  // 缺集就永远没人管了，而那正是用户按这个按钮时最不希望发生的事。
  // 只有硬取消（isCanceled）才连补漏一起中断。
  if (stoppedEarly && pending.length) {
    log(`已停止从清单开新的剧；先把前面攒下的 ${pending.length} 部缺集补完（要立刻结束请按“取消”）`, 'warn');
  }
  for (let round = 1; round <= SERIES_RETRY_ROUNDS && pending.length; round++) {
    if (isCanceled) throw new Error('__CANCELED__');
    log(`====== 补漏第 ${round}/${SERIES_RETRY_ROUNDS} 轮：${pending.length} 部剧待补 ======`, 'warn');

    const next = [];
    for (let i = 0; i < pending.length; i++) {
      if (isCanceled) throw new Error('__CANCELED__');

      const { seriesId, title } = pending[i];
      send('download:series', { current: i + 1, total: pending.length, title: `补漏：${title}` });
      log(`—— 补漏 [${i + 1}/${pending.length}] 《${title}》 ——`);

      try {
        const r = await downloadSeriesCore(`${REFERER}/detail?series_id=${seriesId}`, saveDir, opts);
        if (r.complete) {
          okSeries++;
        } else {
          next.push({ seriesId, title });
        }
      } catch (err) {
        if (err.message === '__CANCELED__') throw err;
        log(`《${title}》补漏失败：${err.message}`, 'error');
        await closeBrowser();
        next.push({ seriesId, title });
      }
    }
    pending = next;
  }

  // 提前停止时【绝不能】报"全部完成"：pending 可能是空的,但后面几百部压根没开始。
  const categoryComplete = pending.length === 0 && !stoppedEarly;
  setStatus(
    categoryComplete
      ? `全部完成：完整 ${okSeries}/${list.length} 部剧 ✅`
      : stoppedEarly
        ? `已按要求停止：完整 ${okSeries}/${list.length} 部剧`
        : `任务结束：完整 ${okSeries}/${list.length} 部剧`
  );
  log(
    `${stoppedEarly ? '分类批量已按要求提前停止' : '分类批量结束'}：` +
      `完整 ${okSeries}/${list.length} 部剧（其中跳过已下载 ${skipped} 部），保存于 ${saveDir}`,
    'success'
  );
  if (stoppedEarly) {
    log('重新粘贴同一个分类链接再跑一次即可从这里继续（已完成的剧会自动跳过）', 'warn');
  }
  if (pending.length) {
    log(
      `补漏后仍未完整（${pending.length} 部）：${pending.map((p) => p.title).join('、')}；重新粘贴分类链接再跑一次即可继续补`,
      'warn'
    );
  }
  send('download:progress', { percent: 100, timemark: '', speed: '' });
  send('download:done', {
    filePath: saveDir,
    complete: categoryComplete,
    okCount: okSeries,
    total: list.length,
    stoppedEarly,
  });
  shell.openPath(saveDir);

  return { ok: true, dir: saveDir, ok_count: okSeries, total: list.length, complete: categoryComplete };
}

// ===========================================================================
// IPC：取消下载
// ===========================================================================
async function handleCancel() {
  isCanceled = true;
  log('正在取消…', 'warn');
  await closeBrowser();
  killFfmpeg();
  abortDirect();
  killGrab();
  return { ok: true };
}

// ===========================================================================
// IPC：抓完当前这一部再停止
// ===========================================================================
async function handleStopAfterSeries() {
  // 已经硬取消过就没必要再排温和停止了
  if (isCanceled) return { ok: true, canceled: true };
  if (stopAfterSeries) return { ok: true, already: true };
  stopAfterSeries = true;
  log('已安排：抓完当前这一部后不再开新的剧，并把前面攒下的缺集补完；'
      + '要立刻中断请按「取消」', 'warn');
  send('download:stop-scheduled');
  return { ok: true };
}

// ===========================================================================
// IPC：选择保存文件夹
// ===========================================================================
async function handleSelectFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择保存文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

// ===========================================================================
// IPC：打开文件夹
// ===========================================================================
async function handleOpenFolder(_event, target) {
  if (!target) return;
  if (fs.existsSync(target)) {
    // 传文件则高亮，传目录则打开
    const stat = fs.statSync(target);
    if (stat.isDirectory()) shell.openPath(target);
    else shell.showItemInFolder(target);
  }
}

// ===========================================================================
// IPC：界面「记住上次填写内容」的持久化
//
// 特意不用 localStorage：渲染进程走 file:// 加载，实测这套 Electron/Chromium 组合下
// localStorage 不会真正落盘——同一进程内 reload 能读到，但真正 quit 再重新打开永远是空的
// （用 Playwright 反复验证过：等够时间、真正调用 app.quit()、直接检查磁盘上的 leveldb 文件，
// 数据从未写进去）。改成主进程用 fs 直接读写 userData 下的 JSON 文件，绕开这个坑。
// ===========================================================================
function uiSettingsFile() {
  return path.join(app.getPath('userData'), 'ui-settings.json');
}

function loadUiSettings() {
  try {
    return JSON.parse(fs.readFileSync(uiSettingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveUiSettings(partial) {
  try {
    const merged = { ...loadUiSettings(), ...(partial || {}) };
    fs.mkdirSync(path.dirname(uiSettingsFile()), { recursive: true });
    fs.writeFileSync(uiSettingsFile(), JSON.stringify(merged, null, 2));
  } catch (e) {
    log(`保存界面设置失败：${e.message}`, 'warn');
  }
}

// ===========================================================================
// 窗口与生命周期
// ===========================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 800,
    minWidth: 720,
    minHeight: 620,
    title: '红果短剧下载器',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => (mainWindow = null));
}

app.whenReady().then(() => {
  // 注册 IPC 处理器
  ipcMain.handle('download:start', handleStartDownload);
  ipcMain.handle('download:cancel', handleCancel);
  ipcMain.handle('download:stop-after-series', handleStopAfterSeries);
  ipcMain.handle('dialog:selectFolder', handleSelectFolder);
  ipcMain.handle('shell:openFolder', handleOpenFolder);
  ipcMain.handle('app:getDefaultDir', () => app.getPath('downloads'));
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('env:check', (_e, payload) =>
    runEnvironmentCheck(payload && payload.grabDir, {
      interactive: false,
      grabMode: (payload && payload.grabMode) || 'offline',
    }));
  ipcMain.handle('env:fix', (_e, payload) =>
    runEnvironmentCheck(payload && payload.grabDir, {
      interactive: true,
      grabMode: (payload && payload.grabMode) || 'offline',
    }));
  ipcMain.handle('notify:test', async (_e, payload) => {
    // 用界面上当前填的值试，不必先保存；留空才回落到已保存的配置。
    const raw = (payload && payload.barkUrl) || (loadUiSettings().barkUrl || '');
    const base = normalizeBarkBase(raw);
    if (!base) return { ok: false, error: 'invalid_bark_url' };
    const r = await sendBark(base, '红果短剧下载器', '通知配置成功，抓完整部剧和出错时会推到这里');
    return { ...r, target: describeBarkTarget(base) };
  });
  ipcMain.handle('settings:load', () => loadUiSettings());
  ipcMain.handle('settings:save', (_e, partial) => saveUiSettings(partial));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 清理正在运行的任务
  killFfmpeg();
  abortDirect();
  killGrab();
  closeBrowser();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  killFfmpeg();
  abortDirect();
  killGrab();
  closeBrowser();
});

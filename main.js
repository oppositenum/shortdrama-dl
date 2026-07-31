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
const {
  appGrabRange,
  isCompleteMarker,
  normalizeEpisodeCount,
} = require('./series-workflow');
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

// ---------------------------------------------------------------------------
// 常量：红果短剧要求的请求头（防盗链）
// ---------------------------------------------------------------------------
const REFERER = 'https://hongguoduanju.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// 捕获视频源的最长等待时间（毫秒）
const CAPTURE_TIMEOUT = 45_000;
// 只捕获到 mp4 时，再多等一会儿看是否有更优的 m3u8
const M3U8_GRACE = 3_000;
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
// 浏览器内核策略：优先复用系统已装的 Chrome / Edge（channel 方式），
// 免去随包分发 500+MB Chromium；开发环境仍可回退到 ms-playwright 自带内核。
// 打包后如果 resources/ms-playwright 存在（旧版全量包），也保留其兜底能力。
// ---------------------------------------------------------------------------
if (app.isPackaged) {
  const bundledBrowsers = path.join(process.resourcesPath, 'ms-playwright');
  if (fs.existsSync(bundledBrowsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
  }
}
const { chromium } = require('playwright');

// 首次成功的浏览器渠道（'chrome' | 'msedge' | ''=自带 Chromium），后续直接复用少走弯路
let workingChannel = null;

/**
 * 启动无头浏览器：依次尝试 系统 Chrome → 系统 Edge → Playwright 自带 Chromium。
 * 成功一次后记住渠道，本次会话内不再逐个试。
 */
async function launchBrowser(extraArgs = [], allowInstall = true) {
  const args = [...extraArgs];
  const candidates =
    workingChannel !== null
      ? [workingChannel]
      : ['chrome', 'msedge', ''];

  let lastErr = null;
  for (const channel of candidates) {
    try {
      const opts = { headless: true, args };
      if (channel) opts.channel = channel;
      const browser = await chromium.launch(opts);
      if (workingChannel === null) {
        workingChannel = channel;
        const name = channel === 'chrome' ? '系统 Chrome' : channel === 'msedge' ? '系统 Edge' : '自带 Chromium';
        log(`使用浏览器内核：${name}`);
      }
      return browser;
    } catch (e) {
      lastErr = e;
    }
  }

  if (allowInstall && (process.platform === 'darwin' || process.platform === 'win32')) {
    const installed = await installHostDependency(
      'browser',
      '网页抓取需要 Chrome 或 Edge',
      process.platform === 'win32'
        ? '检测到 Windows，将使用 WinGet 安装 Google Chrome。'
        : '检测到 macOS，将使用 Homebrew 安装 Google Chrome。',
      '正在安装 Google Chrome…'
    );
    if (installed) {
      workingChannel = null;
      return launchBrowser(extraArgs, false);
    }
  }
  throw new Error(
    `未找到可用的浏览器内核：请安装 Google Chrome（或 Microsoft Edge）后重试。原始错误：${lastErr ? lastErr.message : '未知'}`
  );
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
let mainWindow = null;
let currentBrowser = null;   // 当前 Playwright 浏览器实例（便于取消时关闭）
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

/** 校验是否为合法 http/https 链接 */
function isValidUrl(input) {
  try {
    const u = new URL(String(input).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 是否为剧集详情页链接（含 series_id 且非单集播放页） */
function isSeriesUrl(input) {
  try {
    const u = new URL(String(input).trim());
    if (u.pathname.includes('/player/')) return false;
    return u.pathname.includes('/detail') || u.searchParams.has('series_id');
  } catch {
    return false;
  }
}

/** 是否为分类/榜单列表页链接（如 /category?sort_type=1），页面内含多部剧 */
function isCategoryUrl(input) {
  try {
    const u = new URL(String(input).trim());
    return u.pathname.includes('/category') && !u.searchParams.has('series_id');
  } catch {
    return false;
  }
}

/** 从详情页链接取 series_id（SSR 解析失败时兜底） */
function getSeriesIdFromUrl(input) {
  try {
    return new URL(String(input).trim()).searchParams.get('series_id');
  } catch {
    return null;
  }
}

/**
 * 取某个页面链接对应的 Referer（用页面自身的源）。
 * 不同站点（hongguoduanju.com / novelquickapp.com 分享页等）防盗链要求 Referer
 * 与页面域名一致，写死会导致 403。取不到时回退到默认站点。
 */
function refererOf(pageUrl) {
  try {
    return new URL(pageUrl).origin;
  } catch {
    return REFERER;
  }
}

/** 清洗成合法文件/文件夹名 */
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * 分集文件名。位宽由该剧总集数决定：≥100 集用三位补零（第006集.mp4），否则两位（第06集.mp4）。
 * ⚠️ 必须与 Python 端 hongguo_grab.py 的 epname() 完全一致，否则 App 断点续传和完成校验会错乱。
 */
function epName(ep, total) {
  const width = total >= 100 ? 3 : 2;
  return `第${String(ep).padStart(width, '0')}集.mp4`;
}

/**
 * 判断某个请求/响应是否为视频源，并返回其类型。
 *
 * 不能只看扩展名——红果的真实地址往往没有 .mp4/.m3u8 后缀，
 * 例如：https://.../video/tos/cn/xxx/?...&mime_type=video_mp4&...
 * 因此综合判断：URL 扩展名、query 里的 mime_type、以及响应的 Content-Type。
 *
 * @returns {'hls'|'dash'|'mp4'|null}
 */
function classifyMedia(url, contentType = '') {
  const u = String(url).toLowerCase();
  const ct = String(contentType).toLowerCase();

  // HLS（m3u8）
  if (/\.m3u8(\?|$)/.test(u) || ct.includes('mpegurl')) return 'hls';
  // DASH（mpd）
  if (/\.mpd(\?|$)/.test(u) || ct.includes('dash+xml')) return 'dash';
  // 直连 MP4：扩展名、mime_type 参数、或 Content-Type 为 video/*
  if (/\.mp4(\?|$)/.test(u)) return 'mp4';
  if (/mime_type=video[_/]mp4/.test(u)) return 'mp4';
  if (ct.startsWith('video/')) return 'mp4';

  return null;
}

/**
 * 过滤 Playwright 抓到的浏览器请求头，得到可安全复用的头部对象。
 * 目的：尽量还原浏览器发起视频请求时的头部，绕过防盗链 / CDN 校验。
 *
 * - 剔除 HTTP/2 伪首部（以 : 开头）与逐跳/由客户端自行设置的头
 * - accept-encoding 剔除，避免拿到 gzip 影响处理
 * - range 剔除，确保请求完整文件
 * - 兜底补上 Referer / User-Agent
 *
 * @returns {Record<string,string>}
 */
function filterBrowserHeaders(browserHeaders) {
  const EXCLUDE = new Set([
    'host', 'connection', 'content-length', 'accept-encoding',
    'range', 'proxy-connection', 'te', 'upgrade',
  ]);
  const out = {};
  let hasReferer = false;
  let hasUA = false;

  for (const [k, v] of Object.entries(browserHeaders || {})) {
    if (!k || k.startsWith(':')) continue; // 伪首部
    const lk = k.toLowerCase();
    if (EXCLUDE.has(lk)) continue;
    out[k] = v;
    if (lk === 'referer') hasReferer = true;
    if (lk === 'user-agent') hasUA = true;
  }

  if (!hasReferer) out['Referer'] = REFERER;
  if (!hasUA) out['User-Agent'] = USER_AGENT;
  return out;
}

/**
 * 把浏览器请求头转换成 ffmpeg 的 -headers 字符串（User-Agent 单独返回，走 -user_agent）。
 * 仅用于 HLS/DASH 走 ffmpeg 的场景。
 * @returns {{ headers: string, userAgent: string }}
 */
function buildFfmpegHeaders(browserHeaders) {
  const filtered = filterBrowserHeaders(browserHeaders);
  let userAgent = USER_AGENT;
  const lines = [];
  for (const [k, v] of Object.entries(filtered)) {
    if (k.toLowerCase() === 'user-agent') { userAgent = v; continue; }
    lines.push(`${k}: ${v}`);
  }
  return { headers: lines.join('\r\n') + '\r\n', userAgent };
}

/** 根据播放页链接生成一个较友好的文件名（不含扩展名） */
function buildFileName(playerUrl) {
  let base = 'hongguo_video';
  try {
    const segs = new URL(playerUrl).pathname.split('/').filter(Boolean);
    if (segs.length) base = segs.slice(-2).join('_');
  } catch {
    /* 忽略，使用默认名 */
  }
  // 去掉文件系统非法字符
  base = base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'hongguo_video';
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14); // yyyyMMddHHmmss
  return `${base}_${stamp}`;
}

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
}

/** 发送状态文案 */
function setStatus(text) {
  send('download:status', text);
}

// ===========================================================================
// 核心负一：解析分类/榜单页，取出全部剧目的 series_id
//
// 分类页为服务端渲染直出，每部剧是一张 <a href="/detail?series_id=..."> 卡片，
// 卡片内文本节点依次为：集数（"全72集"）、剧名、分类标签。
// 无需浏览器内核，直接 fetch HTML 后正则解析即可。
// ===========================================================================
async function extractCategorySeries(categoryUrl) {
  setStatus('正在解析分类页剧目列表…');
  log('抓取分类页，解析全部剧目…');

  let res;
  try {
    res = await fetch(categoryUrl, {
      headers: { 'User-Agent': USER_AGENT, Referer: refererOf(categoryUrl) },
      redirect: 'follow',
    });
  } catch (err) {
    throw new Error(`分类页请求失败：${err.message}`);
  }
  if (!res.ok) throw new Error(`分类页请求失败：${res.status} ${res.statusText}`);
  const html = await res.text();

  // 同一部剧的卡片可能出现多次（PC/移动两套布局），用 Map 按 series_id 去重
  const seen = new Map();
  const cardRe = /href="\/detail\?series_id=(\d+)"([\s\S]*?)<\/a>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    // 卡片内的文本节点里，剔除"全N集"后第一个即剧名（仅用于日志，文件夹名以详情页为准）
    const texts = [...m[2].matchAll(/>([^<>]+)</g)]
      .map((t) => t[1].trim())
      .filter(Boolean);
    const title = texts.find((t) => !/^全\s*\d+\s*集$/.test(t)) || '';
    seen.set(id, title);
  }

  if (!seen.size) {
    throw new Error('未能从分类页解析到任何剧目（页面结构可能已变化）');
  }
  return [...seen.entries()].map(([seriesId, title]) => ({ seriesId, title }));
}

// ===========================================================================
// 核心零：解析剧集详情页元数据
//
// 分集数据由详情页服务端渲染在 window._ROUTER_DATA.loaderData.detail_page.seriesDetail：
//   series_name / series_cover / episode_cnt（总集数）/ vid_list（总集数兜底）
// 整剧流程不再打开网页分集播放器；网页只用于解析元数据和封面。
// ===========================================================================
async function extractSeriesInfo(seriesUrl) {
  setStatus('正在解析剧集详情…');
  log('打开详情页解析剧名、总集数和封面…');

  currentBrowser = await launchBrowser();

  try {
    const context = await currentBrowser.newContext({
      userAgent: USER_AGENT,
      extraHTTPHeaders: { Referer: refererOf(seriesUrl) },
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    await page
      .goto(seriesUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch((e) => log(`页面导航提示：${e.message}`, 'warn'));

    // 轮询等待 SSR 数据就绪（最多 ~15s）
    const handle = await page
      .waitForFunction(
        () => {
          const sd = window._ROUTER_DATA?.loaderData?.detail_page?.seriesDetail;
          const list = Array.isArray(sd?.vid_list) ? sd.vid_list : [];
          const total = Number(sd?.episode_cnt);
          if (sd?.series_name && ((Number.isFinite(total) && total > 0) || list.length > 0)) {
            return {
              seriesId: sd.series_id,
              seriesName: sd.series_name,
              vidList: list,
              episodeCnt: sd.episode_cnt || 0,
              cover: sd.series_cover || '',
              // 下面这些只用于生成「简介.txt」。缺了也不影响下载流程，所以一律给默认值，
              // 绝不让详情页少个字段就把整剧判失败。
              // 【抓取范围只能由 episode_cnt / vid_list 决定】。详情页上还有一个"网页免费可看
              // 集数"的字段（通常只有 5），历史上误拿它当过总集数，70 集的剧只抓 5 集就收工；
              // tests/series-workflow.test.js 里有一条断言专门禁止这里再碰那个字段。
              intro: sd.series_intro || '',
              tags: Array.isArray(sd.tags) ? sd.tags.filter((t) => typeof t === 'string') : [],
              episodeText: sd.episode_right_text || '',
              updatedCnt: Number(sd.series_episode_info?.episode_cnt) || 0,
              totalEpisodeCnt: Number(sd.series_episode_info?.episode_total_cnt) || 0,
              celebrities: (Array.isArray(sd.celebrities) ? sd.celebrities : [])
                .filter((c) => c && typeof c === 'object')
                .map((c) => ({ name: c.nickname || '', role: c.sub_title || '' })),
            };
          }
          return null;
        },
        { timeout: 15_000, polling: 500 }
      )
      .catch(() => null);

    const info = handle ? await handle.jsonValue() : null;
    if (!info?.seriesName || normalizeEpisodeCount(info.episodeCnt, info.vidList?.length) <= 0) {
      throw new Error('未能解析到剧名或总集数（页面结构可能已变化，或该链接不是详情页）');
    }
    return info;
  } finally {
    await closeBrowser();
  }
}

// ===========================================================================
// 核心一：用 Playwright 捕获真实视频源地址
// ===========================================================================
async function captureVideoSource(pageUrl) {
  setStatus('正在启动浏览器内核…');
  log('启动 Chromium（Playwright）…');

  currentBrowser = await launchBrowser(['--autoplay-policy=no-user-gesture-required']);

  const context = await currentBrowser.newContext({
    userAgent: USER_AGENT,
    extraHTTPHeaders: { Referer: refererOf(pageUrl) },
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // 用 Promise 捕获视频源；优先 m3u8/dash，其次直连 mp4
  let resolveMedia;
  const mediaPromise = new Promise((resolve) => (resolveMedia = resolve));
  let fallback = null;   // {url, type} mp4 候选，等待是否出现更优的 hls
  let graceTimer = null;
  let settled = false;

  const accept = (url, type, headers) => {
    if (settled) return;
    settled = true;
    if (graceTimer) clearTimeout(graceTimer);
    resolveMedia({ url, type, headers: headers || {} });
  };

  const consider = (url, type, headers) => {
    if (settled || !type) return;
    if (type === 'hls' || type === 'dash') {
      log(`捕获到 ${type.toUpperCase()} 视频源`, 'success');
      accept(url, type, headers);
    } else if (type === 'mp4' && !fallback) {
      // 先记为候选，短暂等待是否出现流媒体（hls）；到期仍无则采用 mp4
      fallback = { url, type, headers: headers || {} };
      log('捕获到 MP4 视频源（稍候确认是否有更优的流…）', 'warn');
      graceTimer = setTimeout(
        () => accept(fallback.url, fallback.type, fallback.headers),
        M3U8_GRACE
      );
    }
  };

  // 请求阶段：靠 URL 与资源类型判断（<video> 触发的请求 resourceType 为 media）
  // 同时抓下该请求的真实头部，供后续 ffmpeg 还原
  page.on('request', (req) => {
    try {
      let type = classifyMedia(req.url());
      if (!type && req.resourceType() === 'media') type = 'mp4';
      if (type) consider(req.url(), type, req.headers());
    } catch {
      /* 忽略单个请求的解析异常 */
    }
  });

  // 响应阶段：可拿到 Content-Type，判断最可靠
  page.on('response', (res) => {
    try {
      const ct = (res.headers()['content-type'] || '');
      const type = classifyMedia(res.url(), ct);
      if (type) consider(res.url(), type, res.request().headers());
    } catch {
      /* 忽略 */
    }
  });

  setStatus('正在打开页面并等待视频加载…');
  log(`打开页面：${pageUrl}`);

  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    // 导航超时/失败不一定致命——可能已经捕获到媒体；继续等待竞速结果
    log(`页面导航提示：${e.message}`, 'warn');
  }

  // 反复尝试触发播放（播放器脚本可能稍后才就绪），不阻塞捕获竞速
  triggerPlay(page);

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error('等待超时：未能在页面中捕获到视频源（m3u8 / mp4）')),
      CAPTURE_TIMEOUT
    )
  );

  try {
    return await Promise.race([mediaPromise, timeoutPromise]);
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
    // 捕获完成后即可关闭浏览器，释放资源（视频地址通常已自带鉴权 token）
    await closeBrowser();
  }
}

/**
 * 多次尝试触发页面播放，促使播放器发起真实视频流请求。
 * 全程吞掉异常（页面可能已关闭），避免未处理的 Promise 异常。
 */
async function triggerPlay(page) {
  const once = async () => {
    try {
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) {
          v.muted = true;
          const p = v.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        const btn = document.querySelector(
          '.play, .play-btn, .vjs-big-play-button, [class*="play"], [class*="Play"]'
        );
        if (btn) btn.click();
      });
      // 模拟一次点击，满足部分播放器的"用户手势"要求
      await page.mouse.click(640, 360);
    } catch {
      /* 页面可能已关闭或结构未知，忽略 */
    }
  };

  try {
    await once();
    await page.waitForTimeout(2000);
    await once();
    await page.waitForTimeout(3000);
    await once();
  } catch {
    /* 忽略 */
  }
}

/** 关闭 Playwright 浏览器 */
async function closeBrowser() {
  if (currentBrowser) {
    try {
      await currentBrowser.close();
    } catch {
      /* 忽略 */
    }
    currentBrowser = null;
  }
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
async function handleStartDownload(_event, payload) {
  const { url, outputDir, appGrab, grabDir, introDetailed } = payload || {};
  isCanceled = false;
  stopAfterSeries = false;
  activeOutputPath = null;
  // App 抓取全集：默认开启（未显式传 false 即视为开启）
  // 简介默认走简洁模式（只有剧名和简介），显式传 true 才写详细版
  const opts = { appGrab: appGrab !== false, grabDir: grabDir || null,
                 introDetailed: introDetailed === true };

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

  // 3) 分发：分类/详情页 → 网页保存封面并由 App 抓取全集；单集播放页 → 网页下载单个
  try {
    if (isCategoryUrl(url)) {
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
const COMPLETE_MARK = '.complete';

function hasCompleteMarker(seriesDir) {
  try {
    return isCompleteMarker(fs.readFileSync(path.join(seriesDir, COMPLETE_MARK), 'utf8'));
  } catch {
    return false;
  }
}

function countExistingEpisodes(seriesDir, total) {
  let count = 0;
  for (let ep = 1; ep <= total; ep++) {
    try {
      const candidate = path.join(seriesDir, epName(ep, total));
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) count++;
    } catch {
      // 单个文件无法读取时按缺集处理。
    }
  }
  return count;
}

function syncCompleteMarker(seriesDir, completed, total) {
  const markerPath = path.join(seriesDir, COMPLETE_MARK);
  try {
    if (total > 0 && completed >= total) {
      fs.writeFileSync(markerPath, `${total}/${total}\n`);
    } else if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch {
    // 标记维护失败不覆盖视频抓取结果。
  }
}

/**
 * 下载剧集封面到剧目文件夹（文件名"封面.jpg/.png/.webp"，按响应类型定扩展名）。
 * 已存在则跳过；失败仅记警告，不影响剧集下载。
 */
async function downloadCover(coverUrl, seriesDir) {
  if (!coverUrl) return;
  try {
    const existing = fs
      .readdirSync(seriesDir)
      .find((f) => f.startsWith('封面.'));
    if (existing) return;

    const res = await fetch(coverUrl, {
      headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg';
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(seriesDir, `封面${ext}`), buf);
    log(`封面已保存：封面${ext}`);
  } catch (err) {
    log(`封面下载失败（不影响剧集）：${err.message}`, 'warn');
  }
}

/** 简洁模式的正文：只有剧名和剧情简介。 */
function buildIntroBrief(info) {
  const name = info.seriesName || '（未知剧名）';
  return info.intro ? `${name}\n\n${info.intro}\n` : `${name}\n`;
}

/** 详细模式的正文：再带上集数、标签、来源和演职人员。 */
function buildIntroDetailed(info, sourceUrl) {
  const L = [];
  const total = normalizeEpisodeCount(info.episodeCnt, info.vidList?.length);
  L.push(info.seriesName || '（未知剧名）', '');
  L.push(`剧名：${info.seriesName || ''}`);
  if (total > 0) L.push(`集数：${info.episodeText || `全${total}集`}（共 ${total} 集）`);
  // 连载中的剧「已更新」会少于总集数；两者相等时这行没有信息量，不写。
  if (info.updatedCnt > 0 && info.totalEpisodeCnt > 0 && info.updatedCnt !== info.totalEpisodeCnt) {
    L.push(`已更新：${info.updatedCnt} / 共 ${info.totalEpisodeCnt} 集`);
  }
  if (info.tags?.length) L.push(`标签：${info.tags.join(' / ')}`);
  if (info.seriesId) L.push(`series_id：${info.seriesId}`);
  if (sourceUrl) L.push(`详情页：${sourceUrl}`);

  if (info.intro) L.push('', '【简介】', info.intro);

  const cast = (info.celebrities || []).filter((c) => c?.name);
  if (cast.length) {
    L.push('', '【演职人员】');
    // 按最长的名字补空格对齐。用展开而不是 .length：中文名逐字算宽，
    // 而 JS 的字符串长度对代理对（部分生僻字）会多算一位。
    const w = Math.max(...cast.map((c) => [...c.name].length));
    for (const c of cast) {
      L.push(`${c.name}${' '.repeat(Math.max(0, w - [...c.name].length))}  ${c.role || ''}`.trimEnd());
    }
  }

  const t = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  L.push(
    '',
    `抓取时间：${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ` +
      `${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}`
  );
  return L.join('\n') + '\n';
}

/**
 * 把详情页解析到的信息写成剧目文件夹里的「简介.txt」。
 * detailed=false（默认）只写剧名和简介；detailed=true 另带集数、标签、来源和演职人员。
 *
 * 每次都重写：连载中的剧简介会改，保留旧的没意义。
 * 这是个纯附带产物，任何一步出问题都只记警告——绝不能因为写不出一个文本文件
 * 就影响视频下载（封面下载也是同样的处理原则）。
 */
function writeSeriesIntro(info, seriesDir, { detailed = false, sourceUrl = '' } = {}) {
  try {
    const text = detailed ? buildIntroDetailed(info, sourceUrl) : buildIntroBrief(info);
    fs.writeFileSync(path.join(seriesDir, '简介.txt'), text, 'utf8');
    log(`简介已保存：简介.txt（${detailed ? '详细' : '简洁'}）`);
  } catch (err) {
    log(`简介保存失败（不影响剧集）：${err.message}`, 'warn');
  }
}

// ===========================================================================
// 核心三：调用 Python 工具（hongguo_grab.py）从红果 App 抓取全集
//
// Python 工具位于统一项目的 python/ 目录，需要一台已 root 的安卓设备 + frida + adb。
// 契约见 docs/ARCHITECTURE.md：stdout 每行一个 JSON 进度事件，退出码区分成败。
// 这里把 Python 的事件映射到本应用既有的 download:* 通道，UI 无需感知来源。
// ===========================================================================
const GRAB_SCRIPT = 'hongguo_grab.py';

/**
 * 解析 App 抓取工具目录，按优先级依次探测：
 *   1) 界面传入的路径（保留现有覆盖能力）
 *   2) 环境变量 HONGGUO_GRAB_DIR
 *   3) 统一项目内置目录：开发态用 <project>/python，打包态用 <resources>/python
 * 校验目录下存在 hongguo_grab.py，返回可用绝对路径；不可用返回 null。
 */
function resolveGrabDir(configured) {
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
      if (fs.existsSync(path.join(dir, GRAB_SCRIPT))) return path.resolve(dir);
    } catch {
      /* 忽略无权限等异常，试下一个 */
    }
  }
  return null;
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

  if (platform === 'macos') {
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
  const merged = pythonDir ? [pythonDir, ...current] : [...current];
  for (const dir of extras) {
    if (!merged.includes(dir)) merged.push(dir);
  }
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
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

/** 校验解释器是否能 import 锁定版本的 Frida/cryptography；失败时把末尾错误写入日志。 */
async function pythonRuntimeOk(pythonBin, env) {
  const r = await runSetupProcess(pythonBin, fridaValidationArgs(), { env, showOutput: false });
  if (r.code === 0) return true;
  log(`Python 依赖校验未通过（${pythonBin}）：${summarizeProcessFailure(r)}`, 'warn');
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
async function probeExistingPython(grabDir) {
  if (isCanceled) throw new Error('__CANCELED__');
  const platform = hostPlatform();
  if (platform === 'unsupported') {
    throw new Error(`App 抓取环境自动准备仅支持 macOS 和 Windows（当前：${process.platform}）`);
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
    if (await pythonRuntimeOk(candidate, buildGrabEnv({ pythonBin: candidate }))) {
      return candidate;
    }
  }

  const launcherPython = await resolveWindowsPyExecutable(buildGrabEnv());
  if (launcherPython &&
      await pythonRuntimeOk(launcherPython, buildGrabEnv({ pythonBin: launcherPython }))) {
    return launcherPython;
  }
  return null;
}

async function ensurePythonRuntime(grabDir) {
  const found = await probeExistingPython(grabDir);
  if (found) return found;

  const platform = hostPlatform();
  const minPythonLabel = MIN_PYTHON.join('.');
  const managedVenv = app.isPackaged
    ? path.join(app.getPath('userData'), 'runtime', 'python')
    : path.join(__dirname, '.venv');
  const versionCheck = pythonVersionCheckArgs(MIN_PYTHON);
  let basePython = await findBasePython(versionCheck);

  if (!basePython && platform === 'macos' && await commandSucceeds('brew', ['--version'], buildGrabEnv())) {
    const install = await confirmEnvironmentInstall(
      `App 抓取需要 Python ${minPythonLabel} 或更高版本`,
      `将使用 Homebrew 安装 Python（≥${minPythonLabel}），并在应用专用目录创建隔离环境。\n` +
        '说明：Frida 17.16+ 需要 Python 3.11+；macOS 自带的 3.9 无法使用。'
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
      `App 抓取需要 Python ${minPythonLabel} 或更高版本`,
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
  log(`准备隔离 Python 环境（Frida ${FRIDA_VERSION} / Python ≥${minPythonLabel}）并安装依赖`);
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
  r = await runSetupProcess(pythonBin, ['-m', 'pip', 'install', '-r', path.join(grabDir, 'requirements.txt')], {
    env: buildGrabEnv({ pythonBin }),
    showOutput: true,
  });
  if (isCanceled || r.signal === 'SIGTERM') throw new Error('__CANCELED__');
  if (r.code !== 0) throw new Error(`安装 Python 依赖失败：${r.stderr.trim() || `退出码 ${r.code}`}`);
  if (!await pythonRuntimeOk(pythonBin, buildGrabEnv({ pythonBin }))) {
    throw new Error(
      `Python 依赖安装结束，但 Frida/cryptography 校验失败（需要 frida==${FRIDA_VERSION} 且可 import；` +
        '详见上方「Python 依赖校验未通过」日志）'
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
async function runEnvironmentCheck(grabDirConfigured, { interactive }) {
  if (envCheckBusy) return;
  envCheckBusy = true;
  send('env:begin');
  try {
    const grabDir = resolveGrabDir(grabDirConfigured);
    if (!grabDir) {
      const message = '未找到 App 抓取组件（python 目录），请检查安装或指定组件目录';
      for (const id of ['python', 'ffmpeg', 'android', 'hongguo_app', 'frida_server']) {
        send('env:item', { id, state: 'error', message });
      }
      return;
    }

    let pythonBin = null;
    try {
      pythonBin = interactive ? await ensurePythonRuntime(grabDir) : await probeExistingPython(grabDir);
      send('env:item', {
        id: 'python',
        state: pythonBin ? 'ok' : 'missing',
        message: pythonBin || '未找到可用的 Python（需 frida/cryptography 可用）',
      });
    } catch (e) {
      send('env:item', { id: 'python', state: 'error', message: e.message });
    }

    try {
      const mediaEnv = buildGrabEnv({ pythonBin });
      const ffmpegOk = interactive
        ? await ensureSystemMediaTools(mediaEnv)
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
function grabWithApp({ seriesName, startEp, endEp, seriesDir, total, grabDir, pythonBin, grabEnv }) {
  return new Promise((resolve, reject) => {
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
    currentGrab = child;

    let okCount = 0;
    let failedEps = [];
    let grabTotal = endEp - startEp + 1;
    let stdoutBuf = '';

    const handleEvent = (ev) => {
      switch (ev.event) {
        case 'init':
          grabTotal = ev.total != null ? ev.total : grabTotal;
          log(`App 抓取就绪：设备 ${ev.device || '?'}，本次待抓 ${grabTotal} 集`);
          break;
        case 'episode_start':
          send('download:episode', { current: ev.ep, total });
          setStatus(`App 抓取 第 ${ev.ep}/${total} 集…`);
          send('download:progress', { percent: 0, timemark: '', speed: '' });
          break;
        case 'progress':
          send('download:progress', {
            percent: Math.max(0, Math.min(100, Number(ev.percent) || 0)),
            timemark: '',
            speed: '',
          });
          break;
        case 'episode_done':
          okCount++;
          send('download:progress', { percent: 100, timemark: '', speed: '' });
          log(`App 抓取 第 ${ev.ep} 集完成（${ev.file || ''}）`, 'success');
          break;
        case 'episode_failed':
          log(`App 抓取 第 ${ev.ep} 集失败：${ev.error || ''}`, 'error');
          break;
        case 'log':
          log(`[App] ${ev.message || ''}`, ev.level || 'info');
          break;
        case 'done':
          if (typeof ev.ok === 'number') okCount = ev.ok;
          if (Array.isArray(ev.failed)) failedEps = ev.failed;
          break;
        default:
          break;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue; // 非 JSON 行忽略（契约保证 stdout 纯净，兜底防脏字节）
        }
        try {
          handleEvent(ev);
        } catch {
          /* 单条事件处理异常不影响后续 */
        }
      }
    });

    // stderr 是调试噪声，仅挑真正的错误行降级为 warn
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const t = line.trim();
        if (t && /(error|exception|traceback|failed|refused|not found)/i.test(t)) {
          log(`[App-stderr] ${t}`, 'warn');
        }
      }
    });

    child.on('error', (err) => {
      currentGrab = null;
      // Python 进程启动错误：降级为环境不可用，不中断整体流程
      log(`无法启动 App 抓取工具：${err.message}（请检查应用准备的 Python 环境）`, 'warn');
      resolve({ code: 3, ok: 0, failed: [] });
    });

    child.on('close', (code, signal) => {
      currentGrab = null;
      if (code === 130 || isCanceled || signal === 'SIGTERM') {
        reject(new Error('__CANCELED__'));
        return;
      }
      if (code === 3) {
        log('App 抓取环境不可用（无设备 / 未装 App / 缺依赖），本次只保存封面', 'warn');
      }
      resolve({ code, ok: okCount, failed: failedEps });
    });
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
 * 整剧下载核心：网页只解析详情和保存封面，视频全部交给 App 从第 1 集抓取。
 * 不发送最终 done 事件、不打开文件夹——由 downloadSeries（单剧）或
 * downloadCategory（多剧批量）的收尾逻辑统一处理。
 * Python 会跳过已存在且非空的分集文件，因此中断后重跑仍可续传。
 */
async function downloadSeriesCore(url, saveDir, opts = {}) {
  const { appGrab = true, grabDir = null, introDetailed = false } = opts;
  const info = await extractSeriesInfo(url);
  if (isCanceled) throw new Error('__CANCELED__');

  const seriesId = info.seriesId || getSeriesIdFromUrl(url);
  if (!seriesId) throw new Error('无法确定 series_id');

  const totalCnt = normalizeEpisodeCount(info.episodeCnt, info.vidList.length);
  const range = appGrabRange(totalCnt);
  if (!range) throw new Error('未能从详情页确定总集数');

  log(
    `剧名：《${info.seriesName}》，共 ${totalCnt} 集；网页仅保存封面，视频由 App 抓取第 1–${totalCnt} 集`,
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
  let appOk = 0;
  let appAttempted = false;
  const resolvedGrabDir = appGrab ? resolveGrabDir(grabDir) : null;

  if (beforeCount >= totalCnt) {
    log(`检测到本地已有完整 ${beforeCount}/${totalCnt} 集，跳过 App 抓取`, 'success');
  } else if (appGrab && resolvedGrabDir && !isCanceled) {
    try {
      const runtime = await ensureAppGrabEnvironment(resolvedGrabDir);
      if (!runtime) {
        log('已取消 App 环境安装，本次只保存封面', 'warn');
      } else {
        appAttempted = true;
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
        appOk = r.ok || 0;
        if (r.code === 0) {
          log(`App 抓取完成：已处理第 ${range.startEp}–${range.endEp} 集`, 'success');
        } else if (r.code === 2) {
          const failedTxt = (r.failed || []).length ? `（缺 第 ${r.failed.join('、')} 集）` : '';
          log(`App 抓取部分完成：成功 ${appOk} 集${failedTxt}`, 'warn');
        }
      }
      // code === 3 已在 grabWithApp 内部 warn，此处按未补全处理
    } catch (err) {
      if (err.message === '__CANCELED__') throw err;
      log(`App 抓取异常：${err.message}（本次只保存封面和已完成分集）`, 'warn');
    }
  } else if (appGrab && !resolvedGrabDir) {
    log(`未找到 App 抓取组件（python/${GRAB_SCRIPT}），本次只保存封面；请配置工具目录`, 'warn');
  } else if (!appGrab) {
    log('App 抓取已关闭，本次只保存封面，不下载网页分集视频', 'warn');
  }

  // Python 的 done.ok 只统计本轮新生成文件，断点续传跳过的文件不计入，因此必须按磁盘实数判定全集。
  const grabbedTotal = countExistingEpisodes(seriesDir, totalCnt);
  const fullyComplete = grabbedTotal >= totalCnt;
  syncCompleteMarker(seriesDir, grabbedTotal, totalCnt);

  log(
    `《${info.seriesName}》结束：网页视频 0 集，当前全集 ${grabbedTotal}/${totalCnt} 集` +
      (appAttempted ? `（本轮 App 成功 ${appOk} 集）` : '') +
      `，封面和视频目录：${seriesDir}`,
    fullyComplete ? 'success' : 'warn'
  );
  return {
    dir: seriesDir,
    seriesName: info.seriesName,
    ok_count: grabbedTotal,
    total: totalCnt,
    web_ok: 0,
    web_total: 0,
    app_ok: appOk,
    app_attempted: appAttempted,
    complete: fullyComplete,
  };
}

/** 整剧下载（详情页链接）：网页保存封面，App 从第 1 集抓取全集 */
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

/** 分类页批量下载：解析全部剧目，逐部保存封面并由 App 从第 1 集抓取全集 */
async function downloadCategory(url, saveDir, opts = {}) {
  const list = await extractCategorySeries(url);
  if (isCanceled) throw new Error('__CANCELED__');

  log(`分类页共解析到 ${list.length} 部剧；网页只保存封面，视频全部从 App 抓取…`, 'success');

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
  ipcMain.handle('env:check', (_e, payload) =>
    runEnvironmentCheck(payload && payload.grabDir, { interactive: false }));
  ipcMain.handle('env:fix', (_e, payload) =>
    runEnvironmentCheck(payload && payload.grabDir, { interactive: true }));

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

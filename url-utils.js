'use strict';

/**
 * url-utils.js —— 链接判别、文件名清洗、媒体类型识别、请求头整理
 *
 * 这里全是纯函数：给什么算什么，不碰文件系统、不碰网络、不碰 Electron。
 * 从 main.js 搬出来是为了能直接 require 进测试——留在主进程里的话，
 * 测一个"这个链接算不算详情页"都得先把 Electron 拉起来。
 */

// 红果站点相关的固定值。防盗链要求 Referer 与页面同源，UA 用桌面 Chrome。
const REFERER = 'https://hongguoduanju.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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

/** 毫秒转「1小时02分03秒 / 2分03秒 / 3.4秒」，用于单剧耗时日志。 */
function formatElapsed(ms) {
  const totalSec = Math.max(0, ms) / 1000;
  // 用四舍五入后的秒数判边界，避免 59.99 秒被打成「60.0秒」
  if (Math.round(totalSec * 10) < 600) return `${totalSec.toFixed(1)}秒`;
  const s = Math.round(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}小时${pad(m)}分${pad(sec)}秒` : `${m}分${pad(sec)}秒`;
}

module.exports = {
  REFERER,
  USER_AGENT,
  buildFfmpegHeaders,
  buildFileName,
  classifyMedia,
  epName,
  filterBrowserHeaders,
  formatElapsed,
  getSeriesIdFromUrl,
  isCategoryUrl,
  isSeriesUrl,
  isValidUrl,
  refererOf,
  sanitizeName,
};

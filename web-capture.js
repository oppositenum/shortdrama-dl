'use strict';

/**
 * web-capture.js —— 网页侧的取数：分类页剧目列表、详情页元数据、单播放页媒体源
 *
 * 这一层只跟浏览器打交道，不下载、不写文件、不认识 Python。浏览器实例的生命周期
 * 也归它管：取消时要能立刻关掉，所以 closeBrowser 由本模块导出，别处不再各自持有
 * 一份实例引用。
 *
 * 日志、状态栏和「是否已取消」由调用方注入——模块本身不假设自己跑在 Electron 里。
 */

const { chromium } = require('playwright');
const { normalizeEpisodeCount } = require('./series-workflow');
const { USER_AGENT, classifyMedia, refererOf } = require('./url-utils');

// 捕获视频源的最长等待时间（毫秒）
const CAPTURE_TIMEOUT = 45_000;
// 只捕获到 mp4 时，再多等一会儿看是否有更优的 m3u8
const M3U8_GRACE = 3_000;

/**
 * @param {object} deps
 * @param {(message: string, level?: string) => void} deps.log
 * @param {(text: string) => void} deps.setStatus
 * @param {() => Promise<boolean>} deps.installBrowser  没有可用内核时征求安装（返回是否已装上）
 *
 * 这里不需要 isCanceled：取消是靠 main 直接调 closeBrowser() 把浏览器关掉，
 * 页面上正在等的 Promise 会随之失败，比在循环里反复查标志更干脆。
 */
function createWebCapture({ log, setStatus, installBrowser }) {
  // 首次成功的浏览器渠道（'chrome' | 'msedge' | ''=自带 Chromium），后续直接复用少走弯路
  let workingChannel = null;
  let currentBrowser = null; // 当前 Playwright 浏览器实例（便于取消时关闭）

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
      const installed = await installBrowser();
      if (installed) {
        workingChannel = null;
        return launchBrowser(extraArgs, false);
      }
    }
    throw new Error(
      `未找到可用的浏览器内核：请安装 Google Chrome（或 Microsoft Edge）后重试。原始错误：${lastErr ? lastErr.message : '未知'}`
    );
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
    const mediaPromise = new Promise((resolve) => {
      resolveMedia = resolve;
    });
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

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error('等待超时：未能在页面中捕获到视频源（m3u8 / mp4）')),
        CAPTURE_TIMEOUT
      );
    });

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

  return {
    captureVideoSource,
    closeBrowser,
    extractCategorySeries,
    extractSeriesInfo,
    launchBrowser,
  };
}

module.exports = { CAPTURE_TIMEOUT, M3U8_GRACE, createWebCapture };

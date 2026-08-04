'use strict';

/**
 * series-files.js —— 剧目文件夹里的产物：完成标记、已有分集清点、封面、简介
 *
 * 这几件事只跟磁盘打交道，和 Electron、Playwright、Python 都没关系。搬出 main.js
 * 之后能直接 require 进测试——原来测「简介写成什么样」得先把 main.js 的源码抠出来
 * 用 new Function 求值，才能绕开 require('electron')。
 *
 * 写封面和简介都是附带产物：任何一步出错都只记警告，绝不能因为写不出一个文本文件
 * 就影响视频下载。日志出口由调用方注入，模块自己不假设有界面。
 */

const fs = require('fs');
const path = require('path');
const { isCompleteMarker, normalizeEpisodeCount } = require('./series-workflow');
const { REFERER, USER_AGENT, epName } = require('./url-utils');


/**
 * @param {{ log: (message: string, level?: string) => void }} deps
 */
function createSeriesFiles({ log }) {
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

  return {
    COMPLETE_MARK,
    buildIntroBrief,
    buildIntroDetailed,
    countExistingEpisodes,
    downloadCover,
    hasCompleteMarker,
    syncCompleteMarker,
    writeSeriesIntro,
  };
}

module.exports = { createSeriesFiles };

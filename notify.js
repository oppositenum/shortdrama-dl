'use strict';

/**
 * notify.js —— Bark 推送
 *
 * 只做两件事：把用户填的地址整理成可用的推送前缀，以及按 Bark 的
 * `<前缀>/<标题>/<内容>` 形式发一条 GET。所有策略（什么时候推、多久推一次）
 * 留在 main.js，这里保持纯函数 + 一个可注入 fetch 的发送器，方便直接测。
 */

const DEFAULT_HOST = 'https://api.day.app';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 整理用户填的地址，返回 `协议://主机/KEY` 形式的前缀；不可用返回 null。
 *
 * 能接受的写法：
 *   AbCdEfGhIjKlMnOpQrStUv                     → 只有 key，补官方域名
 *   api.day.app/KEY                            → 少了协议
 *   https://api.day.app/KEY/                   → 多了尾斜杠
 *   https://api.day.app/KEY/推送标题/推送内容    → 照着示例整条粘进来
 *
 * 最后那种是最容易发生的：官方文档和示例都带着标题和内容。标题内容是我们自己拼的，
 * 所以对官方域名只保留第一段路径（就是 key）。自建 Bark 常挂在子路径下
 * （如 https://bark.example.com/bark/KEY），那种不敢乱截，原样保留。
 */
function normalizeBarkBase(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;

  // 先把别的协议挡掉。不挡的话下面会给它再补一层 https://，拼出
  // https://ftp://... 这种 URL——它居然能 parse 成功（host 变成 ftp），
  // 于是一个明显错的地址会被当成可用配置。
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  if (/^(javascript|data|file|vbscript|blob):/i.test(text)) return null;

  let candidate = text;
  if (!/^https?:\/\//i.test(candidate)) {
    // 没有斜杠 = 只填了 key；有斜杠 = 填了地址但漏了协议
    candidate = candidate.includes('/') ? `https://${candidate}` : `${DEFAULT_HOST}/${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!segments.length) return null;

  const isOfficial = /(^|\.)day\.app$/i.test(parsed.hostname);
  const keep = isOfficial ? segments.slice(0, 1) : segments;
  const encodedPath = keep.map(encodeURIComponent).join('/');
  return `${parsed.protocol}//${parsed.host}/${encodedPath}`;
}

/** 拼出最终推送 URL；base 不合法返回 null。 */
function buildBarkUrl(base, title, body, { group = 'shortdrama-dl' } = {}) {
  const normalized = normalizeBarkBase(base);
  if (!normalized) return null;
  // Bark 按路径取标题和内容，斜杠、问号这些必须转义，否则内容会被截断或当成参数。
  const parts = [encodeURIComponent(String(title || '').trim() || '红果短剧下载器')];
  const text = String(body == null ? '' : body).trim();
  if (text) parts.push(encodeURIComponent(text));
  const url = `${normalized}/${parts.join('/')}`;
  return group ? `${url}?group=${encodeURIComponent(group)}` : url;
}

/** 打日志用：地址里带着 key，别整条写进日志。 */
function describeBarkTarget(base) {
  const normalized = normalizeBarkBase(base);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const key = parsed.pathname.split('/').filter(Boolean).pop() || '';
    const masked = key.length > 6 ? `${key.slice(0, 3)}***${key.slice(-2)}` : '***';
    return `${parsed.host}/${masked}`;
  } catch {
    return '';
  }
}

/**
 * 发一条推送。永远 resolve：推送失败绝不能影响下载本身。
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
async function sendBark(base, title, body, options = {}) {
  const {
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    group,
  } = options;

  const url = buildBarkUrl(base, title, body, group === undefined ? {} : { group });
  if (!url) return { ok: false, error: 'invalid_bark_url' };
  if (!fetchImpl) return { ok: false, error: 'no_fetch' };

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) {
      return { ok: false, status: res ? res.status : undefined, error: `HTTP ${res ? res.status : '?'}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  DEFAULT_HOST,
  buildBarkUrl,
  describeBarkTarget,
  normalizeBarkBase,
  sendBark,
};

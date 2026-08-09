'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const {
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
  isCharacterUrl,
  isSeriesListUrl,
  isSeriesUrl,
  isValidUrl,
  refererOf,
  sanitizeName,
} = require(path.join(projectRoot, 'url-utils.js'));

test('只接受 http/https，其余一律不算合法链接', () => {
  assert.equal(isValidUrl('https://hongguoduanju.com/detail?series_id=1'), true);
  assert.equal(isValidUrl('  http://example.com  '), true, '两边空白要容忍');
  for (const bad of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y', '不是链接', null]) {
    assert.equal(isValidUrl(bad), false, String(bad));
  }
});

// 播放页也带 series_id，判别顺序反了就会把单集当整剧、从第 1 集开始抓全集。
test('播放页不算详情页，哪怕它也带 series_id', () => {
  assert.equal(isSeriesUrl('https://hongguoduanju.com/detail?series_id=123'), true);
  assert.equal(isSeriesUrl('https://hongguoduanju.com/x?series_id=123'), true);
  assert.equal(isSeriesUrl('https://hongguoduanju.com/player/abc?series_id=123'), false);
  assert.equal(isSeriesUrl('https://hongguoduanju.com/category?sort_type=1'), false);
});

test('分类页要排除带 series_id 的那种', () => {
  assert.equal(isCategoryUrl('https://hongguoduanju.com/category?sort_type=1'), true);
  assert.equal(isCategoryUrl('https://hongguoduanju.com/category?series_id=1'), false);
  assert.equal(isCategoryUrl('https://hongguoduanju.com/detail?series_id=1'), false);
});

// 角色/演员聚合页也是一页多部剧，结构与分类页一致，要走同一套批量流程。
test('角色聚合页当列表页处理，且不被误判成详情页', () => {
  const characterUrl = 'https://hongguoduanju.com/character/7429227723668591897';
  assert.equal(isCharacterUrl(characterUrl), true);
  assert.equal(isCharacterUrl('https://hongguoduanju.com/character/1?series_id=1'), false, '带 series_id 的不算');
  assert.equal(isCharacterUrl('https://hongguoduanju.com/category?sort_type=1'), false);
  // 关键：不能掉进详情页/单集分支，否则会被当成单个视频去抓、静默失败
  assert.equal(isSeriesUrl(characterUrl), false);
  assert.equal(isCategoryUrl(characterUrl), false);
});

test('列表页判别覆盖分类页和角色页两种', () => {
  assert.equal(isSeriesListUrl('https://hongguoduanju.com/category?sort_type=1'), true);
  assert.equal(isSeriesListUrl('https://hongguoduanju.com/character/7429227723668591897'), true);
  assert.equal(isSeriesListUrl('https://hongguoduanju.com/detail?series_id=1'), false);
  assert.equal(isSeriesListUrl('https://hongguoduanju.com/player/abc'), false);
});

test('从链接里取 series_id，取不到给 null 而不是抛', () => {
  assert.equal(getSeriesIdFromUrl('https://x.com/detail?series_id=7411446481971842073'), '7411446481971842073');
  assert.equal(getSeriesIdFromUrl('https://x.com/detail'), null);
  assert.equal(getSeriesIdFromUrl('乱码'), null);
});

// 分享页在别的域名下，Referer 写死会被防盗链挡掉。
test('Referer 跟着页面自己的源走，取不到才回落', () => {
  assert.equal(refererOf('https://novelquickapp.com/share/x'), 'https://novelquickapp.com');
  assert.equal(refererOf('不是链接'), REFERER);
});

test('文件名清洗：非法字符换掉、空白压缩、长度封顶', () => {
  assert.equal(sanitizeName('这个/剧名:带*非法?字符'), '这个_剧名_带_非法_字符');
  assert.equal(sanitizeName('  多   空白   '), '多 空白');
  assert.equal(sanitizeName('长'.repeat(200)).length, 80);
  assert.equal(sanitizeName(null), '');
});

// 必须和 Python 端 epname() 完全一致，否则断点续传和完成校验会错乱。
test('分集文件名的补零位宽由总集数决定', () => {
  assert.equal(epName(6, 82), '第06集.mp4');
  assert.equal(epName(6, 100), '第006集.mp4');
  assert.equal(epName(99, 99), '第99集.mp4');
  assert.equal(epName(100, 100), '第100集.mp4');
});

// 真实地址常常没有扩展名，只能靠 query 里的 mime_type 或响应头判断。
test('媒体类型识别不只看扩展名', () => {
  assert.equal(classifyMedia('https://x/a.m3u8?t=1'), 'hls');
  assert.equal(classifyMedia('https://x/a', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(classifyMedia('https://x/a.mpd'), 'dash');
  assert.equal(classifyMedia('https://x/a.mp4'), 'mp4');
  assert.equal(classifyMedia('https://x/video/tos/cn/xx/?a=1&mime_type=video_mp4'), 'mp4');
  assert.equal(classifyMedia('https://x/a', 'video/mp4'), 'mp4');
  assert.equal(classifyMedia('https://x/a.jpg', 'image/jpeg'), null);
  assert.equal(classifyMedia('https://x/a'), null);
});

test('请求头过滤掉伪首部和逐跳头，缺 Referer/UA 时补上', () => {
  const out = filterBrowserHeaders({
    ':authority': 'x.com',
    Host: 'x.com',
    'Accept-Encoding': 'gzip',
    Range: 'bytes=0-100',
    Connection: 'keep-alive',
    Cookie: 'a=b',
  });
  assert.deepEqual(Object.keys(out).sort(), ['Cookie', 'Referer', 'User-Agent']);
  assert.equal(out.Referer, REFERER);
  assert.equal(out['User-Agent'], USER_AGENT);
});

test('已有的 Referer/UA 不被覆盖', () => {
  const out = filterBrowserHeaders({ referer: 'https://other.com', 'user-agent': 'custom/1.0' });
  assert.equal(out.referer, 'https://other.com');
  assert.equal(out['user-agent'], 'custom/1.0');
  assert.equal(out.Referer, undefined, '不该再补一个大小写不同的重复头');
});

test('ffmpeg 头部：UA 单独走 -user_agent，其余按 CRLF 拼', () => {
  const { headers, userAgent } = buildFfmpegHeaders({ Referer: 'https://x.com', 'User-Agent': 'ua/1' });
  assert.equal(userAgent, 'ua/1');
  assert.equal(headers, 'Referer: https://x.com\r\n');
  assert.equal(headers.includes('User-Agent'), false, 'UA 不能同时出现在两处');
});

test('单集文件名带时间戳且不含非法字符', () => {
  const name = buildFileName('https://hongguoduanju.com/player/abc/def?x=1');
  assert.match(name, /^abc_def_\d{14}$/);
  assert.match(buildFileName('不是链接'), /^hongguo_video_\d{14}$/);
});

test('耗时按量级换单位', () => {
  assert.equal(formatElapsed(0), '0.0秒');
  assert.equal(formatElapsed(1234), '1.2秒');
  assert.equal(formatElapsed(59_949), '59.9秒');
  assert.equal(formatElapsed(59_999), '1分00秒', '别打成 60.0秒');
  assert.equal(formatElapsed(125_000), '2分05秒');
  assert.equal(formatElapsed(3_723_000), '1小时02分03秒');
  assert.equal(formatElapsed(-5), '0.0秒');
});

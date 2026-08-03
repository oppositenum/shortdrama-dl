'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const {
  buildBarkUrl,
  describeBarkTarget,
  normalizeBarkBase,
  sendBark,
} = require(path.join(projectRoot, 'notify.js'));

const KEY = 'aBcDeFgHiJkLmNoPqRsTuV';

test('只填 key 也能用，自动补官方域名', () => {
  assert.equal(normalizeBarkBase(KEY), `https://api.day.app/${KEY}`);
  assert.equal(normalizeBarkBase(`  ${KEY}  `), `https://api.day.app/${KEY}`);
});

test('少协议、多尾斜杠都能收拾干净', () => {
  assert.equal(normalizeBarkBase(`api.day.app/${KEY}`), `https://api.day.app/${KEY}`);
  assert.equal(normalizeBarkBase(`https://api.day.app/${KEY}/`), `https://api.day.app/${KEY}`);
});

// 官方文档和示例都是「前缀/标题/内容」，整条粘进来是最常见的填法。
// 标题和内容由程序拼，粘进来的那两段必须去掉，否则推送会变成
// .../KEY/推送标题/这里改成你自己的推送内容/《剧名》已抓完/...
test('照着示例整条粘进来时，只保留 key', () => {
  assert.equal(
    normalizeBarkBase(`https://api.day.app/${KEY}/推送标题/这里改成你自己的推送内容`),
    `https://api.day.app/${KEY}`
  );
});

// 自建 Bark 常挂在子路径下，那种不敢乱截。
test('自建服务器的子路径原样保留', () => {
  assert.equal(
    normalizeBarkBase(`https://bark.example.com/bark/${KEY}`),
    `https://bark.example.com/bark/${KEY}`
  );
});

test('空值和不是 http(s) 的地址一律拒掉', () => {
  for (const bad of ['', '   ', null, undefined, 'ftp://api.day.app/k', 'javascript:alert(1)']) {
    assert.equal(normalizeBarkBase(bad), null, String(bad));
  }
});

test('标题和内容按路径转义，斜杠问号不会截断内容', () => {
  const url = buildBarkUrl(KEY, '《剧名》已抓完', '共 16 集 · /Users/me/hongguo/剧名?x=1');
  assert.match(url, new RegExp(`^https://api\\.day\\.app/${KEY}/`));
  assert.equal(url.includes('/Users/me'), false, '内容里的斜杠必须转义');
  assert.equal(url.split('?').length, 2, '只有 group 那一个问号');
  assert.match(url, /\?group=shortdrama-dl$/);

  const parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  assert.deepEqual(parts, [KEY, '《剧名》已抓完', '共 16 集 · /Users/me/hongguo/剧名?x=1']);
});

test('标题为空时兜底，内容为空时不留空段', () => {
  const url = buildBarkUrl(KEY, '', '');
  assert.equal(new URL(url).pathname, `/${KEY}/${encodeURIComponent('红果短剧下载器')}`);
});

test('地址不可用时不拼 URL', () => {
  assert.equal(buildBarkUrl('', 'a', 'b'), null);
});

// 地址里带着 key，写日志时不能整条打出来。
test('日志用的描述会把 key 打码', () => {
  const shown = describeBarkTarget(KEY);
  assert.equal(shown.includes(KEY), false);
  assert.match(shown, /^api\.day\.app\/aBc\*\*\*uV$/);
});

test('推送成功返回 ok，请求确实发到拼好的地址', async () => {
  const seen = [];
  const r = await sendBark(KEY, '标题', '内容', {
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, status: 200 };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.match(seen[0], new RegExp(`^https://api\\.day\\.app/${KEY}/`));
});

// 通知只是附带功能：Bark 挂了、网络断了都不该抛给下载流程。
test('推送失败只返回结果，不抛异常', async () => {
  const thrown = await sendBark(KEY, 't', 'b', {
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error, 'network down');

  const http500 = await sendBark(KEY, 't', 'b', {
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(http500.ok, false);
  assert.equal(http500.status, 500);

  const noConfig = await sendBark('', 't', 'b', { fetchImpl: async () => ({ ok: true }) });
  assert.equal(noConfig.ok, false);
  assert.equal(noConfig.error, 'invalid_bark_url');
});

test('没配地址时一次请求都不发', async () => {
  let called = 0;
  await sendBark('   ', 't', 'b', { fetchImpl: async () => { called++; return { ok: true }; } });
  assert.equal(called, 0);
});

// ---- 推送策略（住在 main.js 里，按源码校验关键约束）----
test('通知策略：抓完整部剧推一次，出错合并推送', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');

  // 只有真的全集齐了才推
  assert.match(src, /if \(fullyComplete\) \{\s*\n\s*notifySeriesComplete\(/);
  // error 级日志触发通知
  assert.match(src, /if \(level === 'error'\) notifyError\(message\);/);
  // 用户主动取消不算故障
  assert.match(src, /if \(isCanceled\) return;/);
  // 推送失败的那行日志不能再走 log()，否则 error 分支会绕回来变成死循环
  const pushFn = src.slice(src.indexOf('async function pushBark'), src.indexOf('/** 一部剧完整抓完'));
  assert.equal(/\blog\(/.test(pushFn), false, 'pushBark 内不能调用 log()');
  assert.match(pushFn, /send\('download:log'/);
  // 攒下的错误要在任务收尾时补发
  assert.match(src, /flushSuppressedErrors\(\); \/\//);
});

test('通知地址随设置走，且随包分发', () => {
  const builder = require(path.join(projectRoot, 'electron-builder.js'));
  assert.ok(builder.files.includes('notify.js'), 'notify.js 必须打进包里');

  const app = fs.readFileSync(path.join(projectRoot, 'renderer', 'app.js'), 'utf8');
  assert.match(app, /barkUrl: barkUrlInput\.value\.trim\(\)/);
  assert.match(app, /if \(saved\.barkUrl\) barkUrlInput\.value = saved\.barkUrl;/);

  const preload = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');
  assert.match(preload, /testNotification: \(barkUrl\) => ipcRenderer\.invoke\('notify:test'/);
});

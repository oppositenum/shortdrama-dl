'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

/**
 * 把 downloadCategory 从 main.js 里摘出来单独跑（main.js 一 require 就会拉起 Electron）。
 *
 * isCanceled / stopAfterSeries 是模块级的 let，摘出来后必须落在同一个作用域里，
 * 这样返回的 stop() 才能像真实 IPC 那样在循环跑到一半时把标志翻过去。
 */
function loadDownloadCategory({series, onSeries}) {
  const src = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const i = src.indexOf('async function downloadCategory');
  assert.notEqual(i, -1, 'main.js 里找不到 downloadCategory');
  const body = src.slice(i, src.indexOf('\n}\n', i) + 3);

  const logs = [];
  const events = [];
  const statuses = [];
  const visited = [];

  const factory = new Function('deps', `
    const {series, onSeries, logs, events, statuses, visited, path, shell} = deps;
    let isCanceled = false;
    let stopAfterSeries = false;
    const REFERER = 'https://example.invalid';
    const SERIES_RETRY_ROUNDS = 2;
    const log = (m, level) => logs.push([level || 'info', m]);
    const send = (ch, d) => events.push([ch, d]);
    const setStatus = (s) => statuses.push(s);
    const closeBrowser = async () => {};
    const sanitizeName = (s) => s;
    const hasCompleteMarker = () => false;
    const extractCategorySeries = async () => series;
    const downloadSeriesCore = async (url) => {
      const id = url.split('series_id=')[1];
      visited.push(id);
      return onSeries(id);
    };
    ${body}
    return {
      downloadCategory,
      stop: () => { stopAfterSeries = true; },
      cancel: () => { isCanceled = true; },
    };
  `);

  return {
    ...factory({series, onSeries, logs, events, statuses, visited,
                path, shell: {openPath: () => {}}}),
    logs, events, statuses, visited,
  };
}

const LIST = Array.from({length: 6}, (_, i) => ({seriesId: `s${i + 1}`, title: `剧${i + 1}`}));
const ALL_OK = () => ({complete: true, ok_count: 1, total: 1});

test('抓完当前这一部再停：正在跑的那部不被打断，后面的不再开始', async () => {
  let harness;
  // 抓第 2 部时按下按钮 —— 它必须完整返回，第 3 部起不再开工
  const onSeries = (id) => {
    if (id === 's2') harness.stop();
    return ALL_OK();
  };
  harness = loadDownloadCategory({series: LIST, onSeries});
  const r = await harness.downloadCategory('https://example.invalid/category', '/tmp/x');

  assert.deepEqual(harness.visited, ['s1', 's2'], '第 2 部必须跑完，第 3 部不该开始');
  assert.equal(r.ok, true);
  // 后面 4 部压根没开始，绝不能报"全部完成"
  assert.equal(r.complete, false);
  const done = harness.events.find(([ch]) => ch === 'download:done');
  assert.equal(done[1].stoppedEarly, true);
  assert.equal(done[1].complete, false);
  assert.ok(
    harness.logs.some(([, m]) => /已按要求停止开新的剧：完成 2\/6 部，剩余 4 部不再开始/.test(m)),
    JSON.stringify(harness.logs.map((l) => l[1]))
  );
  assert.ok(harness.statuses.some((s) => /已按要求停止/.test(s)), harness.statuses);
});

test('温和停止不抛 __CANCELED__，收尾汇总照常产出', async () => {
  let harness;
  const onSeries = (id) => {
    if (id === 's1') harness.stop();
    return ALL_OK();
  };
  harness = loadDownloadCategory({series: LIST, onSeries});
  // 立即取消走的是抛异常那条路；温和停止必须正常返回，否则汇总和 done 事件都会丢
  const r = await harness.downloadCategory('https://example.invalid/category', '/tmp/x');
  assert.equal(r.ok_count, 1);
  assert.ok(harness.events.some(([ch]) => ch === 'download:done'));
  assert.ok(harness.logs.some(([, m]) => /重新粘贴同一个分类链接再跑一次即可从这里继续/.test(m)));
});

test('温和停止后仍然把前面攒下的缺集补完', async () => {
  let harness;
  const attempts = {};
  // 每部剧第一次跑都缺集，第二次(补漏)才完整。第 2 部时按下按钮：
  // 清单里第 3 部起不再开始，但第 1、2 部的缺集必须补掉。
  const onSeries = (id) => {
    attempts[id] = (attempts[id] || 0) + 1;
    if (id === 's2' && attempts[id] === 1) harness.stop();
    return attempts[id] >= 2
      ? {complete: true, ok_count: 1, total: 1}
      : {complete: false, ok_count: 0, total: 1};
  };
  harness = loadDownloadCategory({series: LIST, onSeries});
  const r = await harness.downloadCategory('https://example.invalid/category', '/tmp/x');

  // s1/s2 各跑两次(首轮 + 补漏)，s3 之后一次都没开始
  assert.deepEqual(attempts, {s1: 2, s2: 2}, JSON.stringify(attempts));
  assert.ok(harness.logs.some(([, m]) => /先把前面攒下的 2 部缺集补完/.test(m)),
    JSON.stringify(harness.logs.map((l) => l[1])));
  assert.ok(harness.logs.some(([, m]) => /补漏第 1\/2 轮/.test(m)), '补漏轮必须跑');
  assert.equal(r.ok_count, 2, '两部都该在补漏后变完整');
  // 清单没跑完，依然不能算"全部完成"
  assert.equal(r.complete, false);
});

test('补漏过程中按「取消」才会真正停下', async () => {
  let harness;
  const attempts = {};
  const onSeries = (id) => {
    attempts[id] = (attempts[id] || 0) + 1;
    if (id === 's1' && attempts[id] === 1) harness.stop();     // 先安排温和停止
    if (id === 's1' && attempts[id] === 2) harness.cancel();   // 补漏跑起来后再硬取消
    return {complete: false, ok_count: 0, total: 1};
  };
  harness = loadDownloadCategory({series: LIST, onSeries});
  await assert.rejects(
    () => harness.downloadCategory('https://example.invalid/category', '/tmp/x'),
    /__CANCELED__/
  );
  assert.equal(attempts.s1, 2, '补漏确实开始了，然后被取消打断');
});

test('没按按钮时行为完全不变：全部跑完并报完成', async () => {
  const harness = loadDownloadCategory({series: LIST, onSeries: ALL_OK});
  const r = await harness.downloadCategory('https://example.invalid/category', '/tmp/x');
  assert.deepEqual(harness.visited, LIST.map((s) => s.seriesId));
  assert.equal(r.complete, true);
  const done = harness.events.find(([ch]) => ch === 'download:done');
  assert.equal(done[1].stoppedEarly, false);
  assert.ok(harness.statuses.some((s) => /全部完成/.test(s)), harness.statuses);
});

test('立即取消仍然是抛 __CANCELED__，不受这次改动影响', async () => {
  let harness;
  const onSeries = (id) => {
    if (id === 's2') harness.cancel();
    return ALL_OK();
  };
  harness = loadDownloadCategory({series: LIST, onSeries});
  await assert.rejects(
    () => harness.downloadCategory('https://example.invalid/category', '/tmp/x'),
    /__CANCELED__/
  );
});

test('主进程不会把温和停止误当成硬取消', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const i = src.indexOf('async function handleStopAfterSeries');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  // 这个处理器【绝不能】设 isCanceled 或杀任何子进程——那会打断正在抓的这一部
  assert.doesNotMatch(body, /isCanceled\s*=\s*true/);
  for (const killer of ['killGrab', 'killFfmpeg', 'abortDirect', 'closeBrowser']) {
    assert.doesNotMatch(body, new RegExp(killer), `不该调用 ${killer}`);
  }
  assert.match(body, /stopAfterSeries = true/);
  // 每次开新任务都要复位，否则上一轮的安排会漏到下一轮
  assert.match(src, /isCanceled = false;\s*\n\s*stopAfterSeries = false;/);
});

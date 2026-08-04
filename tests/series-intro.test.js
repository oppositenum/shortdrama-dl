'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const { createSeriesFiles } = require(path.join(projectRoot, 'series-files.js'));

/**
 * 简介生成以前住在 main.js 里，而 main.js 一 require 就会拉起 Electron，
 * 所以这里曾经要把源码抠出来用 new Function 求值。搬进 series-files.js 之后
 * 直接 require 就行——测的是真模块，不是一段被复制出来的源码。
 */
function loadIntroWriters(logs) {
  const { writeSeriesIntro } = createSeriesFiles({
    log: (message, level) => logs.push([level || 'info', message]),
  });
  return writeSeriesIntro;
}

const INFO = {
  seriesId: '7654815340509006910',
  seriesName: '这个乞丐神医太无敌了',
  episodeCnt: 86,
  vidList: new Array(86).fill('v'),
  cover: 'https://example.invalid/c.jpg',
  intro: '林夜武道医术通神，下山与叶家大小姐履行婚约。',
  tags: ['都市', '无敌神医'],
  episodeText: '全86集',
  updatedCnt: 86,
  totalEpisodeCnt: 86,
  celebrities: [{name: '李书滔', role: '饰 林夜'}, {name: '聂彭逸辰', role: '饰 司徒宇'}],
};

const DETAIL_ONLY = ['集数', '标签', 'series_id', '详情页', '演职人员', '抓取时间', '【简介】'];

function writeTo(t, opts, info = INFO) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const logs = [];
  loadIntroWriters(logs)(info, dir, opts);
  return {text: fs.readFileSync(path.join(dir, '简介.txt'), 'utf8'), logs};
}

test('默认是简洁模式：只有剧名和简介', (t) => {
  // 不传 opts 也必须走简洁模式——默认值是这个功能的约定
  for (const opts of [undefined, {}, {detailed: false}]) {
    const {text, logs} = writeTo(t, opts);
    assert.equal(text, '这个乞丐神医太无敌了\n\n林夜武道医术通神，下山与叶家大小姐履行婚约。\n');
    for (const w of DETAIL_ONLY) assert.doesNotMatch(text, new RegExp(w), `简洁模式不该出现「${w}」`);
    assert.deepEqual(logs, [['info', '简介已保存：简介.txt（简洁）']]);
  }
});

test('详细模式：带集数、标签、来源和演职人员', (t) => {
  const {text, logs} = writeTo(t, {detailed: true, sourceUrl: 'https://hongguoduanju.com/detail?series_id=765'});
  assert.match(text, /^这个乞丐神医太无敌了\n/);
  assert.match(text, /集数：全86集（共 86 集）/);
  assert.match(text, /标签：都市 \/ 无敌神医/);
  assert.match(text, /series_id：7654815340509006910/);
  assert.match(text, /详情页：https:\/\/hongguoduanju\.com\/detail\?series_id=765/);
  assert.match(text, /【简介】\n林夜武道医术通神/);
  // 名字按最长的补空格对齐
  assert.match(text, /李书滔   饰 林夜/);   // 3 字名补 1 空格 + 固定 2 空格
  assert.match(text, /聂彭逸辰  饰 司徒宇/);
  assert.match(text, /抓取时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  // 已更新==总集数时这行没有信息量
  assert.doesNotMatch(text, /已更新/);
  // series_status 是个看不懂的原始数字码，任何模式都不该印
  assert.doesNotMatch(text, /状态：\d/);
  assert.deepEqual(logs, [['info', '简介已保存：简介.txt（详细）']]);
});

test('详细模式下连载中的剧才写「已更新」', (t) => {
  const {text} = writeTo(t, {detailed: true}, {...INFO, updatedCnt: 30, totalEpisodeCnt: 86});
  assert.match(text, /已更新：30 \/ 共 86 集/);
});

test('两种模式在字段全缺时都照常出文件，且绝不抛异常', (t) => {
  for (const detailed of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const write = loadIntroWriters([]);
    assert.doesNotThrow(() => write({}, dir, {detailed}));
    const text = fs.readFileSync(path.join(dir, '简介.txt'), 'utf8');
    assert.doesNotMatch(text, /undefined|NaN|\[object/, `detailed=${detailed} 输出了占位符`);
  }
});

test('目录不可写时只记警告，不影响剧集下载', () => {
  for (const detailed of [false, true]) {
    const logs = [];
    const write = loadIntroWriters(logs);
    assert.doesNotThrow(() => write(INFO, '/no/such/dir/at/all', {detailed}));
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
    assert.match(logs[0][1], /简介保存失败（不影响剧集）/);
  }
});

test('界面选项一路传到写文件，且默认简洁', () => {
  const main = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(projectRoot, 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(projectRoot, 'renderer', 'index.html'), 'utf8');

  // 复选框默认不勾选 = 简洁模式
  assert.match(html, /<input id="introDetailed" type="checkbox" \/>/);
  assert.doesNotMatch(html, /<input id="introDetailed"[^>]*checked/);

  assert.match(app, /introDetailed: introDetailedCheckbox\.checked/);
  assert.match(main, /introDetailed: introDetailed === true/);   // 只有显式 true 才详细
  // grabMode 为主；opts 解构仍默认 introDetailed=false
  assert.match(main, /const grabMode = opts\.grabMode/);
  assert.match(main, /const \{ grabDir = null, introDetailed = false \} = opts/);
  assert.match(main, /writeSeriesIntro\(info, seriesDir, \{ detailed: introDetailed/);
  // 简介生成本身已经搬进 series-files.js，main.js 只负责把选项传过去
  assert.equal(main.includes('function buildIntroDetailed'), false);
});

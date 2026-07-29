'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

/**
 * writeSeriesIntro 住在 main.js 里，而 main.js 一 require 就会拉起 Electron。
 * 这里把该函数的源码摘出来单独求值，只喂它真正用到的几个外部依赖。
 */
function loadWriteSeriesIntro(logs) {
  const src = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const start = src.indexOf('function writeSeriesIntro');
  assert.notEqual(start, -1, 'main.js 里找不到 writeSeriesIntro');
  const body = src.slice(start, src.indexOf('// ====', start));
  const log = (message, level) => logs.push([level || 'info', message]);
  return new Function('fs', 'path', 'log', `${body};return writeSeriesIntro;`)(fs, path, log);
}

test('简介.txt 只写剧名和简介', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const logs = [];
  loadWriteSeriesIntro(logs)(
    {
      seriesId: '7654815340509006910',
      seriesName: '这个乞丐神医太无敌了',
      episodeCnt: 86,
      vidList: new Array(86).fill('v'),
      cover: 'https://example.invalid/c.jpg',
      intro: '林夜武道医术通神，下山与叶家大小姐履行婚约。',
    },
    dir
  );

  const text = fs.readFileSync(path.join(dir, '简介.txt'), 'utf8');
  assert.equal(text, '这个乞丐神医太无敌了\n\n林夜武道医术通神，下山与叶家大小姐履行婚约。\n');
  // 剧名与简介之外的一律不写进来
  for (const unwanted of ['集数', '标签', 'series_id', '详情页', '演职人员', '抓取时间', '【简介】']) {
    assert.doesNotMatch(text, new RegExp(unwanted), `不该出现「${unwanted}」`);
  }
  assert.deepEqual(logs, [['info', '简介已保存：简介.txt']]);
});

test('没有简介时只留剧名，不留空行', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  loadWriteSeriesIntro([])({seriesName: '无简介剧'}, dir);
  assert.equal(fs.readFileSync(path.join(dir, '简介.txt'), 'utf8'), '无简介剧\n');
});

test('字段全缺时照常出文件，且绝不抛异常', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const write = loadWriteSeriesIntro([]);
  assert.doesNotThrow(() => write({}, dir));
  const text = fs.readFileSync(path.join(dir, '简介.txt'), 'utf8');
  assert.doesNotMatch(text, /undefined|NaN|\[object/);
});

test('目录不可写时只记警告，不影响剧集下载', () => {
  const logs = [];
  const write = loadWriteSeriesIntro(logs);
  assert.doesNotThrow(() => write({seriesName: 'x', intro: 'y'}, '/no/such/dir/at/all'));
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'warn');
  assert.match(logs[0][1], /简介保存失败（不影响剧集）/);
});

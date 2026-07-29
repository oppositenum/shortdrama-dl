'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  appGrabRange,
  isCompleteMarker,
  normalizeEpisodeCount,
} = require('../series-workflow');

test('whole-series App capture always starts at episode 1', () => {
  assert.deepEqual(appGrabRange(80), {startEp: 1, endEp: 80});
  assert.deepEqual(appGrabRange(1), {startEp: 1, endEp: 1});
  assert.equal(appGrabRange(0), null);
});

test('detail episode count falls back to vid_list length without using free count', () => {
  assert.equal(normalizeEpisodeCount(80, 5), 80);
  assert.equal(normalizeEpisodeCount(0, 63), 63);
  assert.equal(normalizeEpisodeCount(undefined, 0), 0);
});

test('only a total/total marker represents a completed series', () => {
  assert.equal(isCompleteMarker('80/80\n'), true);
  assert.equal(isCompleteMarker('1/1'), true);
  assert.equal(isCompleteMarker('5/80\n'), false);
  assert.equal(isCompleteMarker('0/0\n'), false);
  assert.equal(isCompleteMarker('done'), false);
});

test('whole-series core has no web episode capture loop', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('async function downloadSeriesCore');
  const end = source.indexOf('/** 整剧下载（详情页链接）', start);
  assert.ok(start >= 0 && end > start);
  const core = source.slice(start, end);

  assert.doesNotMatch(core, /captureVideoSource\(/);
  assert.doesNotMatch(core, /accessible/);
  assert.match(core, /startEp: range\.startEp/);
  assert.match(core, /endEp: range\.endEp/);
  assert.match(core, /网页视频 0 集/);
});

test('detail metadata parsing does not require any web episode entry', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('async function extractSeriesInfo');
  const end = source.indexOf('// 核心一：', start);
  assert.ok(start >= 0 && end > start);
  const extractor = source.slice(start, end);

  assert.match(extractor, /sd\?\.series_name/);
  assert.match(extractor, /sd\?\.episode_cnt/);
  assert.match(extractor, /Array\.isArray\(sd\?\.vid_list\) \? sd\.vid_list : \[\]/);
  assert.doesNotMatch(extractor, /accessible_episode_cnt/);
  assert.doesNotMatch(extractor, /!info\.vidList\.length/);
});

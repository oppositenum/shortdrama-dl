'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const appJs = path.join(projectRoot, 'renderer', 'app.js');
const indexHtml = path.join(projectRoot, 'renderer', 'index.html');

/**
 * 日志滚动那段住在 renderer/app.js 里，那个文件一执行就要真的 DOM。
 * 按 series-intro.test.js 的老办法把这段单独摘出来，喂一个够用的假 DOM：
 * 一个能记住滚动位置的 log 容器 + 一个假按钮。
 */
function loadLogScroll({ clientHeight = 100, lineHeight = 10 } = {}) {
  const src = fs.readFileSync(appJs, 'utf8');
  const start = src.indexOf('// ---------- 日志滚动 ----------');
  assert.notEqual(start, -1, 'app.js 里找不到日志滚动段落');
  const end = src.indexOf('function setDot(', start);
  assert.notEqual(end, -1, 'app.js 里找不到日志滚动段落的结尾');
  const body = src.slice(start, end);

  const handlers = {};
  const logEl = {
    children: [],
    scrollTop: 0,
    clientHeight,
    get scrollHeight() {
      return this.children.length * lineHeight;
    },
    appendChild(node) {
      this.children.push(node);
    },
    addEventListener(type, fn) {
      handlers[type] = fn;
    },
  };
  const logJumpBtn = {
    textContent: '',
    hidden: true,
    addEventListener(type, fn) {
      handlers[`btn:${type}`] = fn;
    },
  };
  const document = {
    createElement: () => ({
      className: '',
      innerHTML: '',
      querySelector: () => ({ textContent: '' }),
    }),
  };

  const api = new Function(
    'logEl', 'logJumpBtn', 'document',
    `${body};return { appendLog, scrollLogToBottom, isLogAtBottom };`
  )(logEl, logJumpBtn, document);

  return {
    ...api,
    logEl,
    logJumpBtn,
    // 模拟用户滚动：改位置并触发 scroll
    scrollTo(top) {
      logEl.scrollTop = top;
      handlers.scroll();
    },
    clickJump() {
      handlers['btn:click']();
    },
  };
}

function fill(ui, count) {
  for (let i = 0; i < count; i++) {
    ui.appendLog({ time: '00:00:00', level: 'info', message: `line ${i}` });
  }
}

test('视线在底部时，新日志照常跟到最新', () => {
  const ui = loadLogScroll();
  fill(ui, 40);
  assert.equal(ui.logEl.scrollTop, ui.logEl.scrollHeight);
  assert.equal(ui.logJumpBtn.hidden, true, '跟随状态下不该弹提示');
});

// 这就是这次要修的：往上翻历史的时候来了新日志，视线被拽回底部，历史根本看不完。
test('往上翻历史时，新日志不动滚动位置', () => {
  const ui = loadLogScroll();
  fill(ui, 40);

  ui.scrollTo(50); // 用户翻到中间
  fill(ui, 5);

  assert.equal(ui.logEl.scrollTop, 50, '滚动位置必须原地不动');
  assert.equal(ui.logJumpBtn.hidden, false);
  assert.match(ui.logJumpBtn.textContent, /5 条新日志/);
});

test('点提示回到底部后，重新跟随最新', () => {
  const ui = loadLogScroll();
  fill(ui, 40);
  ui.scrollTo(50);
  fill(ui, 3);

  ui.clickJump();
  assert.equal(ui.logEl.scrollTop, ui.logEl.scrollHeight);
  assert.equal(ui.logJumpBtn.hidden, true);

  fill(ui, 2);
  assert.equal(ui.logEl.scrollTop, ui.logEl.scrollHeight, '回到底部后应恢复自动跟随');
  assert.equal(ui.logJumpBtn.hidden, true);
});

test('自己滚回底部也算数，计数清零', () => {
  const ui = loadLogScroll();
  fill(ui, 40);
  ui.scrollTo(50);
  fill(ui, 4);
  assert.equal(ui.logJumpBtn.hidden, false);

  ui.scrollTo(ui.logEl.scrollHeight - ui.logEl.clientHeight);
  assert.equal(ui.logJumpBtn.hidden, true);
});

test('差一点点到底（行高取整/惯性）仍算在底部', () => {
  const ui = loadLogScroll();
  fill(ui, 40);
  const bottom = ui.logEl.scrollHeight - ui.logEl.clientHeight;
  ui.scrollTo(bottom - 8); // 8px 在容差内
  fill(ui, 1);
  assert.equal(ui.logEl.scrollTop, ui.logEl.scrollHeight);
  assert.equal(ui.logJumpBtn.hidden, true);
});

// 布局：左侧菜单切换右侧内容。四个页面都在，且每个都有对应的导航项。
test('侧栏导航覆盖全部四个页面', () => {
  const html = fs.readFileSync(indexHtml, 'utf8');
  for (const view of ['download', 'settings', 'env', 'log']) {
    assert.match(html, new RegExp(`class="nav-item[^"]*"[^>]*data-view="${view}"`), `缺导航项 ${view}`);
    assert.match(html, new RegExp(`class="view [^"]*"[^>]*data-view="${view}"`), `缺内容页 ${view}`);
  }
});

// 状态条和进度条必须在页面容器（.content-body）之外，切到任何页都看得到下载进度。
test('状态条与进度条常驻在页面容器之外', () => {
  const html = fs.readFileSync(indexHtml, 'utf8');
  const statusAt = html.indexOf('class="statusbar"');
  const progressAt = html.indexOf('id="progressBar"');
  const bodyAt = html.indexOf('class="content-body"');
  assert.ok(statusAt !== -1 && progressAt !== -1 && bodyAt !== -1);
  assert.ok(statusAt < bodyAt, '状态条要在 content-body 前面（常驻）');
  assert.ok(progressAt < bodyAt, '进度条要在 content-body 前面（常驻）');
});

// 开始/取消按钮在下载页里，不该被藏进任何会整体隐藏的容器之外的机制里——
// 这里保证它们和链接输入同处下载页，切页只影响可见性由 CSS 控制。
test('下载操作按钮与链接输入同在下载页', () => {
  const html = fs.readFileSync(indexHtml, 'utf8');
  const viewStart = html.indexOf('class="view view-download');
  const viewEnd = html.indexOf('class="view view-settings');
  assert.ok(viewStart !== -1 && viewEnd !== -1 && viewStart < viewEnd);
  const downloadView = html.slice(viewStart, viewEnd);
  assert.match(downloadView, /id="url"/);
  assert.match(downloadView, /id="start"/);
  assert.match(downloadView, /id="cancel"/);
});

// 记住上次停在哪一页，下次打开还在那。
test('当前页会被记住并在启动时恢复', () => {
  const app = fs.readFileSync(appJs, 'utf8');
  assert.match(app, /saveSettings\(\{ activeView: target \}\)/, '切页要记住 activeView');
  assert.match(app, /showView\(saved\.activeView\)/, '启动时要恢复上次的页面');

  // 只显示当前激活的视图
  const css = fs.readFileSync(path.join(projectRoot, 'renderer', 'style.css'), 'utf8');
  assert.match(css, /\.view \{[^}]*display: none;/s);
  assert.match(css, /\.view\.active \{[^}]*display: block;/s);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const appJs = path.join(projectRoot, 'renderer', 'app.js');
const mainJs = path.join(projectRoot, 'main.js');
const indexHtml = path.join(projectRoot, 'renderer', 'index.html');

/**
 * resolveSavedGrabMode 住在 renderer/app.js 里，那个文件一执行就要 document/window。
 * 和 series-intro.test.js 一样，把这段源码单独摘出来求值。
 */
function loadResolver() {
  const src = fs.readFileSync(appJs, 'utf8');
  const start = src.indexOf('const SETTINGS_VERSION');
  assert.notEqual(start, -1, 'renderer/app.js 里找不到 SETTINGS_VERSION');
  const end = src.indexOf('// ---------- 记忆', start);
  assert.notEqual(end, -1, 'renderer/app.js 里找不到设置保存段落');
  let body = src.slice(start, end);
  // 这两个函数要摸 DOM 单选框，和迁移逻辑无关，替换成不做事的桩。
  body = body.replace(/function getGrabMode\(\)[\s\S]*?\n}\n/, 'function getGrabMode() { return "offline"; }\n');
  body = body.replace(/function setGrabMode\(mode\)[\s\S]*?\n}\n/, 'function setGrabMode() {}\n');
  return new Function(`${body};return { resolveSavedGrabMode, SETTINGS_VERSION, GRAB_MODE_LABEL };`)();
}

const { resolveSavedGrabMode, SETTINGS_VERSION, GRAB_MODE_LABEL } = loadResolver();

// 实测踩过：旧版界面只有一个默认勾上的「App 抓取」复选框。升级后那份 appGrab:true
// 被原样当成"用户要 App 抓取"，于是日志写着"默认纯协议"、程序却跑去装模拟器。
// 旧默认值不是用户的选择，迁移时要落到新默认「纯协议」。
test('旧版默认的 App 抓取迁移成纯协议，并提示用户', () => {
  assert.deepEqual(resolveSavedGrabMode({ appGrab: true }), { mode: 'api', migrated: true });
  assert.deepEqual(resolveSavedGrabMode({ grabMode: 'app', appGrab: true }), { mode: 'api', migrated: true });
});

test('旧版用户主动关掉的抓取（appGrab:false）保持只存封面', () => {
  assert.deepEqual(resolveSavedGrabMode({ appGrab: false }), { mode: 'none', migrated: false });
  assert.deepEqual(resolveSavedGrabMode({ grabMode: 'none' }), { mode: 'none', migrated: false });
});

test('v3 里选定的四种模式一律照搬', () => {
  for (const mode of ['offline', 'app', 'api', 'none']) {
    assert.deepEqual(
      resolveSavedGrabMode({ settingsVersion: SETTINGS_VERSION, grabMode: mode }),
      { mode, migrated: false }
    );
  }
});

test('v2 用户已选的 api/app/none 升级到 v3 不改动', () => {
  assert.deepEqual(
    resolveSavedGrabMode({ settingsVersion: 2, grabMode: 'api' }),
    { mode: 'api', migrated: false }
  );
  assert.deepEqual(
    resolveSavedGrabMode({ settingsVersion: 2, grabMode: 'app' }),
    { mode: 'app', migrated: false }
  );
});

test('没有任何设置时用新默认「本机签名纯协议」，且不当成迁移', () => {
  assert.deepEqual(resolveSavedGrabMode({}), { mode: 'offline', migrated: false });
  assert.deepEqual(resolveSavedGrabMode({ settingsVersion: SETTINGS_VERSION }), {
    mode: 'offline',
    migrated: false,
  });
  assert.match(GRAB_MODE_LABEL.offline, /本机签名/);
  assert.equal(GRAB_MODE_LABEL.offline.includes('离线六神'), false);
});

// 就绪提示必须报本次真正生效的模式：写死一句"默认纯协议"正是误导的来源。
test('就绪提示在读完设置之后才打，且带上实际模式', () => {
  const src = fs.readFileSync(appJs, 'utf8');
  const initAt = src.indexOf('async function initSettings()');
  const readyAt = src.indexOf('就绪。当前抓取方式');
  assert.ok(readyAt > initAt, '就绪提示必须在 initSettings 里、读完设置之后');
  assert.match(src, /GRAB_MODE_LABEL\[mode\]/);
  assert.equal(src.includes('就绪。默认「纯协议下载」'), false, '不能再打写死的默认模式提示');
  for (const mode of ['offline', 'app', 'api', 'none']) {
    assert.ok(GRAB_MODE_LABEL[mode], `缺少 ${mode} 的模式文案`);
  }
});

test('界面与 main 支持第四种 offline 模式', () => {
  const html = fs.readFileSync(indexHtml, 'utf8');
  assert.match(html, /id="modeOffline"/);
  assert.match(html, /value="offline"/);
  assert.match(html, /id="modeApi"/);
  assert.match(html, /id="modeApp"/);
  assert.match(html, /id="modeNone"/);

  const main = fs.readFileSync(mainJs, 'utf8');
  assert.match(main, /mode === 'offline'/);
  assert.match(main, /signMode === 'offline'/);
  assert.match(main, /--offline-sign/);
  assert.match(main, /grabModeLabel/);
  assert.match(main, /metasec_offline\.py/);
});

test('SETTINGS_VERSION 至少为 3（四选一 grabMode）', () => {
  assert.ok(SETTINGS_VERSION >= 3);
});

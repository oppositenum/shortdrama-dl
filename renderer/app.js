/**
 * app.js —— 渲染进程逻辑
 *
 * 仅通过 preload 暴露的 window.api 与主进程通信，不直接触碰 Node / ipcRenderer。
 */

'use strict';

// ---------- DOM 引用 ----------
const $ = (id) => document.getElementById(id);
const urlInput = $('url');
const dirInput = $('dir');
const chooseDirBtn = $('chooseDir');
const modeApp = $('modeApp');
const modeApi = $('modeApi');
const modeOffline = $('modeOffline');
const modeNone = $('modeNone');
const grabDirInput = $('grabDir');
const chooseGrabDirBtn = $('chooseGrabDir');
const grabDirRow = $('grabDirRow');
const introDetailedCheckbox = $('introDetailed');
const barkUrlInput = $('barkUrl');
const testNotifyBtn = $('testNotify');
const startBtn = $('start');
const cancelBtn = $('cancel');
const stopAfterSeriesBtn = $('stopAfterSeries');
const openDirBtn = $('openDir');
const clearLogBtn = $('clearLog');
const envRecheckBtn = $('envRecheck');
const envFixBtn = $('envFix');
const envSummary = $('envSummary');
const navEl = $('nav');
const appVersionEl = $('appVersion');
const logJumpBtn = $('logJump');
const taskbarEl = $('taskbar');
const pageTitleEl = $('pageTitle');
const pageSubEl = $('pageSub');
const actionsEl = $('actions');

const statusText = $('status');
const statusDot = $('statusDot');
const episodeEl = $('episode');
const progressBar = $('progressBar');
const progressText = $('progressText');
const timemarkEl = $('timemark');
const speedEl = $('speed');
const logEl = $('log');

// ---------- 状态 ----------
let selectedDir = '';   // 用户选择的目录
let lastFilePath = '';  // 最近一次完成/进行的目标文件路径（用于"打开文件夹"）
let downloading = false;
// 「修复缺失项」是否可点，只看这 3 项——红果 App / Frida Server 没有对应的修复动作
const FIXABLE_ENV_IDS = ['python', 'ffmpeg', 'android'];
const envItemState = { python: 'checking', ffmpeg: 'checking', android: 'checking',
  hongguo_app: 'checking', frida_server: 'checking' };

// ---------- 抓取方式 ----------
// 设置结构版本：
//   1（或缺失）= 只有「App 抓取」开关
//   2 = 三选一 grabMode：api | app | none
//   3 = 四选一：offline | api | app | none（offline=本机签名纯协议，内部 id 未改以免坏设置）
// 旧设置里的 appGrab: true 是当年的默认值而不是用户的选择，迁移时不能直接当成
// "用户要 App 抓取"，否则升级后仍会去装模拟器——见 GRAB_MODE_LABEL 下面的迁移逻辑。
const SETTINGS_VERSION = 3;
const GRAB_MODE_LABEL = {
  offline: '本机签名纯协议（无需模拟器，下载需联网）',
  api: '纯协议下载（可借模拟器签名回退）',
  app: 'App 抓取（需 root 安卓 + Frida）',
  none: '仅保存封面与简介',
};

function getGrabMode() {
  if (modeOffline && modeOffline.checked) return 'offline';
  if (modeApi && modeApi.checked) return 'api';
  if (modeNone && modeNone.checked) return 'none';
  return 'app';
}

function setGrabMode(mode) {
  if (mode === 'offline' && modeOffline) modeOffline.checked = true;
  else if (mode === 'api' && modeApi) modeApi.checked = true;
  else if (mode === 'none' && modeNone) modeNone.checked = true;
  else if (modeApp) modeApp.checked = true;
  syncGrabDirRow();
}

/**
 * 从已保存的设置里定出启动时的抓取方式。
 * 返回 { mode, migrated }：migrated=true 表示这次是从旧版默认值迁移过来的，
 * 调用方需要提示用户，并把新的 settingsVersion 落盘，避免下次又迁一遍。
 */
function resolveSavedGrabMode(saved = {}) {
  const known = (m) => m === 'offline' || m === 'app' || m === 'api' || m === 'none';

  // v3+：用户选过什么就是什么（含 offline / api / app / none）。
  if (saved.settingsVersion >= SETTINGS_VERSION) {
    return { mode: known(saved.grabMode) ? saved.grabMode : 'offline', migrated: false };
  }
  // v2：三选一已选定的模式照搬，并升到 v3 时不改用户选择。
  if (saved.settingsVersion >= 2 && known(saved.grabMode) && saved.grabMode !== 'offline') {
    return { mode: saved.grabMode, migrated: false };
  }
  if (saved.settingsVersion >= 2 && saved.grabMode === 'offline') {
    return { mode: 'offline', migrated: false };
  }
  // 旧版设置：关掉过抓取是用户的主动选择，尊重它。
  if (saved.grabMode === 'none' || saved.appGrab === false) {
    return { mode: 'none', migrated: false };
  }
  // grabMode:'app' / appGrab:true 都只是旧版默认值，不是选择，迁到「纯协议」。
  if (saved.grabMode === 'app' || saved.appGrab === true) {
    return { mode: 'api', migrated: true };
  }
  // 头一次运行：新默认「本机签名纯协议」。
  return { mode: 'offline', migrated: false };
}

// ---------- 记忆：保存上次填写的内容 ----------
function saveFormState() {
  window.api.saveSettings({
    settingsVersion: SETTINGS_VERSION,
    url: urlInput.value,
    dir: selectedDir,
    grabMode: getGrabMode(),
    appGrab: getGrabMode() === 'app', // 兼容旧设置字段
    grabDir: grabDirInput.value,
    introDetailed: introDetailedCheckbox.checked,
    barkUrl: barkUrlInput.value.trim(),
  });
}

// ==========================================================================
// 环境检查
// ==========================================================================
const ENV_IDS = ['python', 'ffmpeg', 'android', 'hongguo_app', 'frida_server'];

function setEnvRow(id, state, message) {
  const row = document.querySelector(`.env-row[data-env="${id}"]`);
  if (!row) return;
  envItemState[id] = state;
  const dot = row.querySelector('.env-dot');
  // 纯展示映射：主进程对「当前模式无需」的项发的是 ok + 说明文字，
  // 界面上把它画成灰色 "—" 而不是绿色 ✓，正常与无需一眼可分。
  const displayState =
    state === 'ok' && /不需要|无需/.test(message || '') ? 'blocked' : state;
  dot.className = 'env-dot ' + displayState;
  row.querySelector('.env-msg').textContent = message || '';
  updateEnvSummary();
}

function resetEnvRows() {
  for (const row of document.querySelectorAll('.env-row')) {
    const id = row.dataset.env;
    setEnvRow(id, 'checking', '检查中…');
  }
}

function updateEnvSummary() {
  // 侧栏只给一个克制的信号：全部就绪 ✓ / 有待处理项给数字 / 检查中 …
  const anyChecking = ENV_IDS.some((id) => envItemState[id] === 'checking');
  const troubleCount = ENV_IDS.filter((id) =>
    ['missing', 'warn', 'error'].includes(envItemState[id])
  ).length;
  envSummary.textContent = anyChecking ? '…' : troubleCount ? String(troubleCount) : '✓';
  envSummary.classList.toggle('attention', !anyChecking && troubleCount > 0);
}

// ==========================================================================
// 侧栏导航：点菜单切右侧内容，记住上次停在哪一页。
// 状态条和进度条在内容顶部常驻，切到任何页都看得到下载进度。
// ==========================================================================
const VIEWS = ['download', 'settings', 'env', 'log'];
const VIEW_META = {
  download: ['下载', '输入短剧链接，选择下载方式后开始任务'],
  settings: ['设置', '管理下载目录、组件路径和通知'],
  env: ['环境检查', '检查当前下载方式所需的组件'],
  log: ['运行日志', '任务运行过程的实时输出'],
};

function showView(view) {
  const target = VIEWS.includes(view) ? view : 'download';
  for (const item of navEl.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.view === target);
  }
  for (const panel of document.querySelectorAll('.view')) {
    panel.classList.toggle('active', panel.dataset.view === target);
  }
  const [title, sub] = VIEW_META[target];
  pageTitleEl.textContent = title;
  pageSubEl.textContent = sub;
  // 切到日志页时，若视线本就在底部则跟到最新（新日志可能是切走时攒下的）
  if (target === 'log' && logPinnedToBottom) scrollLogToBottom();
  window.api.saveSettings({ activeView: target });
}

navEl.addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (item) showView(item.dataset.view);
});

window.api.onEnvBegin(() => {
  envRecheckBtn.disabled = true;
  envFixBtn.disabled = true;
  envFixBtn.hidden = true;
  resetEnvRows();
});

window.api.onEnvItem((d) => setEnvRow(d.id, d.state, d.message));

window.api.onEnvDone(() => {
  envRecheckBtn.disabled = false;
  envFixBtn.disabled = !FIXABLE_ENV_IDS.some(
    (id) => envItemState[id] === 'missing' || envItemState[id] === 'warn'
  );
  // 没有可修复项时不显示一个永远禁用的按钮
  envFixBtn.hidden = envFixBtn.disabled;
});

function runEnvCheck() {
  window.api.checkEnvironment(grabDirInput.value.trim(), getGrabMode());
}

function runEnvFix() {
  window.api.fixEnvironment(grabDirInput.value.trim(), getGrabMode());
}

envRecheckBtn.addEventListener('click', () => {
  runEnvCheck();
});

envFixBtn.addEventListener('click', () => {
  runEnvFix();
});

// ==========================================================================
// UI 辅助
// ==========================================================================
// ---------- 日志滚动 ----------
// 只有视线本来就在底部时才自动跟到最新。用户往上翻历史的时候，新日志照常写进去，
// 但绝不动他的滚动位置——被拽回底部会让人根本看不完一行。攒了多少条只在右下角提示，
// 点一下（或自己滚回底部）才回到最新。
const LOG_BOTTOM_SLACK_PX = 24; // 差这点距离仍算“在底部”，容忍行高取整和惯性滚动
let logPinnedToBottom = true;
let pendingLogCount = 0;

function isLogAtBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= LOG_BOTTOM_SLACK_PX;
}

function renderLogJump() {
  if (pendingLogCount > 0) {
    logJumpBtn.textContent = `↓ ${pendingLogCount} 条新日志`;
    logJumpBtn.hidden = false;
  } else {
    logJumpBtn.hidden = true;
  }
}

function scrollLogToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
  logPinnedToBottom = true;
  pendingLogCount = 0;
  renderLogJump();
}

logEl.addEventListener('scroll', () => {
  logPinnedToBottom = isLogAtBottom();
  if (logPinnedToBottom && pendingLogCount) {
    pendingLogCount = 0;
    renderLogJump();
  }
});

logJumpBtn.addEventListener('click', scrollLogToBottom);

const LOG_LEVEL_LABEL = { info: 'INFO', success: 'OK', warn: 'WARN', error: 'ERROR' };

function appendLog({ time, level, message }) {
  // 追加发生在可视区下方，浏览器不会改 scrollTop，所以停在半路的视线自然不受影响。
  const wasPinned = logPinnedToBottom;
  const line = document.createElement('div');
  line.className = `log-line ${level || 'info'}`;
  line.innerHTML =
    `<span class="log-time">${time || ''}</span>` +
    `<span class="log-level"></span>` +
    `<span class="log-msg"></span>`;
  line.querySelector('.log-level').textContent = LOG_LEVEL_LABEL[level] || 'INFO';
  line.querySelector('.log-msg').textContent = message;
  logEl.appendChild(line);
  if (wasPinned) {
    logEl.scrollTop = logEl.scrollHeight;
  } else {
    pendingLogCount++;
    renderLogJump();
  }
}

function setDot(state) {
  statusDot.className = 'status-dot' + (state ? ' ' + state : '');
}

function setProgress(percent) {
  const p = Math.max(0, Math.min(100, percent || 0));
  progressBar.style.width = p + '%';
  progressText.textContent = p.toFixed(1) + '%';
}

function setDownloadingUI(on) {
  downloading = on;
  // 按钮按状态显隐（CSS 依据 .running 切换）：空闲只留「开始下载」，
  // 下载中换成「打开文件夹 / 抓完本部再停 / 取消任务」。
  actionsEl.classList.toggle('running', on);
  startBtn.disabled = on;
  cancelBtn.disabled = !on;
  stopAfterSeriesBtn.disabled = !on;
  if (on) stopAfterSeriesBtn.textContent = '抓完本部再停';
  urlInput.disabled = on;
  chooseDirBtn.disabled = on;
  if (modeApp) modeApp.disabled = on;
  if (modeApi) modeApi.disabled = on;
  if (modeOffline) modeOffline.disabled = on;
  if (modeNone) modeNone.disabled = on;
  grabDirInput.disabled = on || getGrabMode() === 'none';
  chooseGrabDirBtn.disabled = on || getGrabMode() === 'none';
  introDetailedCheckbox.disabled = on;
  barkUrlInput.disabled = on;
  testNotifyBtn.disabled = on;
  startBtn.querySelector('.btn-text').textContent = on ? '下载中…' : '开始下载';
}

// ==========================================================================
// 事件订阅（主进程 -> 渲染进程）
// ==========================================================================
window.api.onLog((d) => appendLog(d));

window.api.onStatus((text) => {
  taskbarEl.hidden = false;
  statusText.textContent = text;
  setDot('running');
});

window.api.onProgress((d) => {
  setProgress(d.percent);
  if (d.timemark) timemarkEl.textContent = d.timemark;
  speedEl.textContent = d.speed || '';
});

let seriesLabel = '';

window.api.onSeries((d) => {
  seriesLabel = `第 ${d.current}/${d.total} 部`;
  episodeEl.textContent = `${seriesLabel}《${d.title || ''}》`;
});

window.api.onEpisode((d) => {
  const prefix = seriesLabel ? `${seriesLabel} · ` : '';
  episodeEl.textContent = `${prefix}第 ${d.current} / ${d.total} 集`;
});

window.api.onDone((d) => {
  lastFilePath = d.filePath || lastFilePath;
  if (d.complete === false) {
    statusText.textContent = d.coverOnly
      ? '封面已保存，未抓到视频'
      : `任务结束：完成 ${d.okCount || 0}/${d.total || 0}`;
  } else {
    statusText.textContent = '下载完成 ✅';
  }
  setDot('done');
  setProgress(100);
  setDownloadingUI(false);
  openDirBtn.disabled = false;
  openDirBtn.hidden = false;
});

window.api.onError((msg) => {
  taskbarEl.hidden = false;
  statusText.textContent = '出错：' + msg;
  setDot('error');
  setDownloadingUI(false);
});

window.api.onCanceled(() => {
  statusText.textContent = '已取消';
  setDot('');
  setProgress(0);
  setDownloadingUI(false);
  // 用户主动取消：回到空闲态，不留一条 0% 的空进度条
  taskbarEl.hidden = true;
});

// ==========================================================================
// 交互
// ==========================================================================
chooseDirBtn.addEventListener('click', async () => {
  const dir = await window.api.selectFolder();
  if (dir) {
    selectedDir = dir;
    dirInput.value = dir;
    saveFormState();
  }
});

function syncGrabDirRow() {
  const needsTools = getGrabMode() !== 'none';
  grabDirRow.style.opacity = needsTools ? '' : '0.5';
  grabDirInput.disabled = !needsTools || downloading;
  chooseGrabDirBtn.disabled = !needsTools || downloading;
}

for (const el of [modeApp, modeApi, modeOffline, modeNone]) {
  if (!el) continue;
  el.addEventListener('change', () => {
    syncGrabDirRow();
    saveFormState();
    // 切换抓取方式后重跑环境检查（纯协议/本机签名不查安卓/Frida）
    if (!downloading) runEnvCheck();
  });
}
syncGrabDirRow();

chooseGrabDirBtn.addEventListener('click', async () => {
  const dir = await window.api.selectFolder();
  if (dir) {
    grabDirInput.value = dir;
    saveFormState();
  }
});

urlInput.addEventListener('input', saveFormState);
grabDirInput.addEventListener('input', saveFormState);
introDetailedCheckbox.addEventListener('change', saveFormState);
barkUrlInput.addEventListener('input', saveFormState);

// 试发一条：配好之后能马上确认地址对不对，不用等一部剧抓完。
testNotifyBtn.addEventListener('click', async () => {
  const raw = barkUrlInput.value.trim();
  if (!raw) {
    appendLog({ time: now(), level: 'warn', message: '还没填 Bark 地址' });
    return;
  }
  testNotifyBtn.disabled = true;
  try {
    const r = await window.api.testNotification(raw);
    if (r && r.ok) {
      appendLog({ time: now(), level: 'success', message: `测试通知已发送到 ${r.target || 'Bark'}` });
    } else {
      const why = r && r.error === 'invalid_bark_url' ? '地址格式不对' : (r && (r.error || r.status)) || '未知原因';
      appendLog({ time: now(), level: 'error', message: `测试通知发送失败：${why}` });
    }
  } finally {
    testNotifyBtn.disabled = false;
  }
});

startBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) {
    appendLog({ time: now(), level: 'error', message: '请先输入播放页 / 详情页链接' });
    urlInput.focus();
    return;
  }

  setProgress(0);
  timemarkEl.textContent = '';
  speedEl.textContent = '';
  episodeEl.textContent = '';
  openDirBtn.disabled = true;
  openDirBtn.hidden = true;
  taskbarEl.hidden = false;
  setDownloadingUI(true);
  setDot('running');
  statusText.textContent = '准备中…';

  const grabMode = getGrabMode();
  await window.api.startDownload({
    url,
    outputDir: selectedDir,
    grabMode,
    appGrab: grabMode === 'app',
    grabDir: grabDirInput.value.trim(),
    introDetailed: introDetailedCheckbox.checked,
  });
});

cancelBtn.addEventListener('click', async () => {
  cancelBtn.disabled = true;
  await window.api.cancelDownload();
});

stopAfterSeriesBtn.addEventListener('click', async () => {
  stopAfterSeriesBtn.disabled = true;
  stopAfterSeriesBtn.textContent = '已安排停止…';
  await window.api.stopAfterSeries();
});

window.api.onStopScheduled(() => {
  stopAfterSeriesBtn.disabled = true;
  stopAfterSeriesBtn.textContent = '已安排停止…';
});

openDirBtn.addEventListener('click', () => {
  if (lastFilePath) window.api.openFolder(lastFilePath);
  else if (selectedDir) window.api.openFolder(selectedDir);
});

clearLogBtn.addEventListener('click', () => {
  logEl.innerHTML = '';
  scrollLogToBottom(); // 清空后没有历史可看了，重新跟随最新
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !downloading) startBtn.click();
});

function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

async function initSettings() {
  const saved = await window.api.loadSettings().catch(() => ({}));

  if (saved.url) urlInput.value = saved.url;
  // 抓取方式先于就绪提示确定：提示里报的必须是本次真正生效的模式，
  // 不能是一句写死的"默认纯协议"——那正是"日志说纯协议、实际去装模拟器"的来源。
  const { mode, migrated } = resolveSavedGrabMode(saved);
  setGrabMode(mode);
  appendLog({
    time: now(),
    level: 'info',
    message:
      `就绪。当前抓取方式：${GRAB_MODE_LABEL[mode]}。网页只解析封面/简介与 series_id。`,
  });
  if (migrated) {
    appendLog({
      time: now(),
      level: 'warn',
      message:
        '已把旧版默认的「App 抓取」迁移为「纯协议下载」（旧版没有这个选项，勾选状态只是当年的默认值）。' +
        '仍要用模拟器抓取的话，在上面选回「App 抓取」即可，之后不再改动。',
    });
    window.api.saveSettings({ settingsVersion: SETTINGS_VERSION, grabMode: mode, appGrab: false });
  }
  if (saved.grabDir) grabDirInput.value = saved.grabDir;
  if (typeof saved.introDetailed === 'boolean') introDetailedCheckbox.checked = saved.introDetailed;
  if (saved.barkUrl) barkUrlInput.value = saved.barkUrl;
  syncGrabDirRow();

  if (saved.dir) {
    selectedDir = saved.dir;
    dirInput.value = saved.dir;
  } else {
    const dir = await window.api.getDefaultDir();
    if (dir) {
      selectedDir = dir;
      dirInput.value = dir;
    }
  }

  showView(saved.activeView);
  runEnvCheck();

  window.api.getAppVersion().then((v) => {
    if (v) appVersionEl.textContent = `v${v}`;
  }).catch(() => {});
}
initSettings();

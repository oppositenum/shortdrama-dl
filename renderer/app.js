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
const modeNone = $('modeNone');
const grabDirInput = $('grabDir');
const chooseGrabDirBtn = $('chooseGrabDir');
const grabDirRow = $('grabDirRow');
const introDetailedCheckbox = $('introDetailed');
const startBtn = $('start');
const cancelBtn = $('cancel');
const stopAfterSeriesBtn = $('stopAfterSeries');
const openDirBtn = $('openDir');
const clearLogBtn = $('clearLog');
const envRecheckBtn = $('envRecheck');
const envFixBtn = $('envFix');
const envCard = $('envCard');
const envToggle = $('envToggle');
const envSummary = $('envSummary');

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
function getGrabMode() {
  if (modeApi && modeApi.checked) return 'api';
  if (modeNone && modeNone.checked) return 'none';
  return 'app';
}

function setGrabMode(mode) {
  if (mode === 'api' && modeApi) modeApi.checked = true;
  else if (mode === 'none' && modeNone) modeNone.checked = true;
  else if (modeApp) modeApp.checked = true;
  syncGrabDirRow();
}

// ---------- 记忆：保存上次填写的内容 ----------
function saveFormState() {
  window.api.saveSettings({
    url: urlInput.value,
    dir: selectedDir,
    grabMode: getGrabMode(),
    appGrab: getGrabMode() === 'app', // 兼容旧设置字段
    grabDir: grabDirInput.value,
    introDetailed: introDetailedCheckbox.checked,
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
  dot.className = 'env-dot ' + state;
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
  const okCount = ENV_IDS.filter((id) => envItemState[id] === 'ok').length;
  const anyChecking = ENV_IDS.some((id) => envItemState[id] === 'checking');
  envSummary.textContent = anyChecking ? '检查中…' : `${okCount}/${ENV_IDS.length} 就绪`;
}

function setEnvCollapsed(collapsed) {
  envCard.classList.toggle('collapsed', collapsed);
  envToggle.setAttribute('aria-expanded', String(!collapsed));
  window.api.saveSettings({ envCollapsed: collapsed });
}

envToggle.addEventListener('click', () => {
  setEnvCollapsed(!envCard.classList.contains('collapsed'));
});

window.api.onEnvBegin(() => {
  envRecheckBtn.disabled = true;
  envFixBtn.disabled = true;
  resetEnvRows();
});

window.api.onEnvItem((d) => setEnvRow(d.id, d.state, d.message));

window.api.onEnvDone(() => {
  envRecheckBtn.disabled = false;
  envFixBtn.disabled = !FIXABLE_ENV_IDS.some(
    (id) => envItemState[id] === 'missing' || envItemState[id] === 'warn'
  );
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
function appendLog({ time, level, message }) {
  const line = document.createElement('div');
  line.className = `log-line ${level || 'info'}`;
  line.innerHTML =
    `<span class="log-time">${time || ''}</span>` +
    `<span class="log-msg"></span>`;
  line.querySelector('.log-msg').textContent = message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
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
  startBtn.disabled = on;
  cancelBtn.disabled = !on;
  stopAfterSeriesBtn.disabled = !on;
  if (on) stopAfterSeriesBtn.textContent = '抓完本部再停';
  urlInput.disabled = on;
  chooseDirBtn.disabled = on;
  if (modeApp) modeApp.disabled = on;
  if (modeApi) modeApi.disabled = on;
  if (modeNone) modeNone.disabled = on;
  grabDirInput.disabled = on || getGrabMode() === 'none';
  chooseGrabDirBtn.disabled = on || getGrabMode() === 'none';
  introDetailedCheckbox.disabled = on;
  startBtn.querySelector('.btn-text').textContent = on ? '下载中…' : '开始下载';
}

// ==========================================================================
// 事件订阅（主进程 -> 渲染进程）
// ==========================================================================
window.api.onLog((d) => appendLog(d));

window.api.onStatus((text) => {
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
});

window.api.onError((msg) => {
  statusText.textContent = '出错：' + msg;
  setDot('error');
  setDownloadingUI(false);
});

window.api.onCanceled(() => {
  statusText.textContent = '已取消';
  setDot('');
  setProgress(0);
  setDownloadingUI(false);
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

for (const el of [modeApp, modeApi, modeNone]) {
  if (!el) continue;
  el.addEventListener('change', () => {
    syncGrabDirRow();
    saveFormState();
    // 切换抓取方式后重跑环境检查（纯协议不查安卓/Frida）
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

startBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) {
    appendLog({ time: now(), level: 'error', message: '请先输入播放页 / 详情页链接' });
    urlInput.focus();
    return;
  }

  setProgress(0);
  timemarkEl.textContent = '--:--:--';
  speedEl.textContent = '';
  episodeEl.textContent = '';
  openDirBtn.disabled = true;
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
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !downloading) startBtn.click();
});

function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

appendLog({
  time: now(),
  level: 'info',
  message:
    '就绪。默认「纯协议下载」（无需模拟器）；「App 抓取」作备用。网页只解析封面/简介与 series_id。',
});

async function initSettings() {
  const saved = await window.api.loadSettings().catch(() => ({}));

  if (saved.url) urlInput.value = saved.url;
  if (saved.grabMode === 'app' || saved.grabMode === 'api' || saved.grabMode === 'none') {
    setGrabMode(saved.grabMode);
  } else if (typeof saved.appGrab === 'boolean') {
    setGrabMode(saved.appGrab ? 'app' : 'none');
  }
  if (saved.grabDir) grabDirInput.value = saved.grabDir;
  if (typeof saved.introDetailed === 'boolean') introDetailedCheckbox.checked = saved.introDetailed;
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

  setEnvCollapsed(saved.envCollapsed === true);
  runEnvCheck();
}
initSettings();

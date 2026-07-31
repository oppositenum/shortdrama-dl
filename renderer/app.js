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
const appGrabCheckbox = $('appGrab');
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
  hongguo_app: 'checking', frida_server: 'checking' }; // id -> state，供决定「修复缺失项」是否可点/展示摘要

// ---------- 初始化：填充默认目录 ----------
window.api.getDefaultDir().then((dir) => {
  if (dir) {
    selectedDir = dir;
    dirInput.value = dir;
  }
});

// ==========================================================================
// 环境检查
// ==========================================================================
const ENV_IDS = ['python', 'ffmpeg', 'android', 'hongguo_app', 'frida_server'];
const ENV_COLLAPSE_KEY = 'shortdrama:envCollapsed';

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
  try {
    localStorage.setItem(ENV_COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    // 隐私模式等场景 localStorage 可能不可用，忽略即可，不影响本次会话使用
  }
}

envToggle.addEventListener('click', () => {
  setEnvCollapsed(!envCard.classList.contains('collapsed'));
});

let storedCollapsed = '0';
try {
  storedCollapsed = localStorage.getItem(ENV_COLLAPSE_KEY) || '0';
} catch {
  // 同上，忽略
}
setEnvCollapsed(storedCollapsed === '1');

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

envRecheckBtn.addEventListener('click', () => {
  window.api.checkEnvironment(grabDirInput.value.trim());
});

envFixBtn.addEventListener('click', () => {
  window.api.fixEnvironment(grabDirInput.value.trim());
});

// 软件一打开就自动探测一次；全程只读，不装不下载不弹确认框
window.api.checkEnvironment(grabDirInput.value.trim());

// ==========================================================================
// UI 辅助
// ==========================================================================
function appendLog({ time, level, message }) {
  const line = document.createElement('div');
  line.className = `log-line ${level || 'info'}`;
  line.innerHTML =
    `<span class="log-time">${time || ''}</span>` +
    `<span class="log-msg"></span>`;
  line.querySelector('.log-msg').textContent = message; // 用 textContent 防止 XSS
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
  // 温和停止只在下载中可用;每次开新任务都要把它复位回可点状态和原文案,
  // 否则上一轮点过之后这个按钮会一直停在"已安排停止"上再也点不动。
  stopAfterSeriesBtn.disabled = !on;
  if (on) stopAfterSeriesBtn.textContent = '抓完本部再停';
  urlInput.disabled = on;
  chooseDirBtn.disabled = on;
  appGrabCheckbox.disabled = on;
  grabDirInput.disabled = on;
  chooseGrabDirBtn.disabled = on;
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

// 分类页批量时的剧目进度前缀（如"第 3/500 部《xxx》"）
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
  }
});

// 勾选状态联动工具目录行的可用性（不勾选时置灰）
function syncGrabDirRow() {
  const on = appGrabCheckbox.checked;
  grabDirRow.style.opacity = on ? '' : '0.5';
  grabDirInput.disabled = !on;
  chooseGrabDirBtn.disabled = !on;
}
appGrabCheckbox.addEventListener('change', syncGrabDirRow);
syncGrabDirRow();

chooseGrabDirBtn.addEventListener('click', async () => {
  const dir = await window.api.selectFolder();
  if (dir) grabDirInput.value = dir;
});

startBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) {
    appendLog({ time: now(), level: 'error', message: '请先输入播放页 / 详情页链接' });
    urlInput.focus();
    return;
  }

  // 重置界面
  setProgress(0);
  timemarkEl.textContent = '--:--:--';
  speedEl.textContent = '';
  episodeEl.textContent = '';
  openDirBtn.disabled = true;
  setDownloadingUI(true);
  setDot('running');
  statusText.textContent = '准备中…';

  await window.api.startDownload({
    url,
    outputDir: selectedDir,
    appGrab: appGrabCheckbox.checked,
    grabDir: grabDirInput.value.trim(),
    introDetailed: introDetailedCheckbox.checked,
  });
  // 结果通过 onDone / onError / onCanceled 事件反映，这里无需处理返回值
});

cancelBtn.addEventListener('click', async () => {
  cancelBtn.disabled = true;
  await window.api.cancelDownload();
});

stopAfterSeriesBtn.addEventListener('click', async () => {
  stopAfterSeriesBtn.disabled = true;
  stopAfterSeriesBtn.textContent = '已安排停止…';
  await window.api.stopAfterSeries();
  // 取消按钮【保持可用】：安排了温和停止之后，用户仍然可以改主意立刻中断
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

// 回车即开始下载
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !downloading) startBtn.click();
});

function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

// 首屏欢迎日志
appendLog({
  time: now(),
  level: 'info',
  message: '就绪。整剧链接只从网页保存封面，视频将由 App 从第 1 集开始抓取。',
});

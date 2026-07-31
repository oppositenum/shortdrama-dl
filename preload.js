/**
 * preload.js —— 预加载脚本
 *
 * 在 contextIsolation 开启的前提下，通过 contextBridge 把一组
 * 白名单 API 暴露给渲染进程（window.api），避免直接暴露 ipcRenderer / Node。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // —— 主动调用（invoke / handle）——
  /** 选择保存文件夹，返回路径或 null */
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  /** 获取默认下载目录 */
  getDefaultDir: () => ipcRenderer.invoke('app:getDefaultDir'),
  /** 开始下载 { url, outputDir, appGrab, grabDir, introDetailed } */
  startDownload: (payload) => ipcRenderer.invoke('download:start', payload),
  /** 立即取消下载（打断正在进行的抓取） */
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),
  /** 抓完当前这一部再停止（不打断正在进行的抓取） */
  stopAfterSeries: () => ipcRenderer.invoke('download:stop-after-series'),
  /** 打开文件夹（传文件则高亮） */
  openFolder: (target) => ipcRenderer.invoke('shell:openFolder', target),
  /** 只读环境检查：不装不下载不弹确认框，仅探测并报告状态 */
  checkEnvironment: (grabDir) => ipcRenderer.invoke('env:check', { grabDir }),
  /** 修复缺失项：走既有的交互式安装确认流程 */
  fixEnvironment: (grabDir) => ipcRenderer.invoke('env:fix', { grabDir }),
  /** 读取上次记住的界面设置（链接、目录等），返回已保存的字段对象 */
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  /** 保存界面设置，只需传有变化的字段，主进程会和已保存内容合并 */
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),

  // —— 事件订阅（主进程 -> 渲染进程）——
  onLog: (cb) => ipcRenderer.on('download:log', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('download:status', (_e, d) => cb(d)),
  onProgress: (cb) => ipcRenderer.on('download:progress', (_e, d) => cb(d)),
  onEpisode: (cb) => ipcRenderer.on('download:episode', (_e, d) => cb(d)),
  onSeries: (cb) => ipcRenderer.on('download:series', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('download:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('download:error', (_e, d) => cb(d)),
  onCanceled: (cb) => ipcRenderer.on('download:canceled', () => cb()),
  onStopScheduled: (cb) => ipcRenderer.on('download:stop-scheduled', () => cb()),
  onEnvBegin: (cb) => ipcRenderer.on('env:begin', () => cb()),
  onEnvItem: (cb) => ipcRenderer.on('env:item', (_e, d) => cb(d)),
  onEnvDone: (cb) => ipcRenderer.on('env:done', () => cb()),
});

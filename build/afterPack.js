/**
 * build/afterPack.js —— electron-builder afterPack 钩子
 *
 * 作用：在打包完成、生成安装包之前清理 Python 资源；默认 macOS 构建再做 ad-hoc 签名。
 *
 * 背景：默认测试构建不读取 Apple 证书，但 Apple Silicon(arm64) 应用仍需有效签名，
 *      否则会出现「应用已损坏」。
 *      electron-builder 在 CSC_IDENTITY_AUTO_DISCOVERY=false 时会「跳过签名」，
 *      导致 bundle 密封被破坏。这里用 `codesign --sign -` 重新做 ad-hoc 签名，
 *      使应用在本机及他机（清除隔离属性后）都能正常启动。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PYTHON_RESOURCE_FILES = Object.freeze([
  'hongguo_grab.py',
  'decrypt_mdl.py',
  'mp4parse.py',
  'capture_final.js',
  'start_avd.sh',
  'start_avd.ps1',
  'requirements.txt',
]);

function isUniversalTemp(appOutDir) {
  return /mac-universal-(?:x64|arm64)-temp$/.test(appOutDir);
}

exports.isUniversalTemp = isUniversalTemp;

function pythonResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    return path.join(context.appOutDir, appName, 'Contents', 'Resources', 'python');
  }
  return path.join(context.appOutDir, 'resources', 'python');
}

function cleanPythonResources(pythonDir) {
  const allowed = new Set(PYTHON_RESOURCE_FILES);
  const removed = [];
  if (!fs.existsSync(pythonDir)) {
    throw new Error(`打包后的 Python 资源目录不存在: ${pythonDir}`);
  }

  for (const entry of fs.readdirSync(pythonDir, { withFileTypes: true })) {
    if (allowed.has(entry.name) && entry.isFile()) continue;
    fs.rmSync(path.join(pythonDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }

  const missing = PYTHON_RESOURCE_FILES.filter((name) => {
    try {
      return !fs.statSync(path.join(pythonDir, name)).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length) {
    throw new Error(`打包后的 Python 资源缺失: ${missing.join(', ')}`);
  }
  return removed;
}

exports.PYTHON_RESOURCE_FILES = PYTHON_RESOURCE_FILES;
exports.cleanPythonResources = cleanPythonResources;

exports.default = async function afterPack(context) {
  // electron-builder 可能复用已有输出目录。无论 macOS 还是 Windows，都在签名/制品生成前
  // 把 Python 资源约束为固定七个文件，防止历史 .mdl、数据库或捕获日志混入安装包。
  const removed = cleanPythonResources(pythonResourcesDir(context));
  if (removed.length) {
    console.log(`  • [afterPack] 已移除 Python 运行时残留: ${removed.join(', ')}`);
  }

  // 后续签名逻辑仅处理 macOS。
  if (context.electronPlatformName !== 'darwin') return;

  // 正式签名模式（SIGN_MAC=1）：交给 electron-builder 用 Developer ID 证书签名+公证，
  // 这里不要做 ad-hoc 签名，以免覆盖正式签名。
  if (process.env.SIGN_MAC === '1') {
    console.log('  • [afterPack] 正式签名模式，跳过 ad-hoc 签名（由 electron-builder 处理）');
    return;
  }

  // electron-builder 会先生成两个临时 App，再合并为 universal App。临时切片若分别签名，
  // 两份 CodeResources 哈希必然不同，@electron/universal 会拒绝合并。最终 universal App
  // 还会再调用一次 afterPack，因此这里只跳过中间目录。
  if (isUniversalTemp(context.appOutDir)) {
    console.log(`  • [afterPack] universal 临时切片跳过签名: ${context.appOutDir}`);
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`  • [afterPack] 对应用做 ad-hoc 签名: ${appPath}`);
  // --force 覆盖已有签名；--deep 递归签名内嵌的 Chromium / Electron Framework 等。
  // 签名失败必须让构建失败，不能生成看似可发布但 Gatekeeper 校验不通过的产物。
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  console.log('  • [afterPack] ad-hoc 签名完成');
};

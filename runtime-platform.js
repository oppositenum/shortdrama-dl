'use strict';

const fs = require('node:fs');
const path = require('node:path');

function platformLabel(platform = process.platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function hostPlatform(platform = process.platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'unsupported';
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function windowsLocalAppData(env = process.env) {
  if (env.LOCALAPPDATA) return env.LOCALAPPDATA;
  if (env.USERPROFILE) return path.win32.join(env.USERPROFILE, 'AppData', 'Local');
  return '';
}

function windowsSdkRoot(env = process.env) {
  return (
    env.SHORTDRAMA_SDK_ROOT ||
    env.ANDROID_SDK_ROOT ||
    env.ANDROID_HOME ||
    (windowsLocalAppData(env) ? path.win32.join(windowsLocalAppData(env), 'Android', 'Sdk') : '')
  );
}

function listDirectories(root, predicate = () => true) {
  if (!root) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && predicate(entry.name))
      .map((entry) => path.win32.join(root, entry.name));
  } catch {
    return [];
  }
}

function windowsRuntimeDirs(env = process.env) {
  const local = windowsLocalAppData(env);
  const sdk = windowsSdkRoot(env);
  const dirs = [
    local && path.win32.join(local, 'Microsoft', 'WinGet', 'Links'),
    local && path.win32.join(local, 'Microsoft', 'WindowsApps'),
    sdk && path.win32.join(sdk, 'platform-tools'),
    sdk && path.win32.join(sdk, 'emulator'),
    sdk && path.win32.join(sdk, 'cmdline-tools', 'latest', 'bin'),
  ];

  const pythonRoot = local && path.win32.join(local, 'Programs', 'Python');
  for (const dir of listDirectories(pythonRoot, (name) => /^Python3/i.test(name))) {
    dirs.push(dir, path.win32.join(dir, 'Scripts'));
  }

  const packagesRoot = local && path.win32.join(local, 'Microsoft', 'WinGet', 'Packages');
  for (const packageDir of listDirectories(packagesRoot, (name) => /^Gyan\.FFmpeg_/i.test(name))) {
    dirs.push(packageDir);
    for (const child of listDirectories(packageDir)) {
      dirs.push(child, path.win32.join(child, 'bin'));
    }
  }
  return unique(dirs);
}

function windowsPythonCandidates(env = process.env) {
  const candidates = [env.SHORTDRAMA_PYTHON];
  for (const dir of windowsRuntimeDirs(env)) {
    candidates.push(path.win32.join(dir, 'python.exe'));
    candidates.push(path.win32.join(dir, 'python3.exe'));
  }
  candidates.push('python.exe', 'python3.exe', 'python');
  return unique(candidates);
}

function windowsPowerShell(env = process.env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const absolute = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return fs.existsSync(absolute) ? absolute : 'powershell.exe';
}

function runtimeFfmpegPath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (env.SHORTDRAMA_WEB_FFMPEG) return env.SHORTDRAMA_WEB_FFMPEG;
  const exists = options.existsSync || fs.existsSync;
  const binary = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const delimiter = platform === 'win32' ? ';' : ':';
  // 拼接也必须跟着【目标平台】走，不能用裸的 path.join——那个跟着【宿主平台】走。
  // 在 Windows 上问 darwin 的路径时，path.join 会拼出 '/custom/bin\ffmpeg'，
  // 于是永远匹配不上，函数悄悄退回裸 'ffmpeg'。分隔符早就按平台分了，拼接漏了。
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binary);
    if (exists(candidate)) return candidate;
  }

  if (platform === 'darwin') {
    const candidates = [
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/opt/local/bin/ffmpeg',
    ];
    return candidates.find(exists) || binary;
  }
  if (platform === 'win32') {
    for (const dir of windowsRuntimeDirs(env)) {
      const candidate = path.win32.join(dir, 'ffmpeg.exe');
      if (exists(candidate)) return candidate;
    }
    return binary;
  }
  return ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(exists) || binary;
}

function androidBootstrapSpec(grabDir, mode, installMissing = false, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (mode !== 'check' && mode !== 'ensure') {
    throw new Error(`Unsupported Android bootstrap mode: ${mode}`);
  }

  if (platform === 'win32') {
    const script = path.join(grabDir, 'start_avd.ps1');
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      mode === 'check' ? '-Check' : '-Ensure',
    ];
    if (installMissing) args.push('-InstallMissing');
    return { command: windowsPowerShell(env), args, script };
  }

  if (platform === 'darwin') {
    const script = path.join(grabDir, 'start_avd.sh');
    const args = [script, mode === 'check' ? '--check' : '--ensure'];
    if (installMissing) args.push('--install-missing');
    return { command: '/bin/bash', args, script };
  }

  throw new Error(`不支持在 ${platformLabel(platform)} 上自动准备 Android 环境`);
}

function dependencyInstaller(kind, platform = process.platform) {
  const ids = {
    python: 'Python.Python.3.12',
    ffmpeg: 'Gyan.FFmpeg',
    browser: 'Google.Chrome',
  };
  if (!ids[kind]) throw new Error(`Unknown dependency: ${kind}`);
  if (platform === 'darwin') {
    return {
      command: 'brew',
      args: kind === 'browser' ? ['install', '--cask', 'google-chrome'] : ['install', kind],
      managerCheck: { command: 'brew', args: ['--version'] },
    };
  }
  if (platform === 'win32') {
    return {
      command: 'winget.exe',
      args: [
        'install',
        '--exact',
        '--id',
        ids[kind],
        '--source',
        'winget',
        '--accept-source-agreements',
        '--accept-package-agreements',
        '--silent',
        '--disable-interactivity',
      ],
      managerCheck: { command: 'winget.exe', args: ['--version'] },
    };
  }
  return null;
}

module.exports = {
  androidBootstrapSpec,
  dependencyInstaller,
  hostPlatform,
  platformLabel,
  runtimeFfmpegPath,
  windowsPythonCandidates,
  windowsRuntimeDirs,
  windowsSdkRoot,
};

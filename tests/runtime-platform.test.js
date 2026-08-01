'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  androidBootstrapSpec,
  dependencyInstaller,
  hostPlatform,
  runtimeFfmpegPath,
  windowsSdkRoot,
} = require('../runtime-platform');
const builder = require('../electron-builder');
const packageJson = require('../package.json');
const {
  PYTHON_RESOURCE_FILES,
  cleanPythonResources,
  isUniversalTemp,
} = require('../build/afterPack');

const projectRoot = path.resolve(__dirname, '..');
const grabDir = path.join(projectRoot, 'python');

test('host platform detection keeps macOS and Windows explicit', () => {
  assert.equal(hostPlatform('darwin'), 'macos');
  assert.equal(hostPlatform('win32'), 'windows');
  assert.equal(hostPlatform('linux'), 'unsupported');
});

test('macOS Android setup selects Bash and start_avd.sh', () => {
  const spec = androidBootstrapSpec(grabDir, 'ensure', true, { platform: 'darwin' });
  assert.equal(spec.command, '/bin/bash');
  assert.equal(path.basename(spec.script), 'start_avd.sh');
  assert.deepEqual(spec.args.slice(-2), ['--ensure', '--install-missing']);
});

test('Windows Android setup selects PowerShell and start_avd.ps1', () => {
  const spec = androidBootstrapSpec(grabDir, 'check', false, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
  });
  assert.match(spec.command, /powershell\.exe$/i);
  assert.equal(path.basename(spec.script), 'start_avd.ps1');
  assert.ok(spec.args.includes('-ExecutionPolicy'));
  assert.ok(spec.args.includes('Bypass'));
  assert.deepEqual(spec.args.slice(-1), ['-Check']);
});

test('Linux is not silently routed through another platform installer', () => {
  assert.throws(
    () => androidBootstrapSpec(grabDir, 'check', false, { platform: 'linux' }),
    /不支持/
  );
});

test('platform package managers are selected per host', () => {
  assert.deepEqual(dependencyInstaller('python', 'darwin').managerCheck, {
    command: 'brew',
    args: ['--version'],
  });
  assert.deepEqual(dependencyInstaller('ffmpeg', 'win32').managerCheck, {
    command: 'winget.exe',
    args: ['--version'],
  });
  const windowsInstall = dependencyInstaller('ffmpeg', 'win32').args;
  assert.ok(windowsInstall.includes('Gyan.FFmpeg'));
  assert.ok(windowsInstall.includes('--source'));
  assert.ok(windowsInstall.includes('--silent'));
  assert.ok(windowsInstall.includes('--disable-interactivity'));
});

test('Windows SDK root follows explicit overrides before LOCALAPPDATA', () => {
  assert.equal(
    windowsSdkRoot({ SHORTDRAMA_SDK_ROOT: 'D:\\AndroidSdk', LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }),
    'D:\\AndroidSdk'
  );
  assert.equal(
    windowsSdkRoot({ LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }),
    'C:\\Users\\A\\AppData\\Local\\Android\\Sdk'
  );
});

test('Windows setup script preserves state markers, exit codes and checksum verification', () => {
  const source = fs.readFileSync(path.join(grabDir, 'start_avd.ps1'), 'utf8');
  for (const state of ['ready', 'stopped', 'missing_avd', 'missing_android_tools']) {
    assert.match(source, new RegExp(`\\"${state}\\"`));
  }
  for (const code of [10, 11, 12, 14, 15, 16]) {
    assert.match(source, new RegExp(`(?:Stop-WithState|exit) ${code}\\b`));
  }
  assert.match(source, /repository2-1\.xml/);
  assert.match(source, /Get-FileHash/);
  assert.match(source, /Host -ne "dl\.google\.com"/);
  assert.match(source, /if \(-not \$algorithm\) \{ \$algorithm = "SHA1" \}/);
  assert.match(source, /\$env:ANDROID_SDK_ROOT = \$SdkRoot/);
  assert.match(source, /EclipseAdoptium\.Temurin\.17\.JDK/);
  assert.match(source, /PROCESSOR_ARCHITECTURE/);
  assert.match(source, /system-images;android-/);
  assert.match(source, /google_apis/);
});

test('packaging includes both platform scripts and the runtime router', () => {
  assert.ok(builder.files.includes('runtime-platform.js'));
  assert.ok(builder.files.includes('series-workflow.js'));
  assert.ok(builder.files.includes('ffmpeg-runner.js'));
  assert.equal(builder.mac.identity, null);
  const pythonResource = builder.extraResources.find((item) => item.to === 'python');
  assert.ok(pythonResource);
  assert.ok(pythonResource.filter.includes('start_avd.sh'));
  assert.ok(pythonResource.filter.includes('start_avd.ps1'));
  assert.equal(pythonResource.filter.length, PYTHON_RESOURCE_FILES.length);
  assert.ok(pythonResource.filter.includes('api_grab.py'));
  assert.ok(pythonResource.filter.includes('spade_keys.py'));
  assert.ok(pythonResource.filter.includes('api_client.py'));
  assert.ok(pythonResource.filter.includes('api_client.py'));
  assert.ok(pythonResource.filter.includes('spade_keys.py'));
  assert.ok(pythonResource.filter.includes('hongguo_grab.py'));
});

test('system FFmpeg path follows overrides, PATH and native package-manager locations', () => {
  const override = '/opt/shortdrama/ffmpeg';
  assert.equal(runtimeFfmpegPath({ env: { SHORTDRAMA_WEB_FFMPEG: override } }), override);

  assert.equal(
    runtimeFfmpegPath({
      platform: 'darwin',
      env: { PATH: '/custom/bin:/usr/bin' },
      existsSync: (candidate) => candidate === '/custom/bin/ffmpeg',
    }),
    '/custom/bin/ffmpeg'
  );
  assert.equal(
    runtimeFfmpegPath({
      platform: 'win32',
      env: { Path: 'C:\\Tools;C:\\Windows' },
      existsSync: (candidate) => candidate === 'C:\\Tools\\ffmpeg.exe',
    }),
    'C:\\Tools\\ffmpeg.exe'
  );
  assert.equal(
    runtimeFfmpegPath({ platform: 'darwin', env: {}, existsSync: () => false }),
    'ffmpeg'
  );
});

test('packaging does not redistribute an architecture-mismatched FFmpeg binary', () => {
  assert.equal(builder.mac.extraResources, undefined);
  assert.equal(builder.win.extraResources, undefined);
  assert.equal(builder.asarUnpack, undefined);
});

test('ad-hoc signing skips universal slices and signs only the merged app', () => {
  assert.equal(isUniversalTemp('/tmp/release/mac-universal-x64-temp'), true);
  assert.equal(isUniversalTemp('/tmp/release/mac-universal-arm64-temp'), true);
  assert.equal(isUniversalTemp('/tmp/release/mac-universal'), false);
  assert.equal(isUniversalTemp('/tmp/release/mac-arm64'), false);
  const source = fs.readFileSync(path.join(projectRoot, 'build', 'afterPack.js'), 'utf8');
  assert.doesNotMatch(source, /签名失败（可忽略/);
});

test('packaging removes runtime data from reused Python resource directories', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'shortdrama-pack-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of PYTHON_RESOURCE_FILES) fs.writeFileSync(path.join(root, name), name);
  fs.mkdirSync(path.join(root, 'allmdl'));
  fs.writeFileSync(path.join(root, 'allmdl', 'private.mdl'), 'private');
  fs.mkdirSync(path.join(root, '.appdb'));
  fs.writeFileSync(path.join(root, 'captured_grab.jsonl'), '{"key":"private"}');

  const removed = cleanPythonResources(root).sort();
  assert.deepEqual(removed, ['.appdb', 'allmdl', 'captured_grab.jsonl']);
  assert.deepEqual(fs.readdirSync(root).sort(), [...PYTHON_RESOURCE_FILES].sort());
});

test('package scripts expose universal, Intel, Apple Silicon and Windows builds', () => {
  assert.match(packageJson.scripts['dist:mac'], /--universal/);
  assert.match(packageJson.scripts['dist:mac:x64'], /--x64/);
  assert.match(packageJson.scripts['dist:mac:arm64'], /--arm64/);
  assert.match(packageJson.scripts['dist:mac:signed'], /SIGN_MAC=1.*--universal/);
  assert.match(packageJson.scripts['dist:win'], /--win --x64/);
  assert.equal(packageJson.dependencies['ffmpeg-static'], undefined);

  // 每个 electron-builder 脚本都必须显式 --publish never。
  // electron-builder 在 CI 里会自己判断要不要发布（日志原话 "Implicit publishing
  // triggered by CI detection"），配置里写 publish: null 也拦不住这个 CLI 层的默认值。
  // 实测代价很重：Windows 打包任务因此挂了 75 分钟、一行输出都没有，
  // 而且发布应当只由 release.yml 里那套带校验的流程负责。
  for (const [name, cmd] of Object.entries(packageJson.scripts)) {
    if (!cmd.includes('electron-builder')) continue;
    assert.match(cmd, /--publish never/, `脚本 ${name} 少了 --publish never`);
  }
});

test('web HLS/DASH performs the same confirmed system FFmpeg preparation', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  assert.match(source, /ensureSystemMediaTools\(mediaEnv, \{/);
  assert.match(source, /requireProbe: false/);
  assert.match(source, /webFfmpegPath = runtimeFfmpegPath/);
  assert.match(source, /startFfmpegDownload/);
  assert.doesNotMatch(source, /log\(cmdLine/);
  assert.equal(packageJson.dependencies['fluent-ffmpeg'], undefined);
});

test('Electron and Playwright keep browser sandboxes enabled', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(source, /'will-navigate'.*preventDefault/);
  assert.doesNotMatch(source, /--no-sandbox/);
});

test('ADBKeyBoard is fetched from a pinned source and is not redistributed', () => {
  const source = fs.readFileSync(path.join(grabDir, 'hongguo_grab.py'), 'utf8');
  assert.match(source, /4b513f3313b8392b316b37e9c08b0be2def79dda/);
  assert.match(source, /e698adea5633135a067b038f9a0cf41baa4de09888713a81593fb2b9682cdc59/);
  assert.match(source, /SHA-256 mismatch/);
  const pythonResource = builder.extraResources.find((item) => item.to === 'python');
  assert.ok(!pythonResource.filter.includes('ADBKeyboard.apk'));
});

test('PowerShell scripts have no scope-qualifier lookalikes like "$Name:"', () => {
  // PowerShell 把 "$Name:" 当作用域限定符（$env:PATH 那种）。写在插值字符串里
  // 就是【整个脚本都加载不了】的语法错误，不是运行到那一行才炸——Windows 的
  // Android 环境准备会直接瘫掉。实测踩过：start_avd.ps1 里一句
  // "Could not start AVD $AvdName: ..." 让整个脚本报 parse error。
  // CI 的 PowerShell 语法检查只在 Windows runner 上跑，macOS 上开发时看不到，
  // 所以这里用纯文本扫描兜住，任何平台都能拦。
  const legalScopes = /^\$(env|script|global|local|private|using|variable|function|workflow):/i;
  for (const rel of ['python/start_avd.ps1', 'scripts/setup-python.ps1']) {
    const src = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
    const offenders = (src.match(/\$[A-Za-z_][A-Za-z0-9_]*:/g) || [])
      .filter((m) => !legalScopes.test(m));
    assert.deepEqual(
      offenders, [],
      `${rel} 里这些写法会被当成作用域限定符，应改成 \${...} 包起来：${offenders.join(', ')}`
    );
  }
});

test('every workflow job has a timeout and packaging jobs cache Electron', () => {
  // GitHub 单个 job 的默认上限是 6 小时。实测有个 Windows 打包挂了 75 分钟还在跑，
  // 没有 timeout-minutes 就会一路烧到 6 小时才被杀。
  // 另外 setup-node 的 cache: npm 只缓 npm tarball（约 27MB），
  // Electron 运行时和 winCodeSign/NSIS 在另外的目录，每轮都要重下约 600MB。
  for (const rel of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const src = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
    // 只看 jobs: 段落——顶层还有 on:，它下面的 push:/pull_request: 缩进相同，会被误当成 job
    const jobsAt = src.search(/^jobs:$/m);
    assert.notEqual(jobsAt, -1, `${rel} 里没有 jobs:`);
    const jobsSection = src.slice(jobsAt);
    const blocks = jobsSection.split(/^ {2}(?=[a-z][\w-]*:$)/m).slice(1);
    assert.ok(blocks.length >= 3, `${rel} 里没解析到 job`);
    for (const block of blocks) {
      const name = block.match(/^([\w-]*):/)[1];
      assert.match(block, /^\s{4}timeout-minutes: \d+$/m, `${rel} 的 job ${name} 少了 timeout-minutes`);
    }
  }

  const ci = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  // 两个打包 job 都要缓存 Electron 下载，并把缓存目录告诉 electron-builder
  assert.equal((ci.match(/name: Cache Electron downloads/g) || []).length, 2);
  assert.equal((ci.match(/ELECTRON_CACHE:/g) || []).length, 2);
  assert.equal((ci.match(/ELECTRON_BUILDER_CACHE:/g) || []).length, 2);
});

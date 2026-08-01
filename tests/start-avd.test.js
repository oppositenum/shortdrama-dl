'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const startAvd = path.join(projectRoot, 'python', 'start_avd.sh');

function executable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -e\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function fakeAndroid({ avdInstalled, running }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdrama-avd-test-'));
  const sdk = path.join(root, 'sdk');
  const runningFlag = path.join(root, 'running');
  const avdFlag = path.join(root, 'avd');
  if (running) fs.writeFileSync(runningFlag, '1');
  if (avdInstalled) {
    fs.writeFileSync(avdFlag, '1');
    fs.mkdirSync(path.join(sdk, 'system-images', 'android-34', 'google_apis', 'arm64-v8a'), {
      recursive: true,
    });
  }

  executable(path.join(sdk, 'platform-tools', 'adb'), `
RUNNING=${JSON.stringify(runningFlag)}
if [[ "\${1:-}" == "devices" ]]; then
  echo "List of devices attached"
  [[ -f "$RUNNING" ]] && printf 'emulator-5554\\tdevice\\n'
  exit 0
fi
if [[ "\${1:-}" == "-s" ]]; then shift 2; fi
case "\${1:-}" in
  get-state) [[ -f "$RUNNING" ]] && echo device ;;
  root|wait-for-device) exit 0 ;;
  shell)
    shift
    case "\${1:-}" in
      getprop) echo 1 ;;
      id) echo 'uid=0(root) gid=0(root)' ;;
      pidof) echo 4321 ;;
      test) exit 1 ;;
    esac
    ;;
esac
`);

  executable(path.join(sdk, 'emulator', 'emulator'), `
AVD=${JSON.stringify(avdFlag)}
RUNNING=${JSON.stringify(runningFlag)}
if [[ "\${1:-}" == "-list-avds" ]]; then
  [[ -f "$AVD" ]] && echo hongguo
  exit 0
fi
touch "$RUNNING"
`);

  // sdkmanager/avdmanager 是 Java 程序。真实的 sdkmanager 拿不到 JDK 时不会好好报错，
  // 只会打一句 "test: : integer expression expected"，所以假的这两个把自己看到的
  // JAVA_HOME 记下来，用例据此确认脚本在调用它们之前确实把 JDK 准备好了。
  const javaHomeSeen = path.join(root, 'java-home-seen');
  const recordJavaHome = `printf '%s\\n' "\${JAVA_HOME:-}" >> ${JSON.stringify(javaHomeSeen)}`;
  executable(path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'), `${recordJavaHome}\nexit 0`);
  executable(
    path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager'),
    `${recordJavaHome}\ntouch ${JSON.stringify(avdFlag)}`
  );

  // 自带一个假 JDK：宿主装没装 Java 都不影响用例结果。
  const javaHome = path.join(root, 'jdk');
  executable(path.join(javaHome, 'bin', 'java'), 'echo \'openjdk version "17.0.99"\' >&2');

  const env = {
    ...process.env,
    HOME: root,
    SHORTDRAMA_SDK_ROOT: sdk,
    SHORTDRAMA_BOOT_TIMEOUT: '5',
    SHORTDRAMA_JAVA_HOME: javaHome,
    PATH: '/usr/bin:/bin',
  };
  delete env.JAVA_HOME;
  return { root, env, avdFlag, javaHome, javaHomeSeen };
}

// start_avd.sh 是 macOS/Linux 链路的脚本；Windows 走的是 start_avd.ps1，
// CI 里由单独的 PowerShell 语法检查覆盖。Windows runner 上没有 /bin/bash，
// spawnSync 直接 ENOENT、status 是 null，断言就成了 "null !== 0" 这种看不懂的失败。
// 这类平台不适用的用例应当【跳过】而不是判失败。
const BASH = '/bin/bash';
const skipNoBash = process.platform === 'win32' || !fs.existsSync(BASH)
  ? `需要 ${BASH}，当前平台不适用（Windows 走 start_avd.ps1）`
  : false;

function run(env, ...args) {
  return spawnSync(BASH, [startAvd, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('check reports a ready emulator without mutating it', {skip: skipNoBash}, (t) => {
  const fixture = fakeAndroid({ avdInstalled: true, running: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /state=ready serial=emulator-5554/);
});

test('check distinguishes an installed but stopped AVD', {skip: skipNoBash}, (t) => {
  const fixture = fakeAndroid({ avdInstalled: true, running: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--check');
  assert.equal(result.status, 10, result.stderr);
  assert.match(result.stdout, /state=stopped avd=hongguo/);
});

test('check reports a missing AVD when SDK managers exist', {skip: skipNoBash}, (t) => {
  const fixture = fakeAndroid({ avdInstalled: false, running: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--check');
  assert.equal(result.status, 11, result.stderr);
  assert.match(result.stdout, /state=missing_avd avd=hongguo/);
});

test('ensure starts an installed AVD and returns its serial', {skip: skipNoBash}, (t) => {
  const fixture = fakeAndroid({ avdInstalled: true, running: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--ensure');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /state=ready serial=emulator-5554/);
  assert.match(result.stdout, /Ready: emulator-5554, root, frida-server pid 4321/);
});

test('install-missing creates and starts the configured AVD', {skip: skipNoBash}, (t) => {
  const fixture = fakeAndroid({ avdInstalled: false, running: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--ensure', '--install-missing');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(fixture.avdFlag), true);
  assert.match(result.stdout, /Creating root-capable Google APIs AVD hongguo/);
  assert.match(result.stdout, /state=ready serial=emulator-5554/);
});

// 实测踩过：macOS 上没有真 JDK 时，/usr/bin/java 只是个占位程序，接受许可证那步
// 会打出 "Unable to locate a Java Runtime" 加一句 sdkmanager 自己的
// "test: : integer expression expected"，而许可证和 SDK 包一个都没装上。
// 安装链路必须先备好 JDK 再碰 sdkmanager/avdmanager。
test('install-missing hands a real JDK to sdkmanager and avdmanager', {skip: skipNoBash}, (t) => {
  const fixture = fakeAndroid({ avdInstalled: false, running: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--ensure', '--install-missing');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`Using Java at ${fixture.javaHome}`));

  const seen = fs.readFileSync(fixture.javaHomeSeen, 'utf8').trim().split('\n');
  assert.ok(seen.length >= 2, `sdkmanager/avdmanager 未被调用：${seen}`);
  for (const value of seen) {
    assert.equal(value, fixture.javaHome);
  }
});

test('the Java check runs before the first sdkmanager call', {skip: skipNoBash}, () => {
  const source = fs.readFileSync(startAvd, 'utf8');
  const ensureJava = source.indexOf('\n    ensure_java\n');
  const licenses = source.indexOf('--licenses');
  const createAvd = source.indexOf('create avd');
  assert.ok(ensureJava > 0, '安装链路里没有 ensure_java');
  assert.ok(ensureJava < licenses, 'ensure_java 必须在接受许可证之前');
  assert.ok(source.lastIndexOf('\n    ensure_java\n') < createAvd, 'ensure_java 必须在建 AVD 之前');
  // 不能只看文件存不存在：/usr/bin/java 一直在，但没 JDK 时跑起来就报错。
  assert.match(source, /"\$1" -version >\/dev\/null 2>&1/);
});

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

  executable(path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'), 'exit 0');
  executable(path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager'), `touch ${JSON.stringify(avdFlag)}`);

  const env = {
    ...process.env,
    HOME: root,
    SHORTDRAMA_SDK_ROOT: sdk,
    SHORTDRAMA_BOOT_TIMEOUT: '5',
    PATH: '/usr/bin:/bin',
  };
  return { root, env, avdFlag };
}

function run(env, ...args) {
  return spawnSync('/bin/bash', [startAvd, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('check reports a ready emulator without mutating it', (t) => {
  const fixture = fakeAndroid({ avdInstalled: true, running: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /state=ready serial=emulator-5554/);
});

test('check distinguishes an installed but stopped AVD', (t) => {
  const fixture = fakeAndroid({ avdInstalled: true, running: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--check');
  assert.equal(result.status, 10, result.stderr);
  assert.match(result.stdout, /state=stopped avd=hongguo/);
});

test('check reports a missing AVD when SDK managers exist', (t) => {
  const fixture = fakeAndroid({ avdInstalled: false, running: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--check');
  assert.equal(result.status, 11, result.stderr);
  assert.match(result.stdout, /state=missing_avd avd=hongguo/);
});

test('ensure starts an installed AVD and returns its serial', (t) => {
  const fixture = fakeAndroid({ avdInstalled: true, running: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--ensure');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /state=ready serial=emulator-5554/);
  assert.match(result.stdout, /Ready: emulator-5554, root, frida-server pid 4321/);
});

test('install-missing creates and starts the configured AVD', (t) => {
  const fixture = fakeAndroid({ avdInstalled: false, running: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture.env, '--ensure', '--install-missing');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(fixture.avdFlag), true);
  assert.match(result.stdout, /Creating root-capable Google APIs AVD hongguo/);
  assert.match(result.stdout, /state=ready serial=emulator-5554/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const pyDir = path.join(projectRoot, 'python');

function pythonCommand() {
  return process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function runPython(probe, env) {
  return spawnSync(pythonCommand(), ['-c', probe], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

// 实测踩过：签名器把 bridge 目录写成了
// <项目>/.venv/lib/python3.14/site-packages/frida_tools/bridges。
// 正式版的 venv 在应用用户数据目录，解释器小版本也未必是 3.14，Windows 更是
// Lib\site-packages —— 于是 frida-tools 明明装着，风控回退却一直报 bridge missing。
test('signer bridge lookup asks the installed frida-tools, not a hardcoded path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdrama-bridges-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 假的 frida_tools 包：装在哪、解释器是什么版本，函数都不该关心。
  const pkg = path.join(root, 'site-packages', 'frida_tools');
  fs.mkdirSync(path.join(pkg, 'bridges'), { recursive: true });
  fs.writeFileSync(path.join(pkg, '__init__.py'), '');
  fs.writeFileSync(path.join(pkg, 'bridges', 'java.js'), '// fake bridge');
  const override = path.join(root, 'override-bridges');
  fs.mkdirSync(override);

  const probe = String.raw`
import os, sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, os.environ["FAKE_SITE_PACKAGES"])
src = Path(os.environ["TTNET_SIGNER"]).read_text(encoding="utf-8")
start = src.index("def resolve_bridge_dir")
end = src.index("USER_AGENT =")
ns = {"os": os, "Path": Path, "Optional": Optional, "ROOT": Path(os.environ["FAKE_ROOT"])}
exec(src[start:end], ns)
resolve = ns["resolve_bridge_dir"]

# 1) 没有环境变量时，问包自己在哪
os.environ.pop("SHORTDRAMA_FRIDA_BRIDGES", None)
found = resolve()
assert found == Path(os.environ["FAKE_SITE_PACKAGES"]) / "frida_tools" / "bridges", found

# 2) 显式覆盖优先
os.environ["SHORTDRAMA_FRIDA_BRIDGES"] = os.environ["OVERRIDE_DIR"]
assert resolve() == Path(os.environ["OVERRIDE_DIR"]), resolve()

# 3) 指到不存在的目录时忽略覆盖，回到包自己的位置
os.environ["SHORTDRAMA_FRIDA_BRIDGES"] = os.path.join(os.environ["FAKE_ROOT"], "nope")
assert resolve() == Path(os.environ["FAKE_SITE_PACKAGES"]) / "frida_tools" / "bridges"
print("OK")
`;

  const result = runPython(probe, {
    TTNET_SIGNER: path.join(pyDir, 'ttnet_signer.py'),
    FAKE_SITE_PACKAGES: path.join(root, 'site-packages'),
    FAKE_ROOT: root,
    OVERRIDE_DIR: override,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});

test('no interpreter version or venv layout is baked into the signer', () => {
  const src = fs.readFileSync(path.join(pyDir, 'ttnet_signer.py'), 'utf8');
  assert.equal(/python3\.\d+/.test(src), false, '不能写死解释器小版本');
  assert.equal(src.includes('/Applications/'), false, '不能写死安装位置');
});

// 110001 是冲着当前身份来的业务风控，不是某台 host 的故障。原来 3 host × 3 轮
// 全打一遍，9 次必然失败的请求只会把风控拖得更久，还拖慢上层的挂签名/换身份。
test('a 110001 stops the host/round retries immediately', () => {
  const probe = String.raw`
import json, os, sys
import importlib.util
import urllib.request

spec = importlib.util.spec_from_file_location("api_client", os.environ["API_CLIENT"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

calls = []

class FakeResp:
    def __init__(self, payload):
        self._payload = payload
    def read(self):
        return json.dumps(self._payload).encode("utf-8")
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False

def fake_urlopen(req, timeout=None):
    calls.append(req.full_url)
    return FakeResp({"code": 110001, "message": "未知异常"})

m.urllib.request.urlopen = fake_urlopen
client = m.HongguoApiClient()
try:
    client.video_detail("7667851513573674046")
except m.ApiError as e:
    assert getattr(e, "code", None) in (110001, "110001"), e
else:
    raise SystemExit("expected ApiError")

assert len(calls) == 1, f"风控后又打了 {len(calls)} 次: {calls}"
print("OK")
`;
  const result = runPython(probe, { API_CLIENT: path.join(pyDir, 'api_client.py') });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});

// 非风控错误（网络抖动之类）仍然值得换 host 重试，别把重试一起砍掉。
test('ordinary failures still fall through to the other hosts', () => {
  const probe = String.raw`
import json, os
import importlib.util

spec = importlib.util.spec_from_file_location("api_client", os.environ["API_CLIENT"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

calls = []

def fake_urlopen(req, timeout=None):
    calls.append(req.full_url)
    raise OSError("connection reset")

m.urllib.request.urlopen = fake_urlopen
client = m.HongguoApiClient()
try:
    client.video_detail("7667851513573674046")
except Exception:
    pass

assert len(calls) > 1, f"普通失败也应该换 host 重试，实际只打了 {len(calls)} 次"
print("OK")
`;
  const result = runPython(probe, { API_CLIENT: path.join(pyDir, 'api_client.py') });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
});

// bridge 在 frida-tools 里，只装 frida 的话签名回退必定挂不上。
test('the pure-protocol environment installs frida-tools, not just frida', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  assert.match(src, /const FRIDA_TOOLS_VERSION = '(\d+\.\d+\.\d+)'/);
  assert.match(src, /`frida-tools==\$\{FRIDA_TOOLS_VERSION\}`/);

  const pinned = src.match(/const FRIDA_TOOLS_VERSION = '([^']+)'/)[1];
  const requirements = fs.readFileSync(path.join(pyDir, 'requirements.txt'), 'utf8');
  assert.match(requirements, new RegExp(`frida-tools==${pinned.replace(/\./g, '\\.')}`),
    'main.js 与 requirements.txt 的 frida-tools 版本必须一致');
});

// 纯协议的卖点是"不需要模拟器"。默认借用已在跑的模拟器签名是有价值的兜底，
// 但必须留一个开关，且不能只靠"不传参数"——api_grab.py 自己也默认开着。
test('the emulator signing fallback can be switched off end to end', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  assert.match(src, /SHORTDRAMA_API_DEVICE_SIGN !== '0'/);
  assert.match(src, /SHORTDRAMA_DEVICE_SIGN_AUTO/);

  const grab = fs.readFileSync(path.join(pyDir, 'api_grab.py'), 'utf8');
  assert.match(grab, /SHORTDRAMA_DEVICE_SIGN_AUTO/);
  // 挂不上就别每集重刷一遍同样的失败
  assert.match(grab, /_is_permanent_sign_failure/);
  assert.match(grab, /本次运行不再尝试挂载 App 签名/);
});

// 第四种模式：本机签名纯协议 — 强制 --offline-sign，且不挂 device-sign-auto
test('offline grab mode forces pure-python sign and never enables device-sign-auto', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  assert.match(src, /signMode === 'offline'/);
  assert.match(src, /args\.push\('--offline-sign'\)/);
  // offline 分支里 deviceSignAuto 应为 false 路径
  assert.match(src, /const offlineOnly = signMode === 'offline'/);
  assert.match(src, /本机签/);
  assert.equal(src.includes('离线六神'), false, '用户可见文案勿再写「离线六神」');
  assert.ok(fs.existsSync(path.join(pyDir, 'metasec_offline.py')), 'metasec_offline.py 必须存在');
  assert.ok(
    fs.existsSync(path.join(pyDir, 'sign_samples', 'gorgon_mid_key_oracle.json')),
    'gorgon mid-key oracle 应存在（打包可选，开发态应有）'
  );
});

// 纯协议只校验 cryptography（故意的：frida 装不上也不该拖垮裸请求）。但这也意味着
// 早先建好的 venv 不会因为缺 frida-tools 而重建，签名回退会一直挂不上——必须在准备
// 环境时补一次，且补不上只警告。
test('an existing pure-protocol venv gets frida-tools backfilled, non-fatally', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function ensureSignFallbackDeps'),
    src.indexOf('async function ensureApiGrabEnvironment'));
  assert.ok(fn.length > 0, 'main.js 里找不到 ensureSignFallbackDeps');
  assert.match(fn, /'-c', 'import frida_tools'/);
  assert.match(fn, /frida-tools==\$\{FRIDA_TOOLS_VERSION\}/);
  // 补装失败必须是 warn 后继续，不能 throw
  assert.match(fn, /log\('frida-tools 补装失败[^']*', 'warn'\)/);
  assert.equal(/throw new Error\((?!'__CANCELED__')/.test(fn), false, '补装失败不能抛错');
  assert.match(src, /await ensureSignFallbackDeps\(pythonBin, env\)/);
});

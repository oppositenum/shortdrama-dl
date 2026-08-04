'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const pyDir = path.join(projectRoot, 'python');

function pythonCommand() {
  return process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function runPython(probe, env) {
  return spawnSync(pythonCommand(), ['-c', probe], {
    cwd: pyDir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

function expectOk(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK/);
}

// 实测踩过：第 98 集 main 超时 53s、backup 超时 53s，然后这一集就被判死了，
// 要等到几分钟后整部剧重跑的补漏轮才有下文。一次偶发超时不该有这种代价。
test('CDN 失败会整对重试，不是各打一枪就放弃', () => {
  const probe = String.raw`
import importlib.util, os, sys
sys.path.insert(0, os.getcwd())
spec = importlib.util.spec_from_file_location("api_grab", "api_grab.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

calls, slept = [], []

def flaky(url, dest, *, expect_size=0, timeout=0, deadline_s=0):
    calls.append(url)
    if len(calls) < 5:            # 前两轮 main+backup 全挂
        raise OSError("timed out")
    return 1234

got = m.download_cdn_with_retry(
    [("main", "http://main/x"), ("backup", "http://backup/x")],
    "/tmp/ep0098_1080p.mp4",
    expect_size=1234, label="第98集",
    on_log=lambda lv, msg: None, sleep=slept.append, downloader=flaky,
)
assert got == 1234, got
assert calls == ["http://main/x", "http://backup/x"] * 2 + ["http://main/x"], calls
assert slept == [2.0, 6.0], slept   # 轮间退避，且第三轮成功后不再等
print("OK")
`;
  expectOk(runPython(probe));
});

test('全部轮次都失败时才放弃，错误里带最后一次的原因', () => {
  const probe = String.raw`
import importlib.util, os, sys
sys.path.insert(0, os.getcwd())
spec = importlib.util.spec_from_file_location("api_grab", "api_grab.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

calls = []
def always_fail(url, dest, **kw):
    calls.append(url)
    raise OSError("timed out")

try:
    m.download_cdn_with_retry(
        [("main", "http://main/x"), ("backup", None)],   # backup 缺失时跳过
        "/tmp/ep0001_1080p.mp4", sleep=lambda s: None, downloader=always_fail,
    )
except RuntimeError as e:
    assert "cdn download failed" in str(e), e
    assert "timed out" in str(e), e
else:
    raise SystemExit("expected RuntimeError")

assert len(calls) == m.CDN_ROUNDS, calls    # 每轮一次（backup 为空不算）
print("OK")
`;
  expectOk(runPython(probe));
});

test('第一次就成功时不重试、不退避', () => {
  const probe = String.raw`
import importlib.util, os, sys
sys.path.insert(0, os.getcwd())
spec = importlib.util.spec_from_file_location("api_grab", "api_grab.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

calls, slept = [], []
got = m.download_cdn_with_retry(
    [("main", "http://main/x"), ("backup", "http://backup/x")],
    "/tmp/ep0002_1080p.mp4",
    sleep=slept.append, downloader=lambda url, dest, **kw: calls.append(url) or 99,
)
assert got == 99 and calls == ["http://main/x"] and slept == [], (got, calls, slept)
print("OK")
`;
  expectOk(runPython(probe));
});

// 重试要有意义，就不能每次都从 0 开始。
test('断点续传：重试时带 Range，接着已下的字节继续', () => {
  const probe = String.raw`
import http.server, importlib.util, os, socketserver, sys, tempfile, threading
sys.path.insert(0, os.getcwd())
spec = importlib.util.spec_from_file_location("api_client", "api_client.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

BODY = bytes(range(256)) * 40          # 10240 字节
state = {"requests": [], "cut_first": True}

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *a): pass
    def do_GET(self):
        rng = self.headers.get("Range")
        state["requests"].append(rng)
        start = 0
        if rng:
            start = int(rng.split("=")[1].split("-")[0])
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(BODY)-1}/{len(BODY)}")
        else:
            self.send_response(200)
        data = BODY[start:]
        if state["cut_first"]:         # 第一次只吐一半就断开
            state["cut_first"] = False
            data = data[: len(data) // 2]
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

srv = socketserver.TCPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/ep.mp4"

tmp = tempfile.mkdtemp()
dest = os.path.join(tmp, "ep0098_1080p.mp4")

# 第一次：服务端提前断流，长度对不上 → 失败，但 .part 必须留着
try:
    m.http_download(url, dest, expect_size=len(BODY), timeout=5)
except Exception as e:
    assert "size mismatch" in str(e), e
else:
    raise SystemExit("expected failure")

part = m.part_path(dest, url)
have = os.path.getsize(part)
assert have == len(BODY) // 2, have

# 第二次：应当带 Range 接着下，而不是从 0 重来
n = m.http_download(url, dest, expect_size=len(BODY), timeout=5)
assert n == len(BODY), n
assert open(dest, "rb").read() == BODY, "续传拼出来的内容必须和原文件一致"
assert state["requests"] == [None, f"bytes={have}-"], state["requests"]
assert not os.path.exists(part), "成功后 .part 应当被 rename 掉"
srv.shutdown()
print("OK")
`;
  expectOk(runPython(probe));
});

// main 和 backup 是两台 CDN 上的同一个文件，但半份 main 接上半份 backup
// 一旦有一字节不同，size 校验照样过，坏的是解密后的成片。
test('main 和 backup 各存各的分片，不会互相接续', () => {
  const probe = String.raw`
import importlib.util, os, sys
sys.path.insert(0, os.getcwd())
spec = importlib.util.spec_from_file_location("api_client", "api_client.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

a = m.part_path("/tmp/ep0098_1080p.mp4", "http://main/x")
b = m.part_path("/tmp/ep0098_1080p.mp4", "http://backup/x")
assert a != b, (a, b)
# 临时文件清理靠 ep<NNNN>_ 前缀，分片名必须还带着它
assert os.path.basename(a).startswith("ep0098_"), a
assert a.endswith(".part") and b.endswith(".part")
print("OK")
`;
  expectOk(runPython(probe));
});

// socket timeout 只管每次 read，一条每 39 秒吐一个字节的连接能挂住几十分钟。
test('总时限能切断慢速连接，socket 超时管不了这种', () => {
  const probe = String.raw`
import http.server, importlib.util, os, socketserver, sys, tempfile, threading, time
sys.path.insert(0, os.getcwd())
spec = importlib.util.spec_from_file_location("api_client", "api_client.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "100000")
        self.end_headers()
        for _ in range(100):          # 每 0.2s 吐一点，socket 超时永远碰不到
            try:
                self.wfile.write(b"x" * 100)
                self.wfile.flush()
            except Exception:
                return
            time.sleep(0.2)

srv = socketserver.TCPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/slow.mp4"
dest = os.path.join(tempfile.mkdtemp(), "ep0003_1080p.mp4")

t0 = time.monotonic()
try:
    m.http_download(url, dest, expect_size=100000, timeout=30, deadline_s=1.0)
except TimeoutError as e:
    assert "exceeded" in str(e), e
else:
    raise SystemExit("expected TimeoutError")
spent = time.monotonic() - t0
assert spent < 10, spent      # 没有总时限的话这里要等 20s
srv.shutdown()
print("OK")
`;
  expectOk(runPython(probe));
});

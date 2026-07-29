'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const grabScript = path.join(projectRoot, 'python', 'hongguo_grab.py');

function pythonCommand() {
  return process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

test('App capture keeps runtime data writable and recognizes advertisement feeds', (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdrama-grab-runtime-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const probe = String.raw`
import os
import runpy
import sys

script = os.environ["SHORTDRAMA_GRAB_SCRIPT"]
sys.argv = [
    script,
    "--series-name", "测试短剧",
    "--start-ep", "1",
    "--end-ep", "2",
    "--output-dir", os.path.dirname(script),
]
ns = runpy.run_path(script)
runtime = ns["_skip_ad_if_present"].__globals__
runtime_dir = os.path.abspath(os.environ["HONGGUO_RUNTIME_DIR"])
assert ns["HERE"] != runtime_dir
assert ns["MDL"] == os.path.join(runtime_dir, "allmdl")
assert ns["CAP"] == os.path.join(runtime_dir, "captured_grab.jsonl")
assert ns["APPDB"] == os.path.join(runtime_dir, ".appdb")

def xml(*texts):
    nodes = "".join(
        '<node text="%s" content-desc="" bounds="[0,0][100,100]" />' % text
        for text in texts
    )
    return '<hierarchy rotation="0">%s</hierarchy>' % nodes

ad_continue = xml("广告", "上滑继续观看短剧")
ad_short = xml("上滑继续看短剧")
ad_label = xml("广告")
normal = xml("测试短剧", "第3集", "选集")
series_with_ad_word = xml("广告人的重生", "第3集", "选集")

assert ns["_is_ad_screen"](ad_continue)
assert ns["_is_ad_screen"](ad_short)
assert ns["_is_ad_screen"](ad_label)
assert not ns["_is_ad_screen"](normal)
assert not ns["_is_ad_screen"](series_with_ad_word)

swipes = []
logs = []
runtime["_swipe_next"] = lambda: swipes.append("swipe")
runtime["logev"] = lambda level, message: logs.append((level, message))
runtime["ui_dump"] = lambda retries=3: normal
assert ns["_skip_ad_if_present"](ad_continue)
assert len(swipes) == 1
assert logs and "广告" in logs[0][1]

swipes.clear()
runtime["ui_dump"] = lambda retries=3: ad_continue
assert ns["_skip_ad_if_present"](ad_continue)
assert len(swipes) == 2

swipes.clear()
assert not ns["_skip_ad_if_present"](normal)
assert not swipes
print("advertisement handling ok")
`;

  const result = spawnSync(pythonCommand(), ['-c', probe], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SHORTDRAMA_GRAB_SCRIPT: grabScript,
      HONGGUO_RUNTIME_DIR: runtimeDir,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /advertisement handling ok/);
});

test('ByteVC2 offline copies fall back to a standard-HEVC rung instead of failing', (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortdrama-grab-rung-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const probe = String.raw`
import os
import runpy
import struct
import sys

sys.path.insert(0, os.path.join(os.environ["SHORTDRAMA_PROJECT_ROOT"], "python"))
import mp4parse

def box(kind, payload):
    return struct.pack(">I", len(payload) + 8) + kind + payload

def trak(fourcc, first_iv, samples=3):
    # 加密轨:stsd 写的是 encv,真实编码藏在 sinf/frma;senc 里是逐样本递增的计数器 IV。
    entry = box(b"encv", b"\x00" * 78 + box(b"sinf", box(b"frma", fourcc)))
    stsd = box(b"stsd", b"\x00" * 4 + struct.pack(">I", 1) + entry)
    ivs = b"".join(struct.pack(">Q", first_iv + i) for i in range(samples))
    senc = box(b"senc", b"\x00" * 4 + struct.pack(">I", samples) + ivs)
    return box(b"trak", box(b"mdia", box(b"minf", box(b"stbl", stsd + senc))))

hevc = trak(b"hvc1", 0x1122334455667788)
bytevc2 = trak(b"bvc2", 0x99AABBCCDDEEFF00)

assert mp4parse.track_format(hevc, 0, len(hevc)) == "hvc1"
assert mp4parse.track_format(bytevc2, 0, len(bytevc2)) == "bvc2"
assert mp4parse.senc_base(hevc, 0, len(hevc)) == 0x1122334455667788
assert mp4parse.senc_base(bytevc2, 0, len(bytevc2)) == 0x99AABBCCDDEEFF00
assert "bvc2" in mp4parse.UNSUPPORTED_FORMATS and "hvc1" not in mp4parse.UNSUPPORTED_FORMATS

script = os.environ["SHORTDRAMA_GRAB_SCRIPT"]
sys.argv = [
    script,
    "--series-name", "测试短剧",
    "--start-ep", "1",
    "--end-ep", "2",
    "--output-dir", os.path.dirname(script),
]
ns = runpy.run_path(script)

# gear_des_key 是首选来源,缺了才退回 video_meta
assert ns["_gear"]({"gear_des_key": "0:MP4|1:encrypt|2:bytevc2|4:720p|5:normal"}) == ("bytevc2", "720p")
assert ns["_gear"]({"video_meta": {"codec_type": "h265_hvc1", "definition": "1080p"}}) == ("h265_hvc1", "1080p")

def rung(definition, codec):
    return {"definition": definition, "codec": codec,
            "height": int(definition.rstrip("p")), "url": "https://x/" + definition,
            "backup": None, "size": 1}

# App 只肯下 720p,而这一集的 720p 是 ByteVC2 -> 必须挑到 1080p 那个标准 HEVC 档
ns["EP_STREAMS"].update({
    1: [rung("1080p", "h265_hvc1"), rung("720p", "bytevc2"), rung("360p", "bytevc2")],
    2: [rung("1080p", "h265_hvc1"), rung("720p", "h265_hvc1")],
    3: [rung("1080p", "bytevc2"), rung("720p", "bytevc2")],
})
assert ns["_pick_rung"](1)["definition"] == "1080p"
assert ns["_pick_rung"](1)["codec"] == "h265_hvc1"
assert ns["_pick_rung"](2)["definition"] == "1080p"
assert ns["_pick_rung"](3) is None          # 全档位都是 ByteVC2:老老实实报失败,不出半成品
assert ns["_pick_rung"](99) is None

# ByteVC2 的集要被推迟到联网阶段换源,而不是当场判失败
runtime = ns["_flush_ready"].__globals__
runtime["_scan_capture"] = lambda: ({7: "ab" * 16, 8: "cd" * 16}, {})
runtime["_mdl_unsupported"] = lambda fn: (["bvc2"] if fn == "vc2.mdl" else [])
runtime["EP2MDL"] = {7: "vc2.mdl", 8: "ok.mdl"}
produced = []
runtime["decrypt_to"] = lambda src, final, key=None: produced.append((src, key)) or True
runtime["_duration_ok"] = lambda ep, path: (True, 0, 0)
pending, ok_list, failed = {7, 8}, [], []
progressed = ns["_flush_ready"](pending, 2, ok_list, failed, {})
assert ns["DEFERRED"] == {7: "ab" * 16}, ns["DEFERRED"]
# 推迟换源的集【必须算进返回值】:调用方用它判断"这一轮有没有进展"(dry = 0 if got else dry + 1)。
# 漏掉就会被当成空转,连着几轮后白白触发选集网格重定位。
assert 7 in progressed and 8 in progressed, progressed
assert ok_list == [8] and failed == [], (ok_list, failed)
assert pending == set(), pending
assert len(produced) == 1 and produced[0][1] is None

# CDN 取源失败必须走 logev(stdout JSON),不能只写 stderr。
# Electron 对抓取进程的 stderr 只放行匹配英文 error/failed/... 的行,中文诊断会被整条丢掉,
# 于是主地址卡住重试的那几分钟界面上一片死寂,和真的卡死分不出来。
assert ns["CDN_TIMEOUT"] <= 30, ns["CDN_TIMEOUT"]        # 这是每次 read 的超时,不是整段下载上限
events = []
runtime["logev"] = lambda level, message: events.append((level, message))
runtime["_http_get"] = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("timed out"))
assert ns["_fetch_rung"](7, {"definition": "1080p", "url": "https://x/main",
                             "backup": "https://x/backup", "size": 1}, "/tmp/none.mp4") is False
text = " | ".join(m for _, m in events)
assert "主地址下载失败" in text and "改用备用地址重试" in text, text
assert "备地址下载失败" in text, text
assert all(lvl == "warn" for lvl, _ in events), events
# 复现实测事故:70 集的剧,盘上留着别的剧的 5 个文件,一路数到 75/70。
foreign = {"old%d.mdl" % i for i in range(5)}
state = {}
runtime["offline_set"] = lambda: foreign | {"new%d.mdl" % i for i in range(state["n"])}
runtime["offline_bytes"] = lambda: state["kb"]
runtime["logev"] = lambda level, message: None
runtime["dbg"] = lambda m: None

def run(stop_at):
    """下到 stop_at 个新文件就不再增加;字节数【永远】在涨,模拟有一集卡着涓涓细流地写。"""
    state.update(n=0, kb=0, t=0.0)
    def fake_sleep(sec):
        state["t"] += sec
        if state["n"] < stop_at: state["n"] = min(stop_at, state["n"] + 3)
        state["kb"] += 1
    runtime["time"].sleep = fake_sleep
    runtime["time"].time = lambda: state["t"]
    return ns["_wait_download"](70, 1800, foreign)

# 本剧只下到 65 集就卡住:必须判 partial。若把别的剧那 5 个也算进来,
# 65+5=70 会满足 n>=N 而误判"已下齐",后面整轮拿着缺集的素材往下走。
assert run(65) == "partial", "本剧没下齐却判成功了(把别的剧的残留算进计数)"
assert state["n"] == 65, state["n"]

# 本剧下齐 70 集,但字节数总也稳不下来:必须在 GIVEUP 上限内收工,不能空转到 30 分钟 timeout。
assert run(70) is True, "文件齐了却没收工"
assert state["t"] < 600, "空转了 %.0fs,应在 GIVEUP 上限内收工" % state["t"]
print("download counting ok (卡住判 partial;齐了 %.0fs 内收工)" % state["t"])

print("bytevc2 rung fallback ok")
`;

  const result = spawnSync(pythonCommand(), ['-c', probe], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SHORTDRAMA_GRAB_SCRIPT: grabScript,
      SHORTDRAMA_PROJECT_ROOT: projectRoot,
      HONGGUO_RUNTIME_DIR: runtimeDir,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /bytevc2 rung fallback ok/);
});

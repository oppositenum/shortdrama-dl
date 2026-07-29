#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hongguo_grab.py —— 供 Electron 作为子进程调用的「按剧名+集数区间」抓取器。

契约见 docs/ARCHITECTURE.md。要点:
  - stdout 只输出 JSON 行(进度协议);所有调试/人类日志走 stderr。
  - 断点续传:跳过 output-dir 里已存在且非空的 第NN集.mp4。
  - 退出码:0 全成功 / 2 部分失败 / 3 环境错误 / 130 收到终止信号。
  - SIGTERM/SIGINT:安全停止、删掉正在写的半截文件后退出 130。
  - 单集失败自动重试 1 次;失败不中断后续集。

原理:红果 App 里所有集可离线下载;下载后断网播放某集会用 libttffmpeg 解密,
用 frida 抓其 AES-128-CTR key,再用 key 离线解密该集完整的 .mdl(明文MP4壳+密文mdat)
→ ffmpeg 重封装为可播 MP4。录制=拿key+解密,不是录屏。

出片用哪个源:App 的离线下载【固定走 720p 档】,而那一档有些集是 ByteVC2 编码
(字节私有,ffmpeg 既没有解码器也没有封装标签,封不出可播文件)。这种集自动改用
服务端 1080p 档——那一档是标准 HEVC。之所以能换源,是因为同一集各清晰度档位共用同一把
AES key,而每个样本的 IV 就写在文件自己的 senc 里,不要求"这个文件被播放过"。
加 --prefer-1080p 可让所有集都走 1080p。
"""
import argparse, sys, os, re, time, json, signal, subprocess, threading, struct, shutil, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)          # 打包态下工作目录不一定是脚本目录
import mp4parse
# HERE 只保存随应用分发的只读脚本。打包态必须把抓取缓存写到 Electron
# userData，避免修改 .app/Contents/Resources 后破坏 macOS 代码签名。
RUNTIME = os.path.abspath(os.environ.get("HONGGUO_RUNTIME_DIR") or HERE)
PKG  = "com.phoenix.read"
OFFDIR    = f"/sdcard/Android/data/{PKG}/files/ttvideo_offline"
CACHEDIRS = [f"/sdcard/Android/data/{PKG}/cache/short", f"/sdcard/Android/data/{PKG}/cache/dataloader"]
DL_ACT    = "com.dragon.read.component.download.impl.DownloadManagementActivity"
MDL       = os.path.join(RUNTIME, "allmdl")
CAP       = os.path.join(RUNTIME, "captured_grab.jsonl")
APPDB     = os.path.join(RUNTIME, ".appdb")
DEEPLINK_SEARCH = "dragon8662://search"

# ============================ CLI ============================
ap = argparse.ArgumentParser(description="红果 App 按剧名抓取指定集数区间")
ap.add_argument("--series-name", required=True, help="剧名(用于 App 内搜索)")
ap.add_argument("--series-id", default="", help="网页版 series_id;App 端按剧名搜索,忽略此参数")
ap.add_argument("--start-ep", type=int, required=True, help="起始集(含)")
ap.add_argument("--end-ep",   type=int, required=True, help="结束集(含)")
ap.add_argument("--output-dir", required=True, help="输出文件夹(绝对路径)")
ap.add_argument("--dwell", type=float, default=8.0, help="每集重播抓key的最长等待秒(默认8)")
ap.add_argument("--keep-download", action="store_true", help="抓完不在App里删除下载(默认会删)")
ap.add_argument("--prefer-1080p", action="store_true",
                help="所有集都用服务端 1080p 源(默认只在 App 下的副本是 ByteVC2 时才换源)")
args = ap.parse_args()

NAME   = args.series_name
START  = args.start_ep
END    = args.end_ep
OUTDIR = os.path.abspath(args.output_dir)
DWELL  = max(3.0, args.dwell)

# ======================= 输出协议 =======================
_out_lock = threading.Lock()
def emit(o):
    with _out_lock:
        sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\n"); sys.stdout.flush()
def dbg(m):
    sys.stderr.write(str(m) + "\n"); sys.stderr.flush()
def logev(level, msg):
    emit({"event": "log", "level": level, "message": msg})

# ======================= 取消/信号 =======================
CANCEL = {"v": False}
_partial = {"path": None}          # 正在写的临时文件,信号时删掉
def _on_sig(signum, frame):
    CANCEL["v"] = True
    dbg(f"[signal] {signum} received, will stop safely")
signal.signal(signal.SIGTERM, _on_sig)
signal.signal(signal.SIGINT,  _on_sig)

def _clean_partial():
    p = _partial["path"]
    for q in ([p, p + ".dec.mp4"] if p else []):
        try:
            if q and os.path.exists(q): os.remove(q)
        except Exception: pass
    _partial["path"] = None

_sess = {"s": None, "scr": None}
def finish(code, ok=None, failed=None, emit_done=True):
    try:
        if _sess["s"] is not None: _sess["s"].detach()
    except Exception: pass
    _clean_partial()
    _release_device_lock()
    try: net(True)
    except Exception: pass
    if emit_done and code in (0, 2):
        emit({"event": "done", "ok": ok if ok is not None else 0, "failed": failed or []})
    sys.exit(code)

# ======================= adb / UI 基础 =======================
# 所有 adb 调用都必须有超时。实测模拟器忙起来时 `adb shell am broadcast` 这类命令会【永久挂住】,
# 而这两个函数原来不带 timeout —— 一挂就是整个抓取器停在那儿不动、也不报错(Electron 那边只看到
# 进度突然不走了)。超时就当这一步失败继续走,上层本来就有重试/复位逻辑。
def sh(*a, timeout=30):
    try: subprocess.run(["adb", "shell", *a], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired: dbg(f"[adb] 超时{timeout}s: shell {' '.join(str(x) for x in a)}")
def adb(*a, timeout=None):
    try:
        return subprocess.run(["adb", *a], capture_output=True, text=True,
                              timeout=timeout if timeout is not None else 300)   # pull 大文件要留足
    except subprocess.TimeoutExpired:
        dbg(f"[adb] 超时: {' '.join(str(x) for x in a)}")
        return subprocess.CompletedProcess(a, 1, "", "timeout")
def tap(x, y): sh("input", "tap", str(int(x)), str(int(y)))
def keyback(): sh("input", "keyevent", "4")
def _attr(s, k):
    m = re.search(k + r'="([^"]*)"', s); return m.group(1) if m else None
def _center(b):
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', b or '')
    return ((int(m[1]) + int(m[3])) // 2, (int(m[2]) + int(m[4])) // 2) if m else None
def _wh():
    try:
        o = adb("shell", "wm", "size", timeout=8).stdout
        m = re.search(r'(\d+)x(\d+)', o)
        if m: return int(m.group(1)), int(m.group(2))
    except Exception: pass
    return 1080, 2400
_W, _H = _wh()

def ui_dump(retries=3):
    P = "/sdcard/ui_grab.xml"
    for _ in range(retries):
        sh("rm", "-f", P)
        try: r = adb("shell", "uiautomator", "dump", P, timeout=20)
        except subprocess.TimeoutExpired: time.sleep(0.6); continue
        if "dumped to" in (r.stdout + r.stderr):
            x = adb("shell", "cat", P, timeout=30).stdout
            if len(x) > 500: return x
        time.sleep(0.6)
    return ""
def dump_stable(tries=5):
    x = ui_dump(2)
    if x: return x
    for _ in range(tries):
        tap(_W // 2, _H // 2); time.sleep(1.3); x = ui_dump(2)
        if x: return x
    return ""
def ui_find(xml, text=None, rid=None, ymax=None):
    for m in re.finditer(r'<node [^>]*>', xml):
        s = m.group(0)
        if text is not None and _attr(s, 'text') != text: continue
        if rid  is not None and _attr(s, 'resource-id') != rid: continue
        c = _center(_attr(s, 'bounds'))
        if c and (ymax is None or c[1] <= ymax): return c
    return None
def net(on):
    for svc in ("wifi", "data"): sh("svc", svc, "enable" if on else "disable")

# ======================= 清理 =======================
def clear_cache():
    for d in CACHEDIRS: sh(f"rm -rf {d}/*")
def clear_all():
    sh(f"rm -rf {OFFDIR}/*")
    for d in CACHEDIRS: sh(f"rm -rf {d}/*")
def offline_set():
    o = adb("shell", f"ls {OFFDIR}/ 2>/dev/null").stdout
    return set(x for x in o.split() if x.endswith('.mdl'))
def offline_bytes():
    o = adb("shell", f"du -k {OFFDIR}/*.mdl 2>/dev/null").stdout
    tot = 0
    for line in o.splitlines():
        p = line.split()
        if p and p[0].isdigit(): tot += int(p[0])
    return tot

# ======================= 环境检查(失败=退出3)=======================
def _pick_device():
    """同时连着多台设备时,不带 -s 的 adb 命令会全部失败(adb: more than one device)。
    本工具就是跑模拟器的:没指定 ANDROID_SERIAL 又刚好只有一台 emulator-* 时,自动认它。
    (实测踩过:一个残留的 adb connect localhost:15551 就能让整轮抓取一上来就死。)"""
    if os.environ.get("ANDROID_SERIAL"): return
    devs = [l.split("\t")[0] for l in adb("devices", timeout=8).stdout.splitlines()[1:]
            if l.strip().endswith("\tdevice")]
    if len(devs) <= 1: return
    emus = [d for d in devs if d.startswith("emulator-")]
    if len(emus) == 1:
        os.environ["ANDROID_SERIAL"] = emus[0]
        logev("info", f"检测到多台设备 {devs},自动使用模拟器 {emus[0]}")

_LOCK = {"path": None}
def _acquire_device_lock(serial):
    """一台设备同一时间只允许一个抓取进程。
    两个进程抢同一台模拟器会互相拆台——一边在"清 App 下载记录后整部重下",另一边正在选集抓 key,
    界面被对方一脚踢走。实测这样能让几十集在一分钟内全部失败,而且日志上看不出是并发导致的。"""
    import tempfile
    p = os.path.join(tempfile.gettempdir(), f"hongguo_grab_{re.sub(r'[^A-Za-z0-9_.-]', '_', serial)}.lock")
    try:
        if os.path.exists(p):
            old = open(p).read().strip()
            alive = False
            if old.isdigit():
                try: os.kill(int(old), 0); alive = True
                except Exception: alive = False
            if alive:
                logev("error", f"设备 {serial} 上已经有一个抓取进程在跑(pid {old})。"
                               f"同一台设备同时只能跑一个,请等它结束或先停掉它。")
                # 直接退出,【绝不走 finish()】:那里会 net(True) 恢复网络,
                # 而正在跑的那个进程此刻多半正处于断网抓取阶段,一恢复网络就把人家搅了。
                sys.exit(3)
            os.remove(p)                                   # 陈旧锁(上次进程被硬杀):直接接管
        with open(p, "w") as f: f.write(str(os.getpid()))
        _LOCK["path"] = p
    except SystemExit: raise
    except Exception as e:
        dbg(f"[lock] 加锁失败(不阻断): {e}")

def _release_device_lock():
    p = _LOCK["path"]
    if not p: return
    try:
        if os.path.exists(p) and open(p).read().strip() == str(os.getpid()): os.remove(p)
    except Exception: pass
    _LOCK["path"] = None

def env_check():
    _pick_device()
    r = adb("get-state", timeout=8)
    serial = adb("get-serialno", timeout=8).stdout.strip()
    if r.stdout.strip() != "device" or not serial or serial == "unknown":
        # 常见坑:同时连着两台设备(另一个模拟器、真机、或残留的 adb connect),
        # 此时所有不带 -s 的 adb 命令都会失败。把设备列表报出来,并提示用 ANDROID_SERIAL 指定。
        lst = adb("devices", timeout=8).stdout.strip().replace("\n", " | ")
        logev("error", f"没有可用的安卓设备(adb get-state != device)。当前 adb devices: {lst}。"
                       f"若同时连着多台,请设环境变量 ANDROID_SERIAL=<序列号> 指定用哪一台")
        finish(3, emit_done=False)
    _acquire_device_lock(serial)      # 同一台设备只许一个抓取进程,防止两边抢界面
    adb("root", timeout=15); time.sleep(1)
    if PKG not in adb("shell", "pm", "list", "packages").stdout:
        logev("error", "红果 App 未安装(com.phoenix.read)"); finish(3, emit_done=False)
    try:
        import frida  # noqa
    except Exception:
        logev("error", "缺少 Python 依赖 frida(pip install frida-tools)"); finish(3, emit_done=False)
    if shutil.which("ffmpeg") is None:
        logev("error", "缺少 ffmpeg(请通过应用环境准备功能安装)"); finish(3, emit_done=False)
    try:
        import cryptography  # noqa
    except Exception:
        logev("error", "缺少 Python 依赖 cryptography(pip install cryptography)"); finish(3, emit_done=False)
    if not os.path.exists(os.path.join(HERE, "capture_final.js")):
        logev("error", "缺少 capture_final.js(frida 钩子脚本)"); finish(3, emit_done=False)
    return serial

# ======================= frida-server + ADBKeyboard =======================
def frida_up():
    return bool(adb("shell", "pidof", "frida-server").stdout.strip())

def _frida_device_version():
    return adb("shell", "/data/local/tmp/frida-server", "--version", timeout=10).stdout.strip()

def _download_frida_server(abi, version):
    """Download the matching official Frida server into the writable runtime cache."""
    import lzma, urllib.request
    arch = {
        "arm64-v8a": "arm64",
        "armeabi-v7a": "arm",
        "x86_64": "x86_64",
        "x86": "x86",
    }.get(abi)
    if not arch or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){2,3}", version or ""):
        return None

    os.makedirs(RUNTIME, exist_ok=True)
    final = os.path.join(RUNTIME, f"frida-server-{version}-android-{arch}")
    if os.path.isfile(final) and os.path.getsize(final) > 0:
        os.chmod(final, 0o755)
        return final

    archive = final + ".xz.part"
    unpacked = final + ".part"
    url = f"https://github.com/frida/frida/releases/download/{version}/frida-server-{version}-android-{arch}.xz"
    logev("info", f"设备缺少匹配的 frida-server,正在下载官方 Frida {version} ({arch}) ...")
    try:
        total = 0
        with urllib.request.urlopen(url, timeout=60) as src, open(archive, "wb") as dst:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk: break
                total += len(chunk)
                if total > 256 * 1024 * 1024:
                    raise RuntimeError("Frida archive exceeds 256 MB safety limit")
                dst.write(chunk)
        with lzma.open(archive, "rb") as src, open(unpacked, "wb") as dst:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk: break
                dst.write(chunk)
        os.chmod(unpacked, 0o755)
        os.replace(unpacked, final)
        return final
    except Exception as e:
        logev("warn", f"自动下载 frida-server 失败: {e}")
        return None
    finally:
        for p in (archive, unpacked):
            try:
                if os.path.exists(p): os.remove(p)
            except Exception: pass

def ensure_frida_server():
    import frida
    host_version = frida.__version__
    if frida_up() and _frida_device_version() == host_version: return
    if frida_up():
        logev("warn", f"设备 frida-server 版本 {_frida_device_version() or 'unknown'} 与 PC {host_version} 不一致,自动更新")
        sh("pkill -9 frida-server")
        time.sleep(1)
    abi = adb("shell", "getprop", "ro.product.cpu.abi").stdout.strip()
    if _frida_device_version() != host_version:
        src = _download_frida_server(abi, host_version)
        if not src:
            cand = [os.path.join(HERE, f"frida-server-{abi}"), os.path.join(HERE, "frida-server")]
            src = next((c for c in cand if os.path.exists(c)), None)
        if not src:
            logev("error", f"设备无匹配的 frida-server,且自动下载 Frida {host_version} 失败")
            finish(3, emit_done=False)
        adb("push", src, "/data/local/tmp/frida-server")
    sh("chmod 755 /data/local/tmp/frida-server; nohup /data/local/tmp/frida-server >/dev/null 2>&1 &")
    time.sleep(3)
    if not frida_up():
        logev("error", "frida-server 启动失败"); finish(3, emit_done=False)
    if _frida_device_version() != host_version:
        logev("error", f"frida-server 版本不匹配(设备 {_frida_device_version() or 'unknown'} / PC {host_version})")
        finish(3, emit_done=False)
def ensure_adbkeyboard():
    if "com.android.adbkeyboard" not in adb("shell", "pm", "list", "packages").stdout:
        import hashlib, urllib.request
        expected = "e698adea5633135a067b038f9a0cf41baa4de09888713a81593fb2b9682cdc59"
        commit = "4b513f3313b8392b316b37e9c08b0be2def79dda"
        url = f"https://raw.githubusercontent.com/senzhk/ADBKeyBoard/{commit}/ADBKeyboard.apk"
        os.makedirs(RUNTIME, exist_ok=True)
        apk = os.environ.get("SHORTDRAMA_ADB_KEYBOARD_APK") or os.path.join(RUNTIME, "ADBKeyboard.apk")

        def valid_apk(path):
            if not os.path.isfile(path) or os.path.getsize(path) > 5 * 1024 * 1024: return False
            with open(path, "rb") as fh:
                return hashlib.sha256(fh.read()).hexdigest() == expected

        if not valid_apk(apk):
            if os.environ.get("SHORTDRAMA_ADB_KEYBOARD_APK"):
                logev("error", "SHORTDRAMA_ADB_KEYBOARD_APK 的 SHA-256 与固定上游 APK 不一致")
                finish(3, emit_done=False)
            tmp = apk + f".{os.getpid()}.part"
            logev("info", "正在下载固定版本 ADBKeyBoard（GPL-2.0，仅用于中文输入）...")
            try:
                total = 0
                digest = hashlib.sha256()
                with urllib.request.urlopen(url, timeout=60) as src, open(tmp, "wb") as dst:
                    while True:
                        chunk = src.read(64 * 1024)
                        if not chunk: break
                        total += len(chunk)
                        if total > 5 * 1024 * 1024: raise RuntimeError("ADBKeyBoard APK exceeds 5 MB limit")
                        digest.update(chunk); dst.write(chunk)
                if digest.hexdigest() != expected: raise RuntimeError("ADBKeyBoard SHA-256 mismatch")
                os.replace(tmp, apk)
            except Exception as e:
                try:
                    if os.path.exists(tmp): os.remove(tmp)
                except OSError: pass
                logev("error", f"ADBKeyBoard 下载或校验失败: {e}")
                finish(3, emit_done=False)

        result = adb("install", "-r", apk, timeout=90); time.sleep(1)
        if result.returncode != 0 or "com.android.adbkeyboard" not in adb("shell", "pm", "list", "packages").stdout:
            logev("error", f"ADBKeyBoard 安装失败: {(result.stderr or result.stdout).strip()}")
            finish(3, emit_done=False)
    sh("ime", "enable", "com.android.adbkeyboard/.AdbIME")
    sh("ime", "set", "com.android.adbkeyboard/.AdbIME"); time.sleep(1)
def type_cn(text):
    sh("am", "broadcast", "-a", "ADB_CLEAR_TEXT"); time.sleep(0.4)
    adb("shell", "am", "broadcast", "-a", "ADB_INPUT_TEXT", "--es", "msg", text, timeout=30); time.sleep(1.5)

# ======================= frida 抓 key =======================
_stats = {"order": [], "seen": set(), "win": None}   # win!=None 时按 key 统计窗口内解密事件数
_lock = threading.Lock()
_fh = None
def _om(m, d):
    p = m.get("payload")
    if isinstance(p, dict) and p.get("tag") == "CRYPT":
        with _lock:
            if _fh: _fh.write(json.dumps(p) + "\n"); _fh.flush()
            k = p.get("key")
            if k:
                if k not in _stats["seen"]:
                    _stats["seen"].add(k); _stats["order"].append(k)
                if _stats["win"] is not None:            # 正在测"前台主导 key"
                    _stats["win"][k] = _stats["win"].get(k, 0) + 1
# 早停下限:窗口最少要等这么多秒才允许提前收工。默认 99 = 【关闭早停】,老老实实等满窗口。
# 为什么默认关:早停确实把"每集中位耗时"从 8.3s 压到 3.7~5.3s,但滑得太急播放器跟不上,
# "播完停住"的卡顿变多,而每次卡顿要 20~45 秒——三轮实测下来【总时长反而更长】
# (75集: 11.9s/集 → 13.4s/集)。而且那三轮是同一台模拟器越跑越钝的顺序,数据本身也不干净。
# 代码留着、参数可调(HG_EARLY_MIN=2.5),等有条件做干净的 A/B 再决定要不要默认打开。
EARLY_MIN = float(os.environ.get("HG_EARLY_MIN", "99"))
def _dominant_key(sec, want=None):
    """开窗口 sec 秒统计解密事件,返回事件最多的 key = 当前【前台播放】那一集。
    前台每帧都在解密,事件数远多于后台预加载 → 不受历史/预加载 key 干扰(治本#2)。

    开窗口前必须先把 JS 端的限流配额清零(post reset):capture_final.js 每个 key 只发 LIMIT 条,
    这个计数原本【整个会话不清零】——一集只要早被播过一次(导航踏脚石、抓完后的连播、预加载),
    它的 key 就永久静音。于是真正导航到这一集时窗口里一个事件都没有,明明画面就停在这一集,
    却报"到位却没抓到解密key",而且【隔一集失败一次】(抓第N集时第N+1集被顺带播过→静音→N+1必挂)。

    早停(want=待抓集合):一旦【待抓的集里有谁拿到 key 了】就收工,不必等满 sec。
    实测每集 8.3 秒里有 6 秒在干等这个固定窗口;而 App 会往前预加载好几集,
    很多时候我们要的那几集早就解密好了,根本不用等——等下去纯属浪费。
    (早停判据不能用"出现了新集":下一集的 key 常常在我们滑过去之前就已经到手,
     窗口里反而"没有新集",于是照样等满——实测这么写几乎没提速。)
    早停不影响判"前台是哪一集":JS 端每个 key 每窗口最多发 LIMIT(60) 条,前台起播一秒内就打满,
    之后本来也不再出声,窗口再长也不会改变谁是主导。"""
    try:
        if _sess.get("scr") is not None: _sess["scr"].post({"type": "reset"})
    except Exception as e:
        dbg(f"[key] reset 配额失败(旧版 capture_final.js?): {e}")
    with _lock: _stats["win"] = {}
    t = time.time()
    while time.time() - t < sec:
        if CANCEL["v"]: break
        time.sleep(0.3)
        if want and time.time() - t >= EARLY_MIN and (set(_scan_capture()[0]) & want):
            break                                          # 要的集已经能出片了,不用再等
    with _lock:
        w = dict(_stats["win"]); _stats["win"] = None
    return max(w, key=w.get) if w else None
def app_pid():
    o = adb("shell", "pidof", PKG).stdout.split()
    return int(o[0]) if o else None
def _frida_device():
    """按【序列号】取 frida 设备,不要用 get_usb_device()。
    实测:同时连着两台设备时 get_usb_device() 会挑中另一台(那台上没有 frida-server),
    报 'unable to connect to remote frida-server: closed',整轮抓取直接死在挂载这一步。"""
    import frida
    ser = os.environ.get("ANDROID_SERIAL") or adb("get-serialno", timeout=8).stdout.strip()
    if ser and ser != "unknown":
        try: return frida.get_device(ser, timeout=10)
        except Exception as e: dbg(f"[frida] 按序列号 {ser} 取设备失败({e}),退回 get_usb_device")
    return frida.get_usb_device(timeout=10)

def frida_attach():
    import frida
    global _fh
    # 【追加而不是覆盖】:捕获文件里的 key 是可以跨次复用的资产——密文索引能认出每条事件属于哪一集,
    # 上一轮顺带解密到的集,这一轮开工就能直接出片、连导航都省了。ct 是按内容匹配的,
    # 旧记录对不上新文件时自然失配,不会张冠李戴。太大了才重开,免得无限长。
    try:
        if os.path.exists(CAP) and os.path.getsize(CAP) > 80 * 1024 * 1024: os.remove(CAP)
    except Exception: pass
    _fh = open(CAP, "a")
    last = None
    for _ in range(5):
        p = app_pid()
        if p:
            try:
                s = _frida_device().attach(p)
                scr = s.create_script(open(os.path.join(HERE, "capture_final.js")).read())
                # capture_final.js 里的 console.log(如 "[ready]…" "[cal] key @ …")默认被 frida 打到
                # stdout,会污染"stdout 只有 JSON 行"的协议(Electron 那边解析会炸)。改道到 stderr。
                try: scr.set_log_handler(lambda level, text: dbg(f"[js:{level}] {text}"))
                except Exception as e: dbg(f"set_log_handler 不可用: {e}")
                scr.on("message", _om); scr.load()
                _sess["s"] = s; _sess["scr"] = scr      # scr 要留着:每次开测量窗口前 post reset 清限流配额
                return s
            except Exception as e:
                last = e; time.sleep(3)
        else:
            time.sleep(3)
    logev("error", f"frida 挂载失败: {last}"); finish(3, emit_done=False)

# ======================= 搜索进剧 / 集数 =======================
def open_search():
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", DEEPLINK_SEARCH)
    time.sleep(2.5)
def _looks_like_series_page(x):
    """像不像"某部剧的页面"(详情页或全屏播放器)。注意这只说明【是一部剧】,不说明是【哪一部】。"""
    return bool(x) and bool(re.search(r'全\d+集', x) or ('选集' in x) or re.search(r'第\d+集', x))

def _title_here(x, name):
    """当前页面上出现的是不是【这部剧】的名字。剧名在详情页标题、播放器底部剧名行都会出现,
    但可能被截断,也可能标点写法不同(：vs :),所以【去标点后】前 6 个字对上就算。"""
    if not x or not name: return False
    if name in x: return True
    want = _norm_title(name)
    if len(want) < 3: return False
    texts = "".join(_norm_title(t) for t in re.findall(r'text="([^"]*)"', x))
    return want[:6] in texts

def search_open(name, tries=3, recovery=False):
    """搜索并进入这部剧。【必须核对进的是哪一部】——这是本脚本出过的最坏的一类事故:

    旧版判据是"页面上有 '全N集' 或 '选集' 就算成功",而这对【任何一部剧】都成立;
    再加上找不到精确标题时会盲点固定坐标(0.26W,0.30H),而搜索结果没加载出来时,
    那个位置正好压在【搜索历史/继续观看】上——第一条往往是上一部抓过的剧。
    于是整轮抓取会静悄悄地跑到别的剧里去:在错的剧里开选集、点第N格,
    量到的 key 对不上本剧任何文件(报 no downloaded file for key),
    或者那部剧的下载早被清掉、只剩黑屏(报 到位却没抓到解密key)。实测截图为证。

    现在:进去之后必须在页面上看到这部剧的名字,看不到就退回搜索页重来。
    盲点兜底也收紧成【只有结果页里确实出现了剧名才敢点】。"""
    for t in range(tries):
        if CANCEL["v"]: return False
        if t: keyback(); time.sleep(1.5)                  # 重试前先退一步,免得卡在上一次的残留页面上
        open_search()
        x = dump_stable()
        inp = ui_find(x, rid=f"{PKG}:id/hhp") or ui_find(x, text='请输入剧名')
        if not inp:                                       # dump 偶发失败/页面还没渲染好,重来一次即可,
            dbg(f"[search] 第{t+1}次:没找到搜索输入框,重来"); time.sleep(2); continue   # 不该因此放弃整轮
        tap(*inp); time.sleep(1)
        type_cn(name)
        x = ui_dump()
        btn = ui_find(x, rid=f"{PKG}:id/hj_") or ui_find(x, text='搜索', ymax=300)
        if not btn:
            dbg(f"[search] 第{t+1}次:没找到搜索按钮,重来"); time.sleep(2); continue
        tap(*btn); time.sleep(3.5)
        x = ui_dump()
        title = None
        for m in re.finditer(r'<node [^>]*>', x or ""):
            s = m.group(0); tt = _attr(s, 'text')
            if tt and tt == name and _attr(s, 'class') != 'android.widget.EditText':
                c = _center(_attr(s, 'bounds'))
                if c and c[1] > 320: title = c; break
        if title:
            tap(title[0], max(360, title[1] - 400))          # 封面在标题上方
        elif _title_here(x, name):
            tap(int(_W * 0.26), int(_H * 0.30))              # 结果页确实有这部剧,才敢盲点第一个卡片
        else:
            dbg(f"[search] 第{t+1}次:结果页里没看到《{name}》(没搜出来/没加载完),重搜")
            time.sleep(2); continue
        time.sleep(3.5)
        x = dump_stable()
        if not x:
            # 界面读不到(落在全屏播放器时 uiautomator dump 经常整个失败)。这【不等于进错剧】,
            # 不能因此把整轮判死——实测就是它把一次本来正常的抓取拖成"连续3次没核对上"而退出。
            # 按进对了处理:真进错了,抓取阶段量到的 key 在本剧索引里认不出来,那时再重进。
            dbg("[search] 进去了但界面读不到(全屏播放器常见),先按进对了处理"); return True
        if _looks_like_series_page(x) and _title_here(x, name): return True
        dbg(f"[search] 第{t+1}次{'进的是别的剧' if _looks_like_series_page(x) else '没进成剧集页'},退回重搜")
        time.sleep(1)
    if recovery:
        logev("info", f"恢复定位时暂未通过 UI 核对《{name}》(已重试 {tries} 次);"
                      f"这是可恢复导航提示,现有分集不受影响,后续仍会用解密事件核对剧集")
    else:
        logev("warn", f"搜索进入《{name}》连续 {tries} 次没核对上")
    return False
def read_total():
    x = dump_stable()
    m = re.search(r'全(\d+)集|共(\d+)集', x)
    return int(next(g for g in m.groups() if g)) if m else 0

def _total_from_grid():
    """从选集面板读总集数:分页标签(1-30 / 31-60 / 91-96)的最大上界就是总集数,没有分页就取最大格子号。
    用于界面上读不到'全N集'的情形——实测搜索进剧后有时直接落在全屏播放器,
    那个版式底栏只有'选集/相关推荐',旧版会在这里直接判'没识别到总集数'退出。"""
    g = _open_grid()
    if not _grid_open(g): return 0
    best = 0
    for m in re.finditer(r'text="(\d+)-(\d+)"', g): best = max(best, int(m.group(2)))
    for m in re.finditer(r'text="(\d+)"', g):       best = max(best, int(m.group(1)))
    dbg(f"[total] 从选集面板读到总集数 {best}")
    return best

# ======================= 下载整部(全选)=======================
# 关键背景:App 的"已下载"标记(✓)来自它自己的下载数据库,和磁盘上的 .mdl 文件是两套。
# 旧版清理用 rm 只删了磁盘文件,没清 App 数据库 → 留下"幽灵记录":App 认为某些集下过、
# 点开始下载不会重下,但盘上其实没有文件。这时无论怎么等都只会卡在 0/N。
# 唯一可靠的修法:磁盘不齐时,先用 App 的"我的下载→删除"把数据库清干净,再整部干净重下。
def _open_dl_panel():
    """在剧集页打开'下载到本地'底部面板,返回面板 xml;打不开返回 ''。
    面板点开了但【读不到布局】不算失败:设备忙起来 uiautomator dump 会整个超时,
    实测出现过面板明明已经开着(截图为证)却因为最后那次 dump 是空的,报"没找到'下载到本地'菜单"
    而整轮下载失败。所以最后一步用 dump_stable 多试几次,而且已经点开就别再重复点 ⋮。"""
    for i in range(3):
        x = dump_stable()
        if x and ('全选' in x or '开始下载' in x): return x        # 面板已经开着了
        dl = ui_find(x, text='下载到本地')
        if not dl:
            tap(int(_W * 0.935), int(_H * 0.077)); time.sleep(2)  # 右上角 ⋮
            dl = ui_find(dump_stable(), text='下载到本地')
        if dl:
            tap(*dl); time.sleep(2.5)
            p = dump_stable()
            if p: return p
            dbg(f"[dl] 面板点开了但读不到布局(dump 超时?),重试 {i+1}/3")
        time.sleep(1.5)
    return ""

def _wait_download(N, timeout, baseline=None):
    """等到本剧 N 集下齐。返回 True / 'partial' / 'cancel'。

    只数【开工后新出现的】文件,不数目录里原有的。原来数的是绝对总数,前提是"清库会把别的剧的
    残留一起清掉"——可 delete_downloads() 全靠点 UI,失败了还不报错,前提随时会塌。
    实测踩过:盘上留着别的剧的 5 个文件,70 集的剧一路数到 75/70。两个后果都很坏——
    本剧其实还差几集时就可能满足 n >= N 提前收工;而且 75>=70 一旦成立,
    后面就只剩"等字节数稳定"这一个出口了(见下面的 GIVEUP)。"""
    STABLE = 12; GIVEUP = 180
    if baseline is None: baseline = offline_set()
    if baseline: dbg(f"[dl] 开工前盘上已有 {len(baseline)} 个 .mdl(别的剧的残留),计数时排除")
    t0 = time.time(); last = 0; last_b = -1; stable_since = None; noprog_since = None
    while time.time() - t0 < timeout:
        if CANCEL["v"]: return "cancel"
        n = len(offline_set() - baseline); b = offline_bytes()
        if b > 0 and b == last_b:
            if stable_since is None: stable_since = time.time()
        else: stable_since = None; last_b = b
        stable_for = (time.time() - stable_since) if stable_since else 0
        if n > last: noprog_since = None
        elif noprog_since is None: noprog_since = time.time()
        last = n
        noprog = (time.time() - noprog_since) if noprog_since else 0
        logev("info", f"下载中 {n}/{N} ({b//1024}MB)")
        if n >= N and (b <= 0 or stable_for >= STABLE): return True
        # 文件数已够,但字节数总也稳不下来:多半是有一集卡在那儿涓涓细流地写,
        # 每次轮询都把稳定计时器重置。没有这一条,循环会一直空转到 timeout(30 分钟)——
        # 实测就这么干等过。所以文件齐了就给个上限:超过 GIVEUP 没有新文件也照样收工,
        # 最后那个可能没下全,交给出片时的时长校验去拦(它本来就是防这一类的)。
        if n >= N and noprog >= GIVEUP:
            logev("warn", f"{N} 集文件已齐,但仍有文件在缓慢写入且 {GIVEUP}s 没有新增,按已齐处理")
            return True
        if n < N and noprog >= GIVEUP and stable_for >= STABLE: return "partial"
        time.sleep(4)
    return "partial"

def _ours_on_disk():
    """设备上属于【本剧】的 .mdl 有几个。没有集号映射时返回 None。
    绝不能拿"离线目录里的文件总数"当数:实测出现过盘上留着【别的剧】的 71 个文件,
    于是判定"已齐 71/63"直接跳过下载,后面拿别人的文件去对本剧的 key,整轮全废。"""
    if not EP2MDL: return None
    have = offline_set()
    return sum(1 for fn in EP2MDL.values() if fn in have)

def download_all(N, timeout=1800):
    # 快路径:盘上【属于本剧的】文件已齐 → 直接复用,一秒跳过(满足"下过就别重下")。
    # 【绝不能按目录里的文件总数判断】:实测抓《三生：渡厄》(80集)时,盘上留着上一部《豪门月嫂》
    # 的 96 个文件,旧判据"96 >= 80"直接跳过下载;而 App 库里没有本剧的下载记录 → 集号映射为空
    # → 密文索引建不起来 → 退回逐集导航模式,整轮又慢又飘。一步误判,后面全错。
    # 拿不到映射时(=App 库里没有本剧的下载记录,说明这部剧压根没下过)就老老实实下载,
    # 大不了多花几分钟,绝不拿别的剧的文件冒充。
    ours = _ours_on_disk()
    if ours is not None and ours >= N:
        logev("info", f"本剧离线文件已齐 {ours}/{N},复用现有,跳过下载")
        return True
    if ours is not None:
        dbg(f"[dl] 盘上属于本剧的只有 {ours}/{N}(目录里共 {len(offline_set())} 个文件,其余是别的剧的残留)")
    elif len(offline_set()):
        logev("info", f"App 库里没有本剧的下载记录,目录里那 {len(offline_set())} 个文件是别的剧的,整部重下")
    # 盘上不齐:可能存在幽灵记录(App 记为已下载但文件已丢),那些集点下载不会重下。
    # 先清 App 下载记录再整部干净重下。注意【不能假设清库会把别的剧的残留一起清掉】:
    # delete_downloads() 走的是 App 自己的删除,只认它数据库里有记录的文件;
    # 数据库不认识的孤儿文件永远删不掉,会一轮轮累积。所以下面一律用"清库后新增"计数。
    for attempt in (1, 2):
        logev("info", f"本剧离线文件不齐(目录内共 {len(offline_set())} 个,含别的剧的残留),"
                      f"清 App 下载记录后整部重下(第{attempt}/2 次)…")
        try: delete_downloads()
        except Exception as e: dbg(f"清下载记录异常: {e}")
        time.sleep(2)
        # 【必须在这里取基准】:清库之后、开下之前。清完还剩下的就是清不掉的别的剧的残留,
        # 后面的计数一律排除它们。放到 _wait_download 里取就晚了——那时点"开始下载"已经过去两秒,
        # 本剧可能已经落盘一两个文件,被当成残留排除掉,反而永远数不到 N。
        baseline = offline_set()
        if not search_open(NAME):
            logev("error", "清库后重新进入该剧失败"); return len(offline_set()) >= 1
        panel = _open_dl_panel()
        if not panel:
            logev("error", "没找到'下载到本地'菜单"); return False
        sa = ui_find(panel, text='全选')
        if sa: tap(*sa); time.sleep(1.5); panel = ui_dump()
        st = ui_find(panel, text='开始下载')
        if not st:
            logev("error", "没找到'开始下载'"); return False
        tap(*st); time.sleep(2)
        cont = ui_find(ui_dump(), text='继续')
        if cont: tap(*cont); time.sleep(2)
        res = _wait_download(N, timeout, baseline)
        if res == "cancel": return "cancel"
        keyback(); time.sleep(1.5)          # 关下载面板,收口回剧详情页(与复用路径同一落点)
        if res is True: return True
        got = len(offline_set() - baseline)      # 与 _wait_download 的判据保持一致,别再报绝对总数
        if attempt == 1:
            logev("warn", f"仅下到 {got}/{N},清库整部重下一次"); continue
        logev("warn", f"下载卡在 {got}/{N},以现有继续")
        return got >= 1
    return True

# ============ 集号 ↔ .mdl 文件 的确定性映射(取自 App 自己的数据库)============
# 界面识别(顶栏'第X集'/高亮格子)会读不到、会滞后,而 App 的下载库里本来就写着
# 【第几集 = 哪个 vid = 哪个 .mdl 文件】。用它给每次抓取做终检:抓到的 key 属于哪个文件、
# 那个文件是第几集,一查便知——错集就当场发现,绝不把上一集的内容存成下一集的文件名。
# 三张表接力(中间那步不能省:video_list 里的 vid 是【剧集视频号】7620641096825064472,
# 而 .mdl 是按【播放源 vid】v02ebeg1... 存的,两者靠 t_series_download_task 对上):
#   series_download_db : t_series_video_detail.video_detail_model → video_list[{vid, vid_index}]
#   series_download_db : t_series_download_task{video_id → mdl_video_id}
#   TTVideoEngine_download_database_v01 : value.base_json{vid, file_path}
# 库结构随 App 版本可能变;取不到就返回空映射,自动退回"不校验"的旧行为(只是少一层保险)。
EP2MDL = {}; MDL2EP = {}
EP_DUR = {}               # 集号 → App 库记的标准时长(秒),用来核对出片有没有短一截
TOTAL_EPS = 0             # 界面上数出来的总集数,用于剧名写法不同时核对是不是同一部
def _pull_app_db():
    """把 App 的下载库拉到本地 .appdb(-wal 一起拉,否则读到的是旧快照)。返回本地目录。"""
    dbdir = APPDB; os.makedirs(dbdir, exist_ok=True)
    base = f"/data/data/{PKG}/databases/"
    for f in ("series_download_db", "series_download_db-wal", "TTVideoEngine_download_database_v01"):
        adb("pull", base + f, os.path.join(dbdir, f), timeout=60)
    return dbdir

def _norm_title(s):
    """剧名归一化:去掉空白和各种标点再比。网页端传来的剧名和 App 里的写法常差一个标点
    (：vs :、，vs ,、书名号等),差一个字符就认不出这部剧,后面索引全建不起来。"""
    return re.sub(r'[\s:：,，、。.·・—\-—_~!！?？"“”\'‘’()（）《》〈〉\[\]【】]', '', s or "")

def _series_video_list(dbdir):
    """取本剧的分集清单(每项含 vid / vid_index / duration)。取不到返回 None。
    【必须对得上这部剧】:曾经写成"库里只有一行就用它",结果 App 换了剧、库里那行是别的剧,
    于是拿别人的集号映射去认本剧的文件,越错越远。宁可没有映射,也不能认错剧。"""
    import sqlite3
    c = sqlite3.connect(os.path.join(dbdir, "series_download_db"))
    rows = c.execute("select video_detail_model from t_series_video_detail").fetchall()
    cand = []
    want = _norm_title(NAME)
    for (raw,) in rows:
        vdata = json.loads(raw).get("video_data", {})
        t = vdata.get("series_title") or ""
        vl = vdata.get("video_list") or []
        cand.append((t, len(vl)))
        n = _norm_title(t)
        if n and want and (n == want or (len(want) >= 4 and (n.startswith(want[:6]) or want.startswith(n[:6])))):
            return vl
    # 剧名对不上的兜底:库里只有一行、且它的集数跟我们在界面上数出来的总集数一致 → 就是它。
    # (集数是硬证据,80 / 96 / 63 各不相同,不会像"只有一行就用它"那样认错剧。)
    if len(rows) == 1 and TOTAL_EPS and cand[0][1] == TOTAL_EPS:
        logev("info", f"App库里的剧名《{cand[0][0]}》与传入的《{NAME}》写法不同,但集数都是 {TOTAL_EPS},按同一部处理")
        return json.loads(rows[0][0]).get("video_data", {}).get("video_list")
    dbg(f"[map] App库里没有《{NAME}》的记录(库里是: {cand})")
    return None

def _total_from_db():
    """从 App 库读本剧总集数。界面上读不到'全N集'时用它兜底——
    实测搜索进剧后有时直接落在全屏播放器里,那个版式的底栏只有'选集/相关推荐',没有'全N集',
    旧版会在这里直接判'没识别到总集数'退出。"""
    try:
        vl = _series_video_list(_pull_app_db())
        return max(int(v["vid_index"]) for v in vl if v.get("vid_index")) if vl else 0
    except Exception as e:
        dbg(f"[map] 从App库读总集数失败: {e}"); return 0

def _load_ep_maps():
    import sqlite3
    dbdir = _pull_app_db()
    c = sqlite3.connect(os.path.join(dbdir, "series_download_db"))
    vl = _series_video_list(dbdir)
    if not vl: return {}, {}
    vid2play = {}                                          # 剧集视频号 → 播放源 vid
    for video_id, mdl_video_id in c.execute("select video_id, mdl_video_id from t_series_download_task"):
        if video_id and mdl_video_id: vid2play[str(video_id)] = mdl_video_id
    t = sqlite3.connect(os.path.join(dbdir, "TTVideoEngine_download_database_v01"))
    play2mdl = {}                                          # 播放源 vid → .mdl 文件名
    for (val,) in t.execute("select value from TTVideoEngine_download_database_v01"):
        try: b = json.loads(val).get("base_json", {})
        except Exception: continue
        if b.get("vid") and b.get("file_path"): play2mdl[b["vid"]] = os.path.basename(b["file_path"])
    ep2mdl = {}
    EP_DUR.clear()
    for v in vl:
        idx = v.get("vid_index")
        if not idx: continue
        if v.get("duration"): EP_DUR[int(idx)] = float(v["duration"])
        fn = play2mdl.get(vid2play.get(str(v.get("vid"))))
        if fn: ep2mdl[int(idx)] = fn
    return ep2mdl, {v: k for k, v in ep2mdl.items()}
CT2EP = {}                # 密文首16字节(前16个hex) → 集号。见 _build_ct_index
def _build_ct_index():
    """给每一集的 .mdl 建【密文样本 → 集号】索引。有了它,任何一条解密事件都能【当场认出是第几集】,
    完全不依赖界面识别。这带来一个关键好处:App 播一集时会顺带解密前后几集(预加载、跳集连播),
    那些集的 key 其实早就落进捕获文件里了——以前不认得,只能眼睁睁判它"没抓到key"而失败;
    现在照着索引一查就能直接出片,连导航都不用。"""
    import mp4parse
    n = 0
    for fn in os.listdir(MDL):
        if not fn.endswith(".mdl"): continue
        ep = MDL2EP.get(fn)
        if ep is None: continue
        try:
            data = open(os.path.join(MDL, fn), "rb").read()
            tracks = mp4parse.get_tracks(data)
        except Exception: continue
        for t in tracks:
            for (soff, ssz) in t["samples"]:
                if soff + 8 > len(data): break
                CT2EP[data[soff:soff+8].hex()] = ep       # 只存前8字节:够唯一,省内存
        n += 1
    dbg(f"[map] 密文索引建好:{n} 个文件 / {len(CT2EP)} 条样本")

_CAP_SCAN = {"pos": 0, "ep2key": {}, "key2ep": {}}
def _scan_capture():
    """扫捕获文件,按密文索引把每条解密事件归到集号。返回 (集号→key, key→集号)。
    主循环里每几秒就要问一次,而捕获文件会长到十万行,所以【只读上次读到的位置之后的新行】
    (文件是追加写的,只会变长)。
    key→集号 这一半是【身份判据】:量到的 key 在这里查不到,说明前台放的根本不是这部剧。"""
    ep2key, key2ep = _CAP_SCAN["ep2key"], _CAP_SCAN["key2ep"]
    if not CT2EP: return {}, {}
    try:
        sz = os.path.getsize(CAP)
        if sz < _CAP_SCAN["pos"]:                          # 文件被重建过(理论上不会) → 从头再来
            _CAP_SCAN.update(pos=0, ep2key={}, key2ep={})
            ep2key, key2ep = _CAP_SCAN["ep2key"], _CAP_SCAN["key2ep"]
        if sz == _CAP_SCAN["pos"]: return ep2key, key2ep
        with open(CAP) as f:
            f.seek(_CAP_SCAN["pos"])
            for line in f:
                if not line.endswith("\n"): break          # 最后一行还没写完,下次再读
                _CAP_SCAN["pos"] += len(line.encode("utf-8", "ignore"))
                try: r = json.loads(line)
                except Exception: continue
                if r.get("tag") != "CRYPT" or not r.get("key") or not r.get("ct"): continue
                ep = CT2EP.get(r["ct"][:16])
                if not ep: continue
                ep2key.setdefault(ep, r["key"]); key2ep.setdefault(r["key"], ep)
    except Exception as e:
        dbg(f"[map] 扫捕获文件失败: {e}")
    return ep2key, key2ep

def _eps_with_key():
    """已经拿到 key 的集号 → key。哪一集出现过解密事件,这里就有它。"""
    return _scan_capture()[0]

def _key_ep(key):
    """这个 key 是本剧第几集的?查不到=它不属于本剧(多半人跑到别的剧上去了)。"""
    return _scan_capture()[1].get(key) if key else None

def _load_ep_maps_safe():
    try:
        a, b = _load_ep_maps()
        dbg(f"[map] App库集号映射 {len(a)} 集" if a else "[map] 没读到App库集号映射,跳过错集终检")
        return a, b
    except Exception as e:
        dbg(f"[map] 读App库失败({e}),跳过错集终检"); return {}, {}

# ============ 服务端清晰度阶梯:绕开 ByteVC2 的关键 ============
# 背景:App 的离线下载【固定走 720p 档】(下载任务 id 就是 <vid>_720p,和播放器里选的清晰度无关,
# 实测把播放清晰度调到 1080P 再重下,拿回来的还是同一个 720p 文件、一字节不差)。
# 而服务端给每集准备了 5 个档位,其中【1080p 档是标准 HEVC(h265_hvc1)】,
# 720p 档才会有一部分集用 ByteVC2 编码——那正是 ffmpeg 认不出、封装不了的那些集。
#
# 各档位共用同一个 kid,也就是同一把 AES key;而每个样本的 IV 直接写在文件自己的 senc 里。
# 所以:用 App 播 720p 副本抓到的 key,可以直接解密我们自己从 CDN 下的 1080p 文件。
# 于是 ByteVC2 不再是死路,顺带还把画质从 720x1280 提到 1080x1920。
EP_STREAMS = {}            # 集号 → [{definition, height, codec, url, backup, size}] 按清晰度从高到低
STREAM_EXPIRE = 0          # 这批 URL 的过期时间(unix 秒);CDN 链接是有时效的
DEFERRED = {}              # 集号 → key:.mdl 是 ByteVC2,等抓取结束联网后改用 1080p 源出片

def _gear(v):
    """从一条播放地址里读出 (编码, 清晰度)。gear_des_key 形如
    '0:MP4|1:encrypt|2:bytevc2|4:720p|5:normal',字段 2=编码、字段 4=清晰度;
    读不到就退回 video_meta。"""
    codec = definition = None
    g = v.get("gear_des_key") or ""
    if g:
        d = dict(p.split(":", 1) for p in g.split("|") if ":" in p)
        codec, definition = d.get("2"), d.get("4")
    m = v.get("video_meta")
    if isinstance(m, dict):
        codec = codec or m.get("codec_type")
        definition = definition or m.get("definition")
    return codec, definition

def _load_ep_streams():
    """读 App 库里缓存的服务端播放地址(t_series_video_model),按集号整理成清晰度阶梯。
    这张表是 App 下载时向服务端要来的,里面就含着每一档的直链。"""
    import sqlite3
    global STREAM_EXPIRE
    out = {}
    dbdir = _pull_app_db()
    s = sqlite3.connect(os.path.join(dbdir, "series_download_db"))
    vl = _series_video_list(dbdir)
    if not vl: return {}
    vid2ep = {str(v["vid"]): int(v["vid_index"]) for v in vl if v.get("vid") and v.get("vid_index")}
    for video_id, vm in s.execute("select video_id, video_model from t_series_video_model"):
        ep = vid2ep.get(str(video_id))
        if not ep: continue
        try: j = json.loads(vm)
        except Exception: continue
        STREAM_EXPIRE = max(STREAM_EXPIRE, int(j.get("url_expire") or 0))
        rungs = []
        for v in j.get("video_list", []) or []:
            codec, definition = _gear(v)
            if not v.get("main_url"): continue
            m = v.get("video_meta") if isinstance(v.get("video_meta"), dict) else {}
            rungs.append({"definition": definition or "?", "codec": codec or "?",
                          "height": int(re.sub(r"\D", "", definition or "0") or 0),
                          "url": v["main_url"], "backup": v.get("backup_url"),
                          "size": int(m.get("size") or 0)})
        if rungs:
            out[ep] = sorted(rungs, key=lambda r: r["height"], reverse=True)
    return out

def _pick_rung(ep):
    """这一集挑哪一档:清晰度最高、且编码是 ffmpeg 认得的那一档。全都不认返回 None。"""
    for r in EP_STREAMS.get(ep, []):
        if "bytevc2" not in (r["codec"] or "").lower():
            return r
    return None

# 单次 socket 操作的超时。这个源正常 1 秒内就有响应,给到 25 秒已经很宽裕。
# 【别再调大】:它是【每次 read 的超时】,不是整段下载的上限。原来写 120 秒时,
# 主地址一旦卡住就要干等满 120 秒,再换备用地址又是一轮——实测出现过单集卡 3 分半,
# 而那段时间界面上一行日志都没有,看起来就像整个程序死了。
CDN_TIMEOUT = 25

def _http_get(url, dest, expect=0, timeout=CDN_TIMEOUT, tag=""):
    import urllib.request
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
        "Accept": "*/*",
    })
    tmp = dest + ".part"
    total = 0
    t0 = last_beat = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as src, open(tmp, "wb") as fh:
            while True:
                if CANCEL["v"]: raise RuntimeError("canceled")
                chunk = src.read(1 << 20)
                if not chunk: break
                total += len(chunk)
                if total > 2 * 1024 * 1024 * 1024: raise RuntimeError("响应超过 2GB 上限")
                fh.write(chunk)
                # 慢下载的心跳。没有它,一次 60 秒的下载在界面上就是 60 秒的死寂,
                # 和真的卡死分不出来——用户唯一能做的判断就是"是不是挂了"。
                now = time.time()
                if now - t0 > 8 and now - last_beat > 5:
                    last_beat = now
                    pct = f" {total * 100 // expect}%" if expect else ""
                    logev("info", f"{tag}下载中{pct} ({total // 1024}KB / {now - t0:.0f}s)")
        if expect and total != expect:
            raise RuntimeError(f"大小不符(拿到 {total},应为 {expect})")
    except Exception:
        try:
            if os.path.exists(tmp): os.remove(tmp)   # 半截文件绝不能留给下一步
        except OSError: pass
        raise
    os.replace(tmp, dest)
    return total

def _fetch_rung(ep, rung, dest):
    """下这一档的源文件,主备地址各试一次。

    失败信息走 logev(stdout JSON) 而【不是 dbg(stderr)】:Electron 那边对抓取进程的 stderr
    只放行匹配英文 error/failed/... 的行,中文诊断会被整条丢掉。结果就是主地址卡住重试的那几分钟
    界面上完全没有输出,用户只能看到进度莫名其妙停住——问题本身反而不是最难受的,看不见才是。"""
    last = None
    for label, url in (("主", rung["url"]), ("备", rung.get("backup"))):
        if not url: continue
        t0 = time.time()
        try:
            n = _http_get(url, dest, expect=rung.get("size") or 0, tag=f"第{ep}集 ")
            el = time.time() - t0
            dbg(f"[cdn] 第{ep}集 {rung['definition']} {label}地址下好 {n}B 用时 {el:.1f}s")
            return True
        except Exception as e:
            last = e
            logev("warn", f"第{ep}集 {label}地址下载失败(等待 {time.time() - t0:.0f}s): {e}"
                          + ("，改用备用地址重试" if label == "主" and rung.get("backup") else ""))
    logev("warn", f"第{ep}集 1080p 源下载失败: {last}")
    return False

def _mdl_unsupported(fn):
    """App 下的这个副本里有没有 ffmpeg 处理不了的编码(ByteVC2)。读不动就当没有,交给后面报错。"""
    try:
        return mp4parse.unsupported_formats(open(os.path.join(MDL, fn), "rb").read())
    except Exception as e:
        dbg(f"[fmt] 读不出 {fn} 的编码({e})"); return []

# ======================= 逐集导航抓 key + 解密 =======================
def _num_cells(xml):
    """粗判选集网格是否打开:纯数字文本节点数(网格有几十个;播放器顶栏没几个)。"""
    return len(re.findall(r'text="\d+"', xml or ""))

def _visible_eps(xml):
    """当前 dump 里所有【纯数字】格子的集号集合(用于挑踏脚石)。"""
    out = set()
    for m in re.finditer(r'<node [^>]*>', xml or ""):
        t = _attr(m.group(0), 'text') or ''
        if t.isdigit(): out.add(int(t))
    return out

def _find_selector(xml):
    """找'选集'入口坐标。三种来源:
      1) 精确 text=='选集'(详情页/小窗态);
      2) text【包含】'选集'的节点——全屏播放器底栏常是【合并文案】'选集 · 已完结 · 全63集',
         此时点它【最左侧'选集'标签处】(x1+70),避开正中的'已完结'等无关文字(误点不开网格);
      3) rid=k2f 兜底。找不到返回 None。"""
    c = ui_find(xml, text='选集')
    if c: return c
    for m in re.finditer(r'<node [^>]*>', xml or ""):
        s = m.group(0); t = _attr(s, 'text') or ''
        if '选集' in t:
            mm = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', _attr(s, 'bounds') or '')
            if mm:
                x1, y1, x2, y2 = int(mm.group(1)), int(mm.group(2)), int(mm.group(3)), int(mm.group(4))
                return (min(x1 + 70, (x1 + x2) // 2), (y1 + y2) // 2)
    return ui_find(xml, rid=f"{PKG}:id/k2f")

def _open_grid():
    """打开选集网格,返回网格 xml;开不出返回 ''。
    只在全屏播放态点'选集'(dump_stable 会先点正中暂停露出控件,全屏点正中=暂停,安全);
    绝不在面板/详情页盲点正中——那里的正中(约 y=1150-1200)正压在'剧名 >'链接上(防灾#3)。"""
    BAR = (int(_W * 0.10), int(_H * 0.944))               # 全屏播放器底栏'选集'标签(实测 ≈113,2265)
    for _i in range(5):
        # 【只用 ui_dump,不用 dump_stable】:dump_stable 拿不到布局时会点屏幕正中,
        # 而全屏播放器点正中=暂停播放,暂停就没有解密事件、抓不到 key。
        x = ui_dump()
        if os.environ.get("HG_DEBUG_UI") == "1":
            dbg(f"[grid#{_i}] len={len(x or '')} tab={bool(re.search(r'text=.[0-9]+-[0-9]+.', x or ''))} "
                f"选集={'选集' in (x or '')} 相关推荐={'相关推荐' in (x or '')} "
                f"第X集={bool(re.search(r'第[0-9]+集', x or ''))} cells={_num_cells(x)}")
        if _grid_open(x): return x                        # 已是网格
        if _blocking_panel(x):                            # 误开的评论/分享浮层盖住底栏,先关掉
            dbg("[grid] 评论/分享浮层,返回关掉"); keyback(); time.sleep(2.0); continue
        if not x:                                         # dump 空(全屏播放器常见)→ 直接盲点底栏'选集'
            dbg("[grid] dump 空,盲点底栏选集"); tap(*BAR); time.sleep(2.5); continue
        if re.search(r'第\d+集', x):                        # 全屏播放器:只认【底栏】那条'选集'(y 在屏幕最下方)
            xj = _bottom_selector(x) or BAR               # 绝不点上半屏的'选集'(那是详情页残留节点,点了只会暂停)
            dbg(f"[grid] 全屏播放器,点底栏选集 {xj}"); tap(*xj); time.sleep(2.5); continue
        if '相关推荐' in x or re.search(r'全\d+集', x):        # 详情页/sheet:点顶部小窗回全屏,网格才会以当前集为中心
            dbg("[grid] 详情页态,点小窗回全屏"); tap(_W // 2, int(_H * 0.22)); time.sleep(2.5); continue
        # 未知态(金币/领取弹窗、活动浮层等把界面盖住):前两次只碰底栏,之后按一次返回关弹窗。
        if _i < 2:
            dbg("[grid] 未知态,点底栏选集"); tap(*BAR)
        else:
            dbg("[grid] 未知态仍在,按返回关弹窗"); keyback()
        time.sleep(2.5)
    return ""

def _bottom_selector(xml):
    """在【屏幕最下方】找'选集'节点并返回可点坐标(取最左侧标签处)。
    全屏播放器底栏是合并文案'选集 · 已完结 · 全63集';只认 y>0.85H 的,
    避免拿到详情页遗留的'选集'标签(在半屏高度),点它等于点视频=暂停。"""
    best = None
    for m in re.finditer(r'<node [^>]*>', xml or ""):
        s = m.group(0); t = _attr(s, 'text') or ''
        if '选集' not in t: continue
        mm = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', _attr(s, 'bounds') or '')
        if not mm: continue
        x1, y1, x2, y2 = int(mm.group(1)), int(mm.group(2)), int(mm.group(3)), int(mm.group(4))
        if y1 < _H * 0.85: continue
        c = (min(x1 + 70, (x1 + x2) // 2), (y1 + y2) // 2)
        if best is None or c[1] > best[1]: best = c
    return best

def _blocking_panel(xml):
    """是否有盖住底栏的浮层(评论/分享/输入面板)。它们会让'选集'点不到,必须先 back 关掉。"""
    x = xml or ""
    if '评论' in x and '选集' not in x: return True
    return ('分享到' in x) or ('有趣评论' in x)

def _ensure_fullscreen():
    """若当前是【详情页 sheet 态】(顶部小窗 + '相关推荐' 标签),点小窗回到全屏播放器。
    实测差别很关键:详情页 sheet 里选集网格总是从第1集顶部起(只有 1~18 露在收藏遮罩之上),
    而全屏播放器点底栏'选集'打开的窗口态网格【以当前正在播的集为中心】——目标自然落在可点带里。"""
    x = ui_dump()
    if '相关推荐' in (x or ""):
        tap(_W // 2, int(_H * 0.22)); time.sleep(2.5); return True
    return False

def _grid_open(xml):
    """网格是否已打开。不能只看数字格子数量——末尾分页(61-63)只有 3 格。
    判据:有【分页 tab(1-30 这类)】,或数字格子够多。"""
    if not xml: return False
    if re.search(r'text="\d+-\d+"', xml): return True
    return _num_cells(xml) > 8

def _cell_bounds(xml, ep):
    """返回标号==ep 的【纯数字】格子的完整 bounds (x1,y1,x2,y2);没有返回 None。
    dump 里节点串是 text 在前 bounds 在后,故直接就近匹配。"""
    for m in re.finditer(r'<node [^>]*>', xml or ""):
        s = m.group(0)
        if _attr(s, 'text') != str(ep): continue
        mm = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', _attr(s, 'bounds') or '')
        if mm: return (int(mm.group(1)), int(mm.group(2)), int(mm.group(3)), int(mm.group(4)))
    return None

def _grid_bounds(xml):
    """选集网格(可滚 GridView,实测 rid=d89)的 bounds (x1,y1,x2,y2);滑动起终点全落它内部,
    才是滚网格本身、而不是拖动整张底部面板。找不到就用可见数字格外接框兜底。"""
    for m in re.finditer(r'<node [^>]*>', xml or ""):
        s = m.group(0)
        if 'GridView' in (_attr(s, 'class') or '') and _attr(s, 'scrollable') == 'true':
            mm = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', _attr(s, 'bounds') or '')
            if mm: return (int(mm.group(1)), int(mm.group(2)), int(mm.group(3)), int(mm.group(4)))
    xs = []; ys = []
    for m in re.finditer(r'text="\d+"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml or ""):
        xs += [int(m.group(1)), int(m.group(3))]; ys += [int(m.group(2)), int(m.group(4))]
    if ys: return (min(xs), min(ys), max(xs), max(ys))
    return (32, 1640, 1048, 2337)

def _scroll_sig(xml):
    """网格滚动位置签名:(最小可见集号, 它的 y1, 最大可见集号)。两次上滑签名不变=已滚到底。"""
    best = None; vmax = 0
    for m in re.finditer(r'text="(\d+)"[^>]*bounds="\[(\d+),(\d+)\]', xml or ""):
        ep = int(m.group(1)); y1 = int(m.group(3))
        if ep > vmax: vmax = ep
        if best is None or ep < best[0]: best = (ep, y1)
    return (best, vmax)

def _overlay_top(xml, gy2):
    """底部'收藏'那条【全幅 clickable 遮罩】(LinearLayout,实测 [0,2167][1080,2337])的上端 y。
    它压在选集网格最下方 1~2 行之上:落进这条带里的点击会被它整条吞掉——既点不到那一格、
    也切不了集(实测点 20 集中心 y≈2214 落此带 → 播放器仍停在第1集)。所以它才是真正的
    【可点下端】,而非 GridView 的树底 gy2(=2337)。找不到就按遮罩约一行高(~160)兜底。"""
    best = None
    for m in re.finditer(r'<node [^>]*>', xml or ""):
        s = m.group(0)
        if _attr(s, 'clickable') != 'true': continue
        if 'LinearLayout' not in (_attr(s, 'class') or ''): continue
        mm = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', _attr(s, 'bounds') or '')
        if not mm: continue
        x1, y1, x2, y2 = int(mm.group(1)), int(mm.group(2)), int(mm.group(3)), int(mm.group(4))
        if x1 <= 8 and x2 >= 1070 and y1 > 1900:      # 贴两侧的底部全幅遮罩条
            if best is None or y1 < best: best = y1
    return min(best, gy2) if best is not None else (gy2 - 160)

def _visible_max_ep(xml):
    """当前可见【纯数字】格子里的最大集号(留作它处引用,不再参与 _tap_cell 判定)。"""
    return _scroll_sig(xml)[1]

def _fresh_grid(prev):
    """取一份【新鲜的、且网格确实还开着】的布局;拿不到返回 ''。
    绝不能沿用旧 xml 里的格子坐标去点:网格一旦已经关掉(回到全屏 feed),
    旧坐标的最右一列(x≈961)正好落在 feed 右侧的星标/评论按钮上——会误开评论浮层,
    之后底栏'选集'被盖住,整集就卡死在那儿(第21集卡住的根因)。"""
    for _ in range(3):
        x = ui_dump()
        if x and _grid_open(x): return x
        time.sleep(1.0)
    return ""

def _expand_sheet(xml):
    """把底部选集面板从【矮态】拉成【高态】,让下面几行格子露出来。成功拖过返回 True。

    这是"找不到第N集格子(翻遍未见)"的正解。实测矮态:GridView=(1866,2337)、收藏遮罩上端=2167,
    于是只有前两行(1~12)够得着,13 起整行压在遮罩下——而这一页格子位置是固定的,
    点踏脚石根本推不动布局,于是来回开面板、一次也点不着(用户看到的"反复打开选集没任何操作")。
    在网格里上滑/下滑都没用(实测上滑反而把面板缩得更小,只剩 1~12)。
    有效的动作只有一个:【从面板顶部(选集/相关推荐 标签那条)往上拖】——
    拖完 GridView 变成 (761,2169),1~54 全部可点。"""
    gy1, gy2 = _grid_bounds(xml)[1], _grid_bounds(xml)[3]
    if gy1 <= _H * 0.55: return False                      # 已经是高态,别再拖(再拖就拖到小窗上了)
    y0 = max(int(_H * 0.60), gy1 - int(_H * 0.017))        # 起点:网格上沿再往上一点=面板标签条
    y1 = max(int(_H * 0.45), y0 - int(_H * 0.26))
    dbg(f"[cell] 面板是矮态(网格上沿{gy1}),把面板往上拖大 {y0}→{y1}")
    sh("input", "swipe", str(_W // 2), str(y0), str(_W // 2), str(y1), "400")
    time.sleep(2.0)
    return True

def _tap_cell(ep, xml):
    """在【已打开】的选集网格里精确点到标号==ep 的格子;点中即代表前台就是这一集,会自动起播。
    实测(1080×2400)选集是底部 sheet 里的可滚 GridView(rid=d89):刚开是高态(1~24 可见),
    会回弹收缩成矮态(仅 1~18 可见),19+ 需上滑翻出。根治要点:
      1) 等回弹稳定后用【新鲜布局】取坐标;
      2) 上滑起终点都落在【GridView 自身 bounds】内(而非固定 0.86H→0.74H),矮态也一定滚得动;
      3) 只点【完整未被网格底裁切】的格子(高度足、y2 不贴网格底),否则先把它顶上来
         ——底行会被'收藏'按钮(c5g,右侧)遮挡,贴边点易误触;
      4) 末尾集(28-30 / 61-63)永远到不了完整位:一旦'滚到底'(签名不变)就用当前可点区兜底点。
    返回被点格子中心坐标 (x,y);翻遍/滚到底仍没有返回 None。

    BAND=可点带下限:格子上沿必须比收藏遮罩上端高出这么多才敢点。原来定 40px 太苛刻——
    实测第51集格子上沿 y1=2130、遮罩上端 ot=2167,露出 37px 本来点得到,却因 2130>2167-40 被判死;
    这一页所有格子位置固定,踏脚石怎么点都推不动它,于是死在"找不到第51集格子(翻遍未见)"。"""
    BAND = 22
    time.sleep(1.5)                                       # 等面板回弹/动画稳定
    xml = _fresh_grid(xml)                                # 必须拿到【新鲜且网格仍开着】的布局才敢点
    if not xml: return None
    tried = set()                                         # 已踩过的踏脚石,防原地打转
    expanded = False                                      # 面板是否已经拖大过(只拖一次)
    for m in re.finditer(r'text="(\d+)-(\d+)"', xml):     # 选对分页 tab(1-30/31-60/…)
        a, b = int(m.group(1)), int(m.group(2))
        if a <= ep <= b:
            c = ui_find(xml, text=f"{a}-{b}")
            if c:
                tap(*c); time.sleep(1.5)
                xml = _fresh_grid(xml)
                if not xml: return None
            break
    for _ in range(18):
        # 注意:不能再用 _num_cells<=8 判"网格没开"——末尾分页(如 61-63)只有 3 个格子,
        # 会被误判成没开而直接放弃(第61集抓不到的根因)。这里【只要目标格子在就继续】。
        if not _cell_bounds(xml, ep) and _num_cells(xml) <= 2: return None
        gx1, gy1, gx2, gy2 = _grid_bounds(xml)
        ot = _overlay_top(xml, gy2)                       # 真正可点下端=收藏遮罩上端(≈2167),不是网格树底 gy2
        b = _cell_bounds(xml, ep)
        if os.environ.get("HG_DEBUG_UI") == "1":          # 排查界面问题时置 HG_DEBUG_UI=1 看格子/遮罩坐标
            _ve = sorted(_visible_eps(xml))
            dbg(f"[cell] want={ep} ot={ot} grid=({gy1},{gy2}) target={b} 可见={_ve[:3]}..{_ve[-3:] if _ve else []}")
        if b:
            x1, y1, x2, y2 = b
            # 治本(夹点):只要格子【上沿在收藏遮罩上端之上(留≥BAND 可点带)】就点它,
            # 把点击 y 夹到【遮罩上端之上、且仍落在格子内】——无需把整格滚到遮罩上方。
            # 这样 19-24/49-54/61-63 这类"上半截露在遮罩之上"的格子【一点即中】,不必长拖、不改播放模态。
            if y1 <= ot - BAND:
                cx = (x1 + x2) // 2
                cy = min((y1 + y2) // 2, ot - 12)         # 夹到遮罩上端之上,避开被收藏条吞点
                cy = max(cy, y1 + 10)                     # 但别越过格子上沿
                tap(cx, cy); time.sleep(2.5); return (cx, cy)
        # 够不到(或这一页压根没渲染出目标)→ 先把面板拖大,这一步能一次解决绝大多数"够不着":
        # 矮态只有 1~12 可点,拖大后 1~54 全可点。拖过一次就不再拖(防止原地反复拖)。
        if not expanded and _expand_sheet(xml):
            expanded = True
            nx = _fresh_grid(xml)
            if nx: xml = nx; continue                     # 用拉大后的新布局重新判定
        # 目标整格还压在遮罩下(如从第1集开时的 25-30)→【踏脚石】:
        # 关键实测:网格【每次打开都以"当前正在播的集"为中心定位】。所以不要滑动
        # (在网格里上滑会把窗口态网格变形成详情页 sheet:小窗+收藏,后续起播/抓key全乱),
        # 而是先点一个【当前可点、且离目标最近】的集当踏脚石,让播放位置前移,
        # 再重开网格——目标就被带进遮罩上方的可点带,一两跳必达(19→25→31…同理适用 55/61)。
        step = None
        for cand in sorted(_visible_eps(xml), key=lambda v: abs(v - ep)):
            bb = _cell_bounds(xml, cand)
            if bb and bb[1] <= ot - BAND and cand != ep:
                step = (cand, bb); break
        if not step: return None
        cand, bb = step
        if cand in tried:                                 # 同一块踏脚石踩两次=定位推不动,别再原地打转
            dbg(f"[cell] 踏脚石第{cand}集重复,放弃"); return None
        tried.add(cand)
        cx = (bb[0] + bb[2]) // 2
        cy = max(min((bb[1] + bb[3]) // 2, ot - 30), bb[1] + 20)
        dbg(f"[cell] ep{ep} 还在遮罩下,先点踏脚石第{cand}集把定位推过去")
        tap(cx, cy); time.sleep(3.0)
        _ensure_fullscreen()                              # 详情页 sheet 里网格总从第1集顶部起;全屏态才会以当前集为中心
        g = _open_grid()                                  # 以新的"当前集"为中心重开网格
        if not g: return None
        xml = g
        # 只有【目标完全不在当前分页】时才点分页 tab:点 tab 会把网格滚回该页顶部,
        # 会把刚用踏脚石推出来的定位又打回去(第18集来回打转的根因)。
        if not _cell_bounds(xml, ep):
            for m in re.finditer(r'text="(\d+)-(\d+)"', xml):
                a, b2 = int(m.group(1)), int(m.group(2))
                if a <= ep <= b2:
                    c = ui_find(xml, text=f"{a}-{b2}")
                    if c:
                        tap(*c); time.sleep(1.5)
                        xml = _fresh_grid(xml)
                        if not xml: return None
                    break

def _dbg_snap(tag):
    """HG_DEBUG_UI=1 时把当前屏幕存到系统临时目录，辅助排查 UI 状态。"""
    if os.environ.get("HG_DEBUG_UI") != "1": return
    try:
        local_path = os.path.join(tempfile.gettempdir(), f"hg_{tag}.png")
        sh("screencap", "-p", f"/sdcard/hg_{tag}.png")
        adb("pull", f"/sdcard/hg_{tag}.png", local_path, timeout=20)
        dbg(f"[snap] {local_path}")
    except Exception as e: dbg(f"[snap] 失败 {e}")

def _nudge_play():
    """没量到 key 时,在全屏播放器点一次正中,把暂停的画面恢复播放(有播放才有解密事件)。
    只在确认是全屏播放器时点:网格/详情页的正中压着'剧名 >',点了会掉进详情页。
    绝不重点原来的格子坐标——网格那时多半已关,老坐标最右列会落到右侧星标/评论上,弹出浮层就卡死。

    两种停摆态处理方式不同(实测截图为证):
      1) 全屏播放器(dump 里有'第X集')→ 点正中 = 恢复播放;
      2) 详情页 sheet 态(顶部小窗 + '选集/相关推荐' 标签)→ 这是"隔一集失败一次"的真凶:
         在 sheet 里点格子,那一集只是被【选中】(格子高亮),画面停在顶部小窗里【不起播】,
         一个解密事件都没有 → 报"到位却没抓到解密key"。此态【绝不能点正中】(正中压着'剧名 >',
         一点就掉进详情页),要点【顶部小窗】回全屏——回全屏就会接着播这一集,key 立刻就有了。"""
    sh("input", "keyevent", "126")                        # MEDIA_PLAY:此 App 实测不理媒体键(127 也停不住),无副作用,留作兜底
    time.sleep(1.0)
    x = ui_dump()
    if x and re.search(r'第\d+集', x):                     # 全屏播放器 → 点正中恢复播放
        tap(_W // 2, _H // 2); time.sleep(1.5); return
    if x and ('相关推荐' in x or re.search(r'全\d+集', x)):   # 详情页 sheet 态 → 点小窗回全屏续播
        dbg("[nudge] sheet 态(选中但没起播),点顶部小窗回全屏"); tap(_W // 2, int(_H * 0.22)); time.sleep(2.5); return
    # dump 拿不到(全屏播放器 SurfaceView 常见)时也必须动一下,否则整集就这么白等着:
    # 点【上部视频区 0.22H】——这一点在两种态里都安全:全屏态它就是视频画面(点=恢复播放),
    # sheet 态它正好是顶部小窗(点=回全屏续播)。绝不盲点正中:sheet 态的正中压着'剧名 >',一点就掉进详情页。
    dbg("[nudge] dump 空,点上部视频区恢复播放"); tap(_W // 2, int(_H * 0.22)); time.sleep(2.0)

# ==================== 顺序滑动收割(主路径)====================
# 为什么不再逐集精确定位:密文索引能确定性地认出"这段解密属于第几集",于是【落点准不准根本不重要】,
# 只要 App 把每一集都播过一遍就行。而"上滑=下一集"是这个界面上最稳的一个动作(hongguo_autoplay
# 全靠它跑完整部剧)。反过来,逐集定位要踩的全是最不稳的地方:选集网格四种形态、点已看完的集会跳集、
# 失败复位又会把播放位置打回续播点甚至带到别的剧——而且恢复动作本身还会制造新的坏状态。
# 所以主路径改成:粗定位一次 → 停留收割 → 上滑一集 → 停留收割 …… 谁被解密了由索引说了算。
# 【位移要够大】,这是单次成功率的决定因素。Android 翻页通常有两个判据:fling 速度达标,
# 或者拖拽距离超过约半页。这个播放器上 fling 判据在模拟器里很不可靠——录屏看得很清楚,
# 页面滑了一小段又弹回原位。所以别指望速度,直接把位移拉到超过半屏,让距离判据兜底。
#   实测(1080x2400):
#     0.62 → 0.25 (37% 屏高)  约 35%
#     0.77 → 0.19 (58% 屏高)  约 28%
#     0.875 → 0.042 (83% 屏高) 约 83%   ← 当前值
# 时长同样测过:100ms 只有 8%(太快反而识别不了),200/500ms 都在 30% 上下,300ms 配大位移最好。
SWIPE_MS = "300"
SWIPE_FROM, SWIPE_TO = 0.875, 0.042      # 1080x2400 上 = y 2100 → 100
# 起点靠下【本来】是有风险的:底部"选集"条(这台机器上 y≈2265)是个 bottom sheet 拖拽把手,
# 从它附近起手会变成"上拉选集面板",掉进详情页 sheet 态——那时上滑只是滚选集网格,永远切不了集。
# 0.875H(y=2100)落在剧名/简介行上、还在那条把手【上方】,实测连续多轮没有掉进去过。
# 【往下调 SWIPE_FROM 要格外小心】,越接近 0.94H 越容易被那条把手截走。
SWIPE_TRIES = 3           # 单次约 83% → 3 次覆盖 1-0.17^3 = 99.5%,再多没意义
SWIPE_VERIFY = 1.6        # 每次重滑后用多长的解密事件窗口确认"到底换没换集"

def _raw_swipe(y1, y2):
    """按【屏幕高度比例】发滑动,不写死像素——换分辨率的设备要照样能用。
    _W/_H 是启动时用 wm size 读的实际分辨率。夹一下边界,免得比例调过头算出屏幕外的坐标。"""
    x = _W // 2
    py1 = max(1, min(_H - 2, int(_H * y1)))
    py2 = max(1, min(_H - 2, int(_H * y2)))
    sh("input", "swipe", str(x), str(py1), str(x), str(py2), SWIPE_MS)

def _swipe_next(expect_from=None, tries=SWIPE_TRIES):
    """全屏播放器里上滑 = 下一集;给了 expect_from 就【确认真的换集了】,没换立刻重滑。

    为什么必须验证:实测盲滑的成功率只有 25~40%(录屏看得很清楚——页面确实滑动了一小段,
    然后又弹回原位,fling 没达标)。而旧写法滑完就走,失败了要等主循环下一轮花掉一整个
    3~6 秒的测量窗口才发现还在原地,那一整轮全是白干。就地重滑一次只要约 2 秒。

    验证【只用解密事件】,绝不读 UI:全屏播放器里视频一直在播,窗口永远不 idle,
    uiautomator dump 必定失败——而一次失败的 dump 要 11.5 秒,ui_dump() 默认重试 3 次
    就是 35 秒。放进重滑循环里会比它要解决的问题还贵。"""
    for i in range(tries):
        _raw_swipe(SWIPE_FROM, SWIPE_TO)
        if expect_from is None:                 # 调用方不知道自己在哪一集,没法比对,滑完就算
            time.sleep(1.2); return True
        ep, state = _now_playing(SWIPE_VERIFY)
        if state == "ok" and ep != expect_from:
            if i: dbg(f"[swipe] 滑了 {i + 1} 次才从第{expect_from}集换到第{ep}集")
            return True
        if state == "foreign":                  # 跑到别的剧上去了,交给上层重进,别在这儿空滑
            dbg("[swipe] 量到的 key 不属于本剧,交给上层处理"); return False
        dbg(f"[swipe] 第{i + 1}/{tries} 次滑动没换集(仍在第{expect_from}集/{state})")
    return False

_AD_CONTINUE_MARKERS = (
    "上滑继续观看短剧",
    "上滑继续看短剧",
)

def _is_ad_screen(xml):
    """只根据可见 UI 文本识别广告 feed,避免剧名/隐藏属性里偶然出现“广告”造成误滑。"""
    values = []
    for m in re.finditer(r'<node [^>]*>', xml or ""):
        node = m.group(0)
        for attr in ("text", "content-desc"):
            value = (_attr(node, attr) or "").strip()
            if value: values.append(value)
    if any(marker in value for value in values for marker in _AD_CONTINUE_MARKERS):
        return True
    has_ad_label = any(value == "广告" or value.startswith("广告 ") for value in values)
    return has_ad_label and not _looks_like_series_page(xml)

def _skip_ad_if_present(xml=None, max_swipes=2):
    """广告页上滑回短剧 feed。二次确认后最多补滑一次,绝不在这里无限循环。"""
    current = xml if xml is not None else ui_dump(2)
    if not _is_ad_screen(current): return False
    logev("info", "检测到广告页,正在上滑继续观看下一集")
    attempts = max(1, min(int(max_swipes), 2))
    for attempt in range(attempts):
        _swipe_next()
        if attempt + 1 >= attempts: break
        current = ui_dump(2)
        if not _is_ad_screen(current): break
        dbg("[ad] 首次上滑后仍在广告页,再上滑一次")
    return True

def _swipe_prev():
    """下滑 = 上一集。用于目标集被跳过(播放头已经越过它)时退回去补。"""
    _raw_swipe(SWIPE_TO, SWIPE_FROM)
    time.sleep(1.2)

def _now_playing(sec, want=None):
    """停留 sec 秒收集解密事件,顺便认出【现在在播本剧第几集】。
    返回 (ep, state):state ∈ {'ok','foreign','idle'}
      ok      = 认出集号了;
      foreign = 有解密事件但不属于本剧 → 人跑到别的剧上去了;
      idle    = 一个事件都没有 → 没在播(暂停/黑屏/加载中)。"""
    key = _dominant_key(sec, want=want)                   # 要的集到手就收工,不干等满窗口
    if not key: return None, "idle"
    ep = _key_ep(key)
    if ep is None:
        _scan_capture()                                  # 可能是刚落盘还没扫到,强制刷新一次再判
        ep = _key_ep(key)
    return (ep, "ok") if ep else (None, "foreign")

def _reenter_series():
    """回到本剧(短暂联网重新搜索进入,进去必须核对剧名)。抓取全程断网,这点联网不影响产物。"""
    net(True); time.sleep(6)
    ok = search_open(NAME, recovery=True)
    net(False); time.sleep(2)
    if ok: _ensure_fullscreen()
    return ok

def full_end(data):
    off = 0
    while off + 8 <= len(data):
        sz = struct.unpack('>I', data[off:off+4])[0]; typ = data[off+4:off+8]
        if typ == b'mdat': return off + sz
        if sz <= 0: break
        off += sz
    return None
def pull_mdl():
    os.makedirs(MDL, exist_ok=True)
    for f in os.listdir(MDL):
        if f.endswith(".mdl"):
            try: os.remove(os.path.join(MDL, f))
            except Exception: pass
    dirs = [OFFDIR] + CACHEDIRS
    lst = adb("shell", "find", *dirs, "-name", "*.mdl").stdout.split()
    for f in lst:
        b = os.path.basename(f.strip())
        if b: adb("pull", f.strip(), os.path.join(MDL, b))
def decrypt_to(src_path, final_path, key=None):
    """用 decrypt_mdl.py 解密并重封装;成功=生成 final_path。返回 True/False。
    src_path 可以是 App 下的 .mdl,也可以是我们自己从 CDN 下的同集分片(那时要显式给 key)。"""
    tmp = os.path.join(os.path.dirname(final_path), ".tmp_" + os.path.basename(final_path))
    _partial["path"] = tmp
    for q in (tmp, tmp + ".dec.mp4"):
        if os.path.exists(q):
            try: os.remove(q)
            except Exception: pass
    cmd = [sys.executable, os.path.join(HERE, "decrypt_mdl.py"), src_path, CAP, tmp]
    if key: cmd += ["--key", key]
    r = subprocess.run(cmd, capture_output=True, text=True)
    dbg(r.stdout); dbg(r.stderr)
    ok = os.path.exists(tmp) and os.path.getsize(tmp) > 0
    if ok:
        os.replace(tmp, final_path)
    else:
        for q in (tmp, tmp + ".dec.mp4"):      # 清残留(含封装失败留下的 .dec.mp4)
            try:
                if os.path.exists(q): os.remove(q)
            except Exception: pass
    _partial["path"] = None
    return ok

# ============================ 主流程 ============================
def epname(ep, width): return f"第{ep:0{width}d}集.mp4"

def _locate_rough(ep):
    """用选集网格【粗】定位到第ep集附近。落点准不准无所谓——后面靠上滑一集一集收割,
    所以这里不重试、不校验、不暂停;开不出网格就返回 False,交给上层换招。"""
    g = _open_grid()
    if not _grid_open(g): return False
    c = _tap_cell(ep, g)
    time.sleep(1.5)
    _ensure_fullscreen()          # 落在详情页 sheet 态要回全屏:sheet 态里上滑是滚页面,不是切集
    return bool(c)

def _relocate_or_reenter(ep):
    """粗定位到第ep集;网格开不出(界面漂到别处了)就先重进本剧再试一次。
    别一开不出网格就判失败——那会把剩下几十集一次性全判死。"""
    if _locate_rough(ep): return True
    dbg("[harvest] 选集网格开不出,重进本剧再定位一次")
    if not _reenter_series(): return False
    return _locate_rough(ep)

def _duration_ok(ep, path):
    """核对出片时长和 App 库记的标准时长对不对得上。返回 (是否合格, 实际秒数, 应有秒数)。
    这一关补的是【集号对、但这一集没下全】:某集的 .mdl 只下了一半时,解出来就是个短视频,
    以前会静悄悄当成功交付。库里每集时长是现成的,ffprobe 一下(约 50ms)就能当场发现。"""
    want = EP_DUR.get(ep, 0)
    if not want: return True, 0, 0
    try:
        o = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", path], capture_output=True, text=True, timeout=60).stdout.strip()
        got = float(o) if o else 0
    except Exception as e:
        dbg(f"[dur] ffprobe 失败: {e}"); return True, 0, want     # 量不了就别拦
    return (abs(got - want) <= 3.0), got, want

def _flush_ready(pending, width, ok_list, failed, badcnt):
    """把【已经拿到 key】的待抓集就地出片,返回本轮出片的集号。
    出片只认 App 库指定的那个 .mdl,不看界面、不看导航结果——串集在这里没有可能。"""
    ep2key, _ = _scan_capture()
    done = []
    for ep in sorted(pending):
        if CANCEL["v"]: break
        fn = EP2MDL.get(ep)
        if ep not in ep2key or not fn: continue
        # App 下的副本是 ByteVC2(或用户要求全走 1080p)→ 这一集改用服务端 1080p 源。
        # key 已经到手了,App 那边就没别的事了;下载要联网,而抓取全程断网,所以推迟到收尾统一做。
        bad = _mdl_unsupported(fn)
        if bad or args.prefer_1080p:
            DEFERRED[ep] = ep2key[ep]
            pending.discard(ep)
            logev("info", f"第{ep}集离线副本是 {bad[0] if bad else '720p'},"
                          f"已拿到 key,改用服务端 1080p 源出片(抓取结束后统一下载)")
            # 【必须算作本轮有进展】。这一集的 key 已经到手,App 那边真的做完了,只是出片挪到收尾。
            # 漏掉这一句,调用方的 `dry = 0 if got else dry + 1` 就会把它当成"这一轮什么也没捞到",
            # 连着 8 轮后白白触发一次选集网格重定位——而 ByteVC2 的集可能占到全剧一半,
            # 于是越是靠换源救回来的剧,越会被这个假信号反复打断。
            done.append(ep)
            continue
        emit({"event": "episode_start", "ep": ep})
        emit({"event": "progress", "ep": ep, "percent": 80.0})
        final = os.path.join(OUTDIR, epname(ep, width))
        if decrypt_to(os.path.join(MDL, fn), final):
            ok, got, want = _duration_ok(ep, final)
            if not ok:
                # 集号是对的,但这一集没下全(下载副本被截断)。删掉半截成品,让下一轮重新下、重新抓,
                # 绝不把短一截的视频当成功交付——这种错最不容易被发现。
                logev("warn", f"第{ep}集时长 {got:.0f}s,App 记的是 {want:.0f}s,判定下载副本残缺,丢弃重来")
                try: os.remove(final)
                except Exception: pass
                emit({"event": "episode_failed", "ep": ep,
                      "error": f"下载副本残缺(时长 {got:.0f}s / 应为 {want:.0f}s)"})
                failed.append(ep); pending.discard(ep); continue
            emit({"event": "episode_done", "ep": ep, "file": epname(ep, width)})
            ok_list.append(ep); done.append(ep); pending.discard(ep)
        else:
            badcnt[ep] = badcnt.get(ep, 0) + 1
            logev("warn", f"第{ep}集解密/封装失败,第{badcnt[ep]}次")
            if badcnt[ep] >= 2:                       # 解不出就是解不出,别在循环里耗着
                emit({"event": "episode_failed", "ep": ep, "error": "decrypt/repack failed"})
                failed.append(ep); pending.discard(ep)
    return done

def run_harvest(todo, width, ok_list, failed):
    """主路径:顺序滑动收割。

    循环很简单:停留几秒(App 在播,顺带把前后几集也解密了)→ 查索引,谁拿到 key 就出片 → 上滑一集。
    位置和身份都靠【解密事件】判断,不靠界面:
      - 量到的 key 认得出集号 → 知道现在播到第几集了;
      - 认不出 → 人在别的剧上,立刻重进本剧(这是以前会静悄悄跑偏一整轮的那个坑);
      - 一个事件都没有 → 没在播,点一下恢复。
    只有【离目标太远】或【卡住】时才动用选集网格粗定位一次。"""
    pending = set(todo); badcnt = {}; misses = {}
    blocked = set()               # 反复攻不动的集:不再作为目标,但仍留在 pending 里
    #                               ——后面播别的集时它可能被顺带解密,收尾再捡一次
    dwell = max(3.0, min(DWELL, 6.0))
    idle_run = 0; dry = 0; relocate_fail = 0
    GIVEUP = 6                    # 连续这么多次连"重进本剧"都不成才收摊。定小了(原来是3)一遇到
    #                               界面抽风就把几十集一次性全判失败——实测 1 分钟内 73 集全废。
    it = 0; MAXIT = len(todo) * 3 + 60
    _flush_ready(pending, width, ok_list, failed, badcnt)   # 开局先把现成的 key 全兑现
    if pending: _locate_rough(min(pending))                # 把播放头挪到第一个缺口
    while pending - blocked and not CANCEL["v"] and it < MAXIT:
        it += 1
        target = min(pending - blocked)
        ep_now, state = _now_playing(dwell, pending - blocked)   # 停留=收割窗口,顺便测位置
        got = _flush_ready(pending, width, ok_list, failed, badcnt)
        dry = 0 if got else dry + 1
        if not pending - blocked: break
        target = min(pending - blocked)

        # 广告不会产生本剧的解密事件,通常会落到 idle;某些广告自身有视频解码时则会落到 foreign。
        # 只在这两种异常态读取 UI,避免给正常逐集收割的每一轮都增加 uiautomator 开销。
        if state != "ok" and _skip_ad_if_present():
            idle_run = 0
            dry = 0
            relocate_fail = 0
            continue

        if state == "foreign":                             # 跑到别的剧去了
            logev("warn", "播放器跑到别的剧上了,重新进入本剧")
            if _reenter_series(): relocate_fail = 0; _locate_rough(target)
            else: relocate_fail += 1
            if relocate_fail >= GIVEUP: break
            continue
        if state == "idle":
            # 没有任何解密事件。实测这时【点屏没用、上滑立刻就好】:这一集播完了停在那儿,
            # 点屏只是在暂停/播放之间来回切,必须换到下一条 feed 才会重新起播解码。
            # (曾经卡在第40集好几分钟,人工上滑一下立刻继续收割。)
            idle_run += 1
            if idle_run == 1:
                dbg("[harvest] 没有解密事件:上滑换一集(这一集多半已经播完停住了)")
                _swipe_next()
            elif idle_run == 2:
                dbg("[harvest] 还是没有:清掉播放器缓存 + 点一下恢复播放")
                clear_cache(); _nudge_play()               # 缓存里若留着已解好的数据,重播就不会再解密
            else:
                idle_run = 0
                if not _relocate_or_reenter(target): relocate_fail += 1
                else: relocate_fail = 0
                if relocate_fail >= GIVEUP: break
            continue
        idle_run = 0

        if ep_now is not None and ep_now > target:
            # 播放头越过目标了(多半是这一集早看完过,点它会从结尾续播直接跳过去)。
            # 先试着下滑退回去补;补不到就认了,别把整轮拖死。
            misses[target] = misses.get(target, 0) + 1
            if misses[target] <= 2 and ep_now - target <= 3:
                dbg(f"[harvest] 播放头在第{ep_now}集,越过了第{target}集,下滑退回去")
                for _ in range(ep_now - target): _swipe_prev()
                continue
            if misses[target] <= 3:
                dbg(f"[harvest] 第{target}集被跳过,用选集网格回去")
                _locate_rough(target); continue
            dbg(f"[harvest] 第{target}集反复攻不动(已看完的集会从结尾续播),先放一放,继续往后收割")
            blocked.add(target); continue                  # 不判死:后面播别的集时它可能被顺带解密

        if ep_now is not None and ep_now < target - 4:     # 离得远:网格跳一次比滑十几次快
            dbg(f"[harvest] 现在第{ep_now}集,目标第{target}集,用选集网格跳过去")
            if not _relocate_or_reenter(target): relocate_fail += 1
            else: relocate_fail = 0
            if relocate_fail >= GIVEUP: break
            continue

        if dry >= 8:                                        # 一直没有新集:重新定位一次
            dry = 0
            dbg(f"[harvest] 连续 8 轮没有新集,重新定位到第{target}集")
            if not _relocate_or_reenter(target): relocate_fail += 1
            else: relocate_fail = 0
            if relocate_fail >= GIVEUP: break
            continue
        # 常态:往下一集走,继续收割。把当前集号传进去,滑完就地确认真的换集了,
        # 没换立刻重滑——盲滑只有约三成能成,失败一次旧写法要赔掉下一整轮的测量窗口。
        _swipe_next(expect_from=ep_now)

    # 收尾:放一放的那些集,这会儿可能已经被顺带解密了,再捡一遍
    if pending and not CANCEL["v"]:
        got = _flush_ready(pending, width, ok_list, failed, badcnt)
        if got: logev("info", f"收尾补捞救回 {len(got)} 集: {got}")
    if pending:
        for ep in sorted(pending):
            emit({"event": "episode_failed", "ep": ep, "error": "没能让这一集起播(播放器反复跳过)"})
            failed.append(ep)
        logev("warn", f"还剩 {len(pending)} 集没拿到 key: {sorted(pending)}")

def produce_from_cdn(width, ok_list, failed):
    """收尾阶段(已联网):把推迟的那些集用服务端 1080p 源出片。

    这条路能成立,靠的是两件已验证的事:
      1) 同一集的各清晰度档位共用同一个 kid,也就是同一把 AES key;
      2) 每个样本的 IV 就写在文件自己的 senc 里,不需要"这个文件被播放过"。
    所以拿 App 播 720p 副本时抓到的 key,能直接解开我们自己下的 1080p 文件。"""
    global EP_STREAMS
    if not DEFERRED: return
    eps = sorted(DEFERRED)
    logev("info", f"{len(eps)} 集需要用服务端 1080p 源出片: {eps}")
    try:
        EP_STREAMS = _load_ep_streams()
    except Exception as e:
        dbg(f"[cdn] 读服务端清晰度阶梯失败: {e}"); EP_STREAMS = {}
    if not EP_STREAMS:
        logev("error", "读不到服务端播放地址(App 库里没有 t_series_video_model 记录),"
                       f"这 {len(eps)} 集无法出片")
        for ep in eps:
            emit({"event": "episode_failed", "ep": ep, "error": "没有可用的 1080p 源地址"})
            failed.append(ep)
        return
    if STREAM_EXPIRE and STREAM_EXPIRE < time.time():
        logev("warn", "服务端播放地址已过期,尝试重新进入该剧刷新 ...")
        search_open(NAME); time.sleep(3)
        try: EP_STREAMS = _load_ep_streams()
        except Exception as e: dbg(f"[cdn] 刷新失败: {e}")

    tmpdir = os.path.join(RUNTIME, ".cdn"); os.makedirs(tmpdir, exist_ok=True)
    for ep in eps:
        if CANCEL["v"]: return
        rung = _pick_rung(ep)
        if not rung:
            logev("error", f"第{ep}集所有清晰度档位都是 ByteVC2,无法出片")
            emit({"event": "episode_failed", "ep": ep, "error": "所有档位都是 ByteVC2"})
            failed.append(ep); continue
        emit({"event": "episode_start", "ep": ep})
        emit({"event": "progress", "ep": ep, "percent": 30.0})
        src = os.path.join(tmpdir, f"ep{ep}.mp4")
        _partial["path"] = src
        try:
            if not _fetch_rung(ep, rung, src):
                emit({"event": "episode_failed", "ep": ep, "error": "1080p 源下载失败"})
                failed.append(ep); continue
            emit({"event": "progress", "ep": ep, "percent": 80.0})
            final = os.path.join(OUTDIR, epname(ep, width))
            if not decrypt_to(src, final, key=DEFERRED[ep]):
                emit({"event": "episode_failed", "ep": ep, "error": "1080p 源解密/封装失败"})
                failed.append(ep); continue
            ok, got, want = _duration_ok(ep, final)
            if not ok:
                logev("warn", f"第{ep}集时长 {got:.0f}s,App 记的是 {want:.0f}s,判定源残缺,丢弃")
                try: os.remove(final)
                except Exception: pass
                emit({"event": "episode_failed", "ep": ep,
                      "error": f"1080p 源残缺(时长 {got:.0f}s / 应为 {want:.0f}s)"})
                failed.append(ep); continue
            logev("info", f"第{ep}集已用 {rung['definition']} {rung['codec']} 源出片")
            emit({"event": "episode_done", "ep": ep, "file": epname(ep, width)})
            ok_list.append(ep)
        finally:
            _partial["path"] = None
            for q in (src, src + ".part"):
                try:
                    if os.path.exists(q): os.remove(q)
                except Exception: pass

def main():
    if START < 1 or END < START:
        logev("error", f"集数区间非法 start={START} end={END}"); finish(3, emit_done=False)
    os.makedirs(OUTDIR, exist_ok=True)
    serial = env_check()
    ensure_frida_server()
    ensure_adbkeyboard()
    net(True); time.sleep(1)

    # 先进剧读总集数,决定命名位宽,并做断点续传筛选。
    # 开局【不清空离线下载】:之前(含被取消的上一轮)已下好的 .mdl 直接复用。
    # 若在此 clear_all,会把文件清掉但 App 仍记为"已下载"→点开始下载不再重下→卡在 0/63。
    # 下载在每轮结束时(delete_downloads)统一清理,正常一轮仍是干净起步。
    if not search_open(NAME):
        logev("error", f"App 内没搜到/进不去这部剧: {NAME}")
        emit({"event": "init", "device": serial, "total": 0})
        finish(2, ok=0, failed=list(range(START, END + 1)))
    total = read_total() or _total_from_grid() or _total_from_db()   # 界面→选集面板→App库,逐级兜底
    if not total:
        logev("error", "没识别到总集数(界面和 App 库都读不到)")
        emit({"event": "init", "device": serial, "total": 0})
        finish(2, ok=0, failed=list(range(START, END + 1)))
    global TOTAL_EPS
    TOTAL_EPS = total
    width = 3 if total >= 100 else 2
    end = min(END, total)
    if end < END: logev("warn", f"end-ep {END} 超过总集数 {total},截到 {end}")

    todo = []
    for ep in range(START, end + 1):
        f = os.path.join(OUTDIR, epname(ep, width))
        if os.path.exists(f) and os.path.getsize(f) > 0:
            logev("info", f"第{ep}集已存在,跳过(断点续传)")
        else:
            todo.append(ep)
    emit({"event": "init", "device": serial, "total": len(todo)})
    if not todo:
        finish(0, ok=0, failed=[])

    # 下载整部(全选)——离线抓key/解密需要完整 .mdl
    # 先读一次集号映射:进了剧详情页 App 就把这部剧的记录写进库了,download_all 靠它判断
    # "盘上这些文件是不是本剧的"(只数文件个数会把别的剧的残留算成已齐)。
    global EP2MDL, MDL2EP
    EP2MDL, MDL2EP = _load_ep_maps_safe()
    logev("info", f"下载《{NAME}》全 {total} 集 ...")
    dres = download_all(total)
    if dres == "cancel": finish(130, emit_done=False)
    if not dres:
        logev("error", "下载失败")
        finish(2, ok=0, failed=todo)
    # download_all 各成功路径已统一收口到"剧详情页"(下载路径自己关了面板,复用路径本就在详情页)。
    # 这里绝不再无条件 keyback——复用路径没有面板,keyback 会把本剧顶出去(会"跑到别的剧")。
    # 保险:确认看得到"选集"再开抓;万一不在剧集页,重进这部剧(而不是盲目后退)。
    # 确认还在这部剧里。注意:dump 为空【不等于】不在剧集页——全屏播放器的 dump 经常整个失败,
    # 旧写法把空 dump 也当成"不在剧集页",于是白白触发一次重进,重进再核对不上就把整轮判死。
    x = ui_dump()                 # 只读判断,用 ui_dump 绝不点屏(dump_stable 兜底会点正中→误触'剧名')
    if x and '选集' not in x:      # 含有即可:全屏 feed 底栏是合并文案'选集 · 已完结 · 全63集'
        logev("info", "下载后不在剧集页,重新进入该剧 ...")
        if not search_open(NAME):
            # 进不去也别急着判死:抓取阶段是靠解密事件认集号的,跑偏了会自己发现并重进。
            logev("warn", "重新进入该剧没核对上,继续尝试抓取(抓取中会用解密事件二次确认是不是本剧)")
    clear_cache()                 # 清预缓冲残片,离线只播完整下载
    net(False); time.sleep(2)     # 断网:逼从完整下载副本(HEVC)起播
    pull_mdl()
    EP2MDL, MDL2EP = _load_ep_maps_safe()     # 下载完成后再读一次:此时这部剧的下载记录才齐
    if EP2MDL: _build_ct_index()              # 密文→集号索引:让"顺带解密到的集"也能直接出片
    frida_attach()

    ok_list = []; failed = []

    # 集号索引是整套方案的地基:没有它就没法确定"这段解密属于第几集",只能退回早期那条
    # 逐集精确导航的老路——实测那条路又慢又飘(选集网格四种形态、点已看完的集会跳集、
    # 失败复位会把播放位置带到别的剧)。与其让它跑几十分钟再交出一堆错的缺的,不如当场讲清楚。
    if not (MDL2EP and CT2EP):
        logev("error", "读不到 App 下载库,定不了集号(需要 adb root,且这部剧要整部下载完成)。"
                       "已中止,免得用不可靠的方式抓出一堆错集")
        finish(3, emit_done=False)

    run_harvest(todo, width, ok_list, failed)

    net(True)
    # 推迟的那些集在这里出片:要联网下服务端 1080p 源,而抓取阶段全程断网。
    # 必须排在 delete_downloads 之前——播放地址是从 App 下载库里读的,删下载会把那张表一起清掉。
    time.sleep(3)
    produce_from_cdn(width, ok_list, failed)
    if not args.keep_download:
        try: delete_downloads()
        except Exception as e: dbg(f"delete_downloads error: {e}")
    open_search()   # 留在干净搜索页,便于下次
    finish(0 if not failed else 2, ok=len(ok_list), failed=failed)

def delete_downloads():
    adb("shell", "am", "start", "-n", f"{PKG}/{DL_ACT}"); time.sleep(2.5)
    x = dump_stable()
    if '暂无已下载' in x: clear_cache(); return
    ed = ui_find(x, text='编辑'); sa = de = None
    if ed: tap(*ed); time.sleep(1.5); sa = ui_find(ui_dump(), text='全选')
    if sa: tap(*sa); time.sleep(1.2); de = ui_find(ui_dump(), text='删除')
    if de:
        tap(*de); time.sleep(1.8)
        cf = ui_find(ui_dump(), text='删除', ymax=int(_H * 0.75))
        if cf: tap(*cf); time.sleep(2.5)
        clear_cache(); return
    clear_all()

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except KeyboardInterrupt:
        finish(130, emit_done=False)
    except Exception as e:
        import traceback; dbg(traceback.format_exc())
        logev("error", f"未捕获异常: {e}")
        finish(2, ok=0, failed=[])

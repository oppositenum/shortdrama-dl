#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯协议整剧/区间抓取入口（无需 App UI、离线下载、逐集播放）。

用法:
  python3 api_grab.py --series-id 7610708001174850584 --output-dir /path/to/out
  python3 api_grab.py --series-id ... --start-ep 1 --end-ep 10 --output-dir ...
  python3 api_grab.py --series-id ... --output-dir ... --key-cache ./keys.json

协议:
  stdout 仅 JSON Lines（与 hongguo_grab.py 相同的 event 协议子集）
  stderr 调试日志
  退出码: 0 全成功 / 2 部分失败 / 3 环境或参数错误

密钥:
  video_model 返回 spade_a，由 spade_keys.unwrap_spade 离线解成 16 字节 AES key。
  优先: --key-hex → 纯本地 spade 解包 → key_cache。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from api_client import ApiError, HongguoApiClient, http_download  # noqa: E402
from spade_keys import KeyCache, try_offline_unwrap  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

_out_lock = threading.Lock()


def emit(o):
    with _out_lock:
        sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def dbg(m):
    sys.stderr.write(str(m) + "\n")
    sys.stderr.flush()


def logev(level, msg):
    emit({"event": "log", "level": level, "message": msg})


def epname(ep: int, width: int) -> str:
    return f"第{ep:0{width}d}集.mp4"


def decrypt_file(src: str, dest: str, key_hex: str) -> bool:
    # 临时文件名必须带 .mp4，否则 ffmpeg 无法推断封装格式
    # （与 hongguo_grab.decrypt_to 的 .tmp_第NN集.mp4 规则一致）
    tmp = os.path.join(os.path.dirname(dest), ".tmp_" + os.path.basename(dest))
    for p in (tmp, tmp + ".dec.mp4"):
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass
    cmd = [
        sys.executable,
        os.path.join(HERE, "decrypt_mdl.py"),
        src,
        os.devnull,
        tmp,
        "--key",
        key_hex,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.stdout:
        dbg(r.stdout.rstrip())
    if r.stderr:
        dbg(r.stderr.rstrip())
    ok = os.path.exists(tmp) and os.path.getsize(tmp) > 0
    if ok:
        os.replace(tmp, dest)
    else:
        for p in (tmp, tmp + ".dec.mp4"):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass
    return ok


def duration_ok(path: str, want: float, tol: float = 3.0):
    if not want:
        return True, 0.0, 0.0
    try:
        o = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout.strip()
        got = float(o) if o else 0.0
    except Exception as e:
        dbg(f"[dur] ffprobe failed: {e}")
        return True, 0.0, want
    return abs(got - want) <= tol, got, want


def resolve_key(cache: KeyCache, *, kid: str, spade_a: str, explicit: str = "") -> Optional[str]:
    k = cache.resolve(kid=kid, spade_a=spade_a, explicit=explicit)
    if k:
        return k
    k = try_offline_unwrap(spade_a) if spade_a else None
    if k:
        cache.put(k, kid=kid, spade_a=spade_a)
        cache.save()
        return k
    return None


# --- CDN 下载重试 ---------------------------------------------------------
# 一轮 = main + backup 各试一次。轮与轮之间退避，给对端喘息的机会。
CDN_ROUNDS = int(os.environ.get("SHORTDRAMA_CDN_ROUNDS", "3") or 3)
CDN_BACKOFF_S = (2.0, 6.0, 15.0)
# socket 超时：管建连和每次 read
CDN_SOCKET_TIMEOUT = float(os.environ.get("SHORTDRAMA_CDN_TIMEOUT", "40") or 40)
# 单次尝试的总时限。分集实测十几到几十秒，这里留足余量；慢速连接被切断后
# 下一轮能接着 .part 继续下，切早了也不会白费。
CDN_ATTEMPT_DEADLINE = float(os.environ.get("SHORTDRAMA_CDN_DEADLINE", "240") or 240)


def _part_bytes(dest: str) -> int:
    """已经攒下多少字节（各 CDN 的分片取最大的那份），只用于日志。"""
    base = os.path.basename(dest)
    d = os.path.dirname(dest) or "."
    best = 0
    try:
        for name in os.listdir(d):
            if name.startswith(base) and name.endswith(".part"):
                best = max(best, os.path.getsize(os.path.join(d, name)))
    except OSError:
        return 0
    return best


def download_cdn_with_retry(
    sources,
    dest: str,
    *,
    expect_size: int = 0,
    label: str = "",
    on_log=None,
    sleep=time.sleep,
    downloader=None,
) -> int:
    """按 main → backup 的顺序整对重试，轮间退避。

    以前是一趟 for 循环走完两个地址就抛错：一次偶发超时就把这一集判死，
    要等到几分钟后整部剧重跑的补漏轮才有下文，两次尝试之间连一秒退避都没有。
    现在整对重试 CDN_ROUNDS 轮；.part 保留，重试是接着下不是从头下。

    @param sources 形如 [("main", url), ("backup", url_or_None)]，None 的跳过
    @returns 下载字节数；全部失败时抛 RuntimeError
    """
    fetch = downloader or http_download
    say = on_log or (lambda level, message: None)
    usable = [(name, url) for name, url in sources if url]
    if not usable:
        raise RuntimeError("cdn download failed: no url")

    last_err = None
    for rnd in range(CDN_ROUNDS):
        for name, url in usable:
            try:
                got = fetch(
                    url,
                    dest,
                    expect_size=expect_size,
                    timeout=CDN_SOCKET_TIMEOUT,
                    deadline_s=CDN_ATTEMPT_DEADLINE,
                )
                return got
            except Exception as e:  # noqa: BLE001 网络什么都可能抛
                last_err = e
                say("warn", f"{label} {name} 下载失败（第 {rnd + 1}/{CDN_ROUNDS} 轮）: {e}")
        if rnd + 1 < CDN_ROUNDS:
            delay = CDN_BACKOFF_S[min(rnd, len(CDN_BACKOFF_S) - 1)]
            have = _part_bytes(dest)
            resume_hint = f"，已下 {have}B 可续" if have else ""
            say("info", f"{label} {delay:.0f}s 后重试 CDN{resume_hint}")
            sleep(delay)
    raise RuntimeError(f"cdn download failed: {last_err}")


def _is_risk_err(err: BaseException) -> bool:
    code = getattr(err, "code", None)
    if code in (110001, "110001", 101001, "101001"):
        return True
    return "110001" in str(err)


def try_attach_device_signer(adb_device: str):
    """尽力挂载 Frida TTNet 签名；失败返回 (None, reason)。"""
    try:
        from ttnet_signer import TtnetDeviceSigner  # noqa: WPS433
    except Exception as e:
        return None, f"无法 import ttnet_signer（需要 frida）: {e}"
    try:
        signer = TtnetDeviceSigner(device_id=adb_device)
        signer.attach()
        return signer, ""
    except Exception as e:
        # 压缩 Frida 长栈，日志里保留首行原因
        msg = str(e).strip()
        first = msg.splitlines()[0] if msg else "unknown"
        if "access violation" in msg.lower() or "0x0" in msg:
            first = (
                f"{first}（Java/Frida 未就绪：已内置重试；请确认模拟器红果已打开且 "
                f"frida-server 在跑）"
            )
        return None, first


# 这些原因这一趟里不会自己好：缺包、没设备。再试也只是每集重复刷同样一行日志。
# access violation 在修复 attach 后多数可恢复，不列为永久失败。
_PERMANENT_SIGN_FAILURES = (
    "无法 import ttnet_signer",
    "找不到 frida-tools",
    "找不到 Frida 设备",
    "unable to find device",
    "device not found",
    "no device",
    "not running",
)


def _is_permanent_sign_failure(reason: str) -> bool:
    low = (reason or "").lower()
    return any(marker.lower() in low for marker in _PERMANENT_SIGN_FAILURES)


def main() -> int:
    ap = argparse.ArgumentParser(description="红果短剧纯协议抓取")
    ap.add_argument("--series-id", required=True, help="网页/详情 series_id")
    ap.add_argument("--series-name", default="", help="仅用于日志/目录名提示")
    ap.add_argument("--start-ep", type=int, default=1)
    ap.add_argument("--end-ep", type=int, default=0, help="0=到最后一集")
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--device-id", default="")
    ap.add_argument("--install-id", default="")
    ap.add_argument("--key-cache", default="", help="kid/spade→key 缓存 JSON 路径")
    ap.add_argument("--key-hex", default="", help="强制使用该 AES key（调试单集）")
    ap.add_argument("--prefer-height", type=int, default=1080)
    ap.add_argument("--keep-encrypted", action="store_true", help="保留加密源文件")
    ap.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("SHORTDRAMA_API_INTERVAL", "1.0") or "1.0"),
        help="分集之间的间隔秒数，降低 110001 频控（默认 1.0）",
    )
    ap.add_argument(
        "--risk-cooldown",
        type=float,
        default=float(os.environ.get("SHORTDRAMA_RISK_COOLDOWN", "45") or "45"),
        help="命中 110001 后的冷却秒数（默认 45）",
    )
    ap.add_argument(
        "--offline-sign",
        action="store_true",
        default=None,
        help="本机 Python 生成 Khronos+Gorgon（无需模拟器；下载仍需联网；默认开启）",
    )
    ap.add_argument(
        "--no-offline-sign",
        action="store_true",
        help="关闭本机签名（仅裸 HTTP，易 110001）",
    )
    ap.add_argument(
        "--device-sign",
        action="store_true",
        help="经 Frida 调用模拟器内红果 App 的 TTNet 签名发请求（与 App 自身一致）",
    )
    ap.add_argument(
        "--device-sign-auto",
        action="store_true",
        help="本机签名仍 110001 时自动尝试挂载 App 签名（需模拟器/真机 + frida-server）",
    )
    ap.add_argument(
        "--adb-device",
        default=os.environ.get("SHORTDRAMA_ADB_DEVICE", "emulator-5554"),
        help="adb/frida 设备 id（默认 emulator-5554）",
    )
    args = ap.parse_args()

    outdir = os.path.abspath(args.output_dir)
    os.makedirs(outdir, exist_ok=True)
    cache = KeyCache(args.key_cache or None)

    auto_sign = bool(
        args.device_sign_auto
        or os.environ.get("SHORTDRAMA_DEVICE_SIGN_AUTO", "").strip() in ("1", "true", "yes")
    )
    # 默认开启设备签名自动回退（可 SHORTDRAMA_DEVICE_SIGN_AUTO=0 关闭）
    if os.environ.get("SHORTDRAMA_DEVICE_SIGN_AUTO", "").strip() not in ("0", "false", "no"):
        if not args.device_sign:
            auto_sign = True

    use_device_sign = bool(
        args.device_sign
        or os.environ.get("SHORTDRAMA_DEVICE_SIGN", "").strip() in ("1", "true", "yes")
    )
    # 本机签名默认开；--no-offline-sign 或 SHORTDRAMA_OFFLINE_SIGN=0 关闭
    use_offline = not args.no_offline_sign
    if os.environ.get("SHORTDRAMA_OFFLINE_SIGN", "").strip() in ("0", "false", "no"):
        use_offline = False
    if args.offline_sign:
        use_offline = True

    signer = None
    sign_failures = 0
    if use_device_sign:
        signer, err = try_attach_device_signer(args.adb_device)
        if signer is None:
            logev("error", f"挂载 App 签名失败: {err}")
            return 3
        logev("info", f"已挂载 App TTNet 签名（device={args.adb_device}）")
        use_offline = False  # 设备签名优先
    elif use_offline:
        try:
            from metasec_offline import OfflineSigner  # noqa: WPS433

            signer = OfflineSigner()
            logev("info", "已启用本机签名（Khronos+Gorgon，无需模拟器；下载需联网）")
        except Exception as e:
            logev("warn", f"本机签名初始化失败，将裸请求: {e}")
            signer = None

    client = HongguoApiClient(
        device_id=args.device_id or None,
        install_id=args.install_id or None,
        signer=signer,
        offline_sign=False,  # 已在上方显式注入 signer
    )

    def ensure_signed_or_recover(reason: str) -> bool:
        """110001 恢复策略（优先快路径）：

        1. 已挂签名（本机或设备）→ 直接继续
        2. 尝试切换/启用本机 OfflineSigner
        3. 允许 auto_sign → 挂载 App 设备签名
        4. 冷却 + 轮换 device_id
        """
        nonlocal signer, auto_sign, sign_failures
        logev("warn", f"触发风控恢复（{reason}）")

        if client.signer is not None:
            # 若当前是本机签仍失败，再尝试设备签名
            is_offline = type(client.signer).__name__ == "OfflineSigner"
            if not is_offline:
                logev("info", "已在设备签名路径，跳过冷却，直接重试")
                return True
            logev("info", "本机签名仍遇风控，尝试其它恢复…")
        else:
            # 先上本机签名
            try:
                from metasec_offline import OfflineSigner  # noqa: WPS433

                signer = OfflineSigner()
                client.set_signer(signer)
                logev("info", "已切换本机签名（Khronos+Gorgon）")
                return True
            except Exception as e:
                logev("warn", f"本机签名不可用: {e}")

        # 有设备就挂 App 签名
        if auto_sign:
            logev("info", f"尝试挂载 App 签名（device={args.adb_device}）…")
            s, err = try_attach_device_signer(args.adb_device)
            if s is not None:
                signer = s
                client.set_signer(s)
                sign_failures = 0
                logev("info", "已挂载 App TTNet 签名，后续请求走设备签名路径")
                return True
            sign_failures += 1
            logev(
                "warn",
                f"挂载签名失败: {err}；改为冷却 {args.risk_cooldown:.0f}s 后轮换身份再试裸请求",
            )
            # 缺包或没设备这类原因不会自己好转，别在后面每一集再重刷一遍同样的失败。
            if _is_permanent_sign_failure(err) or sign_failures >= 2:
                auto_sign = False
                logev("warn", "本次运行不再尝试挂载 App 签名，后续风控只做冷却+轮换身份")
        else:
            logev(
                "info",
                f"未启用自动签名，冷却 {args.risk_cooldown:.0f}s 后轮换身份…",
            )

        time.sleep(max(1.0, float(args.risk_cooldown)))
        client.rotate_device_identity()
        logev("info", f"已轮换 device_id={client.device_id} iid={client.install_id}")
        return True  # 允许调用方用新身份再打一次裸请求

    try:
        detail = client.video_detail(args.series_id)
    except Exception as e:
        msg = str(e)
        if _is_risk_err(e) and ensure_signed_or_recover("video_detail 110001"):
            try:
                detail = client.video_detail(args.series_id)
            except Exception as e2:
                msg = str(e2)
                logev("error", f"拉取剧详情失败: {msg}")
                if signer is not None:
                    try:
                        signer.detach()
                    except Exception:
                        pass
                return 4 if _is_risk_err(e2) else 3
        else:
            logev("error", f"拉取剧详情失败: {msg}")
            if signer is not None:
                try:
                    signer.detach()
                except Exception:
                    pass
            if _is_risk_err(e):
                logev(
                    "warn",
                    "业务 API 返回 110001。可稍后重试、加大 --interval，"
                    "或保证模拟器红果+frida-server 后使用 --device-sign。",
                )
                return 4
            return 3

    title = detail.get("series_title") or args.series_name or args.series_id
    episodes = client.episode_list(detail)
    if not episodes:
        logev("error", "剧详情里没有分集列表")
        return 3

    total = max(ep["ep"] for ep in episodes)
    end = args.end_ep if args.end_ep > 0 else total
    end = min(end, total)
    start = max(1, args.start_ep)
    width = 3 if total >= 100 else 2

    todo = []
    for epinfo in episodes:
        ep = epinfo["ep"]
        if ep < start or ep > end:
            continue
        path = os.path.join(outdir, epname(ep, width))
        if os.path.exists(path) and os.path.getsize(path) > 0:
            logev("info", f"第{ep}集已存在,跳过")
            continue
        todo.append(epinfo)

    emit({"event": "init", "device": "api", "total": len(todo)})
    logev(
        "info",
        f"纯协议抓取《{title}》 series_id={args.series_id} 区间 {start}-{end} 待抓 {len(todo)}/{total}",
    )
    if not todo:
        emit({"event": "done", "ok": 0, "failed": []})
        return 0

    tmpdir = os.path.join(outdir, ".api_tmp")
    os.makedirs(tmpdir, exist_ok=True)
    ok_list = []
    failed = []

    consecutive_risk = 0
    risk_cooldown = float(args.risk_cooldown)
    for idx, epinfo in enumerate(todo):
        if idx > 0 and args.interval > 0:
            time.sleep(args.interval)
        ep = epinfo["ep"]
        vid = epinfo["vid"]
        emit({"event": "episode_start", "ep": ep})
        try:
            vm = None
            last_model_err: Optional[BaseException] = None
            for attempt in range(3):
                try:
                    vm = client.video_model(vid)
                    last_model_err = None
                    consecutive_risk = 0
                    break
                except Exception as e:
                    last_model_err = e
                    emsg = str(e).lower()
                    # Frida 会话中途被毁（App 被杀 / 脚本崩）：重挂再试，不当成永久失败
                    if any(
                        x in emsg
                        for x in (
                            "script has been destroyed",
                            "session is destroyed",
                            "detached",
                            "connection closed",
                        )
                    ):
                        logev(
                            "warn",
                            f"第{ep}集 Frida 签名会话断开（attempt {attempt + 1}/3），重新挂载…",
                        )
                        if client.signer is not None:
                            try:
                                client.signer.detach()
                            except Exception:
                                pass
                        s, err = try_attach_device_signer(args.adb_device)
                        if s is not None:
                            signer = s
                            client.set_signer(s)
                            logev("info", "已重新挂载 App 签名，重试本集")
                            time.sleep(0.5)
                            continue
                        logev("warn", f"重挂失败: {err}")
                        if attempt < 2:
                            time.sleep(1.5)
                            continue
                        raise
                    if not _is_risk_err(e):
                        raise
                    consecutive_risk += 1
                    logev(
                        "warn",
                        f"第{ep}集 video_model 风控 110001（attempt {attempt + 1}/3）",
                    )
                    # 连续多集风控：加长冷却
                    if consecutive_risk >= 2:
                        risk_cooldown = min(180.0, max(risk_cooldown, 60.0))
                    # 临时抬高 ensure 用的冷却
                    args.risk_cooldown = risk_cooldown
                    if not ensure_signed_or_recover(f"ep{ep} video_model"):
                        time.sleep(min(60.0, risk_cooldown * (attempt + 1) * 0.5))
            if vm is None:
                raise last_model_err or RuntimeError("video_model failed")

            rung = client.pick_rung(vm, prefer_height=args.prefer_height)
            if not rung:
                # 再试一次允许 bytevc2（后面解密可能仍失败）
                rung = client.pick_rung(vm, prefer_height=args.prefer_height, allow_bytevc2=True)
            if not rung:
                raise RuntimeError("no playable rung in video_model")

            key = resolve_key(
                cache,
                kid=rung.get("kid") or "",
                spade_a=rung.get("spade_a") or "",
                explicit=args.key_hex if len(todo) == 1 else "",
            )
            if not key and args.key_hex:
                key = args.key_hex.lower().strip()
            if not key:
                raise RuntimeError(
                    f"no AES key for kid={rung.get('kid')} "
                    f"(spade 解包失败，检查 spade_a 是否有效)"
                )

            emit({"event": "progress", "ep": ep, "percent": 30.0})
            enc = os.path.join(tmpdir, f"ep{ep:04d}_{rung['definition']}.mp4")
            # CDN 超时是最常见的偶发故障，而且多半下一秒就好了。以前 main、backup
            # 各打一枪就把这一集判死，要等到几分钟后整部剧重跑的补漏轮才有下文。
            got_bytes = download_cdn_with_retry(
                [("main", rung["url"]), ("backup", rung.get("backup"))],
                enc,
                expect_size=rung.get("size") or 0,
                label=f"第{ep}集",
                on_log=logev,
            )
            dbg(f"[cdn] ep{ep} {rung['definition']} {got_bytes}B")

            emit({"event": "progress", "ep": ep, "percent": 80.0})
            final = os.path.join(outdir, epname(ep, width))
            if not decrypt_file(enc, final, key):
                raise RuntimeError("decrypt/repack failed")

            ok, got, want = duration_ok(final, epinfo.get("duration") or 0)
            if not ok:
                try:
                    os.remove(final)
                except OSError:
                    pass
                raise RuntimeError(f"duration mismatch {got:.0f}s / {want:.0f}s")

            # 成功后把 key 写回缓存
            cache.put(key, kid=rung.get("kid") or "", spade_a=rung.get("spade_a") or "")
            cache.save()

            emit({"event": "episode_done", "ep": ep, "file": epname(ep, width)})
            ok_list.append(ep)
            logev(
                "info",
                f"第{ep}集完成 {rung['definition']} {rung['codec']} key={key[:8]}…",
            )
        except Exception as e:
            dbg(f"[ep{ep}] {e}")
            emit({"event": "episode_failed", "ep": ep, "error": str(e)})
            failed.append(ep)
            # 连续风控失败时放慢，避免把整个 IP 打穿
            if _is_risk_err(e):
                time.sleep(min(30.0, risk_cooldown * 0.3))
        finally:
            if not args.keep_encrypted:
                for name in os.listdir(tmpdir):
                    if name.startswith(f"ep{ep:04d}_"):
                        try:
                            os.remove(os.path.join(tmpdir, name))
                        except OSError:
                            pass

    emit({"event": "done", "ok": len(ok_list), "failed": failed})
    if signer is not None:
        try:
            signer.detach()
        except Exception:
            pass
    return 0 if not failed else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)

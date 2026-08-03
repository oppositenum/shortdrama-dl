#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gorgon/六神 明文与 f3 I/O dump 的 Frida host。

用法:
  # 模拟器红果已启动 + frida-server
  python3 frida_gorgon_plaindump.py --device emulator-5554

  # 主动触发 N 次签名并保存
  python3 frida_gorgon_plaindump.py --device emulator-5554 --trigger 5 \\
      --url 'https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/'

输出:
  python/sign_samples/gorgon_plaindump.jsonl   事件流
  python/sign_samples/gorgon_plaindump_last.json 最后一次摘要

说明:
  - 捕获 f3.a(0x3000001) 入参/出参（含 X-Gorgon 解析 mid/body20）
  - 若 Java 层 StringBuilder 拼出 8404… 会带短栈
  - 真正「加密前 20 字节明文」若只在 native VM 内，需要再叠 Stalker（本脚本先把 Java 边界钉死）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

try:
    import frida
except ImportError:
    print("need frida: pip install frida==17.16.4", file=sys.stderr)
    raise SystemExit(3)

ROOT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "sign_samples"
JS_PATH = HERE / "frida_gorgon_plaindump.js"
PKG = "com.phoenix.read"

# bridge loader for Frida 17 Java
BOOT = r"""
function installBridgeLoader(name) {
  Object.defineProperty(globalThis, name, {
    enumerable: true, configurable: true,
    get: function () {
      let bridge;
      send({ type: 'frida:load-bridge', name: name });
      recv('frida:bridge-loaded', function (msg) {
        bridge = Script.evaluate(
          '/frida/bridges/' + msg.filename,
          '(function () { ' + msg.source + '\nObject.defineProperty(globalThis, "' + name + '", { value: bridge });\nreturn bridge; })();'
        );
      }).wait();
      return bridge;
    }
  });
}
installBridgeLoader('Java');
"""


def find_bridge_dir() -> Path:
    candidates = [
        ROOT / ".venv/lib/python3.14/site-packages/frida_tools/bridges",
        ROOT / ".venv/lib/python3.13/site-packages/frida_tools/bridges",
        ROOT / ".venv/lib/python3.12/site-packages/frida_tools/bridges",
        ROOT / ".venv/lib/python3.11/site-packages/frida_tools/bridges",
    ]
    for p in candidates:
        if p.is_dir():
            return p
    # site-packages scan
    try:
        import frida_tools  # type: ignore

        p = Path(frida_tools.__file__).resolve().parent / "bridges"
        if p.is_dir():
            return p
    except Exception:
        pass
    raise FileNotFoundError("frida_tools bridges not found; pip install frida-tools")


def adb_pid(device: str, package: str) -> int:
    try:
        out = subprocess.check_output(
            ["adb", "-s", device, "shell", "pidof", package],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        if out:
            return int(out.split()[0])
    except Exception:
        pass
    return 0


def ensure_app(device: str, package: str) -> int:
    pid = adb_pid(device, package)
    if pid:
        return pid
    subprocess.call(
        [
            "adb",
            "-s",
            device,
            "shell",
            "monkey",
            "-p",
            package,
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(30):
        time.sleep(1)
        pid = adb_pid(device, package)
        if pid:
            return pid
    raise RuntimeError(f"app not running: {package}")


def get_device(device_id: str):
    mgr = frida.get_device_manager()
    # try explicit
    for d in mgr.enumerate_devices():
        if d.id == device_id:
            return d
    # usb / remote
    try:
        return frida.get_device(device_id, timeout=5)
    except Exception:
        pass
    try:
        return frida.get_usb_device(timeout=5)
    except Exception as e:
        raise RuntimeError(f"no frida device {device_id}: {e}") from e


def main() -> int:
    ap = argparse.ArgumentParser(description="Gorgon plain/f3 dump host")
    ap.add_argument("--device", default="emulator-5554")
    ap.add_argument("--package", default=PKG)
    ap.add_argument("--trigger", type=int, default=3, help="主动签名次数")
    ap.add_argument(
        "--url",
        default="https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/",
    )
    ap.add_argument("--body", default='{"series_id":"7610708001174850584"}')
    ap.add_argument("--listen-s", type=float, default=5.0, help="触发后额外监听秒数")
    args = ap.parse_args()

    if not JS_PATH.is_file():
        print("missing", JS_PATH, file=sys.stderr)
        return 3

    bridge_dir = find_bridge_dir()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    jsonl_path = OUT_DIR / "gorgon_plaindump.jsonl"
    last_path = OUT_DIR / "gorgon_plaindump_last.json"

    pid = ensure_app(args.device, args.package)
    print(f"[+] app pid={pid} device={args.device}")

    device = get_device(args.device)
    session = device.attach(pid)
    events = []

    def on_msg(message, data):
        if message.get("type") == "send":
            payload = message.get("payload")
            if not isinstance(payload, dict):
                return
            if payload.get("type") == "frida:load-bridge":
                stem = str(payload.get("name", "")).lower()
                bridge = next(bridge_dir.glob(stem + ".js"))
                script.post(
                    {
                        "type": "frida:bridge-loaded",
                        "filename": bridge.name,
                        "source": bridge.read_text(encoding="utf-8"),
                    }
                )
                return
            if payload.get("type") == "log":
                print("[log]", payload.get("m"))
            else:
                print("[evt]", payload.get("type"), end="")
                if payload.get("type") == "f3":
                    print(
                        f" opcode={payload.get('opcode')} gorgon={str(payload.get('gorgon') or '')[:24]}…"
                    )
                elif payload.get("type") == "gorgon_string":
                    print(f" {str(payload.get('value'))[:32]}…")
                else:
                    print()
                events.append(payload)
                with jsonl_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        elif message.get("type") == "error":
            print("[frida-error]", message, file=sys.stderr)

    source = BOOT + "\n" + JS_PATH.read_text(encoding="utf-8")
    script = session.create_script(source)
    script.on("message", on_msg)
    script.load()
    time.sleep(1.0)

    body = args.body.encode("utf-8")
    stub = hashlib.md5(body).hexdigest().upper()
    summary = {"triggers": [], "stats": None}

    for i in range(max(0, args.trigger)):
        ticket = str(int(time.time() * 1000))
        url = args.url
        try:
            fu = script.exports_sync.full_url(url.split("?", 1)[0])
            if fu.get("url"):
                url = fu["url"]
        except Exception as e:
            print("[warn] full_url", e)
        print(f"[*] triggerSign #{i+1} stub={stub[:8]}… ticket={ticket}")
        try:
            r = script.exports_sync.trigger_sign(url, stub, ticket)
        except Exception as e:
            r = {"error": str(e)}
        print("    ->", {k: (str(v)[:60] + "…" if isinstance(v, str) and len(str(v)) > 60 else v) for k, v in (r or {}).items() if k != "headers"})
        if isinstance(r, dict) and r.get("headers"):
            g = r["headers"].get("X-Gorgon") or r["headers"].get("x-gorgon")
            print(f"    X-Gorgon={g}")
            print(f"    parse={r.get('gorgon_parse')}")
        summary["triggers"].append({"i": i, "url": url[:200], "result": r})
        time.sleep(0.4)

    time.sleep(max(0.0, args.listen_s))
    try:
        summary["stats"] = script.exports_sync.stats()
    except Exception as e:
        summary["stats"] = {"error": str(e)}

    # last f3 event
    f3s = [e for e in events if e.get("type") == "f3"]
    gstrs = [e for e in events if e.get("type") == "gorgon_string"]
    summary["f3_events"] = len(f3s)
    summary["gorgon_string_events"] = len(gstrs)
    if f3s:
        summary["last_f3"] = f3s[-1]
        # corpus-friendly record
        last = f3s[-1]
        summary["analysis_hints"] = {
            "gorgon": last.get("gorgon"),
            "gorgon_parse": last.get("gorgon_parse"),
            "note": (
                "body20 是密文。若 gorgon_string 事件带 stack，可从栈顶 Java 帧"
                "继续往 native 追；下一步对 libmetasec 写 20 字节缓冲的地址下读写断点。"
            ),
        }
    last_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[+] events={len(events)} f3={len(f3s)} gorgon_str={len(gstrs)}")
    print(f"[+] wrote {jsonl_path}")
    print(f"[+] wrote {last_path}")

    try:
        session.detach()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gorgon native 探测 host：签名后扫内存找 26B 原始 Gorgon。

用法:
  python3 frida_gorgon_native.py --device emulator-5554 --trigger 4

输出:
  sign_samples/gorgon_native.jsonl
  sign_samples/gorgon_native_last.json
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
    print("pip install frida==17.16.4", file=sys.stderr)
    raise SystemExit(3)

ROOT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent
OUT = HERE / "sign_samples"
JS = HERE / "frida_gorgon_native.js"
PKG = "com.phoenix.read"

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


def bridge_dir() -> Path:
    for ver in ("3.14", "3.13", "3.12", "3.11"):
        p = ROOT / f".venv/lib/python{ver}/site-packages/frida_tools/bridges"
        if p.is_dir():
            return p
    try:
        import frida_tools  # type: ignore

        p = Path(frida_tools.__file__).resolve().parent / "bridges"
        if p.is_dir():
            return p
    except Exception:
        pass
    raise FileNotFoundError("frida_tools bridges not found")


def adb_pid(device: str) -> int:
    try:
        out = subprocess.check_output(
            ["adb", "-s", device, "shell", "pidof", PKG], text=True, stderr=subprocess.DEVNULL
        ).strip()
        if out:
            return int(out.split()[0])
    except Exception:
        pass
    return 0


def ensure_app(device: str) -> int:
    pid = adb_pid(device)
    if pid:
        return pid
    subprocess.call(
        ["adb", "-s", device, "shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        time.sleep(1)
        pid = adb_pid(device)
        if pid:
            return pid
    raise RuntimeError("app not running")


def get_device(device_id: str):
    for d in frida.get_device_manager().enumerate_devices():
        if d.id == device_id:
            return d
    try:
        return frida.get_device(device_id, timeout=5)
    except Exception:
        return frida.get_usb_device(timeout=8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="emulator-5554")
    ap.add_argument("--trigger", type=int, default=4)
    ap.add_argument(
        "--url",
        default="https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/",
    )
    ap.add_argument("--body", default='{"series_id":"7668349899590618136"}')
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    jsonl = OUT / "gorgon_native.jsonl"
    lastp = OUT / "gorgon_native_last.json"
    bd = bridge_dir()

    pid = ensure_app(args.device)
    print(f"[+] pid={pid}")
    device = get_device(args.device)
    session = device.attach(pid)
    events = []

    def on_msg(message, data):
        if message.get("type") != "send":
            if message.get("type") == "error":
                print("[err]", message)
            return
        p = message.get("payload")
        if not isinstance(p, dict):
            return
        if p.get("type") == "frida:load-bridge":
            stem = str(p.get("name", "")).lower()
            bridge = next(bd.glob(stem + ".js"))
            script.post(
                {
                    "type": "frida:bridge-loaded",
                    "filename": bridge.name,
                    "source": bridge.read_text(encoding="utf-8"),
                }
            )
            return
        if p.get("type") == "log":
            print("[log]", p.get("m"))
            return
        events.append(p)
        with jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")
        if p.get("type") == "f3_native":
            print(
                f"[evt] gorgon={str(p.get('gorgon'))[:28]}… "
                f"mem_match={len(p.get('mem_match') or [])} "
                f"ascii={len(p.get('mem_ascii') or [])} "
                f"hits={p.get('mem_hit_count')}"
            )
            if p.get("mem_match"):
                print("      mem_match[0]=", p["mem_match"][0])
            if p.get("mem_ascii"):
                print("      mem_ascii[0]=", p["mem_ascii"][0])

    source = BOOT + "\n" + JS.read_text(encoding="utf-8")
    script = session.create_script(source)
    script.on("message", on_msg)
    script.load()
    time.sleep(1.2)

    body = args.body.encode()
    stub = hashlib.md5(body).hexdigest().upper()
    summary = {"triggers": []}

    for i in range(args.trigger):
        ticket = str(int(time.time() * 1000))
        url = args.url
        try:
            fu = script.exports_sync.full_url(url.split("?", 1)[0])
            if fu.get("url"):
                url = fu["url"]
        except Exception as e:
            print("[warn] full_url", e)
        print(f"[*] trigger #{i+1}")
        r = script.exports_sync.trigger_sign(url, stub, ticket)
        g = (r.get("headers") or {}).get("X-Gorgon")
        print(f"    gorgon={g}")
        summary["triggers"].append({"i": i, "url": url[:200], "result_keys": list((r or {}).keys()), "gorgon": g})
        time.sleep(0.6)

    time.sleep(1.0)
    try:
        summary["last"] = script.exports_sync.last()
    except Exception as e:
        summary["last_err"] = str(e)

    f3s = [e for e in events if e.get("type") == "f3_native"]
    summary["f3_count"] = len(f3s)
    summary["any_mem_match"] = any(e.get("mem_match") for e in f3s)
    lastp.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[+] f3_events={len(f3s)} any_mem_match={summary['any_mem_match']}")
    print(f"[+] {jsonl}")
    print(f"[+] {lastp}")
    try:
        session.detach()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

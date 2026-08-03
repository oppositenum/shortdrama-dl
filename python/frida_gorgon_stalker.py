#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gorgon Stalker / NewStringUTF 深挖 host。

用法:
  python3 frida_gorgon_stalker.py --device emulator-5554 --trigger 2

输出:
  sign_samples/gorgon_stalker.jsonl
  sign_samples/gorgon_stalker_last.json

注意: Stalker 较慢，单次签名可能数秒～十几秒。
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
    print("need frida", file=sys.stderr)
    raise SystemExit(3)

ROOT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent
OUT = HERE / "sign_samples"
JS = HERE / "frida_gorgon_stalker.js"
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
    import frida_tools  # type: ignore

    return Path(frida_tools.__file__).resolve().parent / "bridges"


def ensure_app(device: str) -> int:
    try:
        out = subprocess.check_output(
            ["adb", "-s", device, "shell", "pidof", PKG], text=True, stderr=subprocess.DEVNULL
        ).strip()
        if out:
            return int(out.split()[0])
    except Exception:
        pass
    subprocess.call(
        ["adb", "-s", device, "shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        time.sleep(1)
        try:
            out = subprocess.check_output(
                ["adb", "-s", device, "shell", "pidof", PKG], text=True, stderr=subprocess.DEVNULL
            ).strip()
            if out:
                return int(out.split()[0])
        except Exception:
            pass
    raise RuntimeError("app not running")


def get_device(device_id: str):
    for d in frida.get_device_manager().enumerate_devices():
        if d.id == device_id:
            return d
    return frida.get_device(device_id, timeout=8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="emulator-5554")
    ap.add_argument("--trigger", type=int, default=2)
    ap.add_argument(
        "--url",
        default="https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/",
    )
    ap.add_argument("--body", default='{"series_id":"7668349899590618136"}')
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    jsonl = OUT / "gorgon_stalker.jsonl"
    lastp = OUT / "gorgon_stalker_last.json"
    bd = bridge_dir()

    pid = ensure_app(args.device)
    print(f"[+] pid={pid}")
    session = get_device(args.device).attach(pid)
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
        t = p.get("type")
        if t == "f3_stalker":
            print(
                f"[evt] gorgon={str(p.get('gorgon'))[:28]}… "
                f"writes={len(p.get('write_hits') or [])} "
                f"match={len(p.get('write_match') or [])} "
                f"str={len(p.get('string_hits') or [])}"
            )
            for m in (p.get("write_match") or [])[:2]:
                print("  WRITE_MATCH", m.get("pc"), m.get("hex", "")[:40], "bt0=", (m.get("bt") or [""])[0][:80])
            for m in (p.get("string_hits") or [])[-2:]:
                print("  STR", m.get("export", "")[:40], (m.get("bt") or [""])[0][:80])
        elif t == "newstring_utf":
            print("[str]", p.get("value", "")[:40], "bt0=", (p.get("bt") or [""])[0][:90])

    script = session.create_script(BOOT + "\n" + JS.read_text(encoding="utf-8"))
    script.on("message", on_msg)
    script.load()
    time.sleep(1.5)

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
        print(f"[*] trigger #{i+1} (stalker may be slow)…")
        t0 = time.time()
        r = script.exports_sync.trigger_sign(url, stub, ticket)
        print(f"    done in {time.time()-t0:.1f}s gorgon={(r.get('headers') or {}).get('X-Gorgon', '')[:28]}")
        summary["triggers"].append({"i": i, "sec": round(time.time() - t0, 2), "headers": r.get("headers")})
        time.sleep(0.5)

    f3s = [e for e in events if e.get("type") == "f3_stalker"]
    strs = [e for e in events if e.get("type") == "newstring_utf"]
    summary["f3_events"] = len(f3s)
    summary["string_events"] = len(strs)
    if f3s:
        summary["last_f3"] = f3s[-1]
        # extract unique pcs from write hits
        pcs = []
        for e in f3s:
            for w in e.get("write_hits") or []:
                if w.get("pc"):
                    pcs.append(w["pc"])
        summary["unique_write_pcs"] = list(dict.fromkeys(pcs))[:30]
    lastp.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[+] f3={len(f3s)} strings={len(strs)}")
    print(f"[+] {jsonl}\n[+] {lastp}")
    try:
        session.detach()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

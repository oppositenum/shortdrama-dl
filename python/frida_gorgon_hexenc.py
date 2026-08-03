#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 NewStringUTF 捕获 Gorgon 时扫栈/寄存器找 26B 二进制。

用法:
  python3 frida_gorgon_hexenc.py --device emulator-5554 --trigger 3
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import frida

ROOT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent
OUT = HERE / "sign_samples"
JS = HERE / "frida_gorgon_hexenc.js"
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
    ap.add_argument("--trigger", type=int, default=3)
    ap.add_argument(
        "--url",
        default="https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/",
    )
    ap.add_argument("--body", default='{"series_id":"7668349899590618136"}')
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    jsonl = OUT / "gorgon_hexenc.jsonl"
    lastp = OUT / "gorgon_hexenc_last.json"
    bd = bridge_dir()
    pid = ensure_app(args.device)
    print(f"[+] pid={pid}")
    session = get_device(args.device).attach(pid)
    events = []

    def on_msg(message, data):
        if message.get("type") != "send":
            if message.get("type") == "error":
                print("[err]", message.get("description"), message.get("stack", "")[:300])
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
        if p.get("type") == "gorgon_hexenc":
            print(f"[HIT] gorgon={p.get('gorgon','')[:40]}… matched_bin={len(p.get('matched_bin') or [])} bins={len(p.get('bins') or [])}")
            for b in (p.get("matched_bin") or [])[:3]:
                print("  MATCH", b)
            for b in (p.get("bins") or [])[:5]:
                print("  bin", b.get("tag"), b.get("hex"), "off", b.get("off"))
            print("  bt:")
            for line in (p.get("bt") or [])[:12]:
                print("   ", line[:130])
            if p.get("disasm_ret"):
                print("  disasm near ret:")
                for line in p["disasm_ret"][:16]:
                    print("   ", line)

    script = session.create_script(BOOT + "\n" + JS.read_text(encoding="utf-8"))
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
            print("[warn]", e)
        print(f"[*] trigger #{i+1}")
        r = script.exports_sync.trigger_sign(url, stub, ticket)
        g = (r.get("headers") or {}).get("X-Gorgon")
        print(f"    header gorgon={g}")
        summary["triggers"].append({"i": i, "gorgon": g})
        time.sleep(0.4)

    last = None
    try:
        last = script.exports_sync.last()
    except Exception:
        pass
    summary["last"] = last
    summary["events"] = len(events)
    # strip huge regs for last file size
    if isinstance(last, dict) and "regs" in last:
        slim = dict(last)
        slim["regs"] = {k: v for k, v in (last.get("regs") or {}).items() if v.get("ascii") or (v.get("hex32") or "").startswith("8404") or k in ("x0", "x1", "x2", "sp", "lr", "x19", "x20")}
        summary["last_slim"] = slim
    lastp.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[+] events={len(events)} -> {jsonl}\n[+] {lastp}")
    try:
        session.detach()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

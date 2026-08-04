#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Frida host: dump Gorgon mid/body20 + nearby memory for key recovery.

Usage:
  python3 frida_gorgon_keydump.py --device emulator-5554 --trigger 6

Writes:
  sign_samples/gorgon_keydump.jsonl
  sign_samples/gorgon_keydump_last.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import frida
except ImportError:
    print("need frida", file=sys.stderr)
    raise SystemExit(3)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "sign_samples"
JS = HERE / "frida_gorgon_keydump.js"
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


def find_bridge_dir() -> Path:
    for p in [
        ROOT / ".venv/lib/python3.14/site-packages/frida_tools/bridges",
        ROOT / ".venv/lib/python3.13/site-packages/frida_tools/bridges",
        ROOT / ".venv/lib/python3.12/site-packages/frida_tools/bridges",
        ROOT / ".venv/lib/python3.11/site-packages/frida_tools/bridges",
    ]:
        if p.is_dir():
            return p
    import frida_tools  # type: ignore

    p = Path(frida_tools.__file__).resolve().parent / "bridges"
    if p.is_dir():
        return p
    raise FileNotFoundError("frida bridges not found")


def adb(device: str, *args: str) -> str:
    try:
        return subprocess.check_output(
            ["adb", "-s", device, *args], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        return ""


def ensure_app(device: str) -> int:
    out = adb(device, "shell", "pidof", PKG)
    if out:
        return int(out.split()[0])
    subprocess.call(
        [
            "adb",
            "-s",
            device,
            "shell",
            "monkey",
            "-p",
            PKG,
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(4)
    out = adb(device, "shell", "pidof", PKG)
    if not out:
        raise SystemExit(f"app {PKG} not running")
    return int(out.split()[0])


def rev_nib(n: int) -> int:
    t = f"{n:02x}"
    return int(t[1] + t[0], 16)


def rbit(n: int) -> int:
    return int(bin(n)[2:].zfill(8)[::-1], 2)


def decrypt_to_eor(cipher: bytes, length: int = 0x14) -> List[int]:
    eor = list(cipher)
    for i in range(length - 1, -1, -1):
        h = eor[i]
        d = eor[(i + 1) % length]
        x = rbit(h ^ 0xEB) ^ d
        eor[i] = rev_nib(x)
    return eor


def encrypt_cascade(param: List[int], key: List[int], length: int = 0x14) -> List[int]:
    eor = [a ^ b for a, b in zip(param, key)]
    for i in range(length):
        c = rev_nib(eor[i])
        d = eor[(i + 1) % length]
        e = c ^ d
        f = rbit(e)
        eor[i] = ((f ^ 0xFFFFFFFF) ^ length) & 0xFF
    return eor


def md5(b: bytes) -> bytes:
    return hashlib.md5(b).digest()


def analyze_sample(url: str, stub: str, kh: int, gorgon: str) -> Dict[str, Any]:
    raw = bytes.fromhex(gorgon.lower())
    mid = raw[2:4]
    body20 = raw[6:26]
    eor = decrypt_to_eor(body20)
    p = urllib.parse.urlparse(url)
    q = p.query
    data4 = bytes.fromhex(stub.lower())[:4] if stub and len(stub) >= 8 else b"\0" * 4
    param = (
        list(md5(q.encode())[:4])
        + list(data4)
        + [0] * 4
        + [0, 6, 0x0B, 0x1C]
        + list(struct.pack(">I", kh))
    )
    key = bytes(a ^ b for a, b in zip(eor, param))
    ok = encrypt_cascade(param, list(key)) == list(body20)
    return {
        "mid": mid.hex(),
        "body20": body20.hex(),
        "eor": bytes(eor).hex(),
        "param": bytes(param).hex(),
        "key": key.hex(),
        "cascade_ok": ok,
        "kh": kh,
        "stub4": data4.hex(),
        "url4": md5(q.encode())[:4].hex(),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="emulator-5554")
    ap.add_argument("--trigger", type=int, default=4)
    ap.add_argument(
        "--url",
        default="https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/",
    )
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    jsonl = OUT / "gorgon_keydump.jsonl"
    last_path = OUT / "gorgon_keydump_last.json"

    bridge_dir = find_bridge_dir()
    pid = ensure_app(args.device)
    print(f"[+] attach pid={pid} device={args.device}")

    device = frida.get_device(args.device, timeout=5)
    session = device.attach(pid)
    events: List[dict] = []

    def on_msg(message, data):
        if message.get("type") == "send":
            payload = message.get("payload")
            if isinstance(payload, dict):
                if payload.get("type") == "frida:load-bridge":
                    name = payload.get("name") or "Java"
                    # resolve bridge file
                    matches = list(bridge_dir.glob(f"*{name.lower()}*")) or list(
                        bridge_dir.glob("*.js")
                    )
                    # frida 17 java bridge naming
                    for cand in [
                        bridge_dir / "java.js",
                        bridge_dir / "bridge.js",
                        *matches,
                    ]:
                        if cand.is_file() and "java" in cand.name.lower():
                            script.post(
                                {
                                    "type": "frida:bridge-loaded",
                                    "filename": cand.name,
                                    "source": cand.read_text(encoding="utf-8"),
                                }
                            )
                            return
                    # fallback first js
                    for cand in bridge_dir.glob("*.js"):
                        script.post(
                            {
                                "type": "frida:bridge-loaded",
                                "filename": cand.name,
                                "source": cand.read_text(encoding="utf-8"),
                            }
                        )
                        return
                events.append(payload)
                with jsonl.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(payload, ensure_ascii=False) + "\n")
                t = payload.get("type")
                if t == "log":
                    print("[log]", payload.get("m"))
                elif t == "gorgon_site":
                    g = payload.get("g") or {}
                    print(
                        f"[gorgon_site] mid={g.get('mid')} body20={str(g.get('body20'))[:24]}… "
                        f"mem_hits={len(payload.get('body20_mem') or [])}"
                    )
                elif t == "f3_sign":
                    print("[f3]", (payload.get("gorgon") or "")[:40], "kh", payload.get("khronos"))
                elif t == "err":
                    print("[err]", payload.get("e"))
        elif message.get("type") == "error":
            print("[frida-error]", message)

    source = BOOT + "\n" + JS.read_text(encoding="utf-8")
    script = session.create_script(source)
    script.on("message", on_msg)
    script.load()
    time.sleep(1.5)
    try:
        print("[+] ping", script.exports_sync.ping())
        script.exports_sync.install()
    except Exception as e:
        print("[!] install", e)

    # Prefer ttnet_signer path: exec sign via existing agent patterns
    # Use simple Java trigger
    body = json.dumps({"series_id": "7668349899590618136"}, separators=(",", ":")).encode()
    stub = hashlib.md5(body).hexdigest().upper()
    analyses = []
    for i in range(args.trigger):
        ticket = str(int(time.time() * 1000))
        # full_url ideally from app; use short + let app expand if method does
        url = args.url
        print(f"\n=== trigger {i} stub={stub[:8]}… ticket={ticket} ===")
        try:
            r = script.exports_sync.trigger_sign(url, stub, ticket)
            print("trigger ->", {k: r.get(k) for k in ("ok", "error", "method") if k in r or True})
            headers = (r or {}).get("headers") or {}
            g = headers.get("X-Gorgon") or headers.get("x-gorgon")
            kh = headers.get("X-Khronos")
            if g and kh:
                # try get fuller url from headers context — may only have short
                an = analyze_sample(url if "?" in url else url + "?aid=8662", stub, int(kh), g)
                an["i"] = i
                an["gorgon"] = g.lower()
                an["headers"] = headers
                analyses.append(an)
                print("  analysis mid", an["mid"], "key", an["key"][:32] + "…")
        except Exception as e:
            print("trigger err", e)
        time.sleep(0.8)

    # Also pull last site dump
    try:
        last = script.exports_sync.last()
    except Exception:
        last = None

    summary = {
        "analyses": analyses,
        "events_n": len(events),
        "site_events": [e for e in events if e.get("type") == "gorgon_site"],
        "f3_events": [e for e in events if e.get("type") == "f3_sign"],
        "last": last,
        "note": "key=eor^param under classic layout; same mid => same key (if param non-mid parts correct)",
    }
    last_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[+] wrote {last_path} site_events={len(summary['site_events'])}")

    # Cross mid key map
    by_mid = {}
    for a in analyses:
        by_mid[a["mid"]] = a["key"]
    print("[+] unique mids", len(by_mid))
    for m, k in list(by_mid.items())[:8]:
        print(f"    {m} -> {k}")

    session.detach()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Trace MetaSec ms.bd.c.f3.a during sign; dump samples for offline reverse."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import frida

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / ".venv/lib/python3.14/site-packages/frida_tools/bridges"
AGENT = Path(__file__).with_name("frida_metasec_f3.js")
OUT_DIR = ROOT / "python" / "sign_samples"

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


def main() -> int:
    device_id = sys.argv[1] if len(sys.argv) > 1 else "emulator-5554"
    try:
        pid = int(
            subprocess.check_output(
                ["adb", "-s", device_id, "shell", "pidof", "com.phoenix.read"],
                text=True,
            )
            .strip()
            .split()[0]
        )
    except Exception:
        print("app not running", file=sys.stderr)
        return 2

    print("pid", pid, flush=True)
    device = frida.get_device(device_id)
    session = device.attach(pid)
    script = session.create_script(BOOT + "\n" + AGENT.read_text(encoding="utf-8"))
    events: list[dict] = []

    def on_msg(msg, data):
        if msg.get("type") != "send":
            print("MSG", str(msg)[:300], flush=True)
            return
        p = msg.get("payload")
        if not isinstance(p, dict):
            return
        if p.get("type") == "frida:load-bridge":
            stem = str(p.get("name", "")).lower()
            bridge = next(BRIDGE.glob(stem + ".js"))
            script.post(
                {
                    "type": "frida:bridge-loaded",
                    "filename": bridge.name,
                    "source": bridge.read_text(encoding="utf-8"),
                }
            )
            return
        events.append(p)
        t = p.get("type")
        if t == "log":
            print("[log]", p.get("m"), flush=True)
        elif t == "f3":
            # compact line
            print(
                f"f3 a=0x{p.get('a',0):x} b={p.get('b')} c={p.get('c')} d={str(p.get('d'))[:80]}",
                flush=True,
            )
            print(f"   e={json.dumps(p.get('e'), ensure_ascii=False)[:300]}", flush=True)
            print(f"   ret={json.dumps(p.get('ret'), ensure_ascii=False)[:400]}", flush=True)

    script.on("message", on_msg)
    script.load()
    time.sleep(1)
    print("ping", script.exports_sync.ping(), flush=True)

    bodies = [
        b'{"series_id":"7610708001174850584"}',
        b'{"series_id":"7610708001174850584","x":1}',
        b'{"video_id":"7610710952442350654","content_type":1}',
    ]
    samples = []
    for body in bodies:
        stub = hashlib.md5(body).hexdigest().upper()
        ticket = str(int(time.time() * 1000))
        # simple stable url for RE
        url = (
            "https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/"
            f"?aid=8662&device_id=674438832718729&iid=674438832722825&_rticket={ticket}"
        )
        before = len([e for e in events if e.get("type") == "f3"])
        res = script.exports_sync.sign(url, stub, ticket)
        time.sleep(0.3)
        after = [e for e in events if e.get("type") == "f3"][before:]
        samples.append(
            {
                "body": body.decode(),
                "stub": stub,
                "ticket": ticket,
                "url": url,
                "headers": res.get("headers"),
                "error": res.get("error"),
                "f3_calls": after,
            }
        )
        print("headers", list((res.get("headers") or {}).keys()), flush=True)
        time.sleep(0.5)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "f3_trace.json"
    out.write_text(json.dumps(samples, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved", out, "samples", len(samples), flush=True)
    # summary of opcodes
    opcodes = {}
    for s in samples:
        for c in s.get("f3_calls") or []:
            key = (c.get("a"), c.get("d") if isinstance(c.get("d"), str) and len(c.get("d") or "") < 20 else "url/long")
            opcodes[str(key)] = opcodes.get(str(key), 0) + 1
    print("opcode stats", opcodes, flush=True)
    session.detach()
    return 0


if __name__ == "__main__":
    # ensure python path
    sys.path.insert(0, str(ROOT / "python"))
    raise SystemExit(main())

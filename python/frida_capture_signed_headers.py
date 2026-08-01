#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Attach App, hook Cronet native header adds, dump signed headers while App traffic runs."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import frida

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / ".venv/lib/python3.14/site-packages/frida_tools/bridges"
AGENT = Path(__file__).with_name("frida_capture_signed_headers.js")
PKG = "com.phoenix.read"
DEVICE = "emulator-5554"

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


def resolve_pid() -> int:
    out = subprocess.check_output(
        ["adb", "-s", DEVICE, "shell", "pidof", PKG], text=True
    ).strip()
    return int(out.split()[0])


def main() -> int:
    wait = int(sys.argv[1]) if len(sys.argv) > 1 else 35
    pid = resolve_pid()
    print("pid", pid, flush=True)
    device = frida.get_device(DEVICE)
    session = device.attach(pid)
    script = session.create_script(BOOT + "\n" + AGENT.read_text(encoding="utf-8"))
    seen = []

    def on_msg(msg, data):
        if msg.get("type") != "send":
            print("MSG", msg, flush=True)
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
        if p.get("type") == "log":
            print("[log]", p.get("m"), flush=True)
            return
        print(json.dumps(p, ensure_ascii=False)[:800], flush=True)
        seen.append(p)

    script.on("message", on_msg)
    script.load()
    time.sleep(2)
    print("ping", script.exports_sync.ping(), flush=True)
    try:
        apis = script.exports_sync.list_player_api()
        print("player api dump count", len(apis), flush=True)
        for line in apis[:60]:
            print(" ", line[:220], flush=True)
    except Exception as e:
        print("listPlayerApi fail", e, flush=True)

    print(f"waiting {wait}s for traffic (swipe UI)...", flush=True)
    # generate some UI network
    for _ in range(3):
        subprocess.call(
            ["adb", "-s", DEVICE, "shell", "input", "swipe", "500", "1600", "500", "400", "250"]
        )
        time.sleep(2)
        subprocess.call(["adb", "-s", DEVICE, "shell", "input", "tap", "540", "1200"])
        time.sleep(3)

    time.sleep(max(0, wait - 15))
    out = Path("/tmp/hg_signed_headers_cap.json")
    out.write_text(json.dumps(seen, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved", out, "events", len(seen), flush=True)
    # summary of header names seen
    names = set()
    for e in seen:
        if e.get("type") in ("hdr", "nathdr", "tt_hdr"):
            names.add(e.get("n"))
        if e.get("type") in ("sec_in", "sec_out") and isinstance(e.get("headers"), dict):
            names.update(e["headers"].keys())
    print("header names seen:", sorted(str(x) for x in names if x), flush=True)
    session.detach()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

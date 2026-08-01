#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Attach to 红果 App, call MetaSec MSManager.frameSign, optionally smoke-test API.

Usage:
  .venv/bin/python python/frida_framesign_host.py
  .venv/bin/python python/frida_framesign_host.py --sign-only
  .venv/bin/python python/frida_framesign_host.py --series-id 7610708001174850584
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import frida

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from api_client import DEFAULT_DEVICE, USER_AGENT  # noqa: E402

BRIDGE_DIR = ROOT / ".venv/lib/python3.14/site-packages/frida_tools/bridges"
AGENT_PATH = Path(__file__).with_name("frida_framesign.js")
PKG = "com.phoenix.read"
DEVICE_ID = "emulator-5554"


def install_bridge_loader() -> str:
    return r"""
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


def make_message_handler(script):
    def on_msg(msg, data):
        if msg.get("type") != "send":
            print("MSG", msg, flush=True)
            return
        p = msg.get("payload")
        if not isinstance(p, dict):
            print("PAYLOAD", p, flush=True)
            return
        t = p.get("type")
        if t == "frida:load-bridge":
            stem = str(p.get("name", "")).lower()
            bridge = next(BRIDGE_DIR.glob(stem + ".js"))
            print(f"[bridge] load {bridge.name}", flush=True)
            script.post(
                {
                    "type": "frida:bridge-loaded",
                    "filename": bridge.name,
                    "source": bridge.read_text(encoding="utf-8"),
                }
            )
            return
        if t == "log":
            print(f"[log] {p.get('m')}", flush=True)
            return
        if t == "aids":
            print(f"[aids] {p.get('aids')}", flush=True)
            return
        if t == "frameSign_hook":
            print(
                f"[hook frameSign] flag={p.get('flag')} url={str(p.get('url'))[:120]}",
                flush=True,
            )
            print(f"  headers={json.dumps(p.get('headers'), ensure_ascii=False)[:400]}", flush=True)
            return
        if t == "hdr":
            print(f"[hdr] {p.get('name')}={str(p.get('value'))[:160]}", flush=True)
            return
        print(f"[send] {json.dumps(p, ensure_ascii=False)[:500]}", flush=True)

    return on_msg


def build_sign_url(path: str, query: dict, *, full: bool = False, host: str | None = None) -> str:
    qs = urllib.parse.urlencode(query)
    if full:
        h = host or "api5-normal-sinfonlinea.fqnovel.com"
        return f"https://{h}{path}?{qs}"
    return f"{path}?{qs}"


def merge_sign_headers(base: dict, signed: dict) -> dict:
    out = dict(base)
    for k, v in (signed or {}).items():
        if not k or str(k).startswith("__"):
            continue
        out[str(k)] = str(v)
    return out


def try_request(url: str, body: bytes, headers: dict) -> str:
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        return f"HTTP {e.code}: {raw[:500]}"
    except Exception as e:
        return f"ERR {type(e).__name__}: {e}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--series-id", default="7610708001174850584")
    ap.add_argument("--sign-only", action="store_true")
    ap.add_argument("--device", default=DEVICE_ID)
    ap.add_argument("--pid", type=int, default=0)
    ap.add_argument("--aid", default="")
    ap.add_argument("--wait", type=float, default=2.0)
    args = ap.parse_args()

    if not BRIDGE_DIR.is_dir():
        print(f"missing bridge dir: {BRIDGE_DIR}", file=sys.stderr)
        return 2
    agent = AGENT_PATH.read_text(encoding="utf-8")
    source = install_bridge_loader() + "\n" + agent

    import subprocess

    device = frida.get_device(args.device)

    def resolve_pid() -> int:
        if args.pid:
            return int(args.pid)
        # adb pidof is reliable; Frida process.name is often the Chinese label
        try:
            out = subprocess.check_output(
                ["adb", "-s", args.device, "shell", "pidof", PKG],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
            if out:
                return int(out.split()[0])
        except Exception:
            pass
        for p in device.enumerate_processes():
            n = p.name or ""
            if (
                n == PKG
                or "phoenix" in n.lower()
                or "红果" in n
                or n.endswith(".read")
            ):
                return int(p.pid)
        for a in device.enumerate_applications():
            if a.identifier == PKG and a.pid:
                return int(a.pid)
        return 0

    pid = resolve_pid()
    if not pid:
        print("App not running; launching...", flush=True)
        subprocess.check_call(
            [
                "adb",
                "-s",
                args.device,
                "shell",
                "monkey",
                "-p",
                PKG,
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
            ]
        )
        for _ in range(40):
            time.sleep(1)
            pid = resolve_pid()
            if pid:
                break
    if not pid:
        print("failed to find app pid", file=sys.stderr)
        return 3

    print(f"attach pid={pid}", flush=True)
    session = device.attach(pid)
    script = session.create_script(source)
    script.on("message", make_message_handler(script))
    script.load()
    time.sleep(args.wait)

    exp = script.exports_sync
    print("ping", exp.ping(), flush=True)
    print("versionInfo", exp.version_info(), flush=True)
    aids = exp.list_aids()
    print("aids", aids, flush=True)
    aid = args.aid or (aids[0] if isinstance(aids, list) and aids else "8662")
    print("using aid", aid, flush=True)
    print("token", exp.get_token(aid), flush=True)

    q = dict(DEFAULT_DEVICE)
    q["device_id"] = "674438832718729"
    q["iid"] = "674438832722825"
    # App often adds these
    q.setdefault("_rticket", str(int(time.time() * 1000)))
    q.setdefault("ts", str(int(time.time())))

    path = "/novel/player/video_detail/v1/"
    body_obj = {"series_id": str(args.series_id)}
    body = json.dumps(body_obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    stub = hashlib.md5(body).hexdigest().upper()
    print("body md5(x-ss-stub)", stub, flush=True)

    candidates = []
    # Common TTNet sign input shapes
    candidates.append(("path_query", build_sign_url(path, q, full=False)))
    candidates.append(("full_url", build_sign_url(path, q, full=True)))
    candidates.append(("path_only", path))
    # Some stacks append stub into the sign string
    candidates.append(("path_query_stub", build_sign_url(path, q, full=False) + stub))
    candidates.append(
        (
            "path_query_xstub",
            build_sign_url(path, q, full=False) + f"&x-ss-stub={stub}",
        )
    )

    signed_samples = []
    for flag in (0, 1, 2):
        for name, url in candidates:
            res = exp.frame_sign(aid, url, flag)
            keys = list(res.keys()) if isinstance(res, dict) else []
            print(
                f"frameSign flag={flag} {name} keys={keys} sample={json.dumps(res, ensure_ascii=False)[:280]}",
                flush=True,
            )
            signed_samples.append((flag, name, url, res))

    if args.sign_only:
        session.detach()
        return 0

    # Smoke: try each non-error signed header set against video_detail
    host = "api5-normal-sinfonlinea.fqnovel.com"
    base_headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
        "x-ss-stub": stub,
    }
    request_url = f"https://{host}{path}?{urllib.parse.urlencode(q)}"

    best = None
    for flag, name, sign_url, res in signed_samples:
        if not isinstance(res, dict) or res.get("error"):
            continue
        # skip empty maps
        real = {k: v for k, v in res.items() if not str(k).startswith("__")}
        if not real:
            continue
        headers = merge_sign_headers(base_headers, real)
        print(f"\n=== try API with sign {name} flag={flag} headers={list(headers.keys())}", flush=True)
        raw = try_request(request_url, body, headers)
        print("RESP", raw[:400], flush=True)
        if '"code":0' in raw or '"Code":0' in raw or (
            "video_list" in raw and "110001" not in raw
        ):
            best = (name, flag, raw)
            break
        if "110001" not in raw and "ERR" not in raw[:20]:
            best = (name, flag, raw)

    if best:
        print(f"\nBEST {best[0]} flag={best[1]}", flush=True)
    else:
        print("\nNo successful signed response yet", flush=True)

    # keep hooks briefly in case App itself fires requests
    print("waiting 8s for live App hooks...", flush=True)
    time.sleep(8)
    session.detach()
    return 0 if best else 1


if __name__ == "__main__":
    raise SystemExit(main())

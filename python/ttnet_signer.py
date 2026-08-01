#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TTNet security-factor signer for 红果 (aid=8662).

App-identical signing path (verified 2026-08-01):

  1) NetworkParams.addCommonParams(url, true)  → full query string
  2) body MD5 uppercase → x-ss-stub
  3) com.dragon.read.base.http.b
       .onCallToAddSecurityFactor(fullUrl, {x-ss-stub, x-ss-req-ticket})
     → Map of X-Gorgon / X-Argus / X-Ladon / X-Khronos / X-Helios / X-Medusa
  4) Host HTTP POST with those headers succeeds on video_detail / video_model

Offline pure algorithm (no Frida) is still being reverse-engineered; this module
uses a live App process via Frida as the oracle (same code path as the App).

Usage:
  with TtnetDeviceSigner(device_id='emulator-5554') as s:
      data = s.post_json(
          'https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/',
          {'series_id': '...'},
      )
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

import frida

PKG = "com.phoenix.read"
ROOT = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT / ".venv/lib/python3.14/site-packages/frida_tools/bridges"

USER_AGENT = (
    "com.phoenix.read/72732 (Linux; U; Android 14; zh_CN; "
    "sdk_gphone64_arm64; Build/UE1A.230829.036;tt-ok/10.0.0.1)"
)

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

AGENT = r"""
function mapObj(m) {
  var o = {};
  if (!m) return o;
  try {
    var Map = Java.use('java.util.Map');
    var jm = Java.cast(m, Map);
    var ks = jm.keySet().toArray();
    for (var i = 0; i < ks.length; i++) {
      o[String(ks[i])] = String(jm.get(ks[i]));
    }
  } catch (e) {
    o.__e = String(e);
  }
  return o;
}

function getAdapter() {
  var adapters = [];
  try {
    Java.choose('com.dragon.read.base.http.b', {
      onMatch: function (inst) { adapters.push(inst); },
      onComplete: function () {}
    });
  } catch (e) {}
  if (!adapters.length) {
    try {
      Java.choose('com.bytedance.ttnet.cronet.AbsCronetDependAdapter', {
        onMatch: function (inst) { adapters.push(inst); },
        onComplete: function () {}
      });
    } catch (e) {}
  }
  return adapters.length ? adapters[0] : null;
}

rpc.exports = {
  ping: function () { return 'pong'; },
  ready: function () {
    var ok = false, err = null, cls = null;
    Java.performNow(function () {
      try {
        Java.use('com.bytedance.frameworks.baselib.network.http.NetworkParams');
        var a = getAdapter();
        if (!a) { err = 'no_adapter'; return; }
        cls = String(a.getClass().getName());
        ok = true;
      } catch (e) { err = String(e); }
    });
    return err ? { ok: false, error: err } : { ok: true, adapter: cls };
  },
  fullUrl: function (base) {
    var out = null, err = null;
    Java.performNow(function () {
      try {
        var NP = Java.use('com.bytedance.frameworks.baselib.network.http.NetworkParams');
        out = String(NP.addCommonParams(String(base), true));
      } catch (e) { err = String(e); }
    });
    return err ? { error: err } : { url: out };
  },
  // App-identical security factor headers
  signHeaders: function (url, stub, ticket) {
    var out = {};
    Java.performNow(function () {
      try {
        var HashMap = Java.use('java.util.HashMap');
        var hm = HashMap.$new();
        if (stub) hm.put('x-ss-stub', String(stub));
        if (ticket) hm.put('x-ss-req-ticket', String(ticket));
        var a = getAdapter();
        if (!a) { out.error = 'no_adapter'; return; }
        var ret = a.onCallToAddSecurityFactor(String(url), hm);
        out.headers = mapObj(ret);
        out.adapter = String(a.getClass().getName());
      } catch (e) {
        out.error = String(e);
      }
    });
    return out;
  },
  // Fallback: full App stack POST (always works when App online)
  execPost: function (url, body, maxBytes) {
    var out = {};
    Java.performNow(function () {
      try {
        var NU = Java.use('com.ss.android.common.util.NetworkUtils');
        var CT = Java.use('com.bytedance.common.utility.NetworkUtils$CompressType');
        var bytes = Java.use('java.lang.String').$new(String(body)).getBytes('UTF-8');
        var lim = maxBytes | 0; if (lim <= 0) lim = 64 * 1024 * 1024;
        var resp = NU.executePost(lim, String(url), bytes, CT.NONE.value, 'application/json; charset=utf-8');
        out.ok = true;
        out.resp = String(resp);
      } catch (e) {
        out.ok = false;
        out.error = String(e);
      }
    });
    return out;
  }
};
setTimeout(function () {
  Java.perform(function () { send({ type: 'log', m: 'ttnet_signer ready' }); });
}, 200);
"""


class TtnetSignerError(RuntimeError):
    pass


class TtnetDeviceSigner:
    """Frida-backed signer: produces App-identical TTNet security headers."""

    def __init__(
        self,
        *,
        device_id: str = "emulator-5554",
        package: str = PKG,
        wait_app_s: float = 30.0,
        prefer_headers: bool = True,
        timeout: float = 30.0,
    ):
        self.device_id = device_id
        self.package = package
        self.wait_app_s = wait_app_s
        self.prefer_headers = prefer_headers
        self.timeout = timeout
        self._device = None
        self._session = None
        self._script = None

    def _resolve_pid(self) -> int:
        try:
            out = subprocess.check_output(
                ["adb", "-s", self.device_id, "shell", "pidof", self.package],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
            if out:
                return int(out.split()[0])
        except Exception:
            pass
        return 0

    def ensure_app(self) -> int:
        pid = self._resolve_pid()
        if pid:
            return pid
        subprocess.check_call(
            [
                "adb",
                "-s",
                self.device_id,
                "shell",
                "monkey",
                "-p",
                self.package,
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + self.wait_app_s
        while time.time() < deadline:
            time.sleep(1.0)
            pid = self._resolve_pid()
            if pid:
                time.sleep(5.0)  # MetaSec / TTNet init
                return pid
        raise TtnetSignerError(f"app {self.package} not running on {self.device_id}")

    def attach(self, pid: Optional[int] = None) -> None:
        if not BRIDGE_DIR.is_dir():
            raise TtnetSignerError(f"frida Java bridge missing: {BRIDGE_DIR}")
        if pid is None:
            pid = self.ensure_app()
        self._device = frida.get_device(self.device_id)
        self._session = self._device.attach(int(pid))
        self._script = self._session.create_script(BOOT + "\n" + AGENT)

        def on_msg(msg, data):
            if msg.get("type") != "send":
                return
            p = msg.get("payload")
            if not isinstance(p, dict):
                return
            if p.get("type") == "frida:load-bridge":
                stem = str(p.get("name", "")).lower()
                bridge = next(BRIDGE_DIR.glob(stem + ".js"))
                self._script.post(
                    {
                        "type": "frida:bridge-loaded",
                        "filename": bridge.name,
                        "source": bridge.read_text(encoding="utf-8"),
                    }
                )

        self._script.on("message", on_msg)
        self._script.load()
        time.sleep(0.8)
        st = self._script.exports_sync.ready()
        if not st.get("ok"):
            raise TtnetSignerError(f"signer not ready: {st}")

    def detach(self) -> None:
        try:
            if self._session:
                self._session.detach()
        except Exception:
            pass
        self._session = None
        self._script = None
        self._device = None

    def __enter__(self) -> "TtnetDeviceSigner":
        self.attach()
        return self

    def __exit__(self, *exc) -> None:
        self.detach()

    def full_url(self, base: str) -> str:
        if not self._script:
            raise TtnetSignerError("not attached")
        # strip existing query then re-expand for consistency
        if "?" in base:
            base = base.split("?", 1)[0]
        r = self._script.exports_sync.full_url(base)
        if r.get("error"):
            raise TtnetSignerError(r["error"])
        return str(r["url"])

    def sign_headers(self, url: str, body: bytes) -> Dict[str, str]:
        """Return security headers for a POST body (App-identical)."""
        if not self._script:
            raise TtnetSignerError("not attached")
        stub = hashlib.md5(body).hexdigest().upper()
        ticket = str(int(time.time() * 1000))
        r = self._script.exports_sync.sign_headers(url, stub, ticket)
        if r.get("error"):
            raise TtnetSignerError(r["error"])
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
            "x-ss-stub": stub,
            "x-ss-req-ticket": ticket,
        }
        for k, v in (r.get("headers") or {}).items():
            if k and not str(k).startswith("__"):
                headers[str(k)] = str(v)
        return headers

    def post_json(
        self, base_url: str, payload: Dict[str, Any], *, max_bytes: int = 64 << 20
    ) -> Dict[str, Any]:
        if not self._script:
            raise TtnetSignerError("not attached")
        if "://" not in base_url:
            base_url = "https://api5-normal-sinfonlinea.fqnovel.com" + base_url
        bare = base_url.split("?", 1)[0]
        url = self.full_url(bare)
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

        if self.prefer_headers:
            try:
                headers = self.sign_headers(url, body)
                req = urllib.request.Request(url, data=body, method="POST", headers=headers)
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read().decode("utf-8", "replace")
                return json.loads(raw)
            except Exception:
                # fall through to execPost
                pass

        r = self._script.exports_sync.exec_post(url, body.decode("utf-8"), max_bytes)
        if not r.get("ok"):
            raise TtnetSignerError(r.get("error") or "exec_post failed")
        try:
            return json.loads(r.get("resp") or "")
        except Exception as e:
            raise TtnetSignerError(f"non-json: {e}: {(r.get('resp') or '')[:300]}") from e


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="TTNet signer smoke test")
    ap.add_argument("--device", default="emulator-5554")
    ap.add_argument("--series-id", default="7610708001174850584")
    args = ap.parse_args()
    with TtnetDeviceSigner(device_id=args.device) as s:
        data = s.post_json(
            "https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/",
            {"series_id": str(args.series_id)},
        )
        print("code", data.get("code"))
        vlist = ((data.get("data") or {}).get("video_data") or {}).get("video_list") or []
        print("episodes", len(vlist))
        if vlist:
            vid = str(vlist[0].get("vid"))
            m = s.post_json(
                "https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/",
                {
                    "video_id": vid,
                    "content_type": 1,
                    "biz_param": {"video_platform": 3, "need_all_video_definition": True},
                },
            )
            print("model code", m.get("code"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

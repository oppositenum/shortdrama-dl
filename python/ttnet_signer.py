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
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

import frida

PKG = "com.phoenix.read"
ROOT = Path(__file__).resolve().parents[1]


def resolve_bridge_dir() -> Optional[Path]:
    """定位 frida-tools 自带的 Java bridge 目录。

    绝不能写死路径：正式版的 venv 在应用用户数据目录（.../runtime/python），
    不在项目里；解释器小版本决定 lib/pythonX.Y，Windows 又是 Lib\\site-packages。
    写死其中任何一段，换台机器或换个 Python 版本就会以
    "frida Java bridge missing" 收场，而 frida-tools 其实装得好好的。
    正确做法是问包自己在哪。
    """
    env = os.environ.get("SHORTDRAMA_FRIDA_BRIDGES", "").strip()
    if env and Path(env).is_dir():
        return Path(env)
    try:
        import frida_tools  # noqa: WPS433  运行期才需要，import 失败走下面的兜底

        for base in frida_tools.__path__:
            cand = Path(base) / "bridges"
            if cand.is_dir():
                return cand
    except Exception:
        pass
    # 兜底：开发态项目内 venv，解释器版本和平台目录名都不写死。
    for pattern in (".venv/lib/*/site-packages/frida_tools/bridges",
                    ".venv/Lib/site-packages/frida_tools/bridges"):
        for cand in ROOT.glob(pattern):
            if cand.is_dir():
                return cand
    return None


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

/**
 * 在 ART 就绪后同步执行 fn。
 * 禁止在 VM 未起来时 Java.performNow —— 会 access violation @ 0x0。
 */
function withJavaSync(fn, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  try {
    if (typeof Java === 'undefined') {
      return { error: 'Java bridge undefined (loader not ready)' };
    }
  } catch (e0) {
    return { error: 'Java check: ' + e0 };
  }
  var box = { done: false, value: null };
  try {
    Java.perform(function () {
      try {
        box.value = fn() || {};
      } catch (e1) {
        box.value = { error: String(e1) };
      }
      box.done = true;
    });
  } catch (e2) {
    return { error: 'Java.perform: ' + e2 };
  }
  var t0 = Date.now();
  while (!box.done && (Date.now() - t0) < timeoutMs) {
    Thread.sleep(0.05);
  }
  if (!box.done) {
    return { error: 'java_perform_timeout' };
  }
  return box.value || {};
}

rpc.exports = {
  ping: function () { return 'pong'; },
  javaAvailable: function () {
    try {
      return { ok: typeof Java !== 'undefined' && !!Java.available, available: !!(typeof Java !== 'undefined' && Java.available) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  ready: function () {
    return withJavaSync(function () {
      // 先确认 ART
      try {
        if (!Java.available) {
          return { ok: false, error: 'Java.available=false' };
        }
      } catch (e) {
        return { ok: false, error: 'Java.available: ' + e };
      }
      try {
        Java.use('com.bytedance.frameworks.baselib.network.http.NetworkParams');
      } catch (e) {
        return { ok: false, error: 'NetworkParams missing: ' + e };
      }
      var a = getAdapter();
      if (!a) {
        return { ok: false, error: 'no_adapter (open 红果 App 并稍等 TTNet 初始化)' };
      }
      return { ok: true, adapter: String(a.getClass().getName()) };
    }, 20000);
  },
  fullUrl: function (base) {
    return withJavaSync(function () {
      try {
        var NP = Java.use('com.bytedance.frameworks.baselib.network.http.NetworkParams');
        return { url: String(NP.addCommonParams(String(base), true)) };
      } catch (e) {
        return { error: String(e) };
      }
    });
  },
  signHeaders: function (url, stub, ticket) {
    return withJavaSync(function () {
      try {
        var HashMap = Java.use('java.util.HashMap');
        var hm = HashMap.$new();
        if (stub) hm.put('x-ss-stub', String(stub));
        if (ticket) hm.put('x-ss-req-ticket', String(ticket));
        var a = getAdapter();
        if (!a) return { error: 'no_adapter' };
        var ret = a.onCallToAddSecurityFactor(String(url), hm);
        return {
          headers: mapObj(ret),
          adapter: String(a.getClass().getName())
        };
      } catch (e) {
        return { error: String(e) };
      }
    }, 30000);
  },
  execPost: function (url, body, maxBytes) {
    return withJavaSync(function () {
      try {
        var NU = Java.use('com.ss.android.common.util.NetworkUtils');
        var CT = Java.use('com.bytedance.common.utility.NetworkUtils$CompressType');
        var bytes = Java.use('java.lang.String').$new(String(body)).getBytes('UTF-8');
        var lim = maxBytes | 0; if (lim <= 0) lim = 64 * 1024 * 1024;
        var resp = NU.executePost(lim, String(url), bytes, CT.NONE.value, 'application/json; charset=utf-8');
        return { ok: true, resp: String(resp) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, 60000);
  }
};
setTimeout(function () {
  try {
    Java.perform(function () {
      send({ type: 'log', m: 'ttnet_signer java_ok' });
    });
  } catch (e) {
    send({ type: 'log', m: 'ttnet_signer java_defer: ' + e });
  }
}, 500);
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

    def _adb(self, *args: str, check: bool = False, timeout: float = 20.0) -> str:
        cmd = ["adb", "-s", self.device_id, *args]
        try:
            out = subprocess.check_output(
                cmd, text=True, stderr=subprocess.DEVNULL, timeout=timeout
            )
            return (out or "").strip()
        except Exception:
            if check:
                raise
            return ""

    def _resolve_pid(self) -> int:
        out = self._adb("shell", "pidof", self.package)
        if out:
            try:
                return int(out.split()[0])
            except ValueError:
                return 0
        return 0

    def ensure_frida_server(self) -> None:
        """确保设备上 frida-server 在跑（不存在则尝试启动已推送的二进制）。"""
        if self._adb("shell", "pidof", "frida-server"):
            return
        # 常见路径；失败不致命，attach 时再报错
        self._adb("root")
        time.sleep(0.8)
        for path in (
            "/data/local/tmp/frida-server",
            "/data/local/tmp/frida-server-16",
        ):
            # 后台启动
            subprocess.Popen(
                [
                    "adb",
                    "-s",
                    self.device_id,
                    "shell",
                    f"nohup {path} -D >/dev/null 2>&1 &",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(1.2)
            if self._adb("shell", "pidof", "frida-server"):
                return

    def ensure_app(self) -> int:
        """启动/唤醒红果，并给 TTNet/MetaSec 一点初始化时间。"""
        had_pid = self._resolve_pid() > 0
        # 即使已在跑也 monkey 一下，避免进程僵死 / 未进前台导致 adapter 为空
        subprocess.call(
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
                # 冷启动等久一点，热启动也至少 2s 让 Java/TTNet 稳定
                time.sleep(2.0 if had_pid else 5.0)
                return pid
        raise TtnetSignerError(
            f"app {self.package} not running on {self.device_id}（请先打开红果）"
        )

    def _get_frida_device(self):
        """按 device_id 解析 Frida device（兼容 emulator 序列号）。"""
        try:
            return frida.get_device(self.device_id, timeout=5)
        except Exception:
            pass
        for d in frida.get_device_manager().enumerate_devices():
            if d.id == self.device_id:
                return d
            if self.device_id in (d.id or "") or self.device_id in (d.name or ""):
                return d
        try:
            return frida.get_usb_device(timeout=5)
        except Exception as e:
            raise TtnetSignerError(
                f"找不到 Frida 设备 {self.device_id}（frida-server 未跑？）: {e}"
            ) from e

    def attach(self, pid: Optional[int] = None) -> None:
        bridge_dir = resolve_bridge_dir()
        if bridge_dir is None:
            raise TtnetSignerError(
                "找不到 frida-tools 的 Java bridge（需要 pip install frida-tools，"
                "或用 SHORTDRAMA_FRIDA_BRIDGES 指向 frida_tools/bridges 目录）"
            )
        self.ensure_frida_server()
        if pid is None:
            pid = self.ensure_app()
        else:
            # 调用方给了 pid 也稍等，避免 attach 过早
            time.sleep(1.0)

        last_err: Optional[Exception] = None
        for attempt in range(1, 4):
            try:
                self.detach()
                self._device = self._get_frida_device()
                self._session = self._device.attach(int(pid))
                self._script = self._session.create_script(BOOT + "\n" + AGENT)
                bridge_dir_local = bridge_dir

                def on_msg(msg, data):
                    if msg.get("type") != "send":
                        return
                    p = msg.get("payload")
                    if not isinstance(p, dict):
                        return
                    if p.get("type") == "frida:load-bridge":
                        stem = str(p.get("name", "")).lower()
                        matches = list(bridge_dir_local.glob(stem + ".js"))
                        if not matches:
                            return
                        bridge = matches[0]
                        self._script.post(
                            {
                                "type": "frida:bridge-loaded",
                                "filename": bridge.name,
                                "source": bridge.read_text(encoding="utf-8"),
                            }
                        )

                self._script.on("message", on_msg)
                self._script.load()

                # 等 Java bridge + ART：access violation 0x0 多半是 performNow 太早
                st = None
                for _ in range(20):
                    time.sleep(0.5)
                    try:
                        # ping 先确认 RPC
                        self._script.exports_sync.ping()
                    except Exception as e:
                        last_err = e
                        continue
                    try:
                        ja = self._script.exports_sync.java_available()
                        if not ja.get("ok") and not ja.get("available"):
                            last_err = TtnetSignerError(f"java not ready: {ja}")
                            continue
                    except Exception as e:
                        last_err = e
                        continue
                    try:
                        st = self._script.exports_sync.ready()
                    except Exception as e:
                        # 典型：access violation accessing 0x0
                        last_err = e
                        st = {"ok": False, "error": str(e)}
                        continue
                    if st.get("ok"):
                        return
                    last_err = TtnetSignerError(f"signer not ready: {st}")
                # 本轮失败：可能 pid 变了，刷新 app
                pid = self.ensure_app()
                last_err = last_err or TtnetSignerError("signer not ready")
            except Exception as e:
                last_err = e
                time.sleep(1.0 * attempt)
                pid = self._resolve_pid() or self.ensure_app()
        raise TtnetSignerError(
            f"挂载 App 签名失败（已重试）: {last_err}"
        ) from last_err

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

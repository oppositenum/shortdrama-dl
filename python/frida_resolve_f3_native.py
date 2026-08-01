#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Resolve native address of ms.bd.c.f3.a and capture 0x3000001 I/O."""
from __future__ import annotations

import hashlib
import json
import struct
import subprocess
import sys
import time
from pathlib import Path

import frida

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / ".venv/lib/python3.14/site-packages/frida_tools/bridges"
OUT = ROOT / "python" / "sign_samples"
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

AGENT = r"""
function L(m){ send({type:'log', m:String(m)}); }

function jstringToC(env, jstr) {
  if (jstr.isNull()) return null;
  var GetStringUTFChars = new NativeFunction(
    env.getHandle().readPointer().add(Process.pointerSize * 169).readPointer(), // wrong - use env API
    'pointer', ['pointer','pointer','pointer']
  );
}

function dumpJObject(env, obj) {
  // via Java layer only
}

function arrFromJava(o) {
  if (o === null || o === undefined) return null;
  try {
    var cls = o.getClass().getName();
    if (cls === 'java.lang.String') return {t:'str', v:String(o)};
    if (cls === '[B') {
      var ba = Java.array('byte', o);
      var hex = [];
      for (var i = 0; i < ba.length; i++) hex.push(('0' + ((ba[i] + 256) % 256).toString(16)).slice(-2));
      return {t:'bytes', len: ba.length, hex: hex.join('')};
    }
    if (cls === '[Ljava.lang.String;') {
      var a = Java.cast(o, Java.use('[Ljava.lang.String;'));
      var out = [];
      for (var i = 0; i < a.length; i++) out.push(a[i] === null ? null : String(a[i]));
      return {t:'str[]', len: a.length, v: out};
    }
    // generic: try .length
    try {
      var n = o.length;
      var out = [];
      for (var i = 0; i < n; i++) {
        var x = o[i];
        out.push(x === null ? null : String(x));
      }
      return {t:'arr', len: n, v: out, cls: cls};
    } catch (e1) {}
    return {t:'obj', cls: cls, s: String(o).slice(0, 200)};
  } catch (e) {
    return {t:'err', e: String(e)};
  }
}

function dumpMap(m) {
  var o = {};
  if (m == null) return o;
  var Map = Java.use('java.util.Map');
  var jm = Java.cast(m, Map);
  var keys = jm.keySet().toArray();
  for (var i = 0; i < keys.length; i++) {
    var k = String(keys[i]);
    var v = jm.get(keys[i]);
    try {
      var List = Java.use('java.util.List');
      var lst = Java.cast(v, List);
      var arr = [];
      for (var j = 0; j < lst.size(); j++) arr.push(String(lst.get(j)));
      o[k] = arr;
    } catch (ex) {
      o[k] = v == null ? null : String(v);
    }
  }
  return o;
}

function resolveArtMethodNative(methodObj) {
  // methodObj: java.lang.reflect.Method
  var info = { ok: false };
  try {
    var Executable = Java.use('java.lang.reflect.Executable');
    var artField = null;
    var fields = Executable.class.getDeclaredFields();
    for (var i = 0; i < fields.length; i++) {
      var n = String(fields[i].getName());
      if (n === 'artMethod' || n === 'artMethodPtr') {
        artField = fields[i];
        break;
      }
    }
    if (artField == null) {
      // try Method class
      fields = methodObj.getClass().getDeclaredFields();
      for (var i = 0; i < fields.length; i++) {
        var n = String(fields[i].getName());
        info['mf_' + n] = 1;
        if (n.toLowerCase().indexOf('art') >= 0) artField = fields[i];
      }
    }
    if (artField == null) {
      info.err = 'no artMethod field';
      return info;
    }
    artField.setAccessible(true);
    var artLong = artField.getLong(methodObj);
    info.artMethod = '0x' + artLong.toString(16);
    var artPtr = ptr(artLong);

    // Probe entry points at common offsets (pointer-sized fields)
    // Android ART ArtMethod: several pointers after declaring_class etc.
    var probes = [];
    for (var off = 0; off <= 0x40; off += Process.pointerSize) {
      try {
        var p = artPtr.add(off).readPointer();
        var mod = Process.findModuleByAddress(p);
        probes.push({
          off: off,
          ptr: p.toString(),
          mod: mod ? mod.name : null,
          in_metasec: mod ? mod.name.indexOf('metasec') >= 0 : false,
        });
      } catch (e) {}
    }
    info.probes = probes;
    // Prefer metasec module pointer that is not JNI_OnLoad
    for (var i = 0; i < probes.length; i++) {
      if (probes[i].in_metasec) {
        info.candidate = probes[i];
        info.ok = true;
      }
    }
  } catch (e) {
    info.err = String(e);
  }
  return info;
}

Java.perform(function () {
  L('java ready');
  var mod = Process.findModuleByName('libmetasec_ml.so');
  if (mod) L('metasec base=' + mod.base + ' size=' + mod.size);
  else L('metasec not loaded');

  // Resolve Method for f3.a
  try {
    var f3cls = Java.use('ms.bd.c.f3').class;
    var methods = f3cls.getDeclaredMethods();
    var target = null;
    for (var i = 0; i < methods.length; i++) {
      if (String(methods[i].getName()) === 'a' && (methods[i].getModifiers() & 256) !== 0) {
        target = methods[i];
        break;
      }
    }
    if (target) {
      L('found native Method ' + target);
      var res = resolveArtMethodNative(target);
      send({ type: 'art', res: res });
    } else {
      L('native Method not found');
    }
  } catch (e) {
    L('resolve ' + e);
  }

  // Hook f3.a at Java level with better array dump
  var f3 = Java.use('ms.bd.c.f3');
  f3.a.overload('int', 'int', 'long', 'java.lang.String', 'java.lang.Object').implementation = function (a, b, c, d, e) {
    var eDump = arrFromJava(e);
    var ret = this.a(a, b, c, d, e);
    var rDump = arrFromJava(ret);
    // if String return
    try {
      if (ret !== null && ret.getClass().getName() === 'java.lang.String') {
        rDump = { t: 'str', v: String(ret) };
      }
    } catch (ex) {}
    send({
      type: 'f3',
      a: a | 0,
      b: b | 0,
      c: String(c),
      d: d == null ? null : String(d).slice(0, 400),
      e: eDump,
      ret: rDump,
    });
    return ret;
  };
  L('hooked f3.a');

  // If we have a metasec candidate, also attach Interceptor
  rpc.exports = {
    ping: function () { return 'pong'; },
    tryAdd: function (url, stub, ticket) {
      var out = {};
      Java.performNow(function () {
        try {
          var HashMap = Java.use('java.util.HashMap');
          var ArrayList = Java.use('java.util.ArrayList');
          var hm = HashMap.$new();
          function put(k, v) {
            var l = ArrayList.$new();
            l.add(String(v));
            hm.put(String(k), l);
          }
          put('x-ss-stub', stub);
          put('x-ss-req-ticket', ticket);
          out.in = dumpMap(hm);
          var ret = Java.use('com.bytedance.frameworks.baselib.network.http.NetworkParams').tryAddSecurityFactor(String(url), hm);
          out.out = dumpMap(ret);
          // z4 handle
          try {
            var y = null;
            Java.choose('ms.bd.c.y4', {
              onMatch: function (i) { y = i; },
              onComplete: function () {},
            });
            if (y) {
              out.z4_handle = String(y.a.value.a.value);
            }
          } catch (e) {
            out.z4e = String(e);
          }
        } catch (e) {
          out.error = String(e);
        }
      });
      return out;
    },
    attachNative: function (addrStr) {
      var out = { ok: false };
      try {
        var addr = ptr(addrStr);
        Interceptor.attach(addr, {
          onEnter: function (args) {
            // JNI: JNIEnv*, jclass, jint a, jint b, jlong c, jstring d, jobject e
            this.a = args[2].toInt32();
            this.b = args[3].toInt32();
            this.c = args[4]; // jlong may be split on some ABIs - on arm64 jlong is one reg
            // Actually arm64 JNI: a0=env, a1=jclass, a2=a, a3=b, a4=c, a5=d, a6=e
            this.dptr = args[5];
            this.eptr = args[6];
            send({
              type: 'native_enter',
              a: this.a,
              b: this.b,
              c: this.c.toString(),
              d: this.dptr.toString(),
              e: this.eptr.toString(),
            });
          },
          onLeave: function (retval) {
            send({ type: 'native_leave', ret: retval.toString() });
          },
        });
        out.ok = true;
        out.addr = addrStr;
      } catch (e) {
        out.error = String(e);
      }
      return out;
    },
  };
});
"""


def main() -> int:
    device_id = sys.argv[1] if len(sys.argv) > 1 else "emulator-5554"
    try:
        pid = int(
            subprocess.check_output(
                ["adb", "-s", device_id, "shell", "pidof", PKG], text=True
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
    script = session.create_script(BOOT + "\n" + AGENT)
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
        if t in ("log", "art", "f3", "native_enter", "native_leave"):
            print(json.dumps(p, ensure_ascii=False)[:2000], flush=True)

    script.on("message", on_msg)
    script.load()
    time.sleep(1.5)
    print("ping", script.exports_sync.ping(), flush=True)

    # attach native if we found candidate
    for e in events:
        if e.get("type") == "art":
            res = e.get("res") or {}
            cand = res.get("candidate") or {}
            if cand.get("ptr"):
                print("attachNative", cand, flush=True)
                print(script.exports_sync.attach_native(cand["ptr"]), flush=True)
            else:
                # try all metasec probes
                for p in res.get("probes") or []:
                    if p.get("in_metasec"):
                        print("try probe", p, flush=True)
                        print(script.exports_sync.attach_native(p["ptr"]), flush=True)
                        break

    body = b'{"series_id":"7610708001174850584"}'
    stub = hashlib.md5(body).hexdigest().upper()
    ticket = str(int(time.time() * 1000))
    url = (
        "https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/"
        f"?aid=8662&device_id=674438832718729&iid=674438832722825&_rticket={ticket}"
    )
    r = script.exports_sync.try_add(url, stub, ticket)
    print("tryAdd", json.dumps(r, ensure_ascii=False)[:2000], flush=True)

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "f3_native_resolve.json"
    out_path.write_text(
        json.dumps({"tryAdd": r, "events": events}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("saved", out_path, flush=True)
    session.detach()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

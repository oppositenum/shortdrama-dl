#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Probe MetaSec/TTNet signing: SecurityFactorInterceptor, RequestEncryptUtils, headers."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import frida

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / ".venv/lib/python3.14/site-packages/frida_tools/bridges"
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
function mapToObj(map){
  var o={}; if(!map) return o;
  try{
    var Map=Java.use('java.util.Map'); var jm=Java.cast(map,Map);
    var ks=jm.keySet().toArray();
    for(var i=0;i<ks.length;i++){
      var k=ks[i]; var v=jm.get(k);
      o[String(k)] = v==null ? 'null' : String(v);
    }
  }catch(e){ o.__e=String(e);} return o;
}
function dumpOkHeaders(tag, headers){
  try{
    if(headers==null){ send({type:'headers', tag:tag, h:{}}); return; }
    var o={};
    var size=headers.size();
    for(var i=0;i<size;i++) o[String(headers.name(i))]=String(headers.value(i)).slice(0,400);
    send({type:'headers', tag:tag, h:o});
  }catch(e){ L('dumpOkHeaders '+tag+' '+e); }
}

Java.perform(function(){
  L('ready');
  var names=[
    'com.bytedance.frameworks.baselib.network.http.ok3.impl.OkHttp3SecurityFactorInterceptor',
    'com.bytedance.frameworks.core.encrypt.RequestEncryptUtils',
    'com.bytedance.retrofit2.client.Request$Builder',
    'com.bytedance.retrofit2.ttnet.TTInternalInterceptor',
    'com.bytedance.frameworks.baselib.network.http.cronet.impl.SsCronetHttpClient'
  ];
  names.forEach(function(n){
    try{
      var C=Java.use(n);
      L('=== '+n);
      var ms=C.class.getDeclaredMethods();
      for(var i=0;i<ms.length;i++) L('  '+ms[i].toString().slice(0,240));
    }catch(e){ L('miss '+n+' '+e); }
  });

  try{
    var S=Java.use('com.bytedance.frameworks.baselib.network.http.ok3.impl.OkHttp3SecurityFactorInterceptor');
    S.intercept.implementation=function(chain){
      var req=chain.request();
      var url=req.url().toString();
      send({type:'sec_in', url:url.slice(0,300)});
      dumpOkHeaders('sec_in', req.headers());
      var resp=this.intercept(chain);
      try{ dumpOkHeaders('sec_out', resp.request().headers()); }catch(e){}
      return resp;
    };
    L('hooked OkHttp3SecurityFactorInterceptor.intercept');
  }catch(e){ L('SecFactor hook fail '+e); }

  try{
    var RB=Java.use('com.bytedance.retrofit2.client.Request$Builder');
    if(RB.addHeader){
      RB.addHeader.overloads.forEach(function(ov){
        ov.implementation=function(){
          try{
            var n=String(arguments[0]||''); var v=String(arguments[1]||'');
            if(/x-|sign|gorgon|argus|ladon|khronos|stub|ticket|neptune/i.test(n))
              send({type:'hdr', n:n, v:v.slice(0,300)});
          }catch(e){}
          return ov.apply(this, arguments);
        };
      });
      L('hooked retrofit Request.Builder.addHeader');
    }
  }catch(e){ L('RB fail '+e); }

  try{
    var B=Java.use('okhttp3.Request$Builder');
    B.addHeader.overload('java.lang.String','java.lang.String').implementation=function(n,v){
      var nl=String(n);
      if(/x-|sign|gorgon|argus|ladon|khronos|stub|ticket|neptune/i.test(nl))
        send({type:'hdr', n:nl, v:String(v).slice(0,300)});
      return this.addHeader(n,v);
    };
    B.header.overload('java.lang.String','java.lang.String').implementation=function(n,v){
      var nl=String(n);
      if(/x-|sign|gorgon|argus|ladon|khronos|stub|ticket|neptune/i.test(nl))
        send({type:'hdr', n:nl, v:String(v).slice(0,300)});
      return this.header(n,v);
    };
    L('hooked okhttp3.Request.Builder');
  }catch(e){ L('okhttp builder fail '+e); }

  try{
    var RE=Java.use('com.bytedance.frameworks.core.encrypt.RequestEncryptUtils');
    var ms=RE.class.getDeclaredMethods();
    for(var i=0;i<ms.length;i++){
      var methodName=ms[i].getName();
      if(!/encrypt|sign|header|param|url|query/i.test(methodName)) continue;
      (function(mn){
        try{
          var overs=RE[mn].overloads;
          overs.forEach(function(ov){
            ov.implementation=function(){
              var args=[]; for(var j=0;j<arguments.length;j++) args.push(String(arguments[j]).slice(0,200));
              var ret=ov.apply(this, arguments);
              send({type:'encrypt', m:mn, args:args, ret:String(ret).slice(0,500)});
              return ret;
            };
          });
          L('hooked RequestEncryptUtils.'+mn+' x'+overs.length);
        }catch(e){ L('hook RE.'+mn+' '+e); }
      })(methodName);
    }
  }catch(e){ L('RE fail '+e); }

  // Sign-ish method names
  var enumHits=[];
  Java.enumerateLoadedClasses({
    onMatch:function(n){
      if(n.indexOf('Sign')<0 && n.indexOf('SecurityFactor')<0 && n.indexOf('metasec')<0 && n.indexOf('mssdk')<0 && n.indexOf('Encrypt')<0) return;
      try{
        var C=Java.use(n);
        var mth=C.class.getDeclaredMethods();
        for(var i=0;i<mth.length;i++){
          var mn=mth[i].getName();
          if(/Sign|Gorgon|Argus|Ladon|Khronos|Header|encrypt/i.test(mn)){
            enumHits.push(String(mth[i]));
          }
        }
      }catch(e){}
    },
    onComplete:function(){
      L('sign-ish methods '+enumHits.length);
      enumHits.slice(0,100).forEach(function(h){ L('SM '+h); });
    }
  });

  // TTNet Cronet builders
  try{
    var builders=Java.enumerateLoadedClassesSync().filter(function(c){
      return c.indexOf('com.ttnet.org.chromium.net')===0 && /Request/.test(c) && /Builder/.test(c);
    });
    L('ttnet builders '+builders.length);
    builders.forEach(function(n){
      L('TB '+n);
      try{
        var C=Java.use(n);
        if(C.addHeader){
          C.addHeader.overloads.forEach(function(ov){
            ov.implementation=function(){
              try{
                var a0=String(arguments[0]||''); var a1=String(arguments[1]||'');
                if(/x-|sign|gorgon|argus|ladon|khronos|stub|ticket|neptune|cookie/i.test(a0))
                  send({type:'tt_hdr', cls:n, n:a0, v:a1.slice(0,300)});
              }catch(e){}
              return ov.apply(this, arguments);
            };
          });
          L('hooked '+n+'.addHeader');
        }
      }catch(e){}
    });
  }catch(e){ L('tt builders fail '+e); }

  rpc.exports={ ping:function(){ return 'pong'; } };
});
"""


def main() -> int:
    device_id = "emulator-5554"
    try:
        out = subprocess.check_output(
            ["adb", "-s", device_id, "shell", "pidof", PKG], text=True
        ).strip()
        pid = int(out.split()[0])
    except Exception:
        print("app not running", file=sys.stderr)
        return 2

    print("pid", pid, flush=True)
    device = frida.get_device(device_id)
    session = device.attach(pid)
    script = session.create_script(BOOT + "\n" + AGENT)

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
            print("[bridge]", bridge.name, flush=True)
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
        print(json.dumps(p, ensure_ascii=False)[:700], flush=True)

    script.on("message", on_msg)
    script.load()
    time.sleep(3)
    print("ping", script.exports_sync.ping(), flush=True)
    print("waiting 20s for traffic...", flush=True)
    subprocess.call(["adb", "-s", device_id, "shell", "input", "swipe", "500", "1500", "500", "500", "300"])
    time.sleep(20)
    session.detach()
    print("done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

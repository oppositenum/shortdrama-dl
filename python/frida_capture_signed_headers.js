// Capture TTNet/Cronet signed headers for player APIs + optionally fire video_detail via Java.
function L(m) { send({ type: 'log', m: String(m) }); }

function interestingName(n) {
  n = String(n).toLowerCase();
  return /gorgon|argus|ladon|khronos|helios|medusa|ss-stub|ss-req|neptune|x-tt|x-bd|cookie|authorization|sign|token|device/.test(n)
    || n.indexOf('x-') === 0;
}

function hookNativeHeaders() {
  var names = [
    'libsscronet.so',
    'libttboringssl.so',
  ];
  var mod = null;
  for (var i = 0; i < names.length; i++) {
    mod = Process.findModuleByName(names[i]);
    if (mod) break;
  }
  if (!mod) {
    // try enumerate
    Process.enumerateModules().forEach(function (m) {
      if (/sscronet|ttnet|cronet/i.test(m.name) && !mod) mod = m;
    });
  }
  if (!mod) {
    L('no cronet module yet');
    return;
  }
  L('module ' + mod.name + ' base=' + mod.base);

  function tryHook(exportName, cb) {
    var addr = Module.findExportByName(mod.name, exportName);
    if (!addr) {
      L('no export ' + exportName);
      return;
    }
    Interceptor.attach(addr, cb);
    L('hooked native ' + exportName + ' @ ' + addr);
  }

  // Cronet_HttpHeader_name_set / value_set often used when building headers
  var lastNamePtr = null;
  tryHook('Cronet_HttpHeader_name_set', {
    onEnter: function (args) {
      this.hdr = args[0];
      try { this.name = args[1].readUtf8String(); } catch (e) { this.name = null; }
    },
    onLeave: function (retval) {
      if (this.name) this.hdrName = this.name;
    }
  });
  tryHook('Cronet_HttpHeader_value_set', {
    onEnter: function (args) {
      try {
        var v = args[1].readUtf8String();
        // name may be on same object - we only log interesting values / all x-
        if (v && (interestingName(v) || v.length > 8)) {
          send({ type: 'nathdr_val', v: String(v).slice(0, 400) });
        }
      } catch (e) {}
    }
  });

  tryHook('Cronet_UrlRequestParams_request_headers_add', {
    onEnter: function (args) {
      // args: params, header object
      this.params = args[0];
      this.header = args[1];
    },
    onLeave: function (retval) {
      try {
        // try read name/value via exports if available
        var nameGet = Module.findExportByName(mod.name, 'Cronet_HttpHeader_name_get');
        var valGet = Module.findExportByName(mod.name, 'Cronet_HttpHeader_value_get');
        if (nameGet && valGet && this.header) {
          var nPtr = new NativeFunction(nameGet, 'pointer', ['pointer'])(this.header);
          var vPtr = new NativeFunction(valGet, 'pointer', ['pointer'])(this.header);
          var n = nPtr.isNull() ? '' : nPtr.readUtf8String();
          var v = vPtr.isNull() ? '' : vPtr.readUtf8String();
          if (interestingName(n) || interestingName(v)) {
            send({ type: 'nathdr', n: n, v: String(v).slice(0, 400) });
          }
        }
      } catch (e) {
        L('headers_add parse ' + e);
      }
    }
  });

  tryHook('Cronet_ClientOpaqueData_do_sign_set', {
    onEnter: function (args) {
      L('do_sign_set called');
    }
  });
  tryHook('Cronet_ClientOpaqueData_do_sign_get', {
    onLeave: function (retval) {
      L('do_sign_get -> ' + retval);
    }
  });
  tryHook('Cronet_Engine_SetMD5Header', {
    onEnter: function (args) {
      try {
        L('SetMD5Header ' + (args[1].isNull() ? 'null' : args[1].readUtf8String()));
      } catch (e) {
        L('SetMD5Header');
      }
    }
  });
}

function mapToObj(map) {
  var o = {};
  if (!map) return o;
  try {
    var Map = Java.use('java.util.Map');
    var jm = Java.cast(map, Map);
    var ks = jm.keySet().toArray();
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i];
      o[String(k)] = String(jm.get(k));
    }
  } catch (e) {
    o.__e = String(e);
  }
  return o;
}

function hookJava() {
  Java.perform(function () {
    L('java ready');
    // OkHttp security factor
    try {
      var S = Java.use('com.bytedance.frameworks.baselib.network.http.ok3.impl.OkHttp3SecurityFactorInterceptor');
      S.intercept.implementation = function (chain) {
        var req = chain.request();
        var url = req.url().toString();
        if (/novel\/player|video_detail|video_model|fqnovel|snssdk/.test(url)) {
          var h = {};
          var headers = req.headers();
          for (var i = 0; i < headers.size(); i++) h[headers.name(i)] = String(headers.value(i)).slice(0, 400);
          send({ type: 'sec_in', url: url.slice(0, 400), headers: h });
        }
        var resp = this.intercept(chain);
        try {
          if (/novel\/player|video_detail|video_model|fqnovel|snssdk/.test(url)) {
            var req2 = resp.request();
            var h2 = {};
            var headers2 = req2.headers();
            for (var j = 0; j < headers2.size(); j++) h2[headers2.name(j)] = String(headers2.value(j)).slice(0, 400);
            send({ type: 'sec_out', url: req2.url().toString().slice(0, 400), headers: h2 });
          }
        } catch (e) {}
        return resp;
      };
      L('hooked SecurityFactor');
    } catch (e) {
      L('SecurityFactor ' + e);
    }

    // Retrofit client Request final headers
    try {
      var Req = Java.use('com.bytedance.retrofit2.client.Request');
      // log getHeaders if called
      if (Req.getHeaders) {
        Req.getHeaders.implementation = function () {
          var hs = this.getHeaders();
          try {
            var url = String(this.getUrl());
            if (/novel\/player|video_detail|video_model/.test(url)) {
              send({ type: 'retro_headers', url: url.slice(0, 300), headers: String(hs).slice(0, 800) });
            }
          } catch (e) {}
          return hs;
        };
        L('hooked retrofit Request.getHeaders');
      }
    } catch (e) {
      L('retro ' + e);
    }

    // Broad okhttp header
    try {
      var B = Java.use('okhttp3.Request$Builder');
      B.header.overload('java.lang.String', 'java.lang.String').implementation = function (n, v) {
        if (interestingName(n)) send({ type: 'hdr', n: String(n), v: String(v).slice(0, 300) });
        return this.header(n, v);
      };
      B.addHeader.overload('java.lang.String', 'java.lang.String').implementation = function (n, v) {
        if (interestingName(n)) send({ type: 'hdr', n: String(n), v: String(v).slice(0, 300) });
        return this.addHeader(n, v);
      };
      L('hooked okhttp builder');
    } catch (e) {}

    // NetworkParams.addCommonParams for player
    try {
      var NP = Java.use('com.bytedance.frameworks.baselib.network.http.NetworkParams');
      NP.addCommonParams.overload('java.lang.String', 'boolean').implementation = function (url, b) {
        var ret = this.addCommonParams(url, b);
        if (/novel\/player|video_/.test(String(url)) || /novel\/player|video_/.test(String(ret))) {
          send({ type: 'common', url: String(url).slice(0, 200), ret: String(ret).slice(0, 500) });
        }
        return ret;
      };
      L('hooked addCommonParams');
    } catch (e) {}

    rpc.exports = {
      frameSign: function (url, flag) {
        var out = null;
        Java.performNow(function () {
          var U = Java.use('com.bytedance.mobsec.metasec.ml.MSManagerUtils');
          var m = U.get('8662');
          out = mapToObj(m.frameSign(String(url), flag | 0));
        });
        return out;
      },
      // Try to find getPlayerApi and call getVideoDetail-like methods
      listPlayerApi: function () {
        var out = [];
        Java.performNow(function () {
          try {
            var C = Java.use('com.dragon.read.seriessdk.rpc.kmp.rpc.PlayerApiService');
            var ms = C.class.getDeclaredMethods();
            for (var i = 0; i < ms.length; i++) out.push(String(ms[i]));
            // fields / companions
            var fs = C.class.getDeclaredFields();
            for (var j = 0; j < fs.length; j++) out.push('F ' + String(fs[j]));
          } catch (e) {
            out.push('err ' + e);
          }
          // search getPlayerApi owners
          Java.enumerateLoadedClasses({
            onMatch: function (n) {
              if (!/PlayerApi|ShortSeries|VideoDetail|SeriesSdk/i.test(n)) return;
              try {
                var Cl = Java.use(n);
                var mth = Cl.class.getDeclaredMethods();
                for (var i = 0; i < mth.length; i++) {
                  var s = String(mth[i]);
                  if (/getPlayerApi|video_detail|getVideoDetail|getVideoModel|videoDetail/i.test(s)) {
                    out.push(s);
                  }
                }
              } catch (e) {}
            },
            onComplete: function () {}
          });
        });
        return out;
      },
      // Force HTTP via Java HttpURLConnection through TTNet? fallback raw for comparison
      ping: function () {
        return 'pong';
      }
    };
  });
}

// native first (no Java needed)
setTimeout(function () {
  try {
    hookNativeHeaders();
  } catch (e) {
    L('native hook fail ' + e);
  }
  try {
    hookJava();
  } catch (e) {
    L('java hook fail ' + e);
  }
}, 300);

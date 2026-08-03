/**
 * Gorgon / 六神 相关明文与 I/O dump
 *
 * 目标：
 *  1) 钩 ms.bd.c.f3.a(0x3000001) 完整入参/出参
 *  2) 钩 String 构造 / 搜索 "8404" 出现位置（Gorgon hex 前缀）
 *  3) 可选：对 libmetasec_ml.so 写 "8404" 字节模式的内存扫描提示
 *  4) 触发一次 onCallToAddSecurityFactor（由 host 调 rpc）
 *
 * 与 host: frida_gorgon_plaindump.py 配套。
 */

function L(m) {
  send({ type: 'log', m: String(m) });
}

function toHex(u8, max) {
  max = max || u8.length;
  var n = Math.min(u8.length, max);
  var out = [];
  for (var i = 0; i < n; i++) {
    var b = u8[i] & 0xff;
    out.push(('0' + b.toString(16)).slice(-2));
  }
  return out.join('');
}

function dumpJava(o) {
  if (o === null || o === undefined) return null;
  try {
    var cls = o.getClass().getName();
    if (cls === 'java.lang.String') return { t: 'str', v: String(o) };
    if (cls === '[B') {
      var ba = Java.array('byte', o);
      var arr = [];
      for (var i = 0; i < ba.length; i++) arr.push((ba[i] + 256) % 256);
      return { t: 'bytes', len: arr.length, hex: toHex(arr) };
    }
    if (cls === '[Ljava.lang.String;') {
      // Frida Array reflection — avoid broken cast
      var ArrayCls = Java.use('java.lang.reflect.Array');
      var n = ArrayCls.getLength(o);
      var v = [];
      for (var i = 0; i < n; i++) {
        var el = ArrayCls.get(o, i);
        v.push(el === null ? null : String(el));
      }
      return { t: 'str[]', len: n, v: v };
    }
    if (cls.charAt(0) === '[') {
      try {
        var ArrayCls2 = Java.use('java.lang.reflect.Array');
        var n2 = ArrayCls2.getLength(o);
        var v2 = [];
        for (var j = 0; j < n2; j++) v2.push(dumpJava(ArrayCls2.get(o, j)));
        return { t: 'arr', cls: cls, len: n2, v: v2 };
      } catch (e0) {
        return { t: 'arr', cls: cls, e: String(e0) };
      }
    }
    return { t: 'obj', cls: cls, s: String(o).slice(0, 240) };
  } catch (e) {
    return { t: 'err', e: String(e) };
  }
}

function mapObj(m) {
  var o = {};
  if (!m) return o;
  try {
    var Map = Java.use('java.util.Map');
    var jm = Java.cast(m, Map);
    var ks = jm.keySet().toArray();
    for (var i = 0; i < ks.length; i++) o[String(ks[i])] = String(jm.get(ks[i]));
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
    } catch (e2) {}
  }
  return adapters.length ? adapters[0] : null;
}

function analyzeGorgon(hex) {
  if (!hex || hex.length < 12) return null;
  var h = String(hex).toLowerCase();
  return {
    prefix: h.slice(0, 4),
    mid: h.slice(4, 8),
    pad: h.slice(8, 12),
    body20: h.slice(12),
    len_bytes: h.length / 2
  };
}

var gState = {
  f3Count: 0,
  lastF3: null,
  gorgonHits: [],
  string8404: []
};

Java.perform(function () {
  // --- f3.a ---
  try {
    var f3 = Java.use('ms.bd.c.f3');
    f3.a.implementation = function (a, b, c, d, e) {
      var ret = this.a(a, b, c, d, e);
      var rec = {
        type: 'f3',
        opcode: a | 0,
        b: b | 0,
        handle: String(c),
        url: d == null ? null : String(d).slice(0, 800),
        data: dumpJava(e),
        ret: dumpJava(ret),
        ts: Date.now()
      };
      // extract gorgon from ret if present
      if (rec.ret && rec.ret.t === 'str[]' && rec.ret.v) {
        var flat = rec.ret.v;
        for (var i = 0; i + 1 < flat.length; i += 2) {
          if (String(flat[i]).toLowerCase() === 'x-gorgon') {
            rec.gorgon = String(flat[i + 1]);
            rec.gorgon_parse = analyzeGorgon(rec.gorgon);
          }
        }
        // also build header map
        var hdrs = {};
        for (var j = 0; j + 1 < flat.length; j += 2) hdrs[String(flat[j])] = String(flat[j + 1]);
        rec.headers = hdrs;
      }
      gState.f3Count++;
      gState.lastF3 = rec;
      if ((a | 0) === 0x3000001 || (a | 0) === 50331649) {
        send(rec);
      }
      return ret;
    };
    L('hooked ms.bd.c.f3.a');
  } catch (e) {
    L('f3 hook fail: ' + e);
  }

  // --- String 出现 8404 前缀（Gorgon hex）时记短栈；避免 StringBuilder 递归 ---
  try {
    var JString = Java.use('java.lang.String');
    // $new(byte[]) 等路径太多；只钩 getBytes 太晚。
    // 改为在 f3 返回后由 host 分析即可；这里钩 String.<init>(String) 风险也高。
    // 轻量方案：钩 Character 无用。改用一次 MessageDigest? skip.
    // 实用：钩 java.lang.StringBuilder.toString 但调用 overload 原实现
    var SB = Java.use('java.lang.StringBuilder');
    var sbToString = SB.toString.overload();
    sbToString.implementation = function () {
      var s = sbToString.call(this);
      try {
        if (s && s.length >= 48 && s.length <= 64) {
          var low = s.toLowerCase();
          if (low.indexOf('8404') === 0) {
            var hit = {
              type: 'gorgon_string',
              value: s,
              parse: analyzeGorgon(s),
              stack: Java.use('android.util.Log').getStackTraceString(
                Java.use('java.lang.Exception').$new('gorgon')
              ).split('\n').slice(0, 18)
            };
            gState.string8404.push(hit);
            send(hit);
          }
        }
      } catch (e2) {}
      return s;
    };
    L('hooked StringBuilder.toString (8404 filter)');
  } catch (e3) {
    L('StringBuilder hook skip: ' + e3);
  }

  // --- onCallToAddSecurityFactor ---
  try {
    var y4 = Java.use('ms.bd.c.y4');
    // method name may vary; try common
    if (y4.onCallToAddSecurityFactor) {
      y4.onCallToAddSecurityFactor.implementation = function (url, map) {
        var ret = this.onCallToAddSecurityFactor(url, map);
        send({
          type: 'y4',
          url: String(url).slice(0, 500),
          in_map: mapObj(map),
          out_map: mapObj(ret),
          ts: Date.now()
        });
        return ret;
      };
      L('hooked ms.bd.c.y4.onCallToAddSecurityFactor');
    }
  } catch (e4) {
    L('y4 hook skip: ' + e4);
  }

  // libmetasec base
  try {
    var m = Process.findModuleByName('libmetasec_ml.so');
    if (m) {
      L('libmetasec_ml.so base=' + m.base + ' size=' + m.size);
      send({ type: 'module', name: m.name, base: m.base.toString(), size: m.size });
    } else {
      L('libmetasec_ml.so not loaded yet');
    }
  } catch (e5) {
    L('module ' + e5);
  }
});

rpc.exports = {
  ping: function () { return 'pong'; },
  stats: function () {
    return {
      f3Count: gState.f3Count,
      gorgonStrings: gState.string8404.length,
      lastGorgon: gState.lastF3 && gState.lastF3.gorgon ? gState.lastF3.gorgon : null
    };
  },
  /** 主动触发一次 HTTP 签名，便于 dump */
  triggerSign: function (url, stub, ticket) {
    var out = {};
    Java.performNow(function () {
      try {
        var HashMap = Java.use('java.util.HashMap');
        var hm = HashMap.$new();
        if (stub) hm.put('x-ss-stub', String(stub));
        if (ticket) hm.put('x-ss-req-ticket', String(ticket));
        var a = getAdapter();
        if (!a) {
          // fallback y4 if adapter missing
          try {
            var y4 = Java.use('ms.bd.c.y4');
            // static? try instance choose
          } catch (e0) {}
          out.error = 'no_adapter';
          return;
        }
        var ret = a.onCallToAddSecurityFactor(String(url), hm);
        out.headers = mapObj(ret);
        out.adapter = String(a.getClass().getName());
        if (out.headers && out.headers['X-Gorgon']) {
          out.gorgon_parse = analyzeGorgon(out.headers['X-Gorgon']);
        }
      } catch (e) {
        out.error = String(e);
      }
    });
    return out;
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
  }
};

L('frida_gorgon_plaindump ready');

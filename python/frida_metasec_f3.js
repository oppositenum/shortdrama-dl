// Hook MetaSec native bridge ms.bd.c.f3.a and dump full args/returns
function sendLog(m) { send({ type: 'log', m: String(m) }); }

function jstr(o) {
  if (o === null || o === undefined) return null;
  try { return String(o); } catch (e) { return null; }
}

function dumpJava(o) {
  if (o === null || o === undefined) return null;
  try {
    var cls = o.getClass().getName();
    if (cls === 'java.lang.String') return { t: 'str', v: String(o) };
    if (cls === 'java.lang.Integer' || cls === 'java.lang.Long' || cls === 'java.lang.Boolean')
      return { t: 'box', cls: cls, v: String(o) };
    // byte[]
    if (cls === '[B') {
      var ba = Java.array('byte', o);
      var hex = [];
      var n = ba.length;
      for (var i = 0; i < n; i++) {
        var v = (ba[i] + 256) % 256;
        hex.push(('0' + v.toString(16)).slice(-2));
      }
      return { t: 'bytes', len: n, hex: hex.join('') };
    }
    // String[]
    if (cls === '[Ljava.lang.String;') {
      var sa = Java.cast(o, Java.use('[Ljava.lang.String;'));
      var arr = [];
      for (var i = 0; i < sa.length; i++) arr.push(sa[i] == null ? null : String(sa[i]));
      return { t: 'str[]', v: arr, len: sa.length };
    }
    // generic arrays
    if (cls.charAt(0) === '[') {
      try {
        var len = o.length;
        var arr = [];
        for (var i = 0; i < len; i++) arr.push(dumpJava(o[i]));
        return { t: 'arr', cls: cls, len: len, v: arr };
      } catch (e1) {
        return { t: 'arr', cls: cls, s: String(o).slice(0, 200), e: String(e1) };
      }
    }
    // Map
    try {
      var Map = Java.use('java.util.Map');
      var jm = Java.cast(o, Map);
      var out = {};
      var ks = jm.keySet().toArray();
      for (var i = 0; i < ks.length; i++) out[String(ks[i])] = String(jm.get(ks[i]));
      return { t: 'map', v: out };
    } catch (e2) {}
    // List
    try {
      var List = Java.use('java.util.List');
      var jl = Java.cast(o, List);
      var arr = [];
      for (var i = 0; i < jl.size(); i++) arr.push(dumpJava(jl.get(i)));
      return { t: 'list', v: arr };
    } catch (e3) {}
    return { t: 'obj', cls: cls, s: String(o).slice(0, 300) };
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

Java.perform(function () {
  var f3 = Java.use('ms.bd.c.f3');
  f3.a.implementation = function (a, b, c, d, e) {
    var ret = this.a(a, b, c, d, e);
    send({
      type: 'f3',
      a: a | 0,
      b: b | 0,
      c: String(c),
      d: d == null ? null : String(d).slice(0, 500),
      e: dumpJava(e),
      ret: dumpJava(ret),
    });
    return ret;
  };
  sendLog('hooked ms.bd.c.f3.a');

  // Also resolve native address of f3.a
  try {
    var art = Module.findBaseAddress('libart.so');
    // use Java reflection to get method and ArtMethod
    var Method = Java.use('java.lang.reflect.Method');
    var f3cls = Java.use('ms.bd.c.f3').class;
    var methods = f3cls.getDeclaredMethods();
    for (var i = 0; i < methods.length; i++) {
      var m = methods[i];
      if (String(m.getName()) === 'a' && (m.getModifiers() & 256) !== 0) {
        sendLog('native method found: ' + m);
        // try ArtMethod entrypoint via Frida Java
        try {
          var artMethod = m.getArtMethod ? m.getArtMethod() : null;
          sendLog('artMethod ' + artMethod);
        } catch (e1) {}
      }
    }
  } catch (e) {
    sendLog('native resolve ' + e);
  }

  // Process modules
  var mod = Process.findModuleByName('libmetasec_ml.so');
  if (mod) {
    sendLog('libmetasec_ml base=' + mod.base + ' size=' + mod.size);
    // enumerate exports still empty usually
    var exps = mod.enumerateExports();
    sendLog('exports ' + exps.length);
    exps.slice(0, 20).forEach(function (e) {
      sendLog('E ' + e.type + ' ' + e.name + ' ' + e.address);
    });
  } else {
    sendLog('libmetasec_ml not loaded yet');
  }

  rpc.exports = {
    ping: function () {
      return 'pong';
    },
    sign: function (url, stub, ticket) {
      var out = {};
      Java.performNow(function () {
        try {
          var HashMap = Java.use('java.util.HashMap');
          var hm = HashMap.$new();
          if (stub) hm.put('x-ss-stub', String(stub));
          if (ticket) hm.put('x-ss-req-ticket', String(ticket));
          var a = null;
          Java.choose('com.dragon.read.base.http.b', {
            onMatch: function (i) {
              a = i;
            },
            onComplete: function () {},
          });
          if (!a) {
            out.error = 'no_adapter';
            return;
          }
          out.headers = mapObj(a.onCallToAddSecurityFactor(String(url), hm));
        } catch (e) {
          out.error = String(e);
        }
      });
      return out;
    },
    // Call f3.a directly with known opcode
    callF3: function (a, b, c, d, eKind, eJson) {
      var out = {};
      Java.performNow(function () {
        try {
          var f3 = Java.use('ms.bd.c.f3');
          var eArg = null;
          if (eKind === 'strarr') {
            var arr = JSON.parse(eJson || '[]');
            eArg = Java.array('java.lang.String', arr);
          } else if (eKind === 'bytes') {
            var hex = eJson || '';
            var bytes = [];
            for (var i = 0; i < hex.length; i += 2)
              bytes.push(parseInt(hex.substr(i, 2), 16));
            eArg = Java.array(
              'byte',
              bytes.map(function (x) {
                return x > 127 ? x - 256 : x;
              })
            );
          } else if (eKind === 'null') {
            eArg = null;
          }
          var ret = f3.a(a | 0, b | 0, Java.use('java.lang.Long').parseLong(String(c)), d, eArg);
          out.ret = dumpJava(ret);
        } catch (e) {
          out.error = String(e);
        }
      });
      return out;
    },
  };
});

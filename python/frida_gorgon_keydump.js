/**
 * Gorgon key/param dump at NewStringUTF site (libmetasec_ml.so+0x283640).
 *
 * When cstr starts with "8404", dump:
 *  - hex string + mid/body20
 *  - x0..x28 pointer memory (64B)
 *  - stack slots around SP (256B)
 *  - memscan for body20 raw bytes and for reconstructed eor (host-side)
 *
 * Host: frida_gorgon_keydump.py
 */
function L(m) { send({ type: 'log', m: String(m) }); }

function toHex(ptr, n) {
  try {
    var a = new Uint8Array(ptr.readByteArray(n));
    var o = [];
    for (var i = 0; i < a.length; i++) o.push(('0' + a[i].toString(16)).slice(-2));
    return o.join('');
  } catch (e) {
    return null;
  }
}

function tryReadCstr(p, max) {
  max = max || 80;
  try {
    if (p.isNull()) return null;
    return p.readCString(max);
  } catch (e) {
    return null;
  }
}

function parseGorgonHex(s) {
  if (!s || s.length < 52) return null;
  s = String(s).toLowerCase();
  if (s.indexOf('8404') !== 0) return null;
  return {
    hex: s.slice(0, 52),
    mid: s.slice(4, 8),
    pad: s.slice(8, 12),
    body20: s.slice(12, 52)
  };
}

function dumpRegs(ctx) {
  var names = [];
  for (var i = 0; i < 29; i++) names.push('x' + i);
  names.push('sp', 'lr', 'fp');
  var out = {};
  for (var j = 0; j < names.length; j++) {
    var n = names[j];
    try {
      var v = ctx[n];
      if (v === undefined) continue;
      var o = { v: v.toString() };
      try {
        if (!v.isNull && !v.isNull()) {
          o.hex64 = toHex(v, 64);
          o.cstr = tryReadCstr(v, 64);
        }
      } catch (e1) {}
      out[n] = o;
    } catch (e2) {}
  }
  return out;
}

function scanModuleFor(hexNeedle, mod, maxHits) {
  maxHits = maxHits || 8;
  var hits = [];
  if (!hexNeedle || hexNeedle.length < 8) return hits;
  try {
    var pattern = hexNeedle.replace(/(..)/g, '$1 ').trim();
    var res = Memory.scanSync(mod.base, mod.size, pattern);
    for (var i = 0; i < res.length && i < maxHits; i++) {
      hits.push({
        addr: res[i].address.toString(),
        off: res[i].address.sub(mod.base).toString(),
        around: toHex(res[i].address.sub(16), 64)
      });
    }
  } catch (e) {
    hits.push({ err: String(e) });
  }
  return hits;
}

function getAdapter() {
  var found = null;
  try {
    Java.choose('com.dragon.read.base.http.b', {
      onMatch: function (inst) { if (!found) found = inst; },
      onComplete: function () {}
    });
  } catch (e) {}
  return found;
}

var meta = null;
var lastDumps = [];
var hookReady = false;

function ensureMeta() {
  if (meta) return meta;
  meta = Process.findModuleByName('libmetasec_ml.so');
  if (meta) L('metasec base=' + meta.base + ' size=' + meta.size);
  return meta;
}

function installHooks() {
  if (hookReady) return true;
  var m = ensureMeta();
  if (!m) {
    L('libmetasec_ml.so not loaded yet');
    return false;
  }

  // NewStringUTF site for Gorgon hex
  var site = m.base.add(0x283640);
  Interceptor.attach(site, {
    onEnter: function (args) {
      // From decomp: x0 = env-ish, x1 = c++ string / cstr source path
      // Actual NewStringUTF call is blr after; at +0x283640 return path
      // Better: also hook slightly earlier. Dump both x0 and x1 and lr stack.
      try {
        var ctx = this.context;
        var cands = [];
        // x1 often holds string data ptr or std::string
        var x1 = ctx.x1;
        var x19 = ctx.x19;
        var x20 = ctx.x20;
        [x1, x19, x20, ctx.x2, ctx.x3].forEach(function (p, idx) {
          var cs = tryReadCstr(p, 64);
          if (cs && cs.indexOf('8404') === 0) cands.push({ src: 'reg' + idx, s: cs.slice(0, 52) });
          // std::string long mode: ptr at +0x10 if bit0 of size clear... SSO on aarch64 libc++
          try {
            var p2 = p.add(16).readPointer();
            var cs2 = tryReadCstr(p2, 64);
            if (cs2 && cs2.indexOf('8404') === 0) cands.push({ src: 'reg' + idx + '+16', s: cs2.slice(0, 52) });
          } catch (e0) {}
        });
        // Also scan 0x200 bytes below SP for "8404" ascii
        try {
          var spHex = toHex(ctx.sp, 0x200);
          if (spHex) {
            var ascii = '';
            for (var i = 0; i < spHex.length; i += 2) {
              var b = parseInt(spHex.slice(i, i + 2), 16);
              ascii += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
            }
            var idx8404 = ascii.indexOf('8404');
            if (idx8404 >= 0) {
              var hexStart = idx8404; // char index == byte index
              var ghex = '';
              for (var j = 0; j < 52; j++) {
                var bb = parseInt(spHex.slice((hexStart + j) * 2, (hexStart + j) * 2 + 2), 16);
                if (bb >= 48 && bb <= 57) ghex += String.fromCharCode(bb);
                else if (bb >= 97 && bb <= 102) ghex += String.fromCharCode(bb);
                else if (bb >= 65 && bb <= 70) ghex += String.fromCharCode(bb).toLowerCase();
                else break;
              }
              if (ghex.length >= 52) cands.push({ src: 'stack', s: ghex.slice(0, 52) });
            }
          }
        } catch (e1) {}

        if (!cands.length) return;

        var g = parseGorgonHex(cands[0].s);
        if (!g) return;

        var dump = {
          type: 'gorgon_site',
          g: g,
          cands: cands,
          regs: dumpRegs(ctx),
          bt: Thread.backtrace(ctx, Backtracer.ACCURATE).map(DebugSymbol.fromAddress).map(String).slice(0, 16),
          body20_in_metasec: scanModuleFor(g.body20, m, 4),
          // raw binary 26B 84 04 mid 00 00 body — rarely present
          raw26_in_metasec: scanModuleFor('8404' + g.mid + '0000' + g.body20, m, 2)
        };
        // scan readable ranges for body20 (limit)
        try {
          var ranges = Process.enumerateRangesSync('r--');
          var memHits = [];
          var needle = g.body20;
          for (var ri = 0; ri < ranges.length && memHits.length < 6; ri++) {
            var rg = ranges[ri];
            if (rg.size > 32 * 1024 * 1024) continue; // skip huge
            if (rg.size < 20) continue;
            try {
              var found = Memory.scanSync(rg.base, rg.size, needle.replace(/(..)/g, '$1 ').trim());
              for (var fi = 0; fi < found.length && memHits.length < 6; fi++) {
                memHits.push({
                  addr: found[fi].address.toString(),
                  around: toHex(found[fi].address.sub(32), 96),
                  prot: rg.protection
                });
              }
            } catch (e2) {}
          }
          dump.body20_mem = memHits;
        } catch (e3) {
          dump.body20_mem_err = String(e3);
        }

        lastDumps.push(dump);
        if (lastDumps.length > 20) lastDumps.shift();
        send(dump);
      } catch (e) {
        send({ type: 'err', e: String(e), stack: e.stack });
      }
    }
  });

  // Also hook f3 Java for full header + inputs
  Java.perform(function () {
    try {
      var f3 = Java.use('ms.bd.c.f3');
      f3.a.overload('int', 'int', 'long', 'java.lang.String', 'java.lang.Object').implementation = function (a, b, c, d, e) {
        var ret = this.a(a, b, c, d, e);
        if (a === 0x3000001) {
          try {
            var arr = ret;
            var pairs = {};
            if (arr) {
              var ArrayCls = Java.use('java.lang.reflect.Array');
              var n = ArrayCls.getLength(arr);
              for (var i = 0; i + 1 < n; i += 2) {
                var k = ArrayCls.get(arr, i);
                var v = ArrayCls.get(arr, i + 1);
                if (k) pairs[String(k)] = v === null ? null : String(v);
              }
            }
            send({
              type: 'f3_sign',
              gorgon: pairs['X-Gorgon'] || pairs['x-gorgon'] || null,
              khronos: pairs['X-Khronos'] || null,
              all: pairs,
              d: d ? String(d).slice(0, 200) : null
            });
          } catch (e4) {
            send({ type: 'f3_err', e: String(e4) });
          }
        }
        return ret;
      };
      L('hooked f3.a');
    } catch (e5) {
      L('f3 hook fail: ' + e5);
    }
  });

  hookReady = true;
  L('hooks ready @' + site);
  return true;
}

rpc.exports = {
  ping: function () { return { ok: true, hook: hookReady, meta: !!ensureMeta() }; },
  install: function () {
    return installHooks();
  },
  last: function () {
    return lastDumps.length ? lastDumps[lastDumps.length - 1] : null;
  },
  triggerSign: function (url, stub, ticket) {
    var result = { ok: false };
    Java.perform(function () {
      try {
        if (!installHooks()) {
          result.error = 'no hooks';
          return;
        }
        var adapter = getAdapter();
        if (!adapter) {
          result.error = 'no adapter';
          return;
        }
        var HashMap = Java.use('java.util.HashMap');
        var map = HashMap.$new();
        if (stub) map.put('x-ss-stub', stub);
        if (ticket) map.put('x-ss-req-ticket', ticket);
        // onCallToAddSecurityFactor(url, map) naming may vary — try common
        var cls = adapter.getClass();
        var methods = cls.getDeclaredMethods();
        var called = false;
        for (var i = 0; i < methods.length; i++) {
          var m = methods[i];
          var name = String(m.getName());
          if (name.indexOf('SecurityFactor') >= 0 || name.indexOf('securityFactor') >= 0 || name === 'a') {
            try {
              m.setAccessible(true);
              var params = m.getParameterTypes();
              if (params.length === 2) {
                var ret = m.invoke(adapter, url, map);
                result.ok = true;
                result.method = name;
                result.ret = ret ? String(ret).slice(0, 300) : null;
                // map may be mutated
                var iter = map.entrySet().iterator();
                var headers = {};
                while (iter.hasNext()) {
                  var ent = iter.next();
                  headers[String(ent.getKey())] = String(ent.getValue());
                }
                result.headers = headers;
                called = true;
                break;
              }
            } catch (e) {}
          }
        }
        if (!called) {
          // fallback: ttnet_signer style NetworkParams if present
          try {
            var NP = Java.use('com.bytedance.frameworks.baselib.network.http.NetworkParams');
            // skip
          } catch (e2) {}
          result.error = result.error || 'no SecurityFactor method';
        }
      } catch (e3) {
        result.error = String(e3);
      }
    });
    return result;
  }
};

// auto install when Java ready
function boot() {
  try {
    Java.perform(function () {
      installHooks();
    });
  } catch (e) {
    L('boot: ' + e);
    setTimeout(boot, 500);
  }
}
setTimeout(boot, 100);
L('keydump script loaded');

/**
 * Gorgon native 侧探测：
 *  1) 钩 f3.a 拿最终 X-Gorgon
 *  2) 签名前后在 libmetasec_ml.so / heap 扫描 26 字节形态 84 04 ?? ?? 00 00 ...
 *  3) 钩常见 hex 编码路径（若 Java 把 26B 转 hex）
 *  4) 可选：对 dispatcher 附近短时 Stalker（默认关，太慢）
 *
 * host: frida_gorgon_native.py
 */

function L(m) { send({ type: 'log', m: String(m) }); }

function toHex(arr, n) {
  n = n || arr.length;
  var o = [];
  for (var i = 0; i < n && i < arr.length; i++) {
    o.push(('0' + (arr[i] & 0xff).toString(16)).slice(-2));
  }
  return o.join('');
}

function u8FromPtr(p, n) {
  var a = [];
  for (var i = 0; i < n; i++) a.push(p.add(i).readU8());
  return a;
}

function analyzeGorgonHex(hex) {
  hex = String(hex).toLowerCase();
  if (hex.length < 52) return null;
  return {
    prefix: hex.slice(0, 4),
    mid: hex.slice(4, 8),
    pad: hex.slice(8, 12),
    body20: hex.slice(12, 52),
    raw26: hex.slice(0, 52)
  };
}

function parseGorgonBytes(u8) {
  if (!u8 || u8.length < 26) return null;
  if (u8[0] !== 0x84 || u8[1] !== 0x04) return null;
  return {
    mid: toHex(u8.slice(2, 4)),
    pad: toHex(u8.slice(4, 6)),
    body20: toHex(u8.slice(6, 26)),
    hex: toHex(u8.slice(0, 26))
  };
}

function dumpJavaArr(o) {
  if (o == null) return null;
  try {
    var ArrayCls = Java.use('java.lang.reflect.Array');
    var n = ArrayCls.getLength(o);
    var v = [];
    for (var i = 0; i < n; i++) {
      var el = ArrayCls.get(o, i);
      v.push(el === null ? null : String(el));
    }
    return v;
  } catch (e) {
    return null;
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
  } catch (e) {}
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
  return adapters.length ? adapters[0] : null;
}

var metaBase = null;
var metaSize = 0;
var lastSign = null;
var scanHits = [];

function findMetasec() {
  var m = Process.findModuleByName('libmetasec_ml.so');
  if (m) {
    metaBase = m.base;
    metaSize = m.size;
    L('libmetasec_ml.so base=' + metaBase + ' size=' + metaSize);
    send({ type: 'module', base: metaBase.toString(), size: metaSize });
  }
  return m;
}

/**
 * 用 Memory.scanSync 扫可读内存：
 *  - 若已知 gorgonHex，精确匹配 26 字节
 *  - 否则扫 84 04 ?? ?? 00 00 前缀
 */
function hexToScanPattern(hex) {
  return String(hex).toLowerCase().replace(/[^0-9a-f]/g, '').replace(/(..)/g, '$1 ').trim();
}

function scanOneRange(base, size, pattern, tag, hits, file) {
  if (size > 32 * 1024 * 1024) size = 32 * 1024 * 1024;
  try {
    var found = Memory.scanSync(base, size, pattern);
    for (var k = 0; k < found.length; k++) {
      try {
        var address = found[k].address;
        var bytes = u8FromPtr(address, 26);
        var parsed = parseGorgonBytes(bytes);
        if (!parsed || parsed.pad !== '0000') continue;
        hits.push({
          addr: address.toString(),
          hex: parsed.hex,
          mid: parsed.mid,
          body20: parsed.body20,
          tag: tag,
          range_base: base.toString(),
          file: file || null
        });
      } catch (e2) {}
    }
  } catch (e3) {
    // ignore unreadable
  }
}

function scanGorgonPatterns(tag, gorgonHex) {
  var hits = [];
  var pattern = (gorgonHex && gorgonHex.length >= 52)
    ? hexToScanPattern(String(gorgonHex).slice(0, 52))
    : '84 04 ?? ?? 00 00';

  // 1) 整个 libmetasec_ml.so
  try {
    var m = Process.findModuleByName('libmetasec_ml.so');
    if (m) scanOneRange(m.base, m.size, pattern, tag + '_so', hits, m.path || 'libmetasec_ml.so');
  } catch (e0) {
    L('scan so ' + e0);
  }

  // 2) 所有模块（Frida 17: enumerateRanges 可能是 async-less 数组 API）
  var ranges = null;
  try {
    if (typeof Process.enumerateRanges === 'function') {
      ranges = Process.enumerateRanges('r--');
    }
  } catch (e1) {}
  try {
    if (!ranges && typeof Process.enumerateRangesSync === 'function') {
      ranges = Process.enumerateRangesSync('r--');
    }
  } catch (e2) {}

  if (ranges && ranges.length) {
    var maxRanges = 200;
    for (var j = 0; j < ranges.length && j < maxRanges; j++) {
      var rg = ranges[j];
      var path = (rg.file && rg.file.path) ? rg.file.path : '';
      // 跳过超大匿名映射可加速
      if (rg.size > 64 * 1024 * 1024) continue;
      scanOneRange(rg.base, rg.size, pattern, tag, hits, path);
      if (hits.length >= 40) break;
    }
  } else {
    // 3) 回退：扫所有已加载模块
    try {
      var mods = Process.enumerateModules();
      for (var i = 0; i < mods.length; i++) {
        var md = mods[i];
        if (md.size > 64 * 1024 * 1024) continue;
        scanOneRange(md.base, md.size, pattern, tag + '_mod', hits, md.name);
        if (hits.length >= 40) break;
      }
    } catch (e3) {
      L('enumerateModules fail ' + e3);
    }
  }
  return hits;
}

Java.perform(function () {
  findMetasec();

  // f3.a
  try {
    var f3 = Java.use('ms.bd.c.f3');
    f3.a.implementation = function (a, b, c, d, e) {
      var beforeHits = [];
      var opcode = a | 0;
      if (opcode === 0x3000001 || opcode === 50331649) {
        // 签名前轻量扫一次（可能没有）
        // beforeHits = scanGorgonPatterns('pre'); // 太慢，默认关
      }
      var ret = this.a(a, b, c, d, e);
      if (opcode === 0x3000001 || opcode === 50331649) {
        var flat = dumpJavaArr(ret);
        var headers = {};
        var gorgon = null;
        if (flat) {
          for (var i = 0; i + 1 < flat.length; i += 2) {
            headers[String(flat[i])] = String(flat[i + 1]);
            if (String(flat[i]).toLowerCase() === 'x-gorgon') gorgon = String(flat[i + 1]);
          }
        }
        var afterHits = [];
        var asciiHits = [];
        try {
          // 优先精确扫最终 Gorgon 的 26 字节二进制
          afterHits = scanGorgonPatterns('post_exact', gorgon);
          if (!afterHits.length) afterHits = scanGorgonPatterns('post_prefix', null);
          // 再扫 ASCII hex 串（很多路径只保留字符串形态）
          if (gorgon) {
            var ap = '';
            var gs = String(gorgon).toLowerCase().slice(0, 52);
            for (var ai = 0; ai < gs.length; ai++) {
              ap += ('0' + gs.charCodeAt(ai).toString(16)).slice(-2);
              if (ai + 1 < gs.length) ap += ' ';
            }
            try {
              var mods = Process.enumerateModules();
              for (var mi = 0; mi < mods.length && asciiHits.length < 10; mi++) {
                var md = mods[mi];
                if (md.size > 128 * 1024 * 1024) continue;
                try {
                  var af = Memory.scanSync(md.base, md.size, ap);
                  for (var aj = 0; aj < af.length; aj++) {
                    asciiHits.push({
                      addr: af[aj].address.toString(),
                      module: md.name,
                      kind: 'ascii_hex'
                    });
                  }
                } catch (eA) {}
              }
              // also heap via ranges if available
              if (typeof Process.enumerateRanges === 'function') {
                var hrs = Process.enumerateRanges('rw-');
                for (var hi = 0; hi < hrs.length && asciiHits.length < 20; hi++) {
                  if (hrs[hi].size > 32 * 1024 * 1024) continue;
                  try {
                    var hf = Memory.scanSync(hrs[hi].base, hrs[hi].size, ap);
                    for (var hj = 0; hj < hf.length; hj++) {
                      asciiHits.push({
                        addr: hf[hj].address.toString(),
                        module: 'rw',
                        kind: 'ascii_hex'
                      });
                    }
                  } catch (eB) {}
                }
              }
            } catch (eC) {
              L('ascii scan ' + eC);
            }
          }
        } catch (e0) {
          L('scan err ' + e0);
        }
        var matched = [];
        var others = [];
        for (var k = 0; k < afterHits.length; k++) {
          var h = afterHits[k];
          if (gorgon && h.hex === String(gorgon).toLowerCase()) matched.push(h);
          else others.push(h);
        }
        var rec = {
          type: 'f3_native',
          opcode: opcode,
          handle: String(c),
          url: d == null ? null : String(d).slice(0, 900),
          gorgon: gorgon,
          gorgon_parse: gorgon ? analyzeGorgonHex(gorgon) : null,
          headers: headers,
          mem_match: matched,
          mem_ascii: asciiHits.slice(0, 12),
          mem_other_sample: others.slice(0, 5),
          mem_hit_count: afterHits.length,
          ts: Date.now()
        };
        lastSign = rec;
        send(rec);
        L('f3 sign gorgon=' + (gorgon || '').slice(0, 24) + ' mem_match=' + matched.length + ' mem_hits=' + afterHits.length);
      }
      return ret;
    };
    L('hooked f3.a');
  } catch (e) {
    L('f3 fail ' + e);
  }

  // Hex encode: some code paths use Integer.toHexString loop or custom
  // Hook String.format("%02x") is too noisy. Skip.

  // 尝试钩 libmetasec 里导出很少；仅记 base
});

rpc.exports = {
  ping: function () { return 'pong'; },
  last: function () { return lastSign; },
  scan: function () {
    return scanGorgonPatterns('manual');
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
  triggerSign: function (url, stub, ticket) {
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
        if (out.headers && out.headers['X-Gorgon']) {
          out.gorgon_parse = analyzeGorgonHex(out.headers['X-Gorgon']);
        }
      } catch (e) {
        out.error = String(e);
      }
    });
    return out;
  }
};

L('frida_gorgon_native ready');

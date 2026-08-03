/**
 * Gorgon 生成路径深挖：
 *  1) 钩 f3.a 标记签名窗口
 *  2) 钩 art JNI NewStringUTF / NewString：捕获 "8404..." 出现时的 native 栈
 *  3) 签名窗口内 Stalker 仅跟 libmetasec 模块，记录写 20/26 字节且内容含 0x84 0x04 的指令
 *
 * host: frida_gorgon_stalker.py
 */

function L(m) { send({ type: 'log', m: String(m) }); }

function toHex(p, n) {
  try {
    var a = [];
    for (var i = 0; i < n; i++) a.push(('0' + p.add(i).readU8().toString(16)).slice(-2));
    return a.join('');
  } catch (e) {
    return null;
  }
}

function isGorgonHexStr(s) {
  if (!s || s.length < 48) return false;
  s = String(s).toLowerCase();
  return s.indexOf('8404') === 0 && /^[0-9a-f]+$/.test(s.slice(0, 52));
}

var meta = null;
var signing = false;
var stalkerOn = false;
var writeHits = [];
var stringHits = [];
var maxWriteHits = 80;
var maxStringHits = 30;

function findMeta() {
  meta = Process.findModuleByName('libmetasec_ml.so');
  if (meta) L('metasec base=' + meta.base + ' size=' + meta.size);
  return meta;
}

function inMeta(addr) {
  if (!meta || !addr) return false;
  try {
    var a = ptr(addr);
    return a.compare(meta.base) >= 0 && a.compare(meta.base.add(meta.size)) < 0;
  } catch (e) {
    return false;
  }
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
  var a = [];
  try {
    Java.choose('com.dragon.read.base.http.b', {
      onMatch: function (inst) { a.push(inst); },
      onComplete: function () {}
    });
  } catch (e) {}
  return a.length ? a[0] : null;
}

function btCompact(ctx, limit) {
  limit = limit || 12;
  try {
    var bt = Thread.backtrace(ctx, Backtracer.ACCURATE);
    var out = [];
    for (var i = 0; i < bt.length && i < limit; i++) {
      out.push(DebugSymbol.fromAddress(bt[i]).toString());
    }
    return out;
  } catch (e) {
    try {
      var bt2 = Thread.backtrace(ctx, Backtracer.FUZZY);
      var out2 = [];
      for (var j = 0; j < bt2.length && j < limit; j++) {
        out2.push(DebugSymbol.fromAddress(bt2[j]).toString());
      }
      return out2;
    } catch (e2) {
      return [];
    }
  }
}

function startStalker(tid) {
  if (stalkerOn || !meta) return;
  stalkerOn = true;
  writeHits = [];
  try {
    Stalker.follow(tid, {
      transform: function (iterator) {
        var instruction;
        while ((instruction = iterator.next()) !== null) {
          var addr = instruction.address;
          // 只在 metasec 内加 callout，避免全局拖死
          if (inMeta(addr)) {
            // 粗：每条 store 类指令后检查（ARM64）
            var mne = instruction.mnemonic;
            if (mne && (mne.indexOf('str') === 0 || mne.indexOf('stp') === 0 || mne === 'stur')) {
              iterator.putCallout(function (context) {
                if (!signing || writeHits.length >= maxWriteHits) return;
                try {
                  // 检查 X0-X7 指向的内存是否像 gorgon
                  var regs = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'sp'];
                  for (var ri = 0; ri < regs.length; ri++) {
                    var rp = context[regs[ri]];
                    if (!rp) continue;
                    try {
                      var p = ptr(rp);
                      // 26 字节前缀
                      var b0 = p.readU8();
                      var b1 = p.add(1).readU8();
                      if (b0 === 0x84 && b1 === 0x04) {
                        var hex = toHex(p, 26);
                        if (hex && hex.slice(8, 12) === '0000') {
                          writeHits.push({
                            kind: 'ptr_gorgon26',
                            reg: regs[ri],
                            addr: p.toString(),
                            hex: hex,
                            pc: context.pc.toString(),
                            bt: btCompact(context, 10)
                          });
                        }
                      }
                      // 20 字节缓冲：不全是 0
                      // 略
                    } catch (eR) {}
                  }
                } catch (eC) {}
              });
            }
          }
          iterator.keep();
        }
      }
    });
    L('Stalker follow tid=' + tid);
  } catch (e) {
    L('Stalker fail ' + e);
    stalkerOn = false;
  }
}

function stopStalker(tid) {
  if (!stalkerOn) return;
  try {
    Stalker.unfollow(tid);
    Stalker.garbageCollect();
  } catch (e) {}
  stalkerOn = false;
  L('Stalker stop hits=' + writeHits.length);
}

function attachNewStringUTF(addr, label) {
  if (!addr) return false;
  try {
    Interceptor.attach(addr, {
      onEnter: function (args) {
        if (!signing) return;
        try {
          var cstr = args[1];
          if (!cstr || cstr.isNull()) return;
          var s = cstr.readUtf8String();
          if (!s) s = cstr.readCString();
          if (isGorgonHexStr(s)) {
            var hit = {
              type: 'newstring_utf',
              value: String(s).slice(0, 64),
              export: label,
              bt: btCompact(this.context, 14)
            };
            stringHits.push(hit);
            send(hit);
            L('NewStringUTF gorgon ' + String(s).slice(0, 24) + ' via ' + label);
          }
        } catch (e1) {}
      }
    });
    return true;
  } catch (e2) {
    return false;
  }
}

function resolveExport(modName, expName) {
  // Frida 17: Module.findExportByName 已移除
  try {
    if (typeof Module.getGlobalExportByName === 'function') {
      var g = Module.getGlobalExportByName(expName);
      if (g) return g;
    }
  } catch (e0) {}
  try {
    var m = Process.getModuleByName(modName);
    if (m && typeof m.getExportByName === 'function') return m.getExportByName(expName);
    if (m && typeof m.findExportByName === 'function') return m.findExportByName(expName);
  } catch (e1) {}
  return null;
}

function hookMemcpyFamily() {
  var names = ['memcpy', 'memmove', 'bcopy', '__memcpy_chk', '__memmove_chk'];
  var n = 0;
  for (var i = 0; i < names.length; i++) {
    try {
      var addr = resolveExport('libc.so', names[i]);
      if (!addr) continue;
      (function (label, a) {
        Interceptor.attach(a, {
          onEnter: function (args) {
            if (!signing) return;
            try {
              this._dst = args[0];
              this._src = args[1];
              this._n = args[2].toInt32();
            } catch (e0) {
              this._n = 0;
            }
          },
          onLeave: function () {
            if (!signing || !this._n) return;
            var ncopy = this._n;
            if (ncopy < 16 || ncopy > 64) return;
            if (writeHits.length >= maxWriteHits) return;
            try {
              var hex = toHex(this._dst, Math.min(ncopy, 32));
              if (!hex) return;
              var interesting = false;
              if (hex.indexOf('8404') === 0 && hex.length >= 12) interesting = true;
              // also capture 20-byte copies into buffers (common body20 size)
              if (ncopy === 20 || ncopy === 26 || ncopy === 32) interesting = true;
              if (!interesting) return;
              writeHits.push({
                kind: 'memcpy',
                label: label,
                n: ncopy,
                dst: this._dst.toString(),
                src: this._src ? this._src.toString() : null,
                hex: hex,
                bt: btCompact(this.context, 12)
              });
            } catch (e1) {}
          }
        });
        n++;
      })(names[i], addr);
    } catch (e2) {}
  }
  L('hooked memcpy family n=' + n);
}

/** 已知：Gorgon hex 经 NewStringUTF 出自 metasec+0x283640（相对 so 文件偏移） */
var GORGON_HEX_SITE_OFF = 0x283640;

function hookMetasecGorgonSite() {
  if (!meta) return;
  try {
    var site = meta.base.add(GORGON_HEX_SITE_OFF);
    Interceptor.attach(site, {
      onEnter: function (args) {
        if (!signing) return;
        try {
          // 此处多为 bl NewStringUTF 前；x0=JNIEnv, x1=cstr（不同调用约定下可能是 args）
          // 同时扫 SP 附近找 26 字节 84 04
          var sp = this.context.sp;
          var found = [];
          for (var off = 0; off < 0x400; off += 4) {
            try {
              var p = sp.add(off);
              if (p.readU8() === 0x84 && p.add(1).readU8() === 0x04) {
                var hx = toHex(p, 26);
                if (hx && hx.slice(8, 12) === '0000') {
                  found.push({ sp_off: off, hex: hx });
                }
              }
            } catch (e0) {}
          }
          // 寄存器当指针扫
          var regs = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10'];
          var regHits = [];
          for (var ri = 0; ri < regs.length; ri++) {
            try {
              var rp = ptr(this.context[regs[ri]]);
              var cstr = null;
              try { cstr = rp.readUtf8String(64); } catch (e1) {}
              var bin = null;
              try {
                if (rp.readU8() === 0x84 && rp.add(1).readU8() === 0x04) bin = toHex(rp, 26);
              } catch (e2) {}
              if ((cstr && isGorgonHexStr(cstr)) || bin) {
                regHits.push({ reg: regs[ri], ptr: rp.toString(), cstr: cstr, bin: bin });
              }
            } catch (e3) {}
          }
          var hit = {
            type: 'metasec_site',
            pc: site.toString(),
            off: '0x' + GORGON_HEX_SITE_OFF.toString(16),
            sp_gorgon: found.slice(0, 8),
            reg_hits: regHits,
            bt: btCompact(this.context, 16)
          };
          writeHits.push(hit);
          send(hit);
          L('metasec+0x283640 sp_hits=' + found.length + ' reg_hits=' + regHits.length);
        } catch (e) {
          L('site hook ' + e);
        }
      }
    });
    L('hooked metasec gorgon hex site +0x' + GORGON_HEX_SITE_OFF.toString(16));
  } catch (e) {
    L('hook site fail ' + e);
  }
}

function hookArtNewString() {
  var n = 0;
  try {
    var m = Process.getModuleByName('libart.so');
    var syms = m.enumerateSymbols();
    for (var j = 0; j < syms.length; j++) {
      var sn = syms[j].name || '';
      // 精确挂 NewStringUTF 实现（Frida 17 / ART 内联符号）
      if (sn.indexOf('JNIILb') >= 0 && sn.indexOf('NewStringUTFEP7_JNIEnvPKc') >= 0 && sn.indexOf('E19prev') < 0) {
        if (attachNewStringUTF(syms[j].address, sn.slice(0, 80))) n++;
      }
      if (sn.indexOf('String_fillBytesLatin1') >= 0) {
        try {
          Interceptor.attach(syms[j].address, {
            onEnter: function (args) {
              if (!signing) return;
              this._jstr = args[1];
            },
            onLeave: function () {
              if (!signing || writeHits.length >= maxWriteHits) return;
              try {
                // 读 Java String 太重；仅记 bt
              } catch (eL) {}
            }
          });
          n++;
        } catch (eF) {}
      }
    }
  } catch (e1) {
    L('enum symbols ' + e1);
  }
  L('hooked NewStringUTF/latin1 candidates n=' + n);
}

Java.perform(function () {
  findMeta();
  hookMemcpyFamily();
  hookMetasecGorgonSite();
  try { hookArtNewString(); } catch (eA) { L('NewStringUTF skip ' + eA); }

  try {
    var f3 = Java.use('ms.bd.c.f3');
    f3.a.implementation = function (a, b, c, d, e) {
      var opcode = a | 0;
      var isSign = (opcode === 0x3000001 || opcode === 50331649);
      var tid = Process.getCurrentThreadId();
      var useStalker = false; // memcpy 钩更稳；需要时改 true
      if (isSign) {
        signing = true;
        writeHits = [];
        if (useStalker) startStalker(tid);
      }
      var ret;
      try {
        ret = this.a(a, b, c, d, e);
      } finally {
        if (isSign) {
          if (useStalker) stopStalker(tid);
          signing = false;
        }
      }
      if (isSign) {
        var flat = dumpJavaArr(ret);
        var headers = {};
        var gorgon = null;
        if (flat) {
          for (var i = 0; i + 1 < flat.length; i += 2) {
            headers[String(flat[i])] = String(flat[i + 1]);
            if (String(flat[i]).toLowerCase() === 'x-gorgon') gorgon = String(flat[i + 1]);
          }
        }
        // filter writeHits matching final gorgon
        var matched = [];
        for (var w = 0; w < writeHits.length; w++) {
          if (gorgon && writeHits[w].hex === String(gorgon).toLowerCase().slice(0, 52)) {
            matched.push(writeHits[w]);
          }
        }
        var rec = {
          type: 'f3_stalker',
          opcode: opcode,
          gorgon: gorgon,
          headers: headers,
          write_hits: writeHits.slice(0, 40),
          write_match: matched,
          string_hits: stringHits.slice(-10),
          url: d == null ? null : String(d).slice(0, 400),
          ts: Date.now()
        };
        send(rec);
        L('f3 done gorgon=' + (gorgon || '').slice(0, 24) + ' writes=' + writeHits.length + ' match=' + matched.length + ' str=' + stringHits.length);
      }
      return ret;
    };
    L('hooked f3.a + stalker gate');
  } catch (e) {
    L('f3 hook fail ' + e);
  }
});

rpc.exports = {
  ping: function () { return 'pong'; },
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
      } catch (e) {
        out.error = String(e);
      }
    });
    return out;
  },
  stats: function () {
    return { writes: writeHits.length, strings: stringHits.length };
  }
};

L('frida_gorgon_stalker ready');

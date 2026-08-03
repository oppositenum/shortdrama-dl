/**
 * 在 NewStringUTF 收到 "8404..." 时：
 *  - 记录完整 bt
 *  - 扫调用者栈，找 26B 二进制 84 04 .. 00 00
 *  - 扫 x0-x28 指针
 *  - 对 metasec 内返回地址附近反汇编，找 bl 目标
 */
function L(m) { send({ type: 'log', m: String(m) }); }

function toHex(p, n) {
  var a = [];
  for (var i = 0; i < n; i++) {
    try { a.push(('0' + p.add(i).readU8().toString(16)).slice(-2)); }
    catch (e) { break; }
  }
  return a.join('');
}

function isGorgon(s) {
  if (!s || s.length < 48) return false;
  s = String(s).toLowerCase();
  return s.indexOf('8404') === 0 && /^[0-9a-f]+$/.test(s.slice(0, 52));
}

function scanRegion(base, size, tag, out, maxHits) {
  maxHits = maxHits || 8;
  for (var off = 0; off + 26 <= size && out.length < maxHits; off++) {
    try {
      var p = base.add(off);
      if (p.readU8() !== 0x84 || p.add(1).readU8() !== 0x04) continue;
      if (p.add(4).readU8() !== 0 || p.add(5).readU8() !== 0) continue;
      out.push({ tag: tag, off: off, addr: p.toString(), hex: toHex(p, 26) });
    } catch (e) {}
  }
}

function dumpRegs(ctx) {
  var regs = {};
  var names = [];
  for (var i = 0; i < 29; i++) names.push('x' + i);
  names.push('sp', 'lr', 'fp');
  for (var ni = 0; ni < names.length; ni++) {
    var r = names[ni];
    try {
      var v = ptr(ctx[r]);
      var item = { ptr: v.toString() };
      try { item.u64 = v.toString(); } catch (e0) {}
      try {
        var asc = v.readUtf8String(64);
        if (asc) item.ascii = asc.slice(0, 64);
      } catch (e1) {}
      try {
        if (v.readU8() === 0x84) item.hex32 = toHex(v, 32);
      } catch (e2) {}
      // always keep small hex peek
      try { item.peek = toHex(v, 16); } catch (e3) {}
      regs[r] = item;
    } catch (e4) {}
  }
  return regs;
}

var meta = null;
var signing = false;
var lastRec = null;

function findMeta() {
  meta = Process.findModuleByName('libmetasec_ml.so');
  if (meta) L('meta ' + meta.base);
  return meta;
}

function inMeta(addr) {
  if (!meta) return false;
  try {
    var a = ptr(addr);
    return a.compare(meta.base) >= 0 && a.compare(meta.base.add(meta.size)) < 0;
  } catch (e) { return false; }
}

function hookNewStringUTF() {
  var m = Process.getModuleByName('libart.so');
  var syms = m.enumerateSymbols();
  var n = 0;
  for (var i = 0; i < syms.length; i++) {
    var sn = syms[i].name || '';
    if (sn.indexOf('JNIILb0EE12NewStringUTFEP7_JNIEnvPKc') >= 0 && sn.indexOf('prev') < 0) {
      Interceptor.attach(syms[i].address, {
        onEnter: function (args) {
          if (!signing) return;
          try {
            var cstr = args[1];
            var s = cstr.readUtf8String();
            if (!isGorgon(s)) return;
            var bins = [];
            // 1) cstr 附近（有时 hex 紧挨着 raw）
            try { scanRegion(cstr.sub(0x80), 0x200, 'near_cstr', bins, 6); } catch (e0) {}
            // 2) SP 附近
            try { scanRegion(this.context.sp, 0x800, 'stack', bins, 10); } catch (e1) {}
            // 3) FP 附近
            try { scanRegion(ptr(this.context.fp).sub(0x400), 0x800, 'fp', bins, 6); } catch (e2) {}
            // 4) 每个寄存器当指针扫 64 字节窗口
            var regs = dumpRegs(this.context);
            for (var rk in regs) {
              if (!regs.hasOwnProperty(rk)) continue;
              try {
                var rp = ptr(regs[rk].ptr);
                scanRegion(rp.sub(0x40), 0x100, 'reg_' + rk, bins, 3);
              } catch (e3) {}
            }
            // 5) backtrace
            var bt = [];
            try {
              bt = Thread.backtrace(this.context, Backtracer.ACCURATE).map(function (a) {
                return DebugSymbol.fromAddress(a).toString();
              });
            } catch (e4) {
              try {
                bt = Thread.backtrace(this.context, Backtracer.FUZZY).map(function (a) {
                  return DebugSymbol.fromAddress(a).toString();
                });
              } catch (e5) {}
            }
            // 6) 反汇编 metasec 返回点前后
            var dis = [];
            try {
              var retAddr = this.returnAddress;
              if (inMeta(retAddr)) {
                var cur = retAddr.sub(0x40);
                for (var di = 0; di < 24; di++) {
                  try {
                    var ins = Instruction.parse(cur);
                    dis.push(cur.toString() + '  ' + ins.toString());
                    cur = cur.add(ins.size);
                  } catch (e6) { cur = cur.add(4); }
                }
              }
            } catch (e7) {}

            // match bins to gorgon binary
            var ghex = String(s).toLowerCase().slice(0, 52);
            var matched = [];
            for (var bi = 0; bi < bins.length; bi++) {
              if (bins[bi].hex === ghex) matched.push(bins[bi]);
            }

            lastRec = {
              type: 'gorgon_hexenc',
              gorgon: String(s).slice(0, 64),
              cstr: cstr.toString(),
              bins: bins.slice(0, 20),
              matched_bin: matched,
              regs: regs,
              bt: bt.slice(0, 20),
              disasm_ret: dis,
              ts: Date.now()
            };
            send(lastRec);
            L('GORGON NewStringUTF match_bin=' + matched.length + ' bins=' + bins.length + ' bt0=' + (bt[0] || ''));
          } catch (e) {
            L('onEnter ' + e);
          }
        }
      });
      n++;
      L('hooked ' + sn.slice(0, 60));
    }
  }
  return n;
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
      onMatch: function (i) { a.push(i); },
      onComplete: function () {}
    });
  } catch (e) {}
  return a.length ? a[0] : null;
}

Java.perform(function () {
  findMeta();
  var n = hookNewStringUTF();
  L('NewStringUTF hooks=' + n);

  try {
    var f3 = Java.use('ms.bd.c.f3');
    f3.a.implementation = function (a, b, c, d, e) {
      var op = a | 0;
      var isSign = (op === 0x3000001 || op === 50331649);
      if (isSign) signing = true;
      var ret;
      try { ret = this.a(a, b, c, d, e); }
      finally { if (isSign) signing = false; }
      return ret;
    };
    L('f3 gate ok');
  } catch (e) {
    L('f3 ' + e);
  }
});

rpc.exports = {
  ping: function () { return 'pong'; },
  last: function () { return lastRec; },
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
        hm.put('x-ss-stub', String(stub));
        hm.put('x-ss-req-ticket', String(ticket));
        var a = getAdapter();
        if (!a) { out.error = 'no_adapter'; return; }
        var ret = a.onCallToAddSecurityFactor(String(url), hm);
        out.headers = mapObj(ret);
      } catch (e) { out.error = String(e); }
    });
    return out;
  }
};

L('frida_gorgon_hexenc ready');

'use strict';
// 自校准版:key 偏移与 IV 取值自动适配不同架构/版本,失败则回退已验证默认值
function hex(p,n){try{return Array.from(new Uint8Array(p.readByteArray(n))).map(b=>('0'+b.toString(16)).slice(-2)).join('');}catch(e){return'';}}
function findAddr(mod,sym){const m=Process.findModuleByName(mod);if(!m)return null;let a=null;try{a=m.findExportByName(sym);}catch(e){}if(!a){try{const s=m.enumerateSymbols().find(x=>x.name===sym);if(s)a=s.address;}catch(e){}}return a;}

const initKey={};   // ctx -> 真 key(来自 av_aes_ctr_init)
const curIv={};     // ctx -> 真 IV(来自 set_full_iv / set_iv)
let CAL=null;       // 已校准的 key 访问方式 {deref, off}
const DEFAULT_CAL={deref:true, off:160};   // 本机已验证的默认
let sent={};        // key -> 本【测量窗口内】已发送条数(限流,减轻模拟器负担)
const LIMIT=60;     // 每集(每 key)每窗口最多抓 60 条锚点,足够算 key+双轨基址

// 【关键】限流计数必须能被清零,否则是"整个会话内每集只报 60 条"。
// 后果:一集只要被播过一次(踏脚石、抓完后的连播、预加载都算),它的 key 就永久静音;
// 之后真的导航到这一集时,Python 端一个解密事件也收不到 → 判成"到位却没抓到解密key"而整集失败。
// Python 在每次开测量窗口前 post({type:'reset'}),把配额清空,当前在播的那一集必定重新出声。
function armReset(){
  recv('reset', function(){ sent={}; armReset(); });
}
armReset();

function readKeyAt(ctxPtr, cal){
  try{ const base = cal.deref ? ctxPtr.readPointer() : ctxPtr; return hex(base.add(cal.off),16); }
  catch(e){ return ''; }
}
function calibrate(ctxPtr, wantHex){
  for(const deref of [true,false]){
    let base; try{ base = deref ? ctxPtr.readPointer() : ctxPtr; }catch(e){ continue; }
    for(let off=0; off<=1024; off+=4){
      let h; try{ h=hex(base.add(off),16); }catch(e){ break; }
      if(h===wantHex) return {deref, off};
    }
  }
  return null;
}

function go(){
  const initA=findAddr('libttffmpeg.so','av_aes_ctr_init');
  const fullIvA=findAddr('libttffmpeg.so','av_aes_ctr_set_full_iv');
  const ivA=findAddr('libttffmpeg.so','av_aes_ctr_set_iv');
  const cryptA=findAddr('libttffmpeg.so','av_aes_ctr_crypt');
  if(!cryptA){ setTimeout(go,400); return; }
  if(initA) Interceptor.attach(initA,{onEnter(a){ initKey[a[0].toString()]=hex(a[1],16); }});
  if(fullIvA) Interceptor.attach(fullIvA,{onEnter(a){ curIv[a[0].toString()]=hex(a[1],16); }});
  if(ivA) Interceptor.attach(ivA,{onEnter(a){ curIv[a[0].toString()]=hex(a[1],8)+'0000000000000000'; }});
  Interceptor.attach(cryptA,{onEnter(a){
    const ctx=a[0], cs=ctx.toString();
    let key=initKey[cs]||'';
    // 有真 key 且还没校准 -> 用它反推偏移
    if(key && !CAL){
      CAL=calibrate(ctx, key);
      console.log('[cal] key @ '+(CAL?((CAL.deref?'*(ctx)':'ctx')+'+'+CAL.off):'未找到,回退默认'));
      if(!CAL) CAL=DEFAULT_CAL;
    }
    // 没真 key(预加载的集)-> 用校准/默认偏移从内存读
    if(!key) key=readKeyAt(ctx, CAL||DEFAULT_CAL);
    // 限流:每集(key)抓够 LIMIT 条就不再 send —— 省掉最重的 IPC,避免压垮模拟器
    const n=sent[key]||0;
    if(n>=LIMIT) return;
    sent[key]=n+1;
    // IV:优先用 set_full_iv 抓到的真值,回退 ctx+8
    let iv=curIv[cs]; if(!iv) iv=hex(ctx.add(8),16);
    send({tag:'CRYPT', key:key, iv:iv, ct:hex(a[2],32)});
  }});
  console.log('[ready] 自校准 key 偏移 + set_full_iv 取 IV(回退 *(ctx)+160 / ctx+8)');
}
go();

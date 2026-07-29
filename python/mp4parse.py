import struct

def parse_boxes(data, start, end):
    boxes=[]; off=start
    while off+8<=end:
        size=struct.unpack('>I',data[off:off+4])[0]; typ=data[off+4:off+8]
        hdr=8
        if size==1:
            size=struct.unpack('>Q',data[off+8:off+16])[0]; hdr=16
        elif size==0:
            size=end-off
        boxes.append((typ, off, hdr, size))
        if size<=0: break
        off+=size
    return boxes

def find_box(data, start, end, path):
    # path like [b'moov', b'trak'] returns list of (off,hdr,size) for the last element under matches
    results=[]
    def rec(s,e,depth):
        for typ,o,hdr,size in parse_boxes(data,s,e):
            if typ==path[depth]:
                if depth==len(path)-1:
                    results.append((o,hdr,size))
                else:
                    rec(o+hdr, o+size, depth+1)
    rec(start,end,0)
    return results

def full_boxes(data):
    return parse_boxes(data, 0, len(data))

def track_format(data, trak_off, trak_end):
    """这条轨真正的编码 fourcc。加密轨的 stsd 写的是 'encv'/'enca',真实编码藏在 sinf/frma 里
    (hvc1=HEVC 能封装,bvc2=字节私有 ByteVC2 ffmpeg 完全不认)。读不出返回 None。"""
    stsd=find_box(data,trak_off+8,trak_end,[b'mdia',b'minf',b'stbl',b'stsd'])
    if not stsd: return None
    o,h,s=stsd[0]; end=o+s; off=o+h+8            # 跳过 version/flags + entry_count
    if off+8>end: return None
    esz=struct.unpack('>I',data[off:off+4])[0]; fmt=data[off+4:off+8]
    if fmt not in (b'encv',b'enca') or esz<=0: return fmt.decode('latin1',errors='replace')
    # 加密样本条目:视频 8+78 / 音频 8+28 之后才是子 box
    body=off+8+(78 if fmt==b'encv' else 28)
    for t2,o2,h2,s2 in parse_boxes(data,body,off+esz):
        if t2!=b'sinf': continue
        for t3,o3,h3,s3 in parse_boxes(data,o2+h2,o2+s2):
            if t3==b'frma': return data[o3+h3:o3+h3+4].decode('latin1',errors='replace')
    return fmt.decode('latin1',errors='replace')

def senc_base(data, trak_off, trak_end):
    """这条轨的起始 counter,取自 senc box 里第一个样本的 IV。

    这是【关键】:红果的 cenc-aes-ctr 把每个样本的 IV 写成连续递增的 8 字节计数器
    (第 idx 个样本 = base+idx),而 senc 里就明明白白存着这串 IV。
    也就是说 base 直接读文件就有,不必像早期那样靠 frida 抓到的密文锚点去反推——
    实测 24/24 条轨两种算法结果完全一致。
    好处是解密不再要求"这个文件本身被播放过":只要拿到这一集的 key,
    任何清晰度档位的同集文件都能解(各档位共用同一个 kid/key)。读不出返回 None。"""
    r=find_box(data,trak_off+8,trak_end,[b'mdia',b'minf',b'stbl',b'senc'])
    if not r: return None
    o,h,s=r[0]
    if s<16: return None
    cnt=struct.unpack('>I',data[o+12:o+16])[0]
    if cnt<=0 or (s-16)//cnt!=8: return None      # 只认 8 字节 IV、无子样本加密的布局
    return int.from_bytes(data[o+16:o+24],'big')

def get_tracks(data):
    """返回每条 trak 的样本列表:
    [{'handler':.., 'samples':[(offset,size), ...decode order], 'format':.., 'senc_base':..}]"""
    n=len(data)
    # 找 moov
    mv=[b for b in full_boxes(data) if b[0]==b'moov'][0]
    moov_s, moov_hdr, moov_sz = mv[1], mv[2], mv[3]
    tracks=[]
    for (to,th,ts) in find_box(data, moov_s+moov_hdr, moov_s+moov_sz, [b'trak']):
        ts_end=to+ts
        # handler type
        hdlr=find_box(data,to+8,ts_end,[b'mdia',b'hdlr'])
        handler=b'????'
        if hdlr:
            o,h,s=hdlr[0]; handler=data[o+h+8:o+h+12]
        def box1(name):
            r=find_box(data,to+8,ts_end,[b'mdia',b'minf',b'stbl',name])
            return r[0] if r else None
        stsz=box1(b'stsz'); stco=box1(b'stco'); co64=box1(b'co64'); stsc=box1(b'stsc')
        # sample sizes
        o,h,s=stsz
        p=o+h; ver_flags=data[p:p+4]; sample_size=struct.unpack('>I',data[p+4:p+8])[0]
        count=struct.unpack('>I',data[p+8:p+12])[0]
        sizes=[]
        if sample_size!=0:
            sizes=[sample_size]*count
        else:
            q=p+12
            for i in range(count):
                sizes.append(struct.unpack('>I',data[q:q+4])[0]); q+=4
        # chunk offsets
        if stco:
            o,h,s=stco; p=o+h; cc=struct.unpack('>I',data[p+4:p+8])[0]
            q=p+8; choff=[struct.unpack('>I',data[q+4*i:q+4*i+4])[0] for i in range(cc)]
        else:
            o,h,s=co64; p=o+h; cc=struct.unpack('>I',data[p+4:p+8])[0]
            q=p+8; choff=[struct.unpack('>Q',data[q+8*i:q+8*i+8])[0] for i in range(cc)]
        # stsc
        o,h,s=stsc; p=o+h; ec=struct.unpack('>I',data[p+4:p+8])[0]; q=p+8
        entries=[]
        for i in range(ec):
            first=struct.unpack('>I',data[q:q+4])[0]
            spc=struct.unpack('>I',data[q+4:q+8])[0]
            entries.append((first,spc)); q+=12
        # 展开每个 chunk 的样本数
        samples=[]
        si=0  # sample index
        for ci in range(cc):
            # 该 chunk 属于哪个 stsc entry
            spc=entries[0][1]
            for ei in range(len(entries)):
                if entries[ei][0]<=ci+1:
                    spc=entries[ei][1]
                else: break
            base=choff[ci]
            for k in range(spc):
                if si>=count: break
                samples.append((base, sizes[si]))
                base+=sizes[si]; si+=1
        tracks.append({'handler':handler.decode('latin1'),'samples':samples,'count':count,
                       'format':track_format(data,to,ts_end),'senc_base':senc_base(data,to,ts_end)})
    return tracks

UNSUPPORTED_FORMATS={'bvc2'}      # ffmpeg 认不出、也无法封装的私有编码

def unsupported_formats(data):
    """这个文件里 ffmpeg 处理不了的编码(通常是 ByteVC2)。空 = 全都能处理。"""
    return sorted({t['format'] for t in get_tracks(data)
                   if t['format'] in UNSUPPORTED_FORMATS})

#!/usr/bin/env python3
# 离线解密红果加密 MP4(App 的 .mdl 离线副本,或自己从 CDN 下的同集分片):
#   python3 decrypt_mdl.py <src> <captured.jsonl> <out.mp4> [--key HEX]
#
# 加密方案是 cenc-aes-ctr:每个样本一个 IV,IV = 8 字节计数器 + 8 字节 0,
# 计数器按解码顺序连续递增(第 idx 个样本 = base+idx)。
#
# base 从哪来:【优先直接读文件里的 senc box】——那串 IV 本来就写在文件里。
# 早期是靠 frida 抓到的密文锚点去反推 base(要求"这个文件本身被播放过"),
# senc 与锚点两种算法实测 24/24 条轨结果完全一致,所以锚点只保留为兜底。
# 这一步是能兼容 ByteVC2 的关键:有了它,拿到某集的 key 就能解【任意清晰度档位】的同集文件
# (各档位共用同一个 kid/key),于是可以绕开 App 只肯下的 720p,改用 1080p 的标准 HEVC 源。
import sys, json, struct, os, subprocess
import mp4parse
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def decrypt_sample(key, counter, ct):
    iv = struct.pack('>Q', counter & 0xFFFFFFFFFFFFFFFF) + b'\x00' * 8
    d = Cipher(algorithms.AES(key), modes.CTR(iv)).decryptor()
    return d.update(ct) + d.finalize()


def load_anchors(capjson):
    """捕获文件里的 密文首16字节 → (key, iv)。用于兜底求 base,以及在没给 --key 时找 key。"""
    anchors = {}
    key_of = {}
    try:
        rows = [json.loads(l) for l in open(capjson)]
    except Exception:
        return anchors
    for r in rows:
        if r.get('tag') == 'INIT' and r.get('ctx') and r.get('key'):
            key_of[r['ctx']] = r['key']
    for r in rows:
        if r.get('tag') != 'CRYPT' or not r.get('ct'):
            continue
        k = r.get('key') or key_of.get(r.get('ctx'))
        if k:
            anchors.setdefault(r['ct'][:32], (k, r.get('iv') or ''))
    return anchors


def match_anchor(data, track, anchors):
    """沿解码顺序找第一个"被捕获过"的样本,返回 (key_hex, base)。找不到返回 (None, None)。"""
    for idx, (soff, ssz) in enumerate(track['samples']):
        if soff + 16 > len(data):
            break
        hit = anchors.get(data[soff:soff + 16].hex())
        if hit:
            k, iv = hit
            base = int(iv[:16], 16) - idx if len(iv) >= 16 else None
            return k, base
    return None, None


def remux(src, out, extra=()):
    return subprocess.run(['ffmpeg', '-y', '-v', 'error', '-err_detect', 'ignore_err',
                           '-i', src, '-map', '0', '-c', 'copy', '-dn', '-ignore_unknown',
                           *extra, '-movflags', '+faststart', out],
                          capture_output=True, text=True)


def probe_codecs(path):
    """输出文件里实际存在的 (codec_type, codec_name)。用来确认视频轨没被悄悄丢掉。"""
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    out = []
    for line in r.stdout.strip().splitlines():
        parts = [p for p in line.split(',') if p]
        if len(parts) >= 2:
            out.append((parts[1], parts[0]) if parts[0] in ('video', 'audio') else (parts[0], parts[1]))
    return out


def main():
    argv = [a for a in sys.argv[1:]]
    key_hex = None
    if '--key' in argv:
        i = argv.index('--key')
        key_hex = argv[i + 1]
        del argv[i:i + 2]
    src, capjson, out = argv[0], argv[1], argv[2]

    data = bytearray(open(src, 'rb').read())
    n = len(data)
    tracks = mp4parse.get_tracks(bytes(data))
    print(f"[*] {os.path.basename(src)}  {n}B  轨道数={len(tracks)}")

    bad = mp4parse.unsupported_formats(bytes(data))
    if bad:
        # ByteVC2 之类的私有编码:解密能做,但 ffmpeg 既没有解码器也没有封装标签,封不出可播文件。
        # 早说清楚,别让上层拿着一个 0 字节输出去猜原因。
        print(f"[!] 这个文件用的是 ffmpeg 不支持的编码 {bad},无法封装。"
              f"请改用同一集的其它清晰度档位(1080p 通常是标准 HEVC)。")
        sys.exit(4)

    anchors = load_anchors(capjson) if not key_hex else {}
    # key 是【每个文件一把】(实测 83/83 个文件音视频轨共用同一把),所以任意一条轨认出来就够。
    # 早期是逐轨各找各的锚点,哪条轨没锚点就【整条轨跳过解密】——文件照样封装成功,
    # 只是那条轨全是乱码。实测 88 个文件里有 5 个踩到这个坑,而且不会报错。
    if not key_hex:
        for t in tracks:
            k, _ = match_anchor(bytes(data), t, anchors)
            if k:
                key_hex = k
                break
    if not key_hex:
        print("[!] 捕获文件里找不到这个文件的 key(这一集没被播放过?)")
        sys.exit(5)
    key = bytes.fromhex(key_hex)

    bases = []
    for ti, t in enumerate(tracks):
        base = t.get('senc_base')
        how = 'senc'
        if base is None:
            _, base = match_anchor(bytes(data), t, anchors)
            how = '锚点反推'
        bases.append(base)
        print(f"    track{ti} {t['handler']} {t['format']} 样本={t['count']} "
              f"base={hex(base) if base is not None else '缺'}({how})")
    if any(b is None for b in bases):
        # 有轨解不了就别出片:那条轨会是整片乱码,而封装照样"成功",最难被发现。
        print("[!] 有轨道求不出起始 counter,放弃出片(免得交付一条乱码轨)")
        sys.exit(6)

    dec = trunc = 0
    for ti, t in enumerate(tracks):
        base = bases[ti]
        for idx, (soff, ssz) in enumerate(t['samples']):
            if soff + ssz > n:
                trunc += 1
                continue
            data[soff:soff + ssz] = decrypt_sample(key, base + idx, bytes(data[soff:soff + ssz]))
            dec += 1
    print(f"[*] 解密样本 {dec} 个,截断跳过 {trunc} 个")
    if trunc:
        print(f"[!] 源文件被截断,有 {trunc} 个样本不在盘上")

    dec_path = out + '.dec.mp4'
    open(dec_path, 'wb').write(bytes(data))
    r = remux(dec_path, out)
    if not (os.path.exists(out) and os.path.getsize(out) > 0):
        r = remux(dec_path, out, ['-tag:v', 'hvc1'])       # 个别 HEVC 变体要显式打 tag

    if os.path.exists(out) and os.path.getsize(out) > 0:
        # 【必须确认视频轨还在】。remux 用了 -ignore_unknown,一旦 ffmpeg 选择"丢掉认不出的轨"
        # 而不是报错,产出的就是一个只有音轨的 MP4:体积正常、时长和 App 库记的完全对得上,
        # 于是时长校验也放行,最后当成功交付。实测这种文件 1.9MB / 234.24 秒,肉眼完全看不出问题。
        streams = probe_codecs(out)
        if not any(kind == 'video' for _, kind in streams):
            print(f"[!] 封装结果里没有视频轨(只有 {streams}),判为失败")
            os.remove(out)
            sys.exit(7)
        dur = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                              '-of', 'csv=p=0', out], capture_output=True, text=True).stdout.strip()
        print(f"[✓] 输出 {out}  时长={dur}s  轨道={streams}")
        os.remove(dec_path)
    else:
        print(f"[!] 封装失败,保留原始解密容器: {dec_path}")
        print("    ", r.stderr.strip()[:200])
        sys.exit(8)


if __name__ == '__main__':
    main()

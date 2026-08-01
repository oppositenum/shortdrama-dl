#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""spade_a → AES-128 content key.

算法来源（2026-07-31 还原）:
  - 播放器把 encrypt_info.spade_a 原样 base64 解码后交给 libttmplayer
    的 UnWrapper（约 0xc3650），**不经过** libvideodec 的 0xA8 头路径。
  - 红果当前样本：37 字节，tag 为 ASCII ``11``，走 app 默认变换（非 app_v2/web_v2）。
  - 变换后得到 ASCII：``{digit}{32-hex-key}{trailer}``，中间 32 hex 即内容密钥。

key 来源优先级:
  1) 调用方显式传入
  2) 纯本地 ``try_offline_unwrap(spade_a)``
  3) 磁盘缓存 {kid|spade_a → key_hex}
"""
from __future__ import annotations

import base64
import json
import os
import threading
from typing import Dict, Iterable, Optional, Tuple

_lock = threading.Lock()


def default_cache_path() -> str:
    runtime = os.environ.get("HONGGUO_RUNTIME_DIR") or os.path.dirname(os.path.abspath(__file__))
    return os.environ.get("SHORTDRAMA_KEY_CACHE") or os.path.join(runtime, "key_cache.json")


class KeyCache:
    def __init__(self, path: Optional[str] = None):
        self.path = path or default_cache_path()
        self._by_kid: Dict[str, str] = {}
        self._by_spade: Dict[str, str] = {}
        self.load()

    def load(self) -> None:
        if not os.path.exists(self.path):
            return
        try:
            data = json.loads(open(self.path, "r", encoding="utf-8").read())
        except Exception:
            return
        with _lock:
            self._by_kid = {str(k).lower(): str(v).lower() for k, v in (data.get("by_kid") or {}).items()}
            self._by_spade = {str(k): str(v).lower() for k, v in (data.get("by_spade") or {}).items()}

    def save(self) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(self.path)) or ".", exist_ok=True)
        with _lock:
            payload = {"by_kid": dict(self._by_kid), "by_spade": dict(self._by_spade)}
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, self.path)

    def get(self, *, kid: str = "", spade_a: str = "") -> Optional[str]:
        with _lock:
            if kid and kid.lower() in self._by_kid:
                return self._by_kid[kid.lower()]
            if spade_a and spade_a in self._by_spade:
                return self._by_spade[spade_a]
        return None

    def put(self, key_hex: str, *, kid: str = "", spade_a: str = "") -> None:
        key_hex = key_hex.lower().strip()
        if len(key_hex) != 32:
            raise ValueError(f"key must be 16-byte hex, got {key_hex!r}")
        with _lock:
            if kid:
                self._by_kid[kid.lower()] = key_hex
            if spade_a:
                self._by_spade[spade_a] = key_hex

    def resolve(self, *, kid: str = "", spade_a: str = "", explicit: str = "") -> Optional[str]:
        if explicit:
            return explicit.lower().strip()
        offline = try_offline_unwrap(spade_a) if spade_a else None
        if offline:
            return offline
        return self.get(kid=kid, spade_a=spade_a)


def spade_bytes(spade_a: str) -> bytes:
    return base64.b64decode(spade_a)


def _popcount64(x: int) -> int:
    return bin(x & 0xFFFFFFFFFFFFFFFF).count("1")


def _transform_default(body: bytearray, flag: int = 0) -> None:
    """libttmplayer UnWrapper 默认路径（tag 非 app_v2/web_v2）。

    循环内 0x55/0xFA 会被 body 字节链式覆盖，必须按寄存器语义实现。
    """
    w11, w12 = 0x55, 0xFA
    w10 = (-21) & 0xFFFFFFFF
    for i in range(len(body)):
        val = body[i]
        pc = _popcount64(i)
        even = (i & 1) == 0
        xor_c = w12 if even else w11
        w11 = w11 if even else val
        w12 = val if even else w12
        mixed = (xor_c ^ val) & 0xFFFFFFFF
        delta = ((w10 - pc) & 0xFFFFFFFF) if flag == 0 else ((pc + 21) & 0xFFFFFFFF)
        body[i] = (mixed + delta) & 0xFF


def _transform_app_web(body: bytearray, flag: int = 0) -> None:
    """tag 匹配 app_v2 / web_v2 前缀时的路径：成对交换 + 另一套链式变换。"""
    for i in range(0, len(body) - 1, 2):
        body[i], body[i + 1] = body[i + 1], body[i]
    w12, w13 = 0x55, 0xFA
    w11 = (-21) & 0xFFFFFFFF
    for i in range(len(body)):
        val = body[i]
        pc = _popcount64(i)
        even = (i & 1) == 0
        xor_c = w13 if even else w12
        sub_c = w12 if even else w13
        w12 = w12 if even else val
        w13 = val if even else w13
        mixed = ((xor_c ^ val) - sub_c) & 0xFFFFFFFF
        delta = ((w11 - pc) & 0xFFFFFFFF) if flag == 0 else ((pc + 21) & 0xFFFFFFFF)
        body[i] = (mixed + delta) & 0xFF
    for i in range(0, len(body) - 1, 2):
        body[i], body[i + 1] = body[i + 1], body[i]


def _parse_hex_digit(b: int) -> int:
    if 0x30 <= b <= 0x39:
        return b - 0x30
    if 0x61 <= b <= 0x66:
        return b - 0x57
    if 0x41 <= b <= 0x46:
        return b - 0x37
    return -1


def unwrap_spade(spade_a: str, *, flag: int = 0) -> str:
    """离线解包 spade_a，返回 32 字符小写 hex（16 字节 AES key）。

    失败抛 ValueError。
    """
    raw = base64.b64decode(spade_a)
    n = len(raw)
    if n < 5:
        raise ValueError(f"spade too short: {n}")

    xored = (raw[1] ^ raw[0] ^ raw[2]) & 0xFF
    suffix_len = xored - 0x30
    if suffix_len < 1 or suffix_len >= n - 2:
        raise ValueError(f"bad suffix_len={suffix_len} (xored=0x{xored:02x})")

    body_len = n - xored + 0x2F
    if body_len < 1 or 1 + body_len > n:
        raise ValueError(f"bad body_len={body_len}")

    body = bytearray(raw[1 : 1 + body_len])
    base = n - suffix_len
    seed = raw[base - 1] ^ raw[base - 2]
    tag = bytes(seed ^ raw[base + i] for i in range(suffix_len))

    # strncmp(tag, "app_v2"|"web_v2", suffix_len)
    if tag == b"app_v2"[:suffix_len] or tag == b"web_v2"[:suffix_len]:
        _transform_app_web(body, flag)
    else:
        _transform_default(body, flag)

    digit = _parse_hex_digit(body[0])
    if digit < 0:
        raise ValueError(f"bad length digit 0x{body[0]:02x}")
    if body_len - digit < 2:
        raise ValueError("decoded payload too short")

    key_ascii = bytes(body[1 : body_len - digit])
    try:
        key_hex = key_ascii.decode("ascii")
    except UnicodeDecodeError as e:
        raise ValueError("key is not ascii hex") from e
    if len(key_hex) != 32 or any(c not in "0123456789abcdefABCDEF" for c in key_hex):
        raise ValueError(f"bad key ascii: {key_hex!r}")
    return key_hex.lower()


def try_offline_unwrap(spade_a: str) -> Optional[str]:
    """纯本地 spade 解包；失败返回 None。"""
    if not spade_a:
        return None
    try:
        return unwrap_spade(spade_a)
    except Exception:
        return None


def import_keys_from_capture_pairs(pairs: Iterable[Tuple[str, str, str]], cache: KeyCache) -> int:
    """导入 (kid, spade_a, key_hex) 三元组。"""
    n = 0
    for kid, spade_a, key_hex in pairs:
        if not key_hex:
            continue
        cache.put(key_hex, kid=kid or "", spade_a=spade_a or "")
        n += 1
    if n:
        cache.save()
    return n


if __name__ == "__main__":
    import sys

    cache_path = os.environ.get("SHORTDRAMA_KEY_CACHE") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "key_cache.json"
    )
    if len(sys.argv) > 1:
        for sp in sys.argv[1:]:
            print(sp[:32] + "...", "=>", unwrap_spade(sp))
    elif os.path.exists(cache_path):
        data = json.loads(open(cache_path, encoding="utf-8").read())
        ok = 0
        total = 0
        for sp, expect in (data.get("by_spade") or {}).items():
            total += 1
            got = unwrap_spade(sp)
            if got == expect.lower():
                ok += 1
            else:
                print("MISMATCH", got, expect)
        print(f"{ok}/{total} OK")
    else:
        print("usage: spade_keys.py <spade_a> [spade_a ...]", file=sys.stderr)
        sys.exit(2)

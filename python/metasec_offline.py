#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MetaSec offline signing — pure Python（可脱离模拟器）.

Status 2026-08-04（实测验收）:
  ✅ X-Khronos  = unix seconds（或 ticket_ms // 1000）
  ✅ X-Argus    = base64(LE uint32 of Khronos)  # aid=8662 短形态
  ✅ X-Gorgon   = 8404 | mid(2) | 0000 | cascade(param, key(mid))
      - param = md5(query)[:4] + md5(body)[:4] + 0000 + const(0,6,0x0b,0x1c) + BE(khronos)
      - cascade = 经典 leviathan nibble-swap / rbit 轮换（与开源 0404/0408 同结构）
      - mid 形态恒为 N0XX（高字节低 4 bit 为 0）→ 12 bit 熵
      - key = f(mid)：代数式未完全还原，但 **同一 mid→key 可跨请求复用**
        服务端已验收：固定 mid/key 离线算 Gorgon + Khronos → video_detail/model code=0
  ✅ 消融最小集：Khronos+Gorgon 即可（Helios+Medusa 为另一条路径）
  ⏳ mid→key 的闭式 KDF（不依赖 oracle）仍 open；产品用内置 oracle 条目即可
  ⏳ X-Ladon / X-Helios / X-Medusa 完整算法未离线

产品路径：
  OfflineSigner.post_json / sign_kg_headers — 纯 Python，无需 Frida/模拟器
  110001 时优先走离线 Gorgon；仍失败再考虑 TtnetDeviceSigner
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

SAMPLES = Path(__file__).resolve().parent / "sign_samples"
ORACLE_PATH = SAMPLES / "gorgon_mid_key_oracle.json"

# f3.a opcodes (from ms.bd.c.y4 smali)
OP_STRDEC = 0x1000001
OP_HTTP_SIGN = 0x3000001
OP_ALT_SIGN = 0x6000001

# Native (AArch64) relative to libmetasec_ml.so load VA 0x0
F3_JNI_TRAMPOLINE = 0x281AD4
F3_DISPATCHER = 0x17F5A4
F3_VM = 0x173BA4  # FUN_00273ba4 jumptable
JNI_ONLOAD = 0x28F03C

# Classic Gorgon const (开源 leviathan / 本项目 corpus 交叉验证)
GORGON_CONST = (0x00, 0x06, 0x0B, 0x1C)
GORGON_PREFIX = bytes((0x84, 0x04))
GORGON_PAD = bytes((0x00, 0x00))

# 内置 fallback mid/key（来自 emulator 语料，已对线上 video_* 验收）
# mid 形态 N0XX；key 与 mid 绑定且跨请求稳定
_DEFAULT_MID_KEY: Tuple[str, str] = (
    "401c",
    "44b9b9d9a4aef9fca493aa757ca3c2c4a496938f",
)

USER_AGENT_DEFAULT = (
    "com.phoenix.read/72732 (Linux; U; Android 14; zh_CN; "
    "sdk_gphone64_arm64; Build/UE1A.230829.036;tt-ok/10.0.0.1)"
)


# ---------------------------------------------------------------------------
# 基础类型
# ---------------------------------------------------------------------------


@dataclass
class SignInput:
    url: str
    body: bytes
    ticket_ms: Optional[int] = None
    handle: Optional[int] = None

    @property
    def stub(self) -> str:
        return hashlib.md5(self.body).hexdigest().upper()

    @property
    def ticket(self) -> str:
        return str(self.ticket_ms if self.ticket_ms is not None else int(time.time() * 1000))

    def flat_pairs(self) -> List[str]:
        return ["x-ss-stub", self.stub, "x-ss-req-ticket", self.ticket]


@dataclass
class SignOutput:
    headers: Dict[str, str]

    @classmethod
    def from_flat(cls, pairs: Sequence[str]) -> "SignOutput":
        h: Dict[str, str] = {}
        for i in range(0, len(pairs) - 1, 2):
            h[str(pairs[i])] = str(pairs[i + 1])
        return cls(headers=h)


def flat_to_dict(pairs: Sequence[str]) -> Dict[str, str]:
    return SignOutput.from_flat(pairs).headers


# ---------------------------------------------------------------------------
# Khronos / Argus
# ---------------------------------------------------------------------------


def khronos_from_ticket(ticket_ms: int | str) -> int:
    t = int(ticket_ms)
    return t // 1000


def khronos_now() -> int:
    return int(time.time())


def encode_argus_short(khronos: int) -> str:
    """aid=8662 short Argus: base64(little-endian uint32(khronos))."""
    return base64.b64encode(struct.pack("<I", int(khronos) & 0xFFFFFFFF)).decode("ascii")


# ---------------------------------------------------------------------------
# Gorgon 8404 cascade
# ---------------------------------------------------------------------------


def rev_nib(n: int) -> int:
    t = f"{n & 0xFF:02x}"
    return int(t[1] + t[0], 16)


def rbit(n: int) -> int:
    return int(bin(n & 0xFF)[2:].zfill(8)[::-1], 2)


def encrypt_cascade(param: Sequence[int], key: Sequence[int], length: int = 0x14) -> List[int]:
    """经典 leviathan 级联加密 → 20 字节 body。"""
    if len(param) < length or len(key) < length:
        raise ValueError("param/key must be >= 20 bytes")
    eor = [a ^ b for a, b in zip(param[:length], key[:length])]
    for i in range(length):
        c = rev_nib(eor[i])
        d = eor[(i + 1) % length]
        e = c ^ d
        f = rbit(e)
        eor[i] = ((f ^ 0xFFFFFFFF) ^ length) & 0xFF
    return eor


def decrypt_to_eor(cipher: Sequence[int], length: int = 0x14) -> List[int]:
    """从 body20 反推 eor = param XOR key（cascade 逆运算）。"""
    eor = list(cipher[:length])
    for i in range(length - 1, -1, -1):
        h = eor[i]
        d = eor[(i + 1) % length]
        x = rbit(h ^ 0xEB) ^ d
        eor[i] = rev_nib(x)
    return eor


def md5_bytes(data: Union[str, bytes]) -> bytes:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.md5(data).digest()


def gorgon_param(
    query: str,
    body_or_stub: Union[bytes, str],
    khronos: int,
    *,
    cookie4: bytes = b"\x00\x00\x00\x00",
    const: Sequence[int] = GORGON_CONST,
) -> List[int]:
    """构造 20 字节 param。

    query: URL 的 query string（不含 '?'），**不要** path/host。
    body_or_stub: POST body bytes，或 32-char MD5 hex stub。
    """
    if isinstance(body_or_stub, str) and len(body_or_stub) == 32:
        data4 = bytes.fromhex(body_or_stub.lower())[:4]
    else:
        raw = body_or_stub if isinstance(body_or_stub, bytes) else body_or_stub.encode("utf-8")
        data4 = md5_bytes(raw)[:4]
    url4 = md5_bytes(query)[:4]
    c4 = (cookie4 + b"\x00\x00\x00\x00")[:4]
    ts = struct.pack(">I", int(khronos) & 0xFFFFFFFF)
    return list(url4) + list(data4) + list(c4) + list(const) + list(ts)


def analyze_gorgon(hex_str: str) -> Dict[str, object]:
    raw = bytes.fromhex(hex_str)
    return {
        "len": len(raw),
        "prefix": raw[:2].hex() if len(raw) >= 2 else "",
        "mid": raw[2:4].hex() if len(raw) >= 4 else "",
        "pad": raw[4:6].hex() if len(raw) >= 6 else "",
        "body20": raw[6:26].hex() if len(raw) >= 26 else raw[6:].hex(),
        "raw": raw.hex(),
    }


def parse_gorgon_hex(hex_str: str) -> Dict[str, object]:
    raw = bytes.fromhex(hex_str)
    if len(raw) < 26:
        raise ValueError(f"gorgon too short: {len(raw)}")
    return {
        "prefix": raw[:2].hex(),
        "mid": raw[2:4].hex(),
        "pad": raw[4:6].hex(),
        "body20": raw[6:26].hex(),
        "len": len(raw),
    }


def recover_key_from_sample(
    gorgon_hex: str,
    query: str,
    body_or_stub: Union[bytes, str],
    khronos: int,
) -> bytes:
    """从已捕获的 X-Gorgon 反推 20 字节 key（依赖 classic param 布局）。"""
    raw = bytes.fromhex(gorgon_hex.lower())
    body20 = raw[6:26]
    param = gorgon_param(query, body_or_stub, khronos)
    eor = decrypt_to_eor(body20)
    return bytes(a ^ b for a, b in zip(eor, param))


def encode_gorgon_8404(
    query: str,
    body_or_stub: Union[bytes, str],
    khronos: int,
    mid: bytes,
    key: bytes,
) -> str:
    """离线生成 X-Gorgon（52 hex chars）。"""
    if len(mid) != 2:
        raise ValueError("mid must be 2 bytes")
    if len(key) < 20:
        raise ValueError("key must be >= 20 bytes")
    # mid 形态校验（软）：高字节低 nibble 应为 0
    param = gorgon_param(query, body_or_stub, khronos)
    body20 = bytes(encrypt_cascade(param, list(key[:20])))
    return (GORGON_PREFIX + mid + GORGON_PAD + body20).hex()


def query_of_url(url: str) -> str:
    if "?" not in url:
        return ""
    return url.split("?", 1)[1]


# ---------------------------------------------------------------------------
# mid → key oracle
# ---------------------------------------------------------------------------


def load_mid_key_oracle(path: Optional[Path] = None) -> Dict[str, str]:
    """mid_hex → key_hex。优先读文件，并合并内置默认。"""
    out: Dict[str, str] = {_DEFAULT_MID_KEY[0]: _DEFAULT_MID_KEY[1]}
    p = path or ORACLE_PATH
    if p.is_file():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for k, v in data.items():
                    if isinstance(k, str) and isinstance(v, str) and len(k) == 4 and len(v) == 40:
                        out[k.lower()] = v.lower()
        except Exception:
            pass
    return out


def pick_mid_key(oracle: Optional[Dict[str, str]] = None) -> Tuple[bytes, bytes]:
    o = oracle if oracle is not None else load_mid_key_oracle()
    # 优先默认 mid（已验收）
    if _DEFAULT_MID_KEY[0] in o:
        m, k = _DEFAULT_MID_KEY[0], o[_DEFAULT_MID_KEY[0]]
    else:
        m, k = next(iter(o.items()))
    return bytes.fromhex(m), bytes.fromhex(k)


# ---------------------------------------------------------------------------
# 离线签名输出
# ---------------------------------------------------------------------------


def sign_kg_headers(
    url: str,
    body: bytes,
    *,
    khronos: Optional[int] = None,
    mid: Optional[bytes] = None,
    key: Optional[bytes] = None,
    include_argus: bool = False,
    ticket_ms: Optional[int] = None,
) -> Dict[str, str]:
    """生成抗 110001 的最小安全头：X-Khronos + X-Gorgon。

    url 必须带 query；Gorgon 只哈希 query 部分。
    """
    kh = int(khronos if khronos is not None else (ticket_ms // 1000 if ticket_ms else khronos_now()))
    if mid is None or key is None:
        mid, key = pick_mid_key()
    q = query_of_url(url)
    stub = hashlib.md5(body).hexdigest().upper()
    g = encode_gorgon_8404(q, stub, kh, mid, key)
    ticket = str(ticket_ms if ticket_ms is not None else int(time.time() * 1000))
    h = {
        "x-ss-stub": stub,
        "x-ss-req-ticket": ticket,
        "X-Khronos": str(kh),
        "X-Gorgon": g,
    }
    if include_argus:
        h["X-Argus"] = encode_argus_short(kh)
    return h


def partial_headers(inp: SignInput) -> Dict[str, str]:
    """仅 Khronos/Argus/stub/ticket（无 Gorgon）。"""
    ticket = inp.ticket
    kh = khronos_from_ticket(ticket)
    return {
        "x-ss-stub": inp.stub,
        "x-ss-req-ticket": ticket,
        "X-Khronos": str(kh),
        "X-Argus": encode_argus_short(kh),
    }


def analyze_argus(b64: str) -> Dict[str, object]:
    pad = b64 + "=" * ((4 - len(b64) % 4) % 4)
    try:
        raw = base64.b64decode(pad)
    except Exception as e:
        return {"error": str(e)}
    info: Dict[str, object] = {
        "len": len(raw),
        "hex": raw.hex(),
        "ascii": raw.decode("latin1", "replace"),
    }
    if len(raw) == 4:
        le = struct.unpack("<I", raw)[0]
        info["u32le"] = le
        info["equals_khronos_form"] = True
    return info


def load_corpus(path: Optional[Path] = None) -> list:
    p = path or (SAMPLES / "f3_diff_corpus.json")
    if not p.exists():
        return []
    return json.loads(p.read_text(encoding="utf-8"))


def verify_corpus_argus(corpus: Optional[list] = None) -> bool:
    corpus = corpus if corpus is not None else load_corpus()
    if not corpus:
        return False
    for c in corpus:
        out = c.get("out") or {}
        kh = int(out.get("X-Khronos") or 0)
        a = out.get("X-Argus") or ""
        if encode_argus_short(kh) != a and encode_argus_short(kh).rstrip("=") != a.rstrip("="):
            pad = a + "=" * ((4 - len(a) % 4) % 4)
            raw = base64.b64decode(pad)
            if len(raw) != 4 or struct.unpack("<I", raw)[0] != kh:
                return False
    return True


def verify_oracle_roundtrip(oracle: Optional[Dict[str, str]] = None, limit: int = 8) -> int:
    """用语料反推：oracle key 能否复现样本 body20。返回通过数。"""
    o = oracle if oracle is not None else load_mid_key_oracle()
    ok = 0
    n = 0
    for path in (SAMPLES / "gorgon_live_corpus.json", SAMPLES / "gorgon_diff_corpus.json"):
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        items = data.get("samples") if isinstance(data, dict) else data
        for s in items or []:
            if n >= limit:
                return ok
            h = s.get("headers") or {}
            g = h.get("X-Gorgon")
            url = s.get("url") or ""
            stub = s.get("stub") or h.get("x-ss-stub")
            kh = int(h.get("X-Khronos") or 0)
            if not g or not url or not stub or not kh:
                continue
            mid = bytes.fromhex(g.lower())[2:4].hex()
            if mid not in o:
                continue
            q = query_of_url(url)
            pred = encode_gorgon_8404(q, stub, kh, bytes.fromhex(mid), bytes.fromhex(o[mid]))
            n += 1
            if pred.lower() == g.lower():
                ok += 1
    return ok


class OfflineMetaSecNotImplemented(NotImplementedError):
    pass


def sign_offline(inp: SignInput) -> SignOutput:
    """完整六神离线（Gorgon 用 oracle；无 Helios/Medusa/Ladon）。

    产品上 Khronos+Gorgon 已够过 110001；此函数返回 KG（+短 Argus）。
    """
    h = sign_kg_headers(inp.url, inp.body, ticket_ms=int(inp.ticket), include_argus=True)
    return SignOutput(headers=h)


# ---------------------------------------------------------------------------
# 可挂到 HongguoApiClient 的离线 Signer（无 Frida）
# ---------------------------------------------------------------------------


class OfflineSigner:
    """纯 Python TTNet 最小签名：Khronos + Gorgon。

    接口对齐 TtnetDeviceSigner 的常用方法：sign_headers / post_json / full_url(no-op)。
    """

    def __init__(
        self,
        *,
        mid: Optional[str] = None,
        key: Optional[str] = None,
        timeout: float = 30.0,
        user_agent: str = USER_AGENT_DEFAULT,
        include_argus: bool = False,
    ):
        oracle = load_mid_key_oracle()
        if mid and key:
            self.mid = bytes.fromhex(mid)
            self.key = bytes.fromhex(key)
        elif mid and mid.lower() in oracle:
            self.mid = bytes.fromhex(mid.lower())
            self.key = bytes.fromhex(oracle[mid.lower()])
        else:
            self.mid, self.key = pick_mid_key(oracle)
        self.timeout = timeout
        self.user_agent = user_agent
        self.include_argus = include_argus

    def full_url(self, base: str) -> str:
        """离线无 App addCommonParams；原样返回（调用方应用 DEFAULT_DEVICE query）。"""
        return base

    def sign_headers(self, url: str, body: bytes) -> Dict[str, str]:
        return sign_kg_headers(
            url,
            body,
            mid=self.mid,
            key=self.key,
            include_argus=self.include_argus,
        )

    def post_json(
        self, base_url: str, payload: Dict[str, Any], *, max_bytes: int = 64 << 20
    ) -> Dict[str, Any]:
        if "://" not in base_url:
            base_url = "https://api5-normal-sinfonlinea.fqnovel.com" + base_url
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        sec = self.sign_headers(base_url, body)
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        headers.update(sec)
        req = urllib.request.Request(base_url, data=body, method="POST", headers=headers)
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read(max_bytes).decode("utf-8", "replace")
        return json.loads(raw)

    def ensure_alive(self) -> None:
        return None

    def detach(self) -> None:
        return None

    def is_alive(self) -> bool:
        return True

    def __enter__(self) -> "OfflineSigner":
        return self

    def __exit__(self, *exc) -> None:
        return None


def build_host_headers(
    sign_out: SignOutput, body: bytes, ticket: str, user_agent: str
) -> Dict[str, str]:
    h = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": user_agent,
        "x-ss-stub": hashlib.md5(body).hexdigest().upper(),
        "x-ss-req-ticket": ticket,
    }
    h.update(sign_out.headers)
    return h


def corpus_report(corpus: Optional[list] = None) -> str:
    corpus = corpus if corpus is not None else load_corpus()
    lines = [
        f"corpus size={len(corpus)}",
        f"argus==le(khronos) all={verify_corpus_argus(corpus)}",
        f"oracle mids={len(load_mid_key_oracle())}",
        f"oracle roundtrip ok={verify_oracle_roundtrip()}",
    ]
    for i, c in enumerate(corpus[:6]):
        out = c.get("out") or {}
        g = out.get("X-Gorgon", "")
        a = out.get("X-Argus", "")
        lines.append(
            f"[{i}] stub={c.get('stub', '')[:8]}… ticket={c.get('ticket')} "
            f"kh={out.get('X-Khronos')} g={g[:20]}… argus={a} "
            f"g_info={analyze_gorgon(g) if g else None}"
        )
    return "\n".join(lines)


def main() -> int:
    print(corpus_report())
    print("\n--- offline self-check ---")
    print(f"OP_HTTP_SIGN=0x{OP_HTTP_SIGN:x}")
    sample = SignInput(
        url="https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/?aid=8662&device_id=1",
        body=b'{"series_id":"1"}',
    )
    print("partial:", partial_headers(sample))
    print("sign_offline:", sign_offline(sample).headers)
    # roundtrip param
    mid, key = pick_mid_key()
    q = query_of_url(sample.url)
    g = encode_gorgon_8404(q, sample.body, khronos_now(), mid, key)
    print("sample gorgon", g, analyze_gorgon(g))
    rec = recover_key_from_sample(g, q, sample.body, khronos_now())
    # kh may skew by 1 if clock crosses second — use same kh
    kh = khronos_now()
    g2 = encode_gorgon_8404(q, sample.body, kh, mid, key)
    rec2 = recover_key_from_sample(g2, q, sample.body, kh)
    print("key match", rec2 == key, "mid", mid.hex())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

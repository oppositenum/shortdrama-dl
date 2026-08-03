#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MetaSec offline signing — protocol + partial pure reimplementation.

Status (2026-08-01, revalidated):
  Java chain fully reverse-engineered.
  f3.a I/O captured; libmetasec_ml.so is a CFF/VM (FUN_00273ba4).

  Pure offline reimplementation of full six-header set is incomplete:
    ✅ X-Khronos  = ticket_ms // 1000  (or wall clock seconds)
    ✅ X-Argus    = base64(LE uint32 of Khronos)   # short 4-byte form on aid=8662
    ⏳ X-Gorgon   = 8404 + 2 mid + 0000 + 20B encrypted body (key not stable across reqs)
    ⏳ X-Ladon / X-Helios / X-Medusa  (Medusa is the heavy payload; VM-backed)

  IMPORTANT — product path does NOT need offline MetaSec right now:
    2026-08-01 retest: video_detail / video_model return code=0 with only
    common query (aid/device_id/iid/…) and no security headers.
    Full e2e: api_grab.py ep1+ep2 1080p decrypted MP4 without Frida.

  When server returns 110001, use ttnet_signer.TtnetDeviceSigner / --device-sign.
"""
from __future__ import annotations

import base64
import hashlib
import json
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence

SAMPLES = Path(__file__).resolve().parent / "sign_samples"

# f3.a opcodes (from ms.bd.c.y4 smali)
OP_STRDEC = 0x1000001
OP_HTTP_SIGN = 0x3000001
OP_ALT_SIGN = 0x6000001

# Native (AArch64) relative to libmetasec_ml.so load VA 0x0
F3_JNI_TRAMPOLINE = 0x281AD4
F3_DISPATCHER = 0x17F5A4
F3_VM = 0x173BA4  # FUN_00273ba4 jumptable
JNI_ONLOAD = 0x28F03C


@dataclass
class SignInput:
    url: str
    body: bytes
    ticket_ms: Optional[int] = None
    handle: Optional[int] = None  # ms.bd.c.z4.a session handle

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


def khronos_from_ticket(ticket_ms: int | str) -> int:
    t = int(ticket_ms)
    # corpus: Khronos ≈ ticket//1000 (sometimes +1 due to clock skew inside native)
    return t // 1000


def encode_argus_short(khronos: int) -> str:
    """aid=8662 short Argus: base64(little-endian uint32(khronos)).

    Corpus check: Argus u32le == X-Khronos for all f3_diff_corpus samples.
    """
    return base64.b64encode(struct.pack("<I", int(khronos) & 0xFFFFFFFF)).decode("ascii")


def analyze_gorgon(hex_str: str) -> Dict[str, object]:
    raw = bytes.fromhex(hex_str)
    return {
        "len": len(raw),
        "prefix": raw[:2].hex() if len(raw) >= 2 else "",
        "mid": raw[2:4].hex() if len(raw) >= 4 else "",
        "pad": raw[4:6].hex() if len(raw) >= 6 else "",
        "body20": raw[6:].hex() if len(raw) > 6 else "",
        "raw": raw.hex(),
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
    """Return True if every sample's Argus is LE(khronos)."""
    corpus = corpus if corpus is not None else load_corpus()
    if not corpus:
        return False
    for c in corpus:
        out = c.get("out") or {}
        kh = int(out.get("X-Khronos") or 0)
        a = out.get("X-Argus") or ""
        if encode_argus_short(kh) != a and encode_argus_short(kh).rstrip("=") != a.rstrip("="):
            # tolerate padding differences
            pad = a + "=" * ((4 - len(a) % 4) % 4)
            raw = base64.b64decode(pad)
            if len(raw) != 4 or struct.unpack("<I", raw)[0] != kh:
                return False
    return True


def corpus_report(corpus: Optional[list] = None) -> str:
    corpus = corpus if corpus is not None else load_corpus()
    lines = [
        f"corpus size={len(corpus)}",
        f"argus==le(khronos) all={verify_corpus_argus(corpus)}",
    ]
    for i, c in enumerate(corpus):
        out = c.get("out") or {}
        g = out.get("X-Gorgon", "")
        a = out.get("X-Argus", "")
        lines.append(
            f"[{i}] stub={c.get('stub','')[:8]}… ticket={c.get('ticket')} "
            f"kh={out.get('X-Khronos')} g={g[:20]}… argus={a} "
            f"g_info={analyze_gorgon(g) if g else None} argus_info={analyze_argus(a) if a else None}"
        )
    return "\n".join(lines)


def build_host_headers(sign_out: SignOutput, body: bytes, ticket: str, user_agent: str) -> Dict[str, str]:
    """Merge security headers into a host HTTP request header dict."""
    h = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": user_agent,
        "x-ss-stub": hashlib.md5(body).hexdigest().upper(),
        "x-ss-req-ticket": ticket,
    }
    h.update(sign_out.headers)
    return h


def partial_headers(inp: SignInput) -> Dict[str, str]:
    """Headers we can produce offline without MetaSec VM.

    Enough for Khronos/Argus/stub/ticket. Not a substitute for full f3.a output.
    Ablation: 110001 最小集是 Khronos+Gorgon；Gorgon 尚未离线。
    """
    ticket = inp.ticket
    kh = khronos_from_ticket(ticket)
    return {
        "x-ss-stub": inp.stub,
        "x-ss-req-ticket": ticket,
        "X-Khronos": str(kh),
        "X-Argus": encode_argus_short(kh),
    }


def parse_gorgon_hex(hex_str: str) -> Dict[str, object]:
    """Parse 26-byte Gorgon 8404 layout."""
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


class OfflineMetaSecNotImplemented(NotImplementedError):
    """Raised until full libmetasec_ml.so six-header set is reimplemented."""


def sign_offline(inp: SignInput) -> SignOutput:
    """Pure offline full sign — Gorgon/Ladon/Helios/Medusa not yet reimplemented.

    Use partial_headers() for known fields, or ttnet_signer for App-identical output.
    Product path: api_grab without --device-sign works when server is not in 110001 mode.
    """
    raise OfflineMetaSecNotImplemented(
        "Full six-header offline sign needs MetaSec VM (FUN_00273ba4) reimplementation. "
        "Known offline: X-Khronos, X-Argus(short)=b64(le32(kh)). "
        "Product e2e does not require headers today; on 110001 use TtnetDeviceSigner. "
        f"Native entry VA=0x{F3_JNI_TRAMPOLINE:x}, dispatcher≈0x{F3_DISPATCHER:x}, vm≈0x{F3_VM:x}."
    )


def main() -> int:
    print(corpus_report())
    print("\n--- protocol ---")
    print(f"OP_HTTP_SIGN=0x{OP_HTTP_SIGN:x}")
    print(f"F3 trampoline VA=0x{F3_JNI_TRAMPOLINE:x}")
    print(f"dispatcher VA=0x{F3_DISPATCHER:x}")
    print(f"VM FUN_00273ba4 VA=0x{F3_VM:x}")
    sample = SignInput(url="https://example/", body=b"{}")
    print("partial:", partial_headers(sample))
    try:
        sign_offline(sample)
    except OfflineMetaSecNotImplemented as e:
        print("offline full:", e)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

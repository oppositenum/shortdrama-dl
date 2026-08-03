#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gorgon 8404 离线分析 / 候选算法探测。

读 gorgon_diff_corpus.json / gorgon_plaindump / f3_diff_corpus，
尝试经典 cascade 反推与 mid 关联。

用法:
  python3 gorgon_crack.py
  python3 gorgon_crack.py --corpus sign_samples/gorgon_diff_corpus.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import urllib.parse
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
SAMPLES = HERE / "sign_samples"


def rev_nib(n: int) -> int:
    t = f"{n:02x}"
    return int(t[1] + t[0], 16)


def rbit(n: int) -> int:
    return int(bin(n)[2:].zfill(8)[::-1], 2)


def encrypt_cascade(param: Sequence[int], key: Sequence[int], length: int = 0x14) -> List[int]:
    eor = [a ^ b for a, b in zip(param, key)]
    for i in range(length):
        c = rev_nib(eor[i])
        d = eor[(i + 1) % length]
        e = c ^ d
        f = rbit(e)
        eor[i] = ((f ^ 0xFFFFFFFF) ^ length) & 0xFF
    return eor


def decrypt_to_eor(cipher: Sequence[int], length: int = 0x14) -> List[int]:
    eor = list(cipher)
    for i in range(length - 1, -1, -1):
        h = eor[i]
        d = eor[(i + 1) % length]
        x = rbit(h ^ 0xEB) ^ d
        eor[i] = rev_nib(x)
    return eor


def md5(s) -> bytes:
    if isinstance(s, str):
        s = s.encode()
    return hashlib.md5(s).digest()


def make_param(
    url_part: str,
    data4: bytes,
    ts: int,
    const: Tuple[int, int, int, int] = (0, 6, 0xB, 0x1C),
    cookie4: bytes = b"\x00" * 4,
    ts_be: bool = True,
) -> List[int]:
    p = list(md5(url_part)[:4]) + list(data4[:4]) + list(cookie4[:4]) + list(const)
    if ts_be:
        p += [(ts >> 24) & 0xFF, (ts >> 16) & 0xFF, (ts >> 8) & 0xFF, ts & 0xFF]
    else:
        p += [ts & 0xFF, (ts >> 8) & 0xFF, (ts >> 16) & 0xFF, (ts >> 24) & 0xFF]
    return p


def load_samples(path: Path) -> List[dict]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    if isinstance(data, dict) and "samples" in data:
        for s in data["samples"]:
            g = s.get("gorgon") or {}
            hexg = g.get("hex") or s.get("headers", {}).get("X-Gorgon")
            if not hexg:
                continue
            out.append(
                {
                    "url": s.get("url"),
                    "body": s.get("body"),
                    "stub": s.get("stub"),
                    "khronos": int(s.get("khronos") or s.get("headers", {}).get("X-Khronos") or 0),
                    "gorgon": hexg.lower(),
                    "mid": g.get("mid") or bytes.fromhex(hexg)[2:4].hex(),
                    "body20": g.get("body20") or bytes.fromhex(hexg)[6:26].hex(),
                }
            )
    elif isinstance(data, list):
        for s in data:
            g = (s.get("out") or {}).get("X-Gorgon") or s.get("gorgon")
            if not g:
                continue
            out.append(
                {
                    "url": s.get("url"),
                    "body": s.get("body"),
                    "stub": s.get("stub"),
                    "khronos": int((s.get("out") or {}).get("X-Khronos") or s.get("khronos") or 0),
                    "gorgon": g.lower(),
                    "mid": bytes.fromhex(g)[2:4].hex(),
                    "body20": bytes.fromhex(g)[6:26].hex(),
                }
            )
    return out


def try_recover_keys(samples: List[dict]) -> None:
    print(f"\n=== classic cascade key recovery (n={len(samples)}) ===")
    key_counter: Counter = Counter()
    for i, s in enumerate(samples):
        url = s.get("url") or ""
        stub = s.get("stub") or ""
        ts = int(s.get("khronos") or 0)
        body20 = bytes.fromhex(s["body20"])
        if not url or len(stub) != 32 or not ts:
            continue
        eor = decrypt_to_eor(list(body20))
        p = urllib.parse.urlparse(url)
        data4 = bytes.fromhex(stub.lower())[:4]
        for uname, up in [
            ("query", p.query),
            ("path_q", p.path + "?" + p.query),
            ("full", url),
        ]:
            for const in [(0, 6, 0xB, 0x1C), (1, 1, 2, 4)]:
                for ts_be in (True, False):
                    param = make_param(up, data4, ts, const, ts_be=ts_be)
                    key = bytes(a ^ b for a, b in zip(eor, param))
                    # verify
                    if encrypt_cascade(param, key) == list(body20):
                        key_counter[key.hex()] += 1
    print("unique keys", len(key_counter))
    for k, c in key_counter.most_common(5):
        print(f"  count={c} key={k}")
    if key_counter:
        best, cnt = key_counter.most_common(1)[0]
        if cnt >= 2:
            print(f"\n*** possible stable key (count={cnt}): {best}")
        else:
            print("\nno stable key across samples (key depends on mid/random)")


def mid_correlation(samples: List[dict]) -> None:
    print("\n=== mid / khronos correlation ===")
    for s in samples[:12]:
        mid = bytes.fromhex(s["mid"])
        ts = int(s.get("khronos") or 0)
        print(
            f"  mid={s['mid']} mid_u16be={struct.unpack('>H', mid)[0]:5d} "
            f"kh={ts} kh_lo16={ts & 0xFFFF} body20={s['body20'][:16]}…"
        )


def same_input_diff(samples: List[dict]) -> None:
    print("\n=== same stub pairs (xor body20) ===")
    by_stub: Dict[str, List[dict]] = {}
    for s in samples:
        if s.get("stub"):
            by_stub.setdefault(s["stub"], []).append(s)
    for stub, lst in by_stub.items():
        if len(lst) < 2:
            continue
        a, b = lst[0], lst[1]
        xa = bytes.fromhex(a["body20"])
        xb = bytes.fromhex(b["body20"])
        x = bytes(i ^ j for i, j in zip(xa, xb))
        print(
            f"  stub={stub[:8]}… mid {a['mid']}/{b['mid']} kh {a['khronos']}/{b['khronos']}\n"
            f"    xor={x.hex()} zeros={sum(1 for t in x if t == 0)}/20"
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--corpus",
        default=str(SAMPLES / "gorgon_diff_corpus.json"),
        help="primary corpus; also merges f3_diff + plaindump if present",
    )
    args = ap.parse_args()

    samples: List[dict] = []
    for p in [
        Path(args.corpus),
        SAMPLES / "f3_diff_corpus.json",
        SAMPLES / "gorgon_plaindump_last.json",
    ]:
        if not p.exists():
            continue
        if p.name.endswith("last.json"):
            # extract from triggers
            data = json.loads(p.read_text(encoding="utf-8"))
            for t in data.get("triggers") or []:
                r = t.get("result") or {}
                h = r.get("headers") or {}
                g = h.get("X-Gorgon")
                if not g:
                    continue
                samples.append(
                    {
                        "url": t.get("url"),
                        "stub": None,
                        "khronos": int(h.get("X-Khronos") or 0),
                        "gorgon": g.lower(),
                        "mid": bytes.fromhex(g)[2:4].hex(),
                        "body20": bytes.fromhex(g)[6:26].hex(),
                        "body": None,
                    }
                )
        else:
            samples.extend(load_samples(p))

    # dedupe by gorgon hex
    seen = set()
    uniq = []
    for s in samples:
        g = s.get("gorgon")
        if not g or g in seen:
            continue
        seen.add(g)
        uniq.append(s)
    samples = uniq
    print(f"loaded {len(samples)} unique gorgon samples")
    if not samples:
        print("no samples — run gorgon_corpus_collect.py first")
        return 2

    mid_correlation(samples)
    same_input_diff(samples)
    try_recover_keys(samples)

    print(
        "\n=== conclusion template ===\n"
        "If no stable key: mid is per-request random involved in key schedule,\n"
        "or cascade/const/input layout differs from classic 0404/8402.\n"
        "Next: frida_gorgon_native.py mem_match for raw 26B buffer address,\n"
        "then write-breakpoint / Stalker on that buffer fill."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

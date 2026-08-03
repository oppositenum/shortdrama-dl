#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gorgon 差分语料采集（P0）。

固定/变化：
  A. 同 URL 同 body，连续签 N 次（时间变）
  B. 同 URL，body 两档
  C. 尽量固定时间窗口内多次

输出: sign_samples/gorgon_diff_corpus.json

用法:
  python3 gorgon_corpus_collect.py --device emulator-5554 --n 8
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
OUT = HERE / "sign_samples" / "gorgon_diff_corpus.json"


def parse_gorgon(hex_str: str) -> dict:
    raw = bytes.fromhex(hex_str)
    return {
        "hex": hex_str.lower(),
        "mid": raw[2:4].hex(),
        "pad": raw[4:6].hex(),
        "body20": raw[6:26].hex(),
        "raw": raw.hex(),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="emulator-5554")
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument(
        "--url-base",
        default="https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_detail/v1/",
    )
    ap.add_argument("--series-id", default="7668349899590618136")
    args = ap.parse_args()

    from ttnet_signer import TtnetDeviceSigner

    bodies = [
        json.dumps({"series_id": str(args.series_id)}, separators=(",", ":")).encode(),
        json.dumps({"series_id": "1"}, separators=(",", ":")).encode(),
        b"{}",
    ]

    samples = []
    with TtnetDeviceSigner(device_id=args.device) as s:
        full_url = s.full_url(args.url_base.split("?", 1)[0])
        print(f"[+] full_url len={len(full_url)}")
        for bi, body in enumerate(bodies):
            stub = hashlib.md5(body).hexdigest().upper()
            for i in range(args.n if bi == 0 else max(2, args.n // 3)):
                # sign_headers recomputes stub/ticket internally
                headers = s.sign_headers(full_url, body)
                g = headers.get("X-Gorgon") or headers.get("x-gorgon")
                if not g:
                    print("[warn] no gorgon", headers.keys())
                    continue
                rec = {
                    "i": i,
                    "body_id": bi,
                    "body": body.decode("utf-8", "replace"),
                    "stub": stub,
                    "url": full_url,
                    "headers": {
                        k: headers[k]
                        for k in headers
                        if k.lower().startswith("x-") or k.lower().startswith("x-ss")
                    },
                    "gorgon": parse_gorgon(g),
                    "khronos": headers.get("X-Khronos"),
                    "argus": headers.get("X-Argus"),
                    "ts_wall": int(time.time()),
                }
                samples.append(rec)
                print(
                    f"  body{bi}#{i} mid={rec['gorgon']['mid']} "
                    f"kh={rec['khronos']} body20={rec['gorgon']['body20'][:16]}…"
                )
                time.sleep(0.35)

    # pairwise notes for same body
    notes = []
    by_body = {}
    for s in samples:
        by_body.setdefault(s["body_id"], []).append(s)
    for bid, lst in by_body.items():
        if len(lst) < 2:
            continue
        a, b = lst[0], lst[1]
        ba = bytes.fromhex(a["gorgon"]["body20"])
        bb = bytes.fromhex(b["gorgon"]["body20"])
        xor = bytes(x ^ y for x, y in zip(ba, bb)).hex()
        notes.append(
            {
                "body_id": bid,
                "mid_a": a["gorgon"]["mid"],
                "mid_b": b["gorgon"]["mid"],
                "kh_a": a["khronos"],
                "kh_b": b["khronos"],
                "body20_xor": xor,
                "same_mid": a["gorgon"]["mid"] == b["gorgon"]["mid"],
            }
        )

    report = {
        "n": len(samples),
        "full_url_prefix": samples[0]["url"][:160] if samples else "",
        "samples": samples,
        "pairwise": notes,
        "hint": (
            "Khronos 已离线；Gorgon=8404|mid|0000|body20。"
            "同 body 不同 mid → mid 含随机；body20 随 kh/mid 变。"
            "下一步：native 明文 dump 或固定 mid 的条件（若可）。"
        ),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[+] wrote {OUT} n={len(samples)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

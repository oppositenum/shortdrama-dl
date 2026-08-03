#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""六神头消融实验：测服务端最少需要哪些安全头。

关键约束（踩坑记录）：
  签名与 **完整 URL（含 App addCommonParams 后的全部 query）** 绑定。
  若用短 query（仅 aid/device_id）去 POST，即使用 Frida 签出的 full6 也会 110001。
  本脚本默认：签名 URL == 实际请求 URL。

用法:
  python3 metasec_ablation.py --series-id ... --device emulator-5554 --path both

  # 对照：走 App 内 NetworkUtils.executePost（不经本机 urllib）
  # 脚本会先做一次 app_exec 对照

输出: python/sign_samples/ablation_report.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
SAMPLES = HERE / "sign_samples"
sys.path.insert(0, str(HERE))

from api_client import DEFAULT_DEVICE, USER_AGENT  # noqa: E402

SIX = ("X-Gorgon", "X-Argus", "X-Ladon", "X-Khronos", "X-Helios", "X-Medusa")
HOST_DEFAULT = "api5-normal-sinfonlinea.fqnovel.com"


def md5_stub(body: bytes) -> str:
    return hashlib.md5(body).hexdigest().upper()


def build_short_query(device_id: str, install_id: str) -> Dict[str, str]:
    q = dict(DEFAULT_DEVICE)
    q["device_id"] = device_id
    q["iid"] = install_id
    q["_rticket"] = str(int(time.time() * 1000))
    return q


def parse_json_response(raw: bytes, http: Any, t0: float) -> Dict[str, Any]:
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return {
            "ok": False,
            "http": http,
            "code": None,
            "message": f"non-json {raw[:120]!r}",
            "elapsed": round(time.time() - t0, 3),
            "has_data": False,
            "data": None,
        }
    code = data.get("code", data.get("Code"))
    msg = data.get("message") or data.get("Message") or ""
    has = bool(data.get("data"))
    ok = code in (0, "0") or (code is None and has)
    return {
        "ok": bool(ok),
        "http": http,
        "code": code,
        "message": str(msg)[:120],
        "elapsed": round(time.time() - t0, 3),
        "has_data": has,
        "data": data if ok else None,
    }


def post_full_url(
    full_url: str,
    body: bytes,
    headers: Dict[str, str],
    timeout: float = 25.0,
) -> Dict[str, Any]:
    """POST 到完整 URL（禁止再改 query）。"""
    h = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
        **headers,
    }
    req = urllib.request.Request(full_url, data=body, method="POST", headers=h)
    ctx = ssl.create_default_context()
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read()
            http = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read() if e.fp else b""
        http = e.code
    except Exception as e:
        return {
            "ok": False,
            "http": None,
            "code": None,
            "message": str(e)[:200],
            "elapsed": round(time.time() - t0, 3),
            "has_data": False,
            "data": None,
        }
    return parse_json_response(raw, http, t0)


def post_short_query(
    host: str,
    path: str,
    query: Dict[str, str],
    body: bytes,
    headers: Dict[str, str],
    timeout: float = 25.0,
) -> Dict[str, Any]:
    url = f"https://{host}{path}?{urllib.parse.urlencode(query)}"
    return post_full_url(url, body, headers, timeout=timeout)


def load_corpus_headers() -> Tuple[Dict[str, str], str, str, str]:
    p = SAMPLES / "f3_diff_corpus.json"
    if not p.exists():
        p = SAMPLES / "offline_re_notes.json"
        if p.exists():
            o = json.loads(p.read_text(encoding="utf-8"))
            return (
                dict(o.get("headers") or {}),
                o.get("stub", ""),
                o.get("ticket", ""),
                o.get("url") or "",
            )
        raise FileNotFoundError("no corpus for --from-corpus")
    rows = json.loads(p.read_text(encoding="utf-8"))
    row = rows[0]
    out = dict(row.get("out") or {})
    return out, row.get("stub", ""), row.get("ticket", ""), row.get("url") or ""


def normalize_header_map(h: Dict[str, str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    lower = {k.lower(): v for k, v in h.items()}
    for name in SIX:
        if name.lower() in lower:
            out[name] = lower[name.lower()]
    for k in ("x-ss-stub", "x-ss-req-ticket"):
        if k in lower:
            out[k] = lower[k]
    return out


def ablation_sets() -> List[Tuple[str, Tuple[str, ...]]]:
    sets: List[Tuple[str, Tuple[str, ...]]] = [
        ("none", ()),
        ("stub_ticket_only", ()),
        ("Khronos", ("X-Khronos",)),
        ("Argus", ("X-Argus",)),
        ("Gorgon", ("X-Gorgon",)),
        ("Ladon", ("X-Ladon",)),
        ("Helios", ("X-Helios",)),
        ("Medusa", ("X-Medusa",)),
        ("Khronos+Argus", ("X-Khronos", "X-Argus")),
        ("Khronos+Gorgon", ("X-Khronos", "X-Gorgon")),
        ("Gorgon+Medusa", ("X-Gorgon", "X-Medusa")),
        ("Khronos+Gorgon+Medusa", ("X-Khronos", "X-Gorgon", "X-Medusa")),
        ("no_Medusa", ("X-Gorgon", "X-Argus", "X-Ladon", "X-Khronos", "X-Helios")),
        ("no_Gorgon", ("X-Argus", "X-Ladon", "X-Khronos", "X-Helios", "X-Medusa")),
        ("no_Helios", ("X-Gorgon", "X-Argus", "X-Ladon", "X-Khronos", "X-Medusa")),
        ("classic4", ("X-Gorgon", "X-Argus", "X-Ladon", "X-Khronos")),
        ("full6", SIX),
    ]
    for name in SIX:
        rest = tuple(x for x in SIX if x != name)
        sets.append((f"full_minus_{name}", rest))
    return sets


def pick_headers(full: Dict[str, str], names: Sequence[str], *, stub: str, ticket: str) -> Dict[str, str]:
    h = {
        "x-ss-stub": full.get("x-ss-stub") or stub,
        "x-ss-req-ticket": full.get("x-ss-req-ticket") or ticket,
    }
    for n in names:
        if n in full:
            h[n] = full[n]
    return h


def main() -> int:
    ap = argparse.ArgumentParser(description="六神头消融实验")
    ap.add_argument("--series-id", default="7610708001174850584")
    ap.add_argument("--device", default="emulator-5554")
    ap.add_argument("--from-corpus", action="store_true")
    ap.add_argument("--path", choices=("detail", "model", "both"), default="both")
    ap.add_argument("--host", default=HOST_DEFAULT)
    ap.add_argument("--device-id", default="674438832718729")
    ap.add_argument("--iid", default="674438832722825")
    ap.add_argument("--sleep", type=float, default=0.35)
    ap.add_argument("--out", default=str(SAMPLES / "ablation_report.json"))
    ap.add_argument(
        "--also-short-query",
        action="store_true",
        help="额外跑一组「短 query + full6」对照（预期失败，用于验证 URL 绑定）",
    )
    args = ap.parse_args()

    detail_body = json.dumps(
        {"series_id": str(args.series_id)}, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    bare_detail = f"https://{args.host}/novel/player/video_detail/v1/"
    bare_model = f"https://{args.host}/novel/player/video_model/v1/"

    controls: Dict[str, Any] = {}
    signer = None
    signed_detail_url = ""
    full_detail: Dict[str, str] = {}
    full_model: Dict[str, str] = {}
    signed_model_url = ""
    vid: Optional[str] = None

    # --- short unsigned probe ---
    q0 = build_short_query(args.device_id, args.iid)
    controls["unsigned_short"] = post_short_query(
        args.host,
        "/novel/player/video_detail/v1/",
        q0,
        detail_body,
        {"x-ss-stub": md5_stub(detail_body), "x-ss-req-ticket": q0["_rticket"]},
    )
    print(
        f"[probe] unsigned short-query detail code={controls['unsigned_short'].get('code')} "
        f"ok={controls['unsigned_short'].get('ok')}"
    )

    if args.from_corpus:
        full_raw, stub_c, ticket_c, corpus_url = load_corpus_headers()
        full_detail = normalize_header_map(full_raw)
        full_detail["x-ss-stub"] = md5_stub(detail_body)
        full_detail["x-ss-req-ticket"] = str(int(time.time() * 1000))
        signed_detail_url = corpus_url or (
            f"{bare_detail}?{urllib.parse.urlencode(build_short_query(args.device_id, args.iid))}"
        )
        print("[headers] from corpus; url may be stale")
        print(f"[url] {signed_detail_url[:120]}…")
    else:
        from ttnet_signer import TtnetDeviceSigner  # noqa: WPS433

        print(f"[headers] Frida via {args.device} …")
        try:
            signer = TtnetDeviceSigner(device_id=args.device)
            signer.attach()
        except Exception as e:
            print(f"[error] Frida attach failed: {e}")
            return 3

        try:
            signed_detail_url = signer.full_url(bare_detail)
            print(f"[url] App full_url len={len(signed_detail_url)}")
            print(f"[url] {signed_detail_url[:160]}…")

            # control: App 内 executePost（与签名同源）
            try:
                app_data = signer.post_json(bare_detail, json.loads(detail_body.decode()))
                code = app_data.get("code", app_data.get("Code"))
                controls["app_exec_detail"] = {
                    "ok": code in (0, "0"),
                    "code": code,
                    "message": str(app_data.get("message") or app_data.get("Message") or "")[:120],
                    "has_data": bool(app_data.get("data")),
                }
                print(
                    f"[control] app_exec_detail code={code} ok={controls['app_exec_detail']['ok']}"
                )
                if controls["app_exec_detail"]["ok"]:
                    vlist = (
                        ((app_data.get("data") or {}).get("video_data") or {}).get("video_list")
                        or []
                    )
                    if vlist:
                        vid = str(vlist[0].get("vid") or "")
                        print(f"[control] got vid={vid}")
            except Exception as e:
                controls["app_exec_detail"] = {"ok": False, "error": str(e)[:200]}
                print(f"[control] app_exec_detail FAIL: {e}")

            # host urllib + full6 on **same** full_url
            hdrs = signer.sign_headers(signed_detail_url, detail_body)
            full_detail = normalize_header_map(hdrs)
            for k, v in hdrs.items():
                if k.lower() in ("x-ss-stub", "x-ss-req-ticket"):
                    full_detail[k.lower()] = v
            controls["host_full6_same_url"] = post_full_url(
                signed_detail_url,
                detail_body,
                pick_headers(
                    full_detail,
                    SIX,
                    stub=full_detail.get("x-ss-stub") or md5_stub(detail_body),
                    ticket=full_detail.get("x-ss-req-ticket")
                    or str(int(time.time() * 1000)),
                ),
            )
            print(
                f"[control] host urllib full6 + App-full_url → "
                f"code={controls['host_full6_same_url'].get('code')} "
                f"ok={controls['host_full6_same_url'].get('ok')}"
            )

            if args.also_short_query:
                # deliberately wrong: short query + headers signed for full url
                controls["host_full6_short_query"] = post_short_query(
                    args.host,
                    "/novel/player/video_detail/v1/",
                    build_short_query(args.device_id, args.iid),
                    detail_body,
                    pick_headers(
                        full_detail,
                        SIX,
                        stub=full_detail.get("x-ss-stub") or md5_stub(detail_body),
                        ticket=full_detail.get("x-ss-req-ticket") or "0",
                    ),
                )
                print(
                    f"[control] host full6 + SHORT query (预期失败) → "
                    f"code={controls['host_full6_short_query'].get('code')}"
                )

            print("[headers] keys:", ", ".join(sorted(full_detail.keys())))
            missing = [n for n in SIX if n not in full_detail]
            if missing:
                print("[warn] missing six-god:", missing)

        except Exception as e:
            print(f"[error] sign/control failed: {e}")
            if signer:
                try:
                    signer.detach()
                except Exception:
                    pass
            return 3

    # if control host full6 worked but we don't have vid yet
    if not vid and controls.get("host_full6_same_url", {}).get("data"):
        data = controls["host_full6_same_url"]["data"]
        vlist = (((data.get("data") or {}).get("video_data") or {}).get("video_list") or [])
        if vlist:
            vid = str(vlist[0].get("vid") or "")

    model_body: Optional[bytes] = None
    if vid and args.path in ("model", "both"):
        model_body = json.dumps(
            {
                "video_id": vid,
                "content_type": 1,
                "biz_param": {
                    "video_platform": 3,
                    "need_all_video_definition": True,
                },
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if signer is not None:
            try:
                signed_model_url = signer.full_url(bare_model)
                hdrs_m = signer.sign_headers(signed_model_url, model_body)
                full_model = normalize_header_map(hdrs_m)
                for k, v in hdrs_m.items():
                    if k.lower() in ("x-ss-stub", "x-ss-req-ticket"):
                        full_model[k.lower()] = v
                controls["app_exec_model"] = None
                try:
                    md = signer.post_json(bare_model, json.loads(model_body.decode()))
                    controls["app_exec_model"] = {
                        "ok": md.get("code") in (0, "0"),
                        "code": md.get("code"),
                    }
                    print(f"[control] app_exec_model code={md.get('code')}")
                except Exception as e:
                    controls["app_exec_model"] = {"ok": False, "error": str(e)[:160]}
            except Exception as e:
                print(f"[warn] model sign failed: {e}")
                model_body = None
        else:
            signed_model_url = signed_detail_url  # weak fallback
            full_model = dict(full_detail)
            full_model["x-ss-stub"] = md5_stub(model_body)
    elif args.path == "model" and not vid:
        print("[warn] 无 vid，跳过 model（先让 detail 的 full6 成功）")

    def run_matrix(
        tag: str,
        full_url: str,
        body: bytes,
        base_full: Dict[str, str],
    ) -> List[Dict[str, Any]]:
        results = []
        stub_b = base_full.get("x-ss-stub") or md5_stub(body)
        ticket_b = base_full.get("x-ss-req-ticket") or str(int(time.time() * 1000))
        print(f"\n=== ablation {tag} ===")
        print(f"url={full_url[:100]}…")
        print(f"{'set':<28} {'code':<10} {'ok':<5} {'msg'}")
        print("-" * 72)
        for name, gods in ablation_sets():
            # 每个组合用「同一批」签好的头做子集；URL 始终是签名用的 full_url
            # 注意：时效敏感，矩阵要快；必要时可对 full6 每组重签（更慢）
            if name == "none":
                hdrs = {}
            elif name == "stub_ticket_only":
                hdrs = {"x-ss-stub": stub_b, "x-ss-req-ticket": ticket_b}
            else:
                hdrs = pick_headers(base_full, gods, stub=stub_b, ticket=ticket_b)
            r = post_full_url(full_url, body, hdrs)
            row = {
                "tag": tag,
                "set": name,
                "full_url_prefix": full_url[:180],
                "headers": list(hdrs.keys()),
                "gods": list(gods) if name not in ("none", "stub_ticket_only") else [],
                "ok": r.get("ok"),
                "code": r.get("code"),
                "message": r.get("message"),
                "elapsed": r.get("elapsed"),
            }
            results.append(row)
            print(
                f"{name:<28} {str(r.get('code')):<10} {str(r.get('ok')):<5} {r.get('message','')[:40]}"
            )
            time.sleep(max(0.0, args.sleep))
        return results

    all_rows: List[Dict[str, Any]] = []
    if args.path in ("detail", "both") and signed_detail_url:
        # 矩阵前重签一次，避免 control 已消耗时效
        if signer is not None:
            try:
                signed_detail_url = signer.full_url(bare_detail)
                hdrs = signer.sign_headers(signed_detail_url, detail_body)
                full_detail = normalize_header_map(hdrs)
                for k, v in hdrs.items():
                    if k.lower() in ("x-ss-stub", "x-ss-req-ticket"):
                        full_detail[k.lower()] = v
                print("[headers] re-signed for detail matrix")
            except Exception as e:
                print(f"[warn] re-sign detail: {e}")
        all_rows.extend(run_matrix("detail", signed_detail_url, detail_body, full_detail))

    if args.path in ("model", "both") and model_body and signed_model_url:
        if signer is not None:
            try:
                signed_model_url = signer.full_url(bare_model)
                hdrs_m = signer.sign_headers(signed_model_url, model_body)
                full_model = normalize_header_map(hdrs_m)
                for k, v in hdrs_m.items():
                    if k.lower() in ("x-ss-stub", "x-ss-req-ticket"):
                        full_model[k.lower()] = v
                print("[headers] re-signed for model matrix")
            except Exception as e:
                print(f"[warn] re-sign model: {e}")
        all_rows.extend(run_matrix("model", signed_model_url, model_body, full_model))

    if signer is not None:
        try:
            signer.detach()
        except Exception:
            pass

    ok_sets = [r for r in all_rows if r.get("ok")]
    fail_110001 = [r for r in all_rows if str(r.get("code")) == "110001"]
    report = {
        "ts": int(time.time()),
        "series_id": args.series_id,
        "host": args.host,
        "from_corpus": bool(args.from_corpus),
        "signed_detail_url_prefix": (signed_detail_url or "")[:240],
        "vid": vid,
        "controls": {
            k: {kk: vv for kk, vv in v.items() if kk != "data"}
            if isinstance(v, dict)
            else v
            for k, v in controls.items()
        },
        "rows": all_rows,
        "ok_sets": [{"tag": r["tag"], "set": r["set"]} for r in ok_sets],
        "count_ok": len(ok_sets),
        "count_110001": len(fail_110001),
        "interpretation": {
            "app_exec_ok_host_fail": (
                "App 内 OK 但 host full6 失败 → 头不够（缺 cookie）或出站 IP 与 App 不同"
            ),
            "both_fail": "两边都 110001 → 账号/剧/接口侧封锁，不单是缺头",
            "host_full6_ok": "可用 urllib+完整 URL+六神；消融表有意义",
            "short_query_fail": "短 query 必挂证明签名绑完整 URL（历史踩坑）",
        },
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== summary ===")
    print(f"ok sets: {len(ok_sets)} / {len(all_rows)}")
    print(f"110001: {len(fail_110001)}")
    ce = controls.get("app_exec_detail") or {}
    ch = controls.get("host_full6_same_url") or {}
    print(f"control app_exec: {ce.get('code')} ok={ce.get('ok')}")
    print(f"control host full6 same-url: {ch.get('code')} ok={ch.get('ok')}")
    if ok_sets:
        print("successful combinations:")
        for r in ok_sets:
            print(f"  [{r['tag']}] {r['set']}")
    else:
        if ce.get("ok") and not ch.get("ok"):
            print("→ App 签名路径可用，本机 urllib 带同样头仍失败（查 cookie/UA/出站）")
        elif not ce.get("ok"):
            print("→ App 内请求也失败：不单是「头组合」问题，可能是业务/设备风控")
        else:
            print("→ 见 report.interpretation")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

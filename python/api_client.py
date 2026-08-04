#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""红果短剧纯协议客户端（不依赖 App UI / 离线下载 / 逐集播放）。

已验证可用（aid=8662, app_name=novelread）:
  POST /novel/player/video_detail/v1/   body: {"series_id": "<id>"}
      → data.video_data.video_list[{vid, vid_index, duration, ...}]
  POST /novel/player/video_model/v1/    body: {"video_id": "<vid>", "content_type": 1}
      → data.video_model (JSON 字符串) → video_list[].main_url / encrypt_info.spade_a / kid
  POST /novel/player/album_detail/v1/   body: {"album_id": "<id>", "need_video_detail_info": true}
      → 剧元信息（封面/简介/热度），不含分集列表

播放类接口在强风控下会返回 Code=110001，需要 TTNet 安全头。

签名路径（按优先级）：
  1. signer 显式注入（TtnetDeviceSigner / OfflineSigner）
  2. offline_sign=True → metasec_offline.OfflineSigner
     （纯 Python X-Khronos+X-Gorgon，**无需模拟器/Frida**，2026-08-04 验收）
  3. 裸 HTTP（无签名；宽松时段可能仍 code=0）

CDN 直链可匿名 HTTP GET；内容为 cenc-aes-ctr，需 AES-128 key 解密。
key 来源见 spade_keys.py（spade_a 解包 / 缓存）。
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from ttnet_signer import TtnetDeviceSigner
    from metasec_offline import OfflineSigner

DEFAULT_HOSTS = (
    "api5-normal-sinfonlinea.fqnovel.com",
    "api.fqnovel.com",
    "reading.snssdk.com",
)

# 与模拟器抓包一致的默认设备身份（可被环境变量/参数覆盖）
DEFAULT_DEVICE = {
    "aid": "8662",
    "app_name": "novelread",
    "version_code": "72732",
    "version_name": "7.2.7.32",
    "manifest_version_code": "72732",
    "update_version_code": "72732",
    "channel": "69310258a",
    "device_platform": "android",
    "os": "android",
    "ssmix": "a",
    "device_type": "sdk_gphone64_arm64",
    "device_brand": "google",
    "language": "zh",
    "os_api": "34",
    "os_version": "14",
    "resolution": "1080*2209",
    "dpi": "420",
    "ac": "wifi",
}

USER_AGENT = (
    "com.phoenix.read/72732 (Linux; U; Android 14; zh_CN; "
    "sdk_gphone64_arm64; Build/UE1A.230829.036;tt-ok/10.0.0.1)"
)


class ApiError(RuntimeError):
    def __init__(self, message: str, *, code: Any = None, body: Any = None):
        super().__init__(message)
        self.code = code
        self.body = body


class HongguoApiClient:
    def __init__(
        self,
        *,
        device_id: Optional[str] = None,
        install_id: Optional[str] = None,
        host: Optional[str] = None,
        timeout: float = 30.0,
        extra_query: Optional[Dict[str, str]] = None,
        signer: Optional[Any] = None,
        offline_sign: Optional[bool] = None,
    ):
        self.device_id = (
            device_id
            or os.environ.get("SHORTDRAMA_DEVICE_ID")
            or "674438832718729"
        )
        self.install_id = (
            install_id
            or os.environ.get("SHORTDRAMA_INSTALL_ID")
            or "674438832722825"
        )
        self.hosts = [host] if host else list(DEFAULT_HOSTS)
        self.timeout = timeout
        self.query = dict(DEFAULT_DEVICE)
        self.query["device_id"] = self.device_id
        self.query["iid"] = self.install_id
        if extra_query:
            self.query.update({k: str(v) for k, v in extra_query.items()})
        # TTNet signer：Frida 设备签名 或 纯 Python OfflineSigner
        self.signer = signer
        # offline_sign: None → 看环境变量 SHORTDRAMA_OFFLINE_SIGN（默认 1）
        if offline_sign is None:
            env = os.environ.get("SHORTDRAMA_OFFLINE_SIGN", "1").strip().lower()
            offline_sign = env not in ("0", "false", "no", "off")
        self.offline_sign = bool(offline_sign)
        if self.signer is None and self.offline_sign:
            try:
                from metasec_offline import OfflineSigner  # noqa: WPS433

                self.signer = OfflineSigner()
            except Exception:
                self.signer = None

    def _url(self, host: str, path: str) -> str:
        return f"https://{host}{path}?{urllib.parse.urlencode(self.query)}"

    @staticmethod
    def _response_ok(data: Dict[str, Any]) -> Tuple[bool, Any, str]:
        """兼容 code/message 与 Code/Message/BaseResp 两种外壳。"""
        if not isinstance(data, dict):
            return False, None, "non-object response"
        code = data.get("code")
        if code is None:
            code = data.get("Code")
        base = data.get("BaseResp") if isinstance(data.get("BaseResp"), dict) else {}
        if code is None:
            code = base.get("StatusCode")
        msg = data.get("message") or data.get("Message") or base.get("StatusMessage") or ""
        # 成功: code 缺失且有 data，或 code==0
        if code in (0, "0"):
            return True, code, str(msg)
        if code is None and isinstance(data.get("data"), dict) and data.get("data"):
            return True, 0, str(msg)
        return False, code, str(msg)

    def set_signer(self, signer: Any) -> None:
        self.signer = signer

    def _is_offline_signer(self) -> bool:
        if self.signer is None:
            return False
        cls = type(self.signer).__name__
        return cls == "OfflineSigner" or (
            hasattr(self.signer, "sign_headers")
            and not hasattr(self.signer, "ensure_frida_server")
        )

    def post_json(self, path: str, payload: Dict[str, Any], *, retries: int = 3) -> Dict[str, Any]:
        # 1) Signed path: OfflineSigner（纯 Python）或 TtnetDeviceSigner（Frida）
        if self.signer is not None:
            last_err: Optional[Exception] = None
            hosts = list(self.hosts)
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            offline = self._is_offline_signer()
            for rnd in range(max(1, retries)):
                for host in hosts:
                    try:
                        if offline:
                            # 离线签名：本机拼 DEFAULT_DEVICE query + Khronos/Gorgon
                            q = dict(self.query)
                            q["_rticket"] = str(int(time.time() * 1000))
                            url = f"https://{host}{path}?{urllib.parse.urlencode(q)}"
                            if hasattr(self.signer, "post_json"):
                                # OfflineSigner.post_json 会再签一次；直接走 sign_headers 更可控
                                sec = self.signer.sign_headers(url, body)
                                headers = {
                                    "Content-Type": "application/json; charset=utf-8",
                                    "Accept": "application/json",
                                    "User-Agent": USER_AGENT,
                                }
                                headers.update(sec)
                                req = urllib.request.Request(
                                    url, data=body, method="POST", headers=headers
                                )
                                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                                    data = json.loads(
                                        resp.read().decode("utf-8", "replace")
                                    )
                            else:
                                raise ApiError("offline signer missing sign_headers")
                        else:
                            base = f"https://{host}{path}"
                            # 长任务中 Frida 会话可能被 App 杀进程弄死；signer 内部会 reattach
                            if hasattr(self.signer, "ensure_alive"):
                                try:
                                    self.signer.ensure_alive()
                                except Exception as e:
                                    last_err = e
                                    time.sleep(0.5 * (rnd + 1))
                                    continue
                            data = self.signer.post_json(base, payload)
                        ok, code, msg = self._response_ok(data)
                        if not ok:
                            last_err = ApiError(
                                f"{path} code={code} message={msg}",
                                code=code,
                                body=data,
                            )
                            time.sleep(0.4 * (rnd + 1))
                            continue
                        return data
                    except Exception as e:
                        last_err = e
                        # script destroyed / session dead：清掉再让 ensure_alive 重建
                        msg = str(e).lower()
                        if any(
                            x in msg
                            for x in (
                                "script has been destroyed",
                                "session is destroyed",
                                "detached",
                                "connection closed",
                            )
                        ):
                            try:
                                if hasattr(self.signer, "detach"):
                                    self.signer.detach()
                            except Exception:
                                pass
                            time.sleep(1.0 * (rnd + 1))
                        else:
                            time.sleep(0.3 * (rnd + 1))
                        continue
            raise ApiError(
                f"{path} signed post failed: {last_err}",
                code=getattr(last_err, "code", None),
                body=getattr(last_err, "body", None),
            )

        # 2) Unsigned raw HTTP (may hit 110001 on player APIs)
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        last_err = None
        hosts = list(self.hosts)
        rounds = max(1, retries)
        for rnd in range(rounds):
            saw_risk = False
            for host in hosts:
                # 每次请求刷新 _rticket，避免固定 query 被指纹命中
                q = dict(self.query)
                q["_rticket"] = str(int(time.time() * 1000))
                url = f"https://{host}{path}?{urllib.parse.urlencode(q)}"
                req = urllib.request.Request(
                    url,
                    data=body,
                    method="POST",
                    headers={
                        "Content-Type": "application/json; charset=utf-8",
                        "Accept": "application/json",
                        "User-Agent": USER_AGENT,
                    },
                )
                try:
                    with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                        raw = resp.read()
                    data = json.loads(raw.decode("utf-8", "replace"))
                    ok, code, msg = self._response_ok(data)
                    if not ok:
                        last_err = ApiError(
                            f"{path} code={code} message={msg}",
                            code=code,
                            body=data,
                        )
                        if code in (110001, "110001", 101001, "101001"):
                            # 110001 是冲着这套身份来的业务风控，不是这台 host 的毛病。
                            # 换 host 或原地重试只会用同一身份再挨几次拒绝，把风控拖得更久。
                            # 立刻交回上层——只有上层的挂签名/冷却+轮换身份才可能改变结果。
                            saw_risk = True
                            break
                        continue
                    return data
                except ApiError as e:
                    last_err = e
                    continue
                except Exception as e:
                    last_err = e
                    continue
            if saw_risk:
                break  # 风控不重试：本轮就到此为止，别再跑第二、三轮
            # 一轮所有 host 都失败后再退避，避免 3 host × 指数睡眠拖太久
            if rnd + 1 < rounds:
                time.sleep(0.35 * (rnd + 1))
        hint = ""
        code = getattr(last_err, "code", None)
        if code in (110001, "110001"):
            hint = (
                "（业务侧 110001：播放接口被风控。默认会走离线 Khronos+Gorgon；"
                "仍失败可加 --interval，或 --device-sign 挂模拟器 App 签名。）"
            )
        raise ApiError(
            f"{path} failed on all hosts: {last_err}{hint}",
            code=code,
            body=getattr(last_err, "body", None),
        )

    def rotate_device_identity(self) -> None:
        """换一组随机 device_id/iid，缓解单身份被频控。"""
        import random

        self.device_id = str(random.randint(10**14, 10**15 - 1))
        self.install_id = str(random.randint(10**14, 10**15 - 1))
        self.query["device_id"] = self.device_id
        self.query["iid"] = self.install_id

    def video_detail(self, series_id: str) -> Dict[str, Any]:
        """整剧详情 + 分集列表。"""
        data = self.post_json(
            "/novel/player/video_detail/v1/",
            {"series_id": str(series_id)},
        )
        vd = (data.get("data") or {}).get("video_data")
        if not isinstance(vd, dict):
            raise ApiError("video_detail missing data.video_data", body=data)
        return vd

    def album_detail(self, album_id: str) -> Dict[str, Any]:
        data = self.post_json(
            "/novel/player/album_detail/v1/",
            {"album_id": str(album_id), "need_video_detail_info": True},
        )
        return (data.get("data") or {}).get("album_data") or {}

    def video_model(
        self,
        video_id: str,
        *,
        content_type: int = 1,
        need_all_definition: bool = True,
        video_platform: int = 3,
    ) -> Dict[str, Any]:
        """单集播放模型：CDN 直链 + encrypt_info(spade_a/kid)。

        biz_param 来自 DEX GetVideoBizParam：
          need_all_video_definition — 请求全部清晰度（否则常只回 1 档）
          video_platform — 短剧侧常见为 3
        """
        payload: Dict[str, Any] = {
            "video_id": str(video_id),
            "content_type": int(content_type),
            "biz_param": {
                "video_platform": int(video_platform),
                "need_all_video_definition": bool(need_all_definition),
            },
        }
        data = self.post_json("/novel/player/video_model/v1/", payload)
        raw = (data.get("data") or {}).get("video_model")
        if isinstance(raw, str):
            return json.loads(raw)
        if isinstance(raw, dict):
            return raw
        raise ApiError("video_model missing data.video_model", body=data)

    @staticmethod
    def episode_list(video_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        items = video_data.get("video_list") or []
        out = []
        for it in items:
            if not isinstance(it, dict):
                continue
            idx = it.get("vid_index")
            vid = it.get("vid")
            if idx is None or not vid:
                continue
            out.append(
                {
                    "ep": int(idx),
                    "vid": str(vid),
                    "duration": float(it.get("duration") or 0),
                    "title": it.get("title") or "",
                    "need_unlock": bool(it.get("need_unlock")),
                }
            )
        out.sort(key=lambda x: x["ep"])
        return out

    @staticmethod
    def pick_rung(
        video_model: Dict[str, Any],
        *,
        prefer_height: int = 1080,
        allow_bytevc2: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """从 video_list 里挑清晰度档位。默认避开 ByteVC2。"""
        rungs = []
        for v in video_model.get("video_list") or []:
            if not isinstance(v, dict) or not v.get("main_url"):
                continue
            meta = v.get("video_meta") if isinstance(v.get("video_meta"), dict) else {}
            gear = v.get("gear_des_key") or ""
            codec = (meta.get("codec_type") or "") + "|" + gear
            if (not allow_bytevc2) and ("bytevc2" in codec.lower()):
                continue
            height = int(meta.get("vheight") or 0)
            if not height:
                m = re.search(r"(\d+)p", (meta.get("definition") or gear or ""))
                height = int(m.group(1)) if m else 0
            ei = v.get("encrypt_info") if isinstance(v.get("encrypt_info"), dict) else {}
            rungs.append(
                {
                    "url": v["main_url"],
                    "backup": v.get("backup_url") or "",
                    "definition": meta.get("definition") or "?",
                    "codec": meta.get("codec_type") or "?",
                    "height": height,
                    "size": int(meta.get("size") or 0),
                    "kid": ei.get("kid") or "",
                    "spade_a": ei.get("spade_a") or "",
                    "encrypt": bool(ei.get("encrypt")),
                    "encryption_method": ei.get("encryption_method") or "",
                }
            )
        if not rungs:
            return None
        # 优先接近 prefer_height，其次更高，再次更低
        rungs.sort(
            key=lambda r: (
                -1 if r["height"] == prefer_height else 0,
                -abs(r["height"] - prefer_height),
                -r["height"],
            )
        )
        return rungs[0]


def http_download(
    url: str,
    dest: str,
    *,
    expect_size: int = 0,
    timeout: float = 30.0,
    max_bytes: int = 2 * 1024 * 1024 * 1024,
) -> int:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
            "Accept": "*/*",
        },
    )
    tmp = dest + ".part"
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as src, open(tmp, "wb") as fh:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise RuntimeError("response exceeds 2GB")
                fh.write(chunk)
        if expect_size and total != expect_size:
            raise RuntimeError(f"size mismatch got={total} expect={expect_size}")
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise
    os.replace(tmp, dest)
    return total

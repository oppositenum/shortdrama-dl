# TTNet 签名样本与调用链

## 入口（Java）

```text
com.dragon.read.base.http.b
  → AbsCronetDependAdapter.onCallToAddSecurityFactor
  → NetworkParams.tryAddSecurityFactor
  → ms.bd.c.y4.onCallToAddSecurityFactor
  → ms.bd.c.f3.a(...)   [NATIVE → libmetasec_ml.so]
```

## 入参

- `url`: 完整 `https` URL（`NetworkParams.addCommonParams` 补全后）
- map:
  - `x-ss-stub`: `MD5(body).hexdigest().upper()`
  - `x-ss-req-ticket`: 毫秒时间戳字符串

## 出参头

`X-Gorgon`, `X-Khronos`, `X-Argus`, `X-Ladon`, `X-Helios`, `X-Medusa`

## 样本

见 `samples.json`（Frida 抓取，已验证宿主 urllib 可打通 video_detail/model）。

## 离线进展

| 字段 | 状态 |
|---|---|
| X-Khronos | ✅ `ticket//1000` |
| X-Argus（短 4B） | ✅ `b64(LE u32(khronos))` |
| X-Gorgon / Ladon / Helios / Medusa | ⏳ MetaSec VM |

**产品主路径不依赖六神头：** 2026-08-01 裸协议 `api_grab.py` 已无 Frida 出片。  
完整 VM 复刻仅作 110001 时的无设备兜底研究。

`libmetasec_ml.so` 中 `ms.bd.c.f3.a` 对应 native 实现（MetaSec 混淆，仅 `JNI_OnLoad` 导出）。

### f3.a 操作码（自 y4 smali）

| opcode | 含义 |
|---|---|
| `0x1000001` | 字符串解密：`data=byte[]`，`s=id`，返回 `String` |
| `0x3000001` | HTTP 签名：`s=url`，`data=String[]{k,v,...}`，`handle=z4.a`，返回头数组 |
| `0x6000001` | 非 http 变体 |

### 文件

- `samples.json` — 早期 frameSign 样本
- `f3_trace.json` — f3 调用轨迹
- `offline_re_notes.json` — 可用的六神头样本
- `f3_protocol.json` — 协议摘要
- `ablation_report.json` — 消融实验输出（`metasec_ablation.py` 生成）
- `gorgon_plaindump*.json*` — Gorgon/f3 dump（`frida_gorgon_plaindump.py` 生成）

结论解读见 `docs/ABLATION_FINDINGS.md`（Khronos+Gorgon 最小集等）。

### 实验脚本

见仓库 `docs/sign_samples_tools.md`：

- `../metasec_ablation.py` — 六神消融
- `../frida_gorgon_plaindump.py` — f3/Gorgon dump

# 六神消融结论（实测）

> 样本：`series_id=7668349899590618136`，`emulator-5554`，完整 App URL + 新鲜签名。  
> 原始表：`python/sign_samples/ablation_report.json`  
> 日期：2026-08-03

## 1. 对照实验（先建立可信度）

| 对照 | 结果 |
|---|---|
| 短 query 裸请求 | `110001` |
| App 内 `executePost` | **`code=0`** |
| 本机 urllib + **同一 full_url** + full6 | **`code=0`** |

结论：

1. 签名绑 **App `addCommonParams` 后的完整 URL**（不能再用短 query）。  
2. 本机带正确 URL + 六神 **可以**过风控（不依赖 App 出站 IP 独一份）。  
3. 消融表可信。

## 2. 成功 / 失败一览（detail 与 model 一致）

### 成功（ok）

| 集合 | 含有的六神 |
|---|---|
| **Khronos+Gorgon** | K + G |
| **no_Gorgon** | A + L + K + H + M（无 G） |
| **full6** | 全有 |
| **full_minus_Gorgon** | 同 no_Gorgon |
| **full_minus_Argus** | 无 A |
| **full_minus_Ladon** | 无 L |
| **full_minus_Khronos** | 无 K（有 G 或 H+M 等其余） |

### 明确失败（110001）

| 集合 | 说明 |
|---|---|
| none / 仅 stub | 无安全头 |
| 任一单头 | 不够 |
| Khronos+Argus | 无 G 也无 H/M |
| Gorgon 单头 | 缺 K（或校验不完整） |
| Gorgon+Medusa | 有 M 无 H |
| Khronos+Gorgon+Medusa | 有 M 无 H |
| no_Medusa | 有 H 无 M |
| no_Helios | 有 M 无 H |
| classic4 (G+A+L+K) | 无 H/M，但多了 A/L |
| full_minus_Helios | 有 M 无 H |
| full_minus_Medusa | 有 H 无 M |

## 3. 解释模型（两套校验路径）

服务端对播放类接口更像 **双路径**（与字节系常见设计一致）：

```text
路径 L（轻量）
  最少：X-Khronos + X-Gorgon
  不要夹带「半套」Helios/Medusa，也不要乱塞 Argus/Ladon 触发重校验

路径 H（重量）
  需要 Helios + Medusa 成对出现
  有 H+M 时，Gorgon 可缺（no_Gorgon / full_minus_Gorgon 成功）
  缺 H 或缺 M 任一 → 110001
```

支持证据：

- `Khronos+Gorgon` ✅ 且无 H/M  
- `full_minus_Helios` / `full_minus_Medusa` ❌（H/M 拆对必挂）  
- `Khronos+Gorgon+Medusa` ❌（只有 M 无 H，像半套重量头）  
- `no_Gorgon` ✅（有完整 H+M 等）  
- `classic4` ❌：在 L 路径上多带 A/L 可能触发更严规则，却又没有 H+M  

> Argus/Ladon：可单独缺省（full_minus_Argus/Ladon ✅），**不是**当前最小集的硬依赖。  
> Khronos：可被 full_minus_Khronos 缺省（有其它头时），但 **L 路径上建议保留**（与 Gorgon 搭配实测成功）。

## 4. 对「完全破解」的优先级重排

| 优先级 | 目标 | 理由 |
|---|---|---|
| **P0** | **X-Gorgon** 离线算法 | L 路径两件套之一；Khronos 已破解 |
| **P0** | **X-Khronos** | 已完成（ticket//1000） |
| **P1** | **X-Helios + X-Medusa 成对** | H 路径；可不要 Gorgon |
| **P2** | Argus / Ladon | 当前可省略；短 Argus 已基本懂 |
| — | 完整六神 | 有 full6 即可；产品可用 L 最小集 |

**最小离线目标（抗 110001）：**

```text
能生成 (X-Khronos, X-Gorgon)
```

### 2026-08-04 已达成

- 纯 Python `encode_gorgon_8404` + 固定 mid→key oracle  
- **short DEFAULT_DEVICE query 即可**（不必 App full_url）  
- `video_detail` / `video_model` / `api_grab` 第 1 集 1080p 解密 MP4 **无模拟器**  

实现：`python/metasec_offline.py` → `OfflineSigner`；`api_grab` 默认启用。

若 Gorgon oracle 失效，可改走 H 路径：Helios+Medusa（算法未离线，需设备签名）。

## 5. 产品侧策略

1. **默认离线 Khronos+Gorgon**（`SHORTDRAMA_OFFLINE_SIGN=1`）。  
2. Gorgon 的 URL 输入是 **query string only**（不含 path/host）。  
3. 切勿只带 Medusa 或只带 Helios。  
4. 仍 110001 时再 `--device-sign` 挂 App。  

## 6. 研究剩余

见 **[GORGON_RE_STATUS.md](./GORGON_RE_STATUS.md)**：`key=f(mid)` 闭式、Helios/Medusa 离线。

---

**一句话：** 风控下不必六神齐；**离线 Khronos+Gorgon 已够脱离模拟器出片**；Helios/Medusa 为备选路径。  

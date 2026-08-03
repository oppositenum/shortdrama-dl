# 红果短剧纯协议逆向讲义

> 面向学习：把「为什么能不用 App 播放逐集、直接在电脑上下完一剧」讲清楚。  
> 工程细节与接口字段以 [API_REVERSE.md](./API_REVERSE.md) 为准；本文偏**逻辑与方法论**。  
> 日期基线：2026-08（`aid=8662` / `com.phoenix.read`）。

---

## 0. 你先建立的一张总图

把整条链路想成五层，从上到下：

```text
┌─────────────────────────────────────────────────────────────┐
│ ① 发现剧：网页详情页 → series_id、剧名、集数、封面          │
├─────────────────────────────────────────────────────────────┤
│ ② 业务 API：video_detail 列分集 → video_model 要播放地址     │
├─────────────────────────────────────────────────────────────┤
│ ③ 传输安全（可选硬门槛）：TTNet 六神头 / MetaSec 签名        │
├─────────────────────────────────────────────────────────────┤
│ ④ CDN：匿名 GET 加密 MP4（cenc-aes-ctr）                     │
├─────────────────────────────────────────────────────────────┤
│ ⑤ 内容安全：spade_a → AES-128 key → 解密 → 可播 MP4          │
└─────────────────────────────────────────────────────────────┘
```

**产品主路径（纯协议）**走 ①②④⑤；③ 在风控 `110001` 时才强制介入。  
**App 抓取路径**走 App UI + 离线下载 + Frida 钩密钥，不依赖我们自己拼 ②③。

对应代码：

| 层 | 实现 |
|---|---|
| ① | Electron `main.js` 解析详情页 |
| ② | `python/api_client.py` / `api_grab.py` |
| ③ | `ttnet_signer.py`（Frida 借 App 签名）；完整离线算法未完成 |
| ④⑤ | `http_download` + `spade_keys.py` + `decrypt_mdl.py` |

---

## 1. 逆向在解什么问题？

目标不是「破解网站好看」，而是回答：

1. **服务器承认谁？** 要哪些 query / body / header 才返回业务数据？  
2. **播放地址从哪来？** 是 m3u8、直链 MP4，还是加密容器？  
3. **密钥在哪？** 在响应 JSON 里？在播放器 so 里算？还是运行时才出现？  
4. **哪一步必须 App，哪一步可以纯协议？** 能拿掉模拟器的步骤越多，产品越稳。

红果这条线的最终答案可以概括成：

> **列表与播放模型多数时候是普通 HTTPS JSON；媒体是 AES-CTR 加密 MP4；key 藏在 `spade_a` 里，算法在 `libttmplayer` 的 UnWrapper。**  
> **签名（Gorgon 等）是 App 请求栈的标准配件，服务端有时严查有时松，不能当「永远不需要」。**

---

## 2. 方法论：我们实际怎么拆的

按时间顺序，大致是这种节奏（也适合你复盘时对照）：

### 2.1 从「能抓」到「懂抓」

| 阶段 | 做法 | 产出 |
|---|---|---|
| App 抓取可用 | ADB + 红果离线下载 + Frida 钩 AES | 证明：能出片，但重、慢、依赖设备 |
| 抓业务流量 | 代理 / Frida / 日志看 host 与 path | 发现 `fqnovel.com` 上的 player API |
| 对照 DEX/smali | 搜 `video_detail`、`video_model`、`spade_a` | 确认参数名、content_type、biz_param |
| 最小复现 | 本机 `urllib` 裸 POST | 验证哪些字段真需要 |
| 密钥逆向 | 从错误的 so 路径纠正到 `libttmplayer` | 纯 Python `unwrap_spade` |
| 签名逆向 | Java 链 → native `f3.a` → MetaSec VM | 协议清楚；完整算法未完；用 Frida oracle 兜底 |

### 2.2 三条原则

1. **先定位数据，再抠算法**  
   先拿到「明文 JSON 长什么样」，再决定要不要解 so。  
2. **区分「业务鉴权」和「内容加密」**  
   API 风控（110001）≠ 视频 AES。两个问题两个解。  
3. **产品路径用「够用的正确」**  
   能裸 HTTP 出片就优先裸 HTTP；签名用 App 当 oracle，不必卡死在 VM 还原上。

### 2.3 常用工具角色

| 工具 | 在本项目里干什么 |
|---|---|
| jadx / smali | 找 API 路径、参数类、签名回调类名 |
| Frida | 钩 Java（`onCallToAddSecurityFactor`）、钩 native、当签名 oracle |
| Ghidra | `libmetasec_ml.so` 控制流（发现 CFF/VM） |
| adb | 推 frida-server、拉 so、看进程 |
| 本机 Python | 复现协议、差分样本、出片验证 |

---

## 3. 层 ①：从链接到 series_id

用户贴的是网页链接（如 `hongguoduanju.com/detail?series_id=...`）。

- Electron 打开详情页（或 SSR HTML）解析：**剧名、总集数、封面、series_id**。  
- **不**从网页下分集视频；网页只当「目录页」。  
- 真正视频全部由 Python 侧用 `series_id` 去拉。

学习点：很多短剧站是「壳站点 + 中台 API」。壳负责 SEO/分享，中台才是内容源。

---

## 4. 层 ②：业务 API（纯协议核心）

### 4.1 身份长什么样

请求 query 里要带一串「看起来像安卓 App」的公共参数，例如：

- `aid=8662`，`app_name=novelread`
- `device_id` / `iid`（安装身份）
- `version_code` / `device_type` / `os` 等

实现：`api_client.DEFAULT_DEVICE`。  
它们**不保证**永远不被风控，但构成「合法客户端画像」。

### 4.2 两步拿齐播放材料

```text
POST /novel/player/video_detail/v1/
  body: {"series_id":"<id>"}
  → data.video_data.video_list[]
      每集: vid, vid_index, duration, title, ...

POST /novel/player/video_model/v1/
  body: {
    "video_id": "<vid>",
    "content_type": 1,
    "biz_param": {
      "video_platform": 3,
      "need_all_video_definition": true
    }
  }
  → data.video_model（JSON 字符串）
      video_list[]: main_url, backup_url,
                    encrypt_info.spade_a, kid, encryption_method, ...
```

要点：

- `video_detail`：**目录**（有哪些集、vid 是什么）。  
- `video_model`：**某一集怎么播**（CDN 链接 + 加密元数据）。  
- `need_all_video_definition`：尽量要到多档清晰度（含 1080p）。  
- 选档时避开 ByteVC2（ffmpeg 难解），优先标准 HEVC/AVC —— `pick_rung()`。

### 4.3 响应外壳

业务里常见两种成功形态：

- `code == 0`  
- 或没有 code 但有非空 `data`

失败里最重要的是 **`code == 110001`**（见第 7 节）。

---

## 5. 层 ④⑤：CDN 与 spade_a（内容加密）

### 5.1 下到的不是「明文 MP4」

`main_url` 往往是可匿名 GET 的地址，文件是 **CENC / AES-CTR** 加密的 MP4：

- 容器仍是 ftyp/moov…  
- 样本在 `senc` 等 box 里带 IV  
- 没有 key 时：文件在、播不动或花屏

解密实现：`decrypt_mdl.py`（读 box → CTR 解密样本 → ffmpeg 重封装）。

### 5.2 spade_a 是什么

`video_model` 里 `encrypt_info.spade_a` 是 **base64 包了一层的密钥材料**，不是 16 字节 key 本身。

历史上容易走错的路：

- 在 `libvideodec` 里找「0xA8 解密」→ **不是**红果这条播放路径的主解包。  
- 正确落点：**播放器 `libttmplayer` 的 UnWrapper**（`setStringOption(144, spade_a)` 一类入口）。

### 5.3 离线解包逻辑（概念版）

`spade_keys.unwrap_spade` 做的事可以记成：

```text
raw = b64decode(spade_a)          # 红果样本约 37 字节
用 raw[0..2] 推导 suffix_len、body 切片
用尾部字节与 seed 还原 tag（如 "11" / 与 app_v2|web_v2 前缀比较）
按 tag 分支做一层表变换 / 置换
从 body 中抽出 32 字符 ASCII hex → 16 字节 AES key
```

验证方式：对真实 `spade_a` 解出 key，解密一集，`ffprobe` 时长与 `video_detail` 里 duration 对齐。

**学习点：** 内容密钥可以完全离线；**不需要**为了解密去 hook 每一集播放。

---

## 6. 层 ③：TTNet / MetaSec 签名（请求安全）

App 真实发 HTTP 时，TTNet/Cronet 会在发送前塞一组「安全因子」头，俗称六神：

| 头 | 形态（aid=8662 实测） | 离线进度 |
|---|---|---|
| `X-Khronos` | unix 秒 ≈ ticket//1000 | ✅ 已懂 |
| `X-Argus` | 短 4 字节 base64 = `b64(LE u32(Khronos))` | ✅ 语料验证 |
| `X-Gorgon` | hex，前缀 `8404`，后接加密 body | ⏳ 结构知、密钥算法未知 |
| `X-Ladon` | 短 base64 | ⏳ |
| `X-Helios` | ~36B base64 | ⏳ |
| `X-Medusa` | ~900B+ base64，主载荷 | ⏳ |

另有业务头：

- `x-ss-stub` = `MD5(body).hex().upper()`  
- `x-ss-req-ticket` = 毫秒时间戳字符串  

### 6.1 Java 调用链（已完整摸清）

```text
com.dragon.read.base.http.b
  └─ AbsCronetDependAdapter.onCallToAddSecurityFactor(url, Map)
       └─ NetworkParams.tryAddSecurityFactor
            └─ ms.bd.c.y4.onCallToAddSecurityFactor   # MetaSec 回调
                 └─ ms.bd.c.f3.a(opcode, b, handle, s, data)  【JNI】
                      └─ libmetasec_ml.so
```

`f3.a` 关键操作码：

| opcode | 含义 |
|---|---|
| `0x1000001` | 字符串解密 |
| `0x3000001` | **HTTP 签名**（主路径） |
| `0x6000001` | 非 http 变体 |

HTTP 签名入参/出参（Frida 反射 `Array` 抓到）：

```text
in:
  handle = ms.bd.c.z4.a     # 进程内 long 会话句柄
  s      = 完整 https URL
  data   = ["x-ss-stub", stub, "x-ss-req-ticket", ticket]

out (flat String[]):
  X-Argus, X-Gorgon, X-Helios, X-Khronos, X-Ladon, X-Medusa
```

样本目录：`python/sign_samples/`（含 `f3_diff_corpus.json`、`f3_protocol.json`）。

### 6.2 Native 为什么难

Ghidra 结论（摘要）：

```text
libmetasec_ml.so (AArch64)
  f3.a trampoline @ 0x281ad4
    → dispatcher @ 0x17f5a4
      → FUN_00273ba4 @ 0x173ba4   # 自定义 VM / 间接跳表 / CFF
```

这不是「MD5 一下再 XOR」的透明函数，而是 **混淆 VM**。  
公开的 TikTok 老版 Gorgon 0404/部分 8404 实现**对不上**红果语料（body 加密、密钥随请求变）。

因此工程策略是：

- **协议与 I/O 契约**：已文档化（可当 oracle 对照）  
- **纯 Python 完整六神**：未完成  
- **可用兜底**：Frida 调 App 同一条 `onCallToAddSecurityFactor` / `NetworkUtils.executePost`  
  → `python/ttnet_signer.py`

### 6.3 「挂载 App 签名」到底是什么

用户侧理解：

> 红果进程在后台开着即可，**不用播放任何剧**。  
> 程序用 Frida attach 到该进程，借用 App 内部已经初始化好的 MetaSec，算出与官方一致的请求头。

技术侧理解：

> 不在 PC 上复刻 VM；把 PC 的 body/url 送进 App 的签名函数，拿回 headers，再由 PC 发 HTTPS。

---

## 7. 风控 110001：业务层「软门槛」

### 7.1 现象

- 前几十集 `video_model` 正常 `code=0`  
- 之后突然 `code=110001`（message 常为「未知异常」）  
- 严重时同一出口 IP 上 **连 `video_detail` 裸请求也被拒**  
- 换随机 `device_id` 也不一定立刻好 → 更像 **频控 / 行为 / IP 画像**，不是单纯「缺一个头」

### 7.2 产品策略（当前实现）

`api_grab.py` / Electron 纯协议：

1. **降速**：分集间隔 `--interval`（界面侧默认约 1.2s）  
2. **遇 110001 优先挂 App 签名**（`--device-sign-auto`，不先干等 45s）  
3. 挂不上再 **冷却 + 轮换 device_id** 重试裸请求  
4. 已下完的集 **跳过**，同目录续传  

学习点：**协议逆向成功 ≠ 服务端永远放行**。要设计降级路径。

---

## 8. 两条产品路径怎么选

```text
                    ┌─ 纯协议（推荐默认）
用户点「开始下载」─┤     网页解析 → api_grab
                    │     正常：裸 HTTP
                    │     风控：Frida 借签名（红果挂着）
                    │
                    └─ App 抓取
                          模拟器里红果离线下载
                          Frida 钩播放器密钥 / 拉 .mdl
```

| | 纯协议 | App 抓取 |
|---|---|---|
| 要模拟器 | 风控时才强依赖 | 始终依赖 |
| 要操作 App | 后台挂着即可 | 自动点 UI 下载 |
| 出片核心 | API + spade + decrypt | 离线文件 + 密钥事件 |
| 卡点 | 110001、签名 oracle | 设备/Frida/UI 变更 |

---

## 9. 端到端数据流（一张图背下来）

```text
series_id
    │
    ▼
video_detail ─────────────────────► [ep, vid, duration] × N
    │
    │  for each vid（跳过已有 mp4）
    ▼
video_model ──────────────────────► main_url + spade_a (+ kid)
    │                                    │
    │         ┌──────────────────────────┘
    │         ▼
    │    unwrap_spade(spade_a) ──► aes_key_hex (16B)
    │         │
    ▼         ▼
GET main_url ──► 加密 mp4 ──decrypt_mdl(key)──► 第XX集.mp4
```

签名插入点（若需要）：

```text
构造 body 与 url
    →（可选）TtnetDeviceSigner.sign / exec_post
    → POST video_* 
```

---

## 10. 代码地图（按学习顺序读）

建议阅读顺序：

1. **`docs/API_REVERSE.md`** — 接口与字段清单  
2. **`python/api_client.py`** — 如何拼 URL/POST、如何判 code  
3. **`python/api_grab.py`** — 整剧循环、跳过已有、风控恢复  
4. **`python/spade_keys.py`** — spade 离线解包  
5. **`python/decrypt_mdl.py`** — cenc 与 ffmpeg  
6. **`python/ttnet_signer.py`** — Frida 签名 oracle  
7. **`python/metasec_offline.py`** — 已还原的 Khronos/Argus、未完成声明  
8. **`python/sign_samples/README.md`** — 六神样本与 f3 操作码  
9. **`main.js` 中 `grabWithApi` / `ensureApiGrabEnvironment`** — 桌面如何接纯协议  

调试脚本（不进正式包）：`frida_*.py/js`、Ghidra 日志等，在 `python/` 与 `sign_samples/ghidra/`。

---

## 11. 建议的自学实验（由浅入深）

在合法、自有设备与测试剧范围内练习：

1. **只调 video_detail**  
   用 `api_client` 打一条，打印 `episode_cnt` 与前 3 个 `vid`。  
2. **只调 video_model**  
   看 `video_list` 有几档、`spade_a` 长度、`main_url` 是否 https。  
3. **只解 spade**  
   `python3 spade_keys.py '<spade_a>'` 得到 32 hex。  
4. **下一小段加密文件 + 解密**  
   对照 duration。  
5. **故意连打 50 次 video_model**  
   观察是否 110001（理解风控）。  
6. **Frida 抓一次 f3.a 出参**  
   对照 `sign_samples` 里 Gorgon 前缀 `8404`、Argus 是否等于 LE(khronos)。  

---

## 12. 已完成 / 未完成（诚实清单）

| 项 | 状态 |
|---|---|
| 业务 API 路径与参数 | ✅ |
| 纯协议出片（无签名时） | ✅ |
| spade_a → AES key 离线 | ✅ |
| cenc 解密出片 | ✅ |
| Electron `grabMode=api` | ✅ |
| 签名 Java 链与 f3 契约 | ✅ |
| 短 Argus / Khronos | ✅ |
| Gorgon body / Medusa 等完整算法 | ⏳ MetaSec VM |
| 无设备、无 Frida 的永久抗 110001 | ⏳ 依赖完整签名或服务端策略变化 |

未完成的部分**不阻塞**主路径；它们决定的是：  
「在严风控、又完全不想开模拟器时，还能不能稳。」

---

## 13. 术语表

| 词 | 含义 |
|---|---|
| 纯协议 | 不操作 App UI，直接按 HTTPS API + CDN + 本地解密出片 |
| series_id | 一部剧的业务 ID |
| vid | 一集视频 ID |
| spade_a | 加密后的密钥材料（base64） |
| 六神头 | Gorgon/Argus/Ladon/Khronos/Helios/Medusa 等 |
| MetaSec | 字节系安全 SDK，实现在 `libmetasec_ml.so` |
| f3.a | MetaSec JNI 入口 `ms.bd.c.f3.a` |
| 挂载签名 | Frida attach 到红果进程，调用其签名逻辑 |
| 110001 | 播放类接口业务风控码 |
| oracle | 用真实 App 当「标准答案生成器」验证/替代未还原算法 |

---

## 14. 完全破解六神：仓库内实验工具

| 工具 | 作用 |
|---|---|
| `python/metasec_ablation.py` | 六神**消融表**：测 110001 时最少要哪些头 |
| `python/frida_gorgon_plaindump.py` (+ `.js`) | **f3/Gorgon dump**：抓签名 I/O 与 8404 字符串 |

用法说明见 **[sign_samples_tools.md](./sign_samples_tools.md)**。

建议顺序：先消融缩目标 → 再 dump 对齐语料 → 再 VM/仿真。

### 14.1 消融实测结论（2026-08-03）

详见 **[ABLATION_FINDINGS.md](./ABLATION_FINDINGS.md)**。摘要：

- 必须用 **App 完整 URL**；短 query + 六神也会挂。  
- 本机 urllib + full_url + 正确头 → `code=0`。  
- **最小够用：`X-Khronos` + `X-Gorgon`**。  
- 另一条路：有 **Helios+Medusa 成对** 时可不带 Gorgon。  
- Helios / Medusa **不能拆开**；Argus/Ladon 当前非硬依赖。  
- 离线破解 **P0 = Gorgon**（Khronos 已完成）。

## 15. 一句话总结

> 我们逆向的不是「一个神秘下载按钮」，而是：**中台 JSON 协议 + 播放器侧 spade 密钥格式 +（可选）TTNet 请求签名。**  
> 前两者已足够日常纯协议出片；签名摸清了入口与契约，完整 VM 仍可用 App 进程代替。

更细的接口样例、host 列表、Ghidra 地址见 **[API_REVERSE.md](./API_REVERSE.md)**。  
架构与 Electron 编排见 **[ARCHITECTURE.md](./ARCHITECTURE.md)**。

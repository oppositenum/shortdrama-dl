# 红果「六神」签名逆向与离线实现报告

> 项目：shortdrama-dl（红果短剧下载器）  
> 对象：TTNet / MetaSec 安全请求头（俗称「六神」）  
> 基线 App：`com.phoenix.read` / `aid=8662` / 版本约 `7.2.7.32`  
> 报告日期：2026-08-04  
> 状态：**产品可用**——纯 Python **本机生成** `X-Khronos` + `X-Gorgon`，无需模拟器即可拉列表、播放模型并解密出片（**下载仍需联网**）。  
> Electron 第四种抓取模式对外名称：**「本机签名纯协议」**（内部 mode id 仍为 `offline`，勿理解成断网下载）。

---

## 0. 一句话结论

服务端对播放类接口的强校验（`Code=110001`）并不要求六个安全头齐套。  
**最小充分条件是 `X-Khronos` + `X-Gorgon`。**  
其中 Khronos 平凡；Gorgon 是经典 leviathan cascade 的 8404 变体。  
key 随 mid 变，闭式 KDF 未完全还原，但 **同一 mid→key 可跨请求复用**——据此落地纯 Python 签名，脱离模拟器。

---

## 1. 问题从哪来

### 1.1 产品目标分层

红果整条链路可拆成五层：

| 层 | 内容 | 是否依赖六神 |
|---|---|---|
| ① 发现剧 | 网页详情 → series_id | 否 |
| ② 业务 API | `video_detail` 列集、`video_model` 拿 CDN | **风控时是** |
| ③ 传输安全 | 六神 / MetaSec | 本文主题 |
| ④ CDN | 匿名 GET 加密 MP4 | 否 |
| ⑤ 内容安全 | `spade_a` → AES 解密 | 否（另线已破解） |

早期：裸 HTTP 有时能过；风控收紧后 `video_*` 普遍 `110001`，纯协议断掉。  
目标变成：**在电脑上自己签出服务端认可的安全头**，而不是一直挂着模拟器里的红果 App。

### 1.2 「六神」是什么

TTNet 请求上常见的一组安全头（名称因 App/版本略有差异）：

| 头 | 角色（本项目观测） | 离线状态 |
|---|---|---|
| **X-Khronos** | 时间戳（秒） | ✅ 已破解 |
| **X-Gorgon** | 请求摘要 + 加密体（主校验） | ✅ 可生成（oracle mid/key） |
| **X-Argus** | aid=8662 上为短形态 `b64(LE(khronos))` | ✅ 已懂，非最小集必需 |
| **X-Ladon** | 约 4 字节 | ⏳ 可省略 |
| **X-Helios** | ~36 字节，与 Medusa 成对 | ⏳ 另一条路径，未离线 |
| **X-Medusa** | ~940 字节，重量载荷 | ⏳ 同上 |

另有业务侧：

- `x-ss-stub` = `MD5(POST body).hex().upper()`
- `x-ss-req-ticket` = 毫秒时间戳字符串  

签名入口在 Java：`tryAddSecurityFactor` → `ms.bd.c.y4` → **`ms.bd.c.f3.a(opcode=0x3000001, …)`**，native 落在 **`libmetasec_ml.so`**（CFF/VM，非直线算法）。

---

## 2. 总体方法论

贯穿始终的原则：

1. **先定位数据，再抠算法**  
   先拿到「成功请求长什么样」，再决定要不要啃 VM。
2. **区分业务鉴权 vs 内容加密**  
   `110001` 是 API 风控；视频 AES 是 `spade_a`，两条线。
3. **消融（ablation）定最小集**  
   不要默认「六个都要」；用删头实验回答「服务端到底查什么」。
4. **产品路径用「够用的正确」**  
   最小集离线可生成即可出片；完整还原六神可以后置。
5. **设备当 oracle，最后再扔掉设备**  
   Frida 签名 → 差分语料 → 离线复现 → 脱离模拟器。

工具角色：

| 工具 | 用途 |
|---|---|
| jadx / smali | API 路径、签名回调类名 |
| Frida | 钩 `f3.a`、当签名 oracle、`ttnet_signer` |
| Ghidra | `libmetasec_ml.so` 反编译 / 站点定位 |
| adb + 模拟器 | 跑红果、采样本 |
| 本机 Python | 差分、消融、出片验证 |
| Electron | 产品入口四模式 |

---

## 3. 阶段一：看清协议，不碰六神也能出片（早期）

在风控宽松窗口：

- `POST /novel/player/video_detail/v1/` + `{"series_id"}`  
- `POST /novel/player/video_model/v1/` + `video_id` / `biz_param`  
- CDN 直链 + `spade_a` 离线 AES（`libttmplayer` UnWrapper 已还原）

产物：`api_client.py` / `api_grab.py` / `spade_keys.py` / `decrypt_mdl.py`。  
**结论：业务形态清楚；六神是「可选硬门槛」，不是播放器本身。**

---

## 4. 阶段二：风控来了——Frida 借 App 签名（设备路径）

`110001` 常态化后，先做 **可工作的产品路径**，而不是卡死在 so 里。

### 4.1 设备签名器 `ttnet_signer.py`

- 附加红果进程，走 App 内 TTNet / `NetworkUtils.executePost` 或 header 签名  
- 关键：URL 须与 App **`addCommonParams` 后的 full_url** 一致（早期消融结论）  
- 后续：Frida 会话中途 `script has been destroyed` → `ensure_alive` / reattach  

### 4.2 Electron 路径

- **App 抓取**：UI + Frida 钩密钥  
- **纯协议**：`api_grab.py`，遇 110001 可 `--device-sign-auto` 借已开模拟器  

此阶段：**能下完剧，但绑模拟器/USB/App 前台**，长任务易断会话。

---

## 5. 阶段三：消融实验——证明「不必六神齐」

脚本：`metasec_ablation.py`；结论：`docs/ABLATION_FINDINGS.md`。

### 5.1 对照

| 对照 | 结果 |
|---|---|
| 短 query 裸请求 | 110001 |
| App 内 executePost | code=0 |
| 本机 urllib + 同 full_url + 全套六神 | code=0 |

→ 签名可在本机复用，不依赖 App 出口 IP 独一份。

### 5.2 双路径模型

```text
路径 L（轻量）  最少：X-Khronos + X-Gorgon
路径 H（重量）  Helios + Medusa 成对；有 H+M 时 Gorgon 可缺
半套 H/M（只有 Helios 或只有 Medusa）→ 必 110001
classic4（G+A+L+K 无 H/M）→ 失败（易触发更严规则）
Argus / Ladon → 当前播放接口可单独缺省
```

### 5.3 优先级重排

| 优先级 | 目标 |
|---|---|
| **P0** | X-Gorgon 离线 + X-Khronos（已平凡） |
| P1 | Helios+Medusa 成对 |
| P2 | Argus/Ladon 完整 |

**产品目标收窄为：离线生成 (Khronos, Gorgon)。**

---

## 6. 阶段四：Gorgon 形态钉死与 native 定位

### 6.1 二进制布局（所有样本一致）

```text
X-Gorgon = hex(26 bytes)
         = 84 04 | mid(2) | 00 00 | body(20)
```

- 前缀 **8404**：版本/族标记（开源老算法多为 0404/0408）  
- **mid**：2 字节；统计上高字节低 4 bit 恒为 0 → 形态 `N0XX`，约 **12 bit 熵**  
- **pad**：恒 `0000`  
- **body20**：20 字节密文  

### 6.2 进 Java 的位置

```text
libmetasec_ml.so + 0x283640
  → art::JNI::NewStringUTF
  → cstr = "8404...." （52 个 ASCII hex 字符，不是 26 字节二进制对象）
```

重要推论：

- 内存里几乎扫不到完整 `84 04 .. 00 00` 的 26 字节结构体  
- hex 由 nibble 查表写出，不经 libc `printf` 拼 8404  
- 钩错 hex 站点易导致进程/脚本被毁（反调试或钩到函数体中间）  

### 6.3 输入侧（f3）

- opcode `0x3000001` = HTTP 签名  
- 入参含 URL、stub、ticket、session handle（`ms.bd.c.z4.a`）  
- 出参 flat 串：成对 header 名/值  

---

## 7. 阶段五：算法结构——经典 cascade + 可变 key

### 7.1 与开源 leviathan 的关系

社区旧实现（TikTok 系 0404/0408）大致是：

```text
param[20] = md5(url)[:4] + md5(data)[:4] + md5(cookie)[:4] + const + BE(ts)
body20    = cascade_encrypt(param, FIXED_KEY)
header    = version_prefix + random_mid + body20_hex
```

cascade 核心循环（本项目与开源一致）：

1. `eor[i] = param[i] ^ key[i]`  
2. 对每个 i：`rev_nib`（半字节交换）→ 与 `eor[(i+1)%20]` XOR → **rbit**（8 位反转）→ 再与 `0x14` 混合  

逆向方向：`decrypt_to_eor` 可从 body20 反推 `eor = param XOR key`。

### 7.2 对本仓库语料的验证

用 **query-only** 的 md5、stub 前 4 字节、cookie 全 0、const `(0,6,0x0b,0x1c)`、大端 khronos：

- 从样本反推 `key = eor XOR param`  
- **同一 mid 的两次请求（仅 ts 变）→ key 完全相同**  
- 用该 key 预测「同 mid、khronos+1」的 body20 → **逐字节命中**  

→ cascade 结构 + 时间戳布局正确；**key 是 mid 的函数（或与 mid 一一绑定）**。

### 7.3 否定掉的捷径

| 尝试 | 结果 |
|---|---|
| 开源固定 key（如 DF77B940…） | 服务端 110001 |
| 把 path+query 或 full URL 当 md5 输入 | 110001（**必须仅 query string**） |
| 仅 Khronos / 仅 Gorgon | 110001 |
| 简单 `key = md5(mid)` / RC4(mid) / 仿射 mid→key | 全库 0 命中 |
| so 内直接搜 20 字节 key 明文 | 无 |

### 7.4 内存扫描补充

签名刚结束后扫进程：

- 完整 20B param/eor/key/**body20 极少落地**（栈/寄存器生命周期短）  
- 偶见 key 前 8 字节、const+ts 片段 → 与「算完即 hex 写出」一致  

因此主路径改为 **密码学差分 + 服务端验收**，而非死磕 Stalker 明文。

---

## 8. 阶段六：决定性实验——oracle mid/key 离线过线

### 8.1 实验设计

1. 用 Frida/`ttnet_signer` 采一批真签名 → 反推 mid→key 表（oracle）  
2. **不再调 App**，固定取某条 `(mid, key)`  
3. 对本机新请求：  
   - 新 body / 新 stub / 新 khronos / 可换 short query  
   - `encode_gorgon_8404` 算 body20  
   - 只带 `X-Khronos` + `X-Gorgon` POST  

### 8.2 结果（2026-08-04）

| 请求 | 结果 |
|---|---|
| 裸 short query | 110001 |
| 离线 KG + short DEFAULT_DEVICE query | **code=0** |
| 离线 KG + 多条不同 mid（oracle 内） | **全部 code=0** |
| `video_model` 离线 KG | **code=0**，含 `spade_a` / `main_url` |
| `api_grab` 第 1 集 | **1080p 解密 MP4 成功，全程无模拟器** |

含义：

1. **param 布局正确**（服务端用同一公式验）  
2. **key 与 mid 绑定且跨请求稳定**（可复用，不必每请求随机 mid）  
3. **short 设备 query 足够**（最终产品不必强绑 App full_url；早期「必须 full_url」是在「无合法 Gorgon」时的现象）  
4. 未还原 `KDF(mid)` 闭式 **不阻塞出片**

默认内置样例：`mid=401c` + 对应 20 字节 key（见 `metasec_offline._DEFAULT_MID_KEY` 与 `sign_samples/gorgon_mid_key_oracle.json`）。

---

## 9. 离线算法规格（可实现摘要）

```text
khronos = floor(unix_time_seconds)   # 或 ticket_ms // 1000

param[20] =
    MD5(url_query)[0:4]              # 仅 ? 后字符串，不含 path/host
  + MD5(POST_body)[0:4]              # 与 x-ss-stub 前 4 字节一致
  + 00 00 00 00                      # cookie 空
  + 00 06 0B 1C                      # 常量
  + big_endian_u32(khronos)

body20 = cascade_encrypt(param, key)  # key 长 20，与 mid 绑定

X-Gorgon  = hex( 84 04 || mid || 00 00 || body20 )   # 52 hex chars
X-Khronos = decimal string of khronos

可选：
X-Argus   = base64( little_endian_u32(khronos) )     # 短形态，非 L 路径必需
```

cascade 与开源 leviathan 同构（`rev_nib` / 邻位 XOR / `rbit` / 长度 0x14）。

实现文件：

- `python/metasec_offline.py` — `encode_gorgon_8404` / `OfflineSigner` / `sign_kg_headers`  
- `python/api_client.py` — 可挂 Offline signer  
- `python/api_grab.py` — CLI：`--offline-sign` / `--device-sign` / `--device-sign-auto`  

---

## 10. 产品接入：四条抓取路径

Electron「整剧抓取方式」：

| 模式 | 行为 |
|---|---|
| **本机签名纯协议**（`offline`，推荐） | 电脑上自签 KG，**禁止** device-sign-auto；**下载要联网** |
| **纯协议下载**（`api`） | 协议下载；默认可本机签，遇 110001 **可**借已开模拟器签名 |
| **App 抓取**（`app`） | 红果 UI + Frida 钩密钥 |
| **仅封面**（`none`） | 不下载视频 |

打包资源额外包含：`metasec_offline.py`、`sign_samples/gorgon_mid_key_oracle.json`。

端到端（离线模式）：

```text
链接 → series_id → video_detail（离线 KG）
     → 各集 video_model（离线 KG）→ CDN → spade 解密 → 本地 MP4
```

无 ADB、无 frida-server、无红果前台。

---

## 11. 失败过的路与经验（给后来者）

| 弯路 | 教训 |
|---|---|
| 一上来死磕完整六神 / VM 全还原 | 先消融最小集，产品目标可砍半 |
| 假设 26B 结构体堆上常驻 | hex 直出，扫内存常空 |
| 套用 2019–2021 固定 key Gorgon | 8404 的 key 已 per-mid |
| 对 md5 输入用 path 或 full URL | **只有 query** 通过验收 |
| 长任务 Frida 不 reattach | `script has been destroyed` 会整段挂掉 |
| 把「必须 full_url」写成永恒真理 | 有合法 Gorgon 后 short query 也可 |

有效节奏：

```text
能抓流量 → 消融最小集 → 钉死输出形态
→ 对齐经典算法结构 → 差分 mid/key
→ 服务端黑盒验收 → 固化 oracle → 产品接线
→（可选）再回去啃 KDF/VM
```

---

## 12. 尚未完成（研究债，非阻塞）

1. **`key = KDF(mid)` 闭式**  
   现用固定 mid 复用；若服务端拉黑该 mid，可用模拟器再采 oracle 扩表。  
2. **Helios + Medusa 离线**  
   重量路径；Medusa 偏 VM，工作量大。  
3. **Ladon 语义**  
   播放接口可省略。  
4. **设备/版本漂移**  
   换大版本 so 后需回归消融与样本。  

---

## 13. 关键文件索引

| 路径 | 说明 |
|---|---|
| `docs/SIXGODS_RE_REPORT.md` | 本报告 |
| `docs/ABLATION_FINDINGS.md` | 消融表与双路径 |
| `docs/GORGON_RE_STATUS.md` | Gorgon 算法与验收清单 |
| `docs/REVERSE_LEARNING.md` | 全链路学习讲义 |
| `docs/API_REVERSE.md` | 业务 API 字段 |
| `python/metasec_offline.py` | 离线签名实现 |
| `python/ttnet_signer.py` | Frida 设备签名 oracle |
| `python/metasec_ablation.py` | 消融实验 |
| `python/gorgon_corpus_collect.py` / `gorgon_crack.py` | 语料与爆破 |
| `python/sign_samples/*` | 差分样本、Ghidra 日志、oracle |
| `python/native/libmetasec_ml.so` | 分析用 so |
| `main.js` / `renderer/*` | Electron 四模式 |

---

## 14. 时间线（浓缩）

```text
早期     裸协议 + spade 解密出片；六神未强制
         ↓
风控     110001 常态 → Frida 设备签名兜底（产品不断供）
         ↓
消融     证明 Khronos+Gorgon 最小；双路径 L/H
         ↓
形态     8404|mid|0000|body20；NewStringUTF 出 hex
         ↓
结构     cascade 对齐开源；key=f(mid)；固定 key 失败
         ↓
验收     oracle mid/key 离线 POST code=0；short query OK
         ↓
产品     OfflineSigner → api_grab → Electron「离线六神」模式
         ↓
现状     用户可无模拟器正常下载（本报告时点）
```

---

## 15. 结语

六神工作的本质不是「一次逆向出全部黑盒」，而是：

1. **用消融把问题降维**到两个头；  
2. **用经典算法骨架**对齐 body20；  
3. **用差分证明 key 只跟 mid 走**；  
4. **用服务端当最终裁判**确认布局；  
5. **用可复用的 mid/key 完成工程闭环**。  

闭式 KDF 与 Helios/Medusa 仍是研究项；  
**对「脱离模拟器、纯协议下视频」这一产品目标，当前方案已经闭环。**

---

*本文档随仓库维护；算法细节以 `GORGON_RE_STATUS.md` 与 `metasec_offline.py` 源码为准。*

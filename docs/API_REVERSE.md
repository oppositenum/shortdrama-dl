# 红果短剧纯协议逆向笔记

> **学习向总览**（方法论、分层、签名链、风控策略）：见 [REVERSE_LEARNING.md](./REVERSE_LEARNING.md)。  
> 本文偏接口字段与工程状态清单。

本文记录从 App 链路拆出的业务 API 与出片路径，对应实现见：

- `python/api_client.py` — HTTP 客户端
- `python/api_grab.py` — 纯协议抓取入口
- `python/spade_keys.py` — AES key 缓存 + spade 离线解包
- `python/decrypt_mdl.py` — cenc-aes-ctr 解密 + ffmpeg 重封装

## 1. 结论

| 步骤 | 是否已纯协议 | 说明 |
|---|---|---|
| 剧详情 + 分集列表 | ✅ | `POST /novel/player/video_detail/v1/` |
| 单集 CDN 地址 + 加密元数据 | ✅ | `POST /novel/player/video_model/v1/` |
| CDN 下载 | ✅ | 匿名 GET `main_url` |
| AES key（spade_a 解包） | ✅ | `spade_keys.unwrap_spade` 离线还原（libttmplayer UnWrapper） |
| 解密出片 | ✅ | 已有 `decrypt_mdl.py`（读 senc IV） |

**实测：** 用真实 `series_id` / `video_id` 调上述接口多数时候 **无需 X-Gorgon 等签名头**，只要带上 `aid=8662`、`device_id`、`iid` 等公共 query。  
连打几十集 `video_model` 后容易触发 **`Code=110001` 风控/频控**（甚至整段 IP 暂时封禁裸请求）。处理策略：

1. 分集间隔 `--interval`（Electron 默认 1.2s）
2. 命中后冷却 `--risk-cooldown`（默认 45s）并轮换 `device_id`
3. **自动 `--device-sign-auto`**：挂模拟器红果 App 的 Frida 签名继续（Electron 默认开启）

端到端验证（**无 Frida / 无签名头 / 纯本地**，2026-08-01）：

```text
python3 api_grab.py --series-id 7610708001174850584 --start-ep 1 --end-ep 2 --output-dir /tmp/hg
→ 第01集.mp4 1080p bytevc1 ~17MB 时长 193.3s
→ 第02集.mp4 1080p ~15MB 时长 170.6s
video_detail → video_model → CDN GET → unwrap_spade → decrypt_mdl  全本地
```

## 2. 主机与身份

- 业务 host（任选，失败可回退）：
  - `api5-normal-sinfonlinea.fqnovel.com`
  - `api.fqnovel.com`
  - `reading.snssdk.com`
- App：`com.phoenix.read`，`aid=8662`，`app_name=novelread`
- 公共 query 字段见 `api_client.DEFAULT_DEVICE`
- 设备身份可用环境变量：
  - `SHORTDRAMA_DEVICE_ID`
  - `SHORTDRAMA_INSTALL_ID`

## 3. 接口

### 3.1 剧详情 / 分集

```http
POST /novel/player/video_detail/v1/?aid=8662&device_id=...&iid=...&app_name=novelread&...
Content-Type: application/json

{"series_id":"7610708001174850584"}
```

响应要点：

```json
{
  "code": 0,
  "data": {
    "video_data": {
      "series_title": "...",
      "series_id": "...",
      "episode_cnt": 70,
      "video_list": [
        {"vid":"7610710952442350654","vid_index":1,"duration":193, ...}
      ]
    }
  }
}
```

DEX 模型名：`GetVideoAlbumDetailRequest` 用于 album；分集详情走 `video_detail`。

### 3.2 专辑元信息

```http
POST /novel/player/album_detail/v1/
{"album_id":"7610708001174850584","need_video_detail_info":true}
```

返回封面/简介/热度，**不含**完整分集 `vid` 列表。

### 3.3 单集播放模型（核心）

```http
POST /novel/player/video_model/v1/
{
  "video_id": "<vid>",
  "content_type": 1,
  "biz_param": {
    "video_platform": 3,
    "need_all_video_definition": true
  }
}
```

DEX：`GetVideoModelRequest{video_id, biz_param, content_type, mixed_video_id_map, NovelCommonParam}`  
`GetVideoBizParam` 关键字段：`video_platform`、`need_all_video_definition`（要全部清晰度必须开）、`device_level`、`source` 等。  
响应：`GetVideoModelResponse{data, code, message, log_id}`，其中 `data.video_model` 是 **JSON 字符串**。

`video_model` 内：

| 字段 | 含义 |
|---|---|
| `video_list[].main_url` / `backup_url` | CDN 直链（有 `url_expire`） |
| `video_list[].video_meta` | 清晰度 / 编码 / size / file_hash |
| `video_list[].encrypt_info.encrypt` | 恒 true |
| `video_list[].encrypt_info.kid` | 密钥 ID（各档共用） |
| `video_list[].encrypt_info.spade_a` | base64 包装密钥 |
| `video_list[].encrypt_info.encryption_method` | `cenc-aes-ctr` |
| `video_list[].gear_des_key` | 如 `0:MP4\|1:encrypt\|2:h265_hvc1\|4:720p\|...` |

注意：不带 `need_all_video_definition` 时常见只回 **1 档（720p）**；720p 可能是 ByteVC2。App 离线库可有 5 档（360–1080）。

### 3.3.1 Code=110001 与 TTNet 签名（必做）

```json
{"Code":110001,"Message":"未知异常","BaseResp":{"StatusCode":110001,"StatusMessage":"unknown error"}}
```

含义（实测 2026-07-31）：

- **不是** Electron 接线失败，也 **不是** spade 解包失败。
- 服务端对 `video_detail` / `video_model` 等**播放接口**强制校验 App 同款 TTNet 安全因子；`album_detail` 等弱接口有时仍可裸调。
- 裸 HTTP（仅公共 query + JSON body）**会被拒**；必须走与 App 相同的签名链。

#### 签名链（已逆向到可复用入口，宿主 HTTP 可用）

| 层级 | 组件 | 作用 |
|---|---|---|
| Query | `NetworkParams.addCommonParams(url, true)` | 补齐 `device_id/iid/klink_egdi/_rticket/...` |
| Stub | `MD5(body).hex().upper()` | 请求头 `x-ss-stub` |
| Ticket | `str(ms_epoch)` | 请求头 `x-ss-req-ticket` |
| **安全因子** | `com.dragon.read.base.http.b.onCallToAddSecurityFactor(fullUrl, Map)` | 返回 `X-Gorgon/X-Argus/X-Ladon/X-Khronos/X-Helios/X-Medusa` |
| 发送 | 宿主 `urllib` POST + 上述头 | **无需**再走 App 内 `executePost` |

补充：

- `MSManager.frameSign` → `signvalue/signinfo/lid`（frame 协议，**不是** HTTP Gorgon）
- HTTP/2 下 SSL_write 看不到明文头（HPACK）；必须 hook Java 入口

**输入 / 输出样例（2026-08-01 实测）：**

```text
in:
  url = https://api5-.../novel/player/video_detail/v1/?klink_egdi=...&aid=8662&...
  x-ss-stub = MD5('{"series_id":"..."}').upper()
  x-ss-req-ticket = "1785516747xxx"

out headers:
  X-Gorgon: 8404....   (hex)
  X-Khronos: <unix sec>
  X-Argus / X-Ladon / X-Helios / X-Medusa: base64
```

**已验证：**

```text
# 主路径（2026-08-01）：裸 HTTP 即可
api_grab.py（无 --device-sign）→ video_detail/model code=0 → 出片 1080p

# 签名路径（风控 110001 时）
Frida onCallToAddSecurityFactor → 宿主 urllib → code=0
api_grab --device-sign 第1集 1080p 出片成功
```

实现：`python/ttnet_signer.py`  
接入：`HongguoApiClient(signer=...)` / `api_grab.py --device-sign`

```bash
# 主路径：纯协议，无需设备
python3 python/api_grab.py \
  --series-id 7610708001174850584 \
  --start-ep 1 --end-ep 1 \
  --output-dir /tmp/hg_offline

# 兜底：模拟器已装红果 + frida-server，本机 frida
python3 python/api_grab.py ... --device-sign --adb-device emulator-5554
```

环境变量：`SHORTDRAMA_DEVICE_SIGN=1`、`SHORTDRAMA_ADB_DEVICE=emulator-5554`

#### 完整调用链（Java → Native）

```text
宿主/App 请求
  └─ com.dragon.read.base.http.b  (extends AbsCronetDependAdapter)
       └─ AbsCronetDependAdapter.onCallToAddSecurityFactor(url, Map)
            ├─ 把 Map<String,String> 转成 Map<String,List<String>>
            └─ NetworkParams.tryAddSecurityFactor(url, map)
                 └─ sAddSecurityFactorProcessCallback
                      = ms.bd.c.y4.onCallToAddSecurityFactor  (MetaSec 回调)
                           └─ ms.bd.c.f3.a(int,int,long,String,Object)  【NATIVE】
                                └─ libmetasec_ml.so  (真正 Gorgon/Argus/… 实现)
```

#### MetaSec native 协议（`ms.bd.c.f3.a`）— 已完整抓到 I/O

从 `ms.bd.c.y4` smali + Frida 反射 Array 抓取：

```text
f3.a(opcode, b, handle, s, data) -> Object

opcode 0x1000001  字符串解密
  data = byte[] 密文, s = 字符串 id（如 "8e890e"）
  return String（如 "http" / "https"）

opcode 0x3000001  HTTP 签名（主路径）  ★
  handle = ms.bd.c.z4.a  (long，进程内会话句柄，如 511428941648)
  s      = 完整 https URL
  data   = String[4] = ["x-ss-stub", stub, "x-ss-req-ticket", ticket]
  return String[12] = [
    "X-Argus", val, "X-Gorgon", val, "X-Helios", val,
    "X-Khronos", val, "X-Ladon", val, "X-Medusa", val
  ]

opcode 0x6000001  非 http 方案变体
```

实测头形态（aid=8662 / 2026-08-01）：

| 头 | 形态 | 离线还原 |
|---|---|---|
| X-Gorgon | 26 字节 hex：`8404` + 2B mid + `0000` + 20B body | ⏳ body 加密，密钥随请求变化（非公开 0404/8404 固定 key） |
| X-Khronos | unix 秒，≈ ticket//1000 | ✅ |
| X-Argus | **4 字节** base64 = `b64(LE uint32(Khronos))` | ✅ 语料 6/6 验证 |
| X-Ladon | 4 字节 base64 | ⏳ |
| X-Helios | ~36 字节 base64 | ⏳ |
| X-Medusa | ~940 字节 base64（主载荷） | ⏳ MetaSec VM |

#### Native 控制流（Ghidra）

```text
libmetasec_ml.so (AArch64, imageBase 在 Ghidra 为 +0x100000)
  JNI_OnLoad @ 0x28f03c
    → 混淆初始化 + 间接跳转

  f3.a JNI trampoline @ 0x281ad4
    → 参数重排 → b 0x17f5a4

  dispatcher FUN @ 0x17f5a4
    → 打包参数栈帧
    → FUN_00273ba4(...)   ★ 自定义 VM 分发

  FUN_00273ba4 @ 0x173ba4
    → 按 *param_1 低 6 bit 查表间接跳转
    → 「WARNING: Could not recover jumptable — Too many branches」
    → 典型 MetaSec 字节码 / CFF VM
```

so 可从 App 包抽出（约 5.6MB，不入库）：  
`python/native/libmetasec_ml.so`（本地 pull，见 `.gitignore`）

样本与笔记：`python/sign_samples/`  
离线骨架：`python/metasec_offline.py`（`partial_headers` + 语料校验）  
Ghidra 日志：`python/sign_samples/ghidra/`

#### 离线算法状态

| 项 | 状态 |
|---|---|
| 签名入口与入参 | ✅ 已定 |
| 六神头字段集合与长度 | ✅ 已定 |
| f3.a 完整入参/出参（Array 反射） | ✅ 已抓 |
| 差分样本语料 | ✅ `f3_diff_corpus.json` |
| X-Khronos / 短 X-Argus 纯 Python | ✅ |
| 用 App 实例生成头 + 宿主 urllib 出片 | ✅ |
| so 内 JNI 地址 / VM 分发点 | ✅ Ghidra 定位 |
| Gorgon 8404 body / Medusa 等 | ⏳ VM（不阻塞出片） |
| **无 Frida 纯协议出片** | ✅ **已成功**（见 §1；签名非硬依赖） |

> **Electron：** `main.js` 已支持 `grabMode=api` → `api_grab.py`，无需设备。  
> 六神头完整 VM 复刻仍可后续做，作为 110001 时的无设备兜底；当前主路径是裸协议。

### 3.4 其它相关路径（DEX 可见，参数未完全敲定）

```text
POST /novel/player/multi_video_detail/v1/
POST /novel/player/multi_video_model/v1/
POST /novel/player/multi_video_detail/:dr_scene/v1/
POST /novel/player/multi_video_model/:dr_scene/v1/
GET  /reading/bookapi/video_tab/video_model/v:version/
GET  /reading/bookapi/video_tab/video_detail/v:version/
GET  /reading/bookapi/video_tab/multi_video_detail/v:version/
POST /reading/bookapi/multi_video_data/get/v:version/
```

刷新播放：`fallback_api` 指向  
`https://vas-lf-x.snssdk.com/video/fplay/1/...`（CDN 过期后可用）。

## 4. 加密与 spade_a

- 算法：`cenc-aes-ctr`，样本 IV 在文件 `senc` box 内（`decrypt_mdl.py` 已直接读取）。
- `spade_a` 标准 base64，解码后通常 **37 字节**；不是明文 key。
- **真正解包不在 `libvideodec` 的 0xA8 路径**，而在播放器 `libttmplayer` UnWrapper（`setStringOption(144, spade_a)`）。

### 4.1 离线算法（已实现）

```text
raw = b64decode(spade_a)          # 37 bytes
xored = raw[0] ^ raw[1] ^ raw[2]
suffix_len = xored - 0x30         # 红果样本恒为 2
body = raw[1 : 1 + (len - xored + 0x2f)]   # 34 bytes
tag  = 由末尾 suffix_len 字节与 seed XOR 得到  # 红果样本为 b"11"

if tag 匹配 "app_v2"/"web_v2" 前缀:
    成对交换 + 链式变换 B
else:
    链式变换 A（0x55/0xFA 寄存器被 body 字节覆盖，含 popcount 位移）

变换后 body 为 ASCII:  "{digit}{32-hex-key}{trailer}"
key = bytes.fromhex(中间 32 字符)
```

实现：`python/spade_keys.py` → `unwrap_spade` / `try_offline_unwrap`。  
用历史 35 组 Frida key 对验证 **35/35**。

### 4.2 易混淆点

| 路径 | 用途 |
|---|---|
| `libvideodec.getDecodedStr` + 头 `0x00A8/0x0001` | 另一类包装（URL/`key_seed` 场景），**不是**当前红果 `spade_a` |
| `TTHelper.base64Decode(s, key_seed)` | 解码 **加密 URL** 等，需要 video_model 顶层 `key_seed`；红果当前 model **无**该字段 |
| `libttmplayer` UnWrapper | **当前** `spade_a` → AES key |

## 5. CLI

```bash
# 依赖: python3, cryptography, ffmpeg/ffprobe
python3 python/api_grab.py \
  --series-id 7610708001174850584 \
  --start-ep 1 --end-ep 5 \
  --output-dir ~/Downloads/无敌王三七 \
  --key-cache python/key_cache.json
```

环境变量：

| 变量 | 作用 |
|---|---|
| `SHORTDRAMA_DEVICE_ID` | 覆盖 device_id |
| `SHORTDRAMA_INSTALL_ID` | 覆盖 iid |
| `SHORTDRAMA_KEY_CACHE` | key 缓存路径 |
| `HONGGUO_RUNTIME_DIR` | 默认缓存根目录 |

## 6. 与旧 App 链路对比

| | 旧 `hongguo_grab.py` | 新 `api_grab.py` |
|---|---|---|
| 搜剧 | UI 自动化 | series_id 直调 |
| 分集 | App 下载库 | video_detail |
| 媒体 | 离线 .mdl 或 CDN | 仅 CDN |
| 拿 key | 断网逐集播放 + Frida | 纯本地 `unwrap_spade` |
| 速度 | 慢（UI + dwell） | 接近纯下载带宽 |
| 依赖 | root/模拟器/Frida | 仅网络 + 密钥 |

## 7. 下一步

1. ~~还原 spade_a 离线解包~~ ✅
2. 摸清 `multi_video_model` / 多清晰度参数，稳定拿 1080p HEVC（非 ByteVC2）
3. 搜索接口（按剧名 → series_id）纯协议化；处理 Code 110001 频控
4. ~~Electron 侧增加「纯协议模式」开关，与 App 抓取并列~~ ✅（`grabMode=api`，与 App 互不替代）

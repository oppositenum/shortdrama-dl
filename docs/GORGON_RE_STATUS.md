# Gorgon 8404 逆向进度（P0）

> 目标：离线生成 `X-Gorgon`，配合已破解的 `X-Khronos` → 110001 最小集。  
> 消融：见 [ABLATION_FINDINGS.md](./ABLATION_FINDINGS.md)。  
> **2026-08-04：离线 Khronos+Gorgon 已对线上 video_detail / video_model 验收 code=0（无需模拟器）。**

## 形态（钉死）

```text
X-Gorgon = hex(26 bytes) = 84 04 | mid(2) | 00 00 | body(20)
```

- **mid** 形态恒为 `N0XX`（高字节低 4 bit = 0）→ 有效熵 12 bit。  
- **body20** = 经典 leviathan cascade 加密输出。

## 离线算法（已验收）

```text
param[20] =
    md5(url_query)[:4]
  + md5(POST_body)[:4]          # 即 x-ss-stub 前 4 字节
  + 00 00 00 00                 # cookie 空
  + 00 06 0B 1C                 # 常量
  + big-endian(uint32 khronos)

body20 = cascade_encrypt(param, key)
X-Gorgon = hex(84 04 || mid || 00 00 || body20)
X-Khronos = unix_seconds
```

cascade 与开源 0404/0408 相同：`rev_nib` + 邻位 XOR + `rbit` + `^0x14`。

### key = f(mid)

- 同一 mid → 同一 key（跨请求、跨 URL/body/ts 稳定）。  
- 闭式 KDF（不依赖查表）尚未还原。  
- **产品策略**：内置 oracle 条目（`sign_samples/gorgon_mid_key_oracle.json` + 默认 mid=`401c`），固定 mid/key 复用即可过服务端。  
- 语料扩展：用 `ttnet_signer` 签一批样 → `recover_key_from_sample` 写入 oracle。

### 已否定

| 尝试 | 结果 |
|---|---|
| 经典固定 key（gaplan DF77…） | 110001 |
| query 用 path+query / full URL | 110001（必须 **仅 query string**） |
| 仅 Khronos / 仅 Gorgon | 110001 |

### 实测对照（2026-08-04）

| 请求 | 结果 |
|---|---|
| 裸 short query | 110001 |
| 离线 KG + short DEFAULT_DEVICE query | **code=0** |
| 离线 KG + App full_url | **code=0** |
| video_model 离线 KG | **code=0** + spade_a/main_url |
| Helios+Medusa（无 G） | code=0（另一条路径，算法未离线） |

## 产品接入

```text
python/metasec_offline.py  OfflineSigner / encode_gorgon_8404 / sign_kg_headers
python/api_client.py       offline_sign=True（默认，SHORTDRAMA_OFFLINE_SIGN=1）
python/api_grab.py         默认启用离线签名；--device-sign 仍可走 Frida
```

```bash
# 完全脱离模拟器
python3 api_grab.py --series-id <id> --output-dir ./out

# 强制关离线（仅裸 HTTP）
python3 api_grab.py ... --no-offline-sign
```

## 工具链

```bash
cd python
python3 gorgon_corpus_collect.py --device emulator-5554 --n 8   # 扩 oracle（需设备）
python3 gorgon_crack.py
python3 metasec_offline.py   # 自检 + oracle roundtrip
```

## 研究剩余（非阻塞）

1. 还原 `key = KDF(mid)` 闭式（当前 12-bit mid，或可从 libmetasec VM 抽）  
2. Helios(36B) + Medusa(~940B) 离线  
3. Ladon 4B 形态  

## 验收

- [x] 离线头挂在 short query 上，`video_detail` / `video_model` → code=0  
- [x] 无 Frida / 无模拟器跑通列表 + 播放模型  
- [ ] 长剧整本下载回归（产品路径）  
- [ ] mid→key 闭式 KDF  

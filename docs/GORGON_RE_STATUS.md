# Gorgon 8404 逆向进度（P0）

> 目标：离线生成 `X-Gorgon`，配合已破解的 `X-Khronos` 形成最小抗 110001 集。  
> 消融结论见 [ABLATION_FINDINGS.md](./ABLATION_FINDINGS.md)。

## 形态（已钉死）

```text
X-Gorgon = hex( 26 bytes )
         = 84 04 | mid(2) | 00 00 | body(20)
```

- 生成位置：**native**（`libmetasec_ml.so`），Java 层无 StringBuilder 拼 `8404`
- 入口：`ms.bd.c.f3.a(0x3000001, …)` → MetaSec VM

## 工具

| 脚本 | 作用 |
|---|---|
| `python/gorgon_corpus_collect.py` | 差分语料（同/不同 body、连续时间） |
| `python/gorgon_crack.py` | 经典 cascade 密钥反推、mid 相关性 |
| `python/frida_gorgon_plaindump.py` | f3 I/O + Gorgon 解析 |
| `python/frida_gorgon_native.py` | 签名后内存精确扫 26B 缓冲 |

## 已做实验结论

1. **经典 0404/8402 cascade + 固定 key 无法跨样本复现**（key 随请求变）。  
2. **mid 每请求变化**，像随机或密钥扩展输入；偶发相同 mid 时 body20 前缀更相似。  
3. **body20 与 stub/khronos 强相关**（同 stub 两次 body20 全不同）。  
4. 语料：`sign_samples/gorgon_diff_corpus.json`（可重复采集）。

## 下一步（硬核）

1. `frida_gorgon_native.py` 拿到 **mem_match 地址** 后：  
   - 对该地址 `MemoryAccessMonitor` / 写断点  
   - 或 Stalker 只跟写 body20 的 basic block  
2. dump **写入前的 20B 明文候选**（query MD5 前 4 + stub 前 4 + …）  
3. 若明文 = 经典 param 布局 → 只差 **per-request key(mid)**  
4. 实现 `metasec_offline.gorgon_8404(url, stub, khronos, mid?)` 并用消融最小集线上验证

## 验收

- 离线产出的 `X-Khronos`+`X-Gorgon` 挂在 **App full_url** 上  
- `video_detail` / `video_model` 在 110001 窗口 `code=0`  

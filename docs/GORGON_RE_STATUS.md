# Gorgon 8404 逆向进度（P0）

> 目标：离线生成 `X-Gorgon`，配合已破解的 `X-Khronos` → 110001 最小集。  
> 消融：见 [ABLATION_FINDINGS.md](./ABLATION_FINDINGS.md)。

## 形态（钉死）

```text
X-Gorgon = hex(26 bytes) = 84 04 | mid(2) | 00 00 | body(20)
```

## 产品 vs 研究

| | 状态 |
|---|---|
| 协议出片（裸请求） | ✅ 可用 |
| 110001 + Frida 签名 + App full_url | ✅ 可用 |
| **离线纯 Python 算 Gorgon** | ⏳ 研究中（不阻塞出片） |

## 工具链

```bash
cd python
python3 gorgon_corpus_collect.py --device emulator-5554 --n 8
python3 gorgon_crack.py
python3 frida_gorgon_plaindump.py --device emulator-5554 --trigger 3
python3 frida_gorgon_native.py --device emulator-5554 --trigger 2
python3 frida_gorgon_stalker.py --device emulator-5554 --trigger 2
```

| 脚本 | 作用 |
|---|---|
| `gorgon_corpus_collect.py` | 差分语料 |
| `gorgon_crack.py` | 经典 cascade / mid 爆破 |
| `frida_gorgon_plaindump.py` | f3 I/O |
| `frida_gorgon_native.py` | 内存扫 26B |
| `frida_gorgon_stalker.py` | memcpy + **NewStringUTF** + metasec 站点 |

## 关键突破（持续更新）

### 1) Gorgon 进 Java 的位置（已钉死）

```text
libmetasec_ml.so + 0x283640
  → (vtable + 0x538) / art::JNI::NewStringUTF
  → cstr = "8404........" (52 hex chars, 非 26 字节二进制)
```

反汇编要点（运行时）：

```text
mov x20, x0
mov x19, x1          // 已是 hex 字符串或 C++ string 数据
bl  +0x182fd8
ldr x8, [x20]; ldr x8, [x8, #0x538]
blr x8               // → NewStringUTF，返回到 +0x283640
```

Ghidra：`FUN_003835dc`（+0x2835dc）调用方包括：

| 调用方 | 作用线索 |
|---|---|
| `FUN_00381ed8` | `vsnprintf` 拼串 → `FUN_003835dc`（日志/格式化旁路，签名时未必走） |
| `FUN_00383678` / `FUN_003836f4` | 把栈上 C++ string 送进 `FUN_003835dc` |

### 2) 二进制 26B 几乎不落地

| 尝试 | 结果 |
|---|---|
| 扫内存精确 26B `84 04 .. 00 00` | 无与当次 Gorgon 匹配 |
| memcpy 钩 n=26 | 无 8404 前缀 |
| NewStringUTF 时扫栈/寄存器 | **bins=0** |
| libc `snprintf`/`vsnprintf` | **无 8404 输出** |

**推论：** Gorgon 很可能 **按半字节写成 ASCII hex**（或私有转换，不经 libc printf），**从不**以「26 字节结构体」完整存在于堆/栈可扫区域。  
消融里的「26 字节形态」是**逻辑结构**，不是运行时对象布局。

### 3) hex 字母表与候选编码器

```text
rodata: file+0xc403e  "0123456789abcdef"
        file+0xc4258  "0123456789ABCDEF"
```

ADRP+ADD 精确指向小写表的站点很少（约 2 处），其一：

```text
file + 0x28aeac  （Ghidra 反编译为 nibble 循环查表 → 疑似 int/bytes→hex）
file + 0x28ad00  同类
```

对上述地址粗暴 Interceptor 易导致进程/脚本被毁（反调试或钩到函数体中间）。需 **精确函数入口 + 最小 onEnter** 或静态跟 xref。

### 4) 否定的算法路径

| 尝试 | 结果 |
|---|---|
| 经典 0404 cascade + 固定 key | 无稳定 key |
| mid 派生 key × 多种 param | 0 hit |
| 仅 XOR | 0 hit |

### 5) 语料 / 日志

- `sign_samples/gorgon_diff_corpus.json`
- `sign_samples/gorgon_stalker.jsonl` / `gorgon_hexenc.jsonl`
- `sign_samples/ghidra/xref_gorgon.log` / `decomp_hexenc.log` / `hex_callers.log`

## 下一步（可执行）

1. **静态：** 以 `0x28ad00` / `0x28aeac` 为锚，Ghidra 找 **真正 bulk 26B→52hex** 的上层循环（或 VM handler）。  
2. **动态：** 只钩确认的函数 prologue；或对 `meta.base+0x28ad00` 用 `Stalker` 仅跟该函数范围。  
3. 在 hex 循环里 dump：**每字节输入** + **输出缓冲** → 还原 26B 序列。  
4. 再往前追 26B 的生成（加密/拼接）。  
5. 落地 `metasec_offline.gorgon_8404`，验收：`Khronos+Gorgon` + App full_url → `code=0`。

## 验收

离线头挂在 `addCommonParams` 后的 URL 上，风控窗口 `video_detail`/`video_model` 成功。

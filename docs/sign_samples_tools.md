# 六神破解实验工具

配合 [REVERSE_LEARNING.md](./REVERSE_LEARNING.md) 第 6–7 节与「完全破解六神」路线。

## 1. 消融实验 `metasec_ablation.py`

**问题：** 服务端 110001 时，最少要哪些头？

```bash
cd python

# 推荐：Frida 取「新鲜完整六神」再消融（红果挂着 + frida-server）
python3 metasec_ablation.py \
  --series-id 7610708001174850584 \
  --device emulator-5554 \
  --path both

# 无设备：用语料旧头（可能因时效失败，仅参考）
python3 metasec_ablation.py --series-id ... --from-corpus --path detail
```

输出：

- 终端表格：`set / code / ok`
- `python/sign_samples/ablation_report.json`

解读：

| 现象 | 含义 |
|---|---|
| `none`/`stub` 也 ok | 当前无风控，需等 110001 窗口重跑 |
| 仅 `full6` ok | 签名有效；看 leave-one-out 谁被硬校验 |
| `full_minus_Medusa` 仍 ok | Medusa 可能非必需，优先攻 Gorgon |
| **control `app_exec` ok，host full6 也 ok** | 消融表可信 |
| **app_exec ok，host full6 失败** | 缺 cookie/UA 或 PC 出口与 App 不同 |
| **两边都 110001** | 不只是缺头（设备/账号/IP 业务风控） |
| 短 query + full6 失败 | **正常**：签名绑的是 App `addCommonParams` 后的完整 URL |

### 踩坑（你这次日志）

Frida 已签出六神，但矩阵全 110001，且「拿不到 vid」——旧脚本用**短 query** 去 POST，与签名用的 **App 完整 URL** 不一致，full6 也会挂。  
已修：请求 URL 必须等于 `NetworkParams.addCommonParams` 后的 URL；并增加 `app_exec` / `host_full6_same_url` 对照。

## 2. Gorgon dump `frida_gorgon_plaindump.py`

**问题：** f3 边界 I/O 与 Gorgon 字符串从哪冒出来？

```bash
cd python
python3 frida_gorgon_plaindump.py --device emulator-5554 --trigger 5
```

输出：

- `sign_samples/gorgon_plaindump.jsonl` 事件流
- `sign_samples/gorgon_plaindump_last.json` 摘要（含 `gorgon_parse`: mid/body20）

已捕获：

- `f3.a(0x3000001)` 入参 url/stub/ticket、出参六神
- 若 Java 拼出 `8404…` 字符串，带短栈

**尚未自动捕获：** native VM 内「加密前 20 字节明文」（需对 `libmetasec_ml.so` 再下读写断点/Stalker；本工具先钉死 Java 边界）。

## 3. Gorgon P0 工具链

| 脚本 | 命令 |
|---|---|
| 差分语料 | `python3 gorgon_corpus_collect.py --device emulator-5554 --n 8` |
| 算法探测 | `python3 gorgon_crack.py` |
| native 内存扫 | `python3 frida_gorgon_native.py --device emulator-5554 --trigger 3` |
| NewStringUTF / 站点 | `python3 frida_gorgon_stalker.py --device emulator-5554 --trigger 2` |

进度说明：[GORGON_RE_STATUS.md](./GORGON_RE_STATUS.md)  

**路标：** Gorgon hex 从 `libmetasec_ml.so+0x283640` → `NewStringUTF` 进入 Java（见 stalker 日志）。

## 4. 建议实验顺序

1. 消融（已完成：最小集 Khronos+Gorgon）  
2. `gorgon_corpus_collect` + `gorgon_crack`  
3. `frida_gorgon_native` 找 26B 缓冲地址 → 写断点/Stalker  
4. 还原 body20 → 线上用最小集验证  

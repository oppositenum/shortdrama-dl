# shortdrama-dl 架构与运行协议

本文档记录 Electron 与 Python 正式运行链的边界。除非同时更新并验证协议两端，否则不得修改这里列出的参数、事件、退出码、信号处理和命名规则。

## 1. 组件边界

### Electron

Electron 主进程位于项目根目录 `main.js`，负责：

- 创建桌面窗口并通过 `preload.js` 暴露白名单 IPC。
- 解析播放页，以及详情页/分类页的剧名、总集数和封面。
- 仅对单播放页使用 Playwright 捕获媒体请求；整剧网页路径不下载分集视频。
- 用 Node.js `fetch` 下载直连 MP4。
- 用 `fluent-ffmpeg` + 当前系统原生 FFmpeg 合并 HLS/DASH；缺少时经用户确认安装。
- 管理剧集目录、封面、断点续传和 `.complete`。
- 处理整剧时从第 1 集启动 Python 子进程抓取全集。
- 解析 Python stdout JSON Lines、筛选 stderr、处理退出码和取消操作。

### Python

Python 正式入口为 `python/hongguo_grab.py`，负责：

- 校验 CLI 参数和主机依赖。
- 选择 ADB 设备并对同一设备加进程锁。
- 检查 root、目标 App、Frida、ffmpeg 和 cryptography。
- 准备 Frida Server 与 ADBKeyboard。
- 通过 UI 自动化搜索目标剧并管理 App 离线下载。
- 拉取并读取 App SQLite 下载库。
- 建立集号、视频 ID、播放源 ID 与 `.mdl` 文件之间的确定性映射。
- 断网播放离线文件并加载 Frida Hook。
- 将采集到的密文样本映射回正确集号。
- 调用解密辅助脚本并用 ffprobe 核对成片时长。
- 输出稳定的 JSON Lines 协议。
- 在结束或取消时清理临时文件、恢复网络并释放设备锁。

Electron 不导入 Python 模块，Python 也不依赖 Electron API。唯一正式边界是子进程参数、工作目录、环境变量、stdout、stderr、退出码和操作系统信号。

## 2. Electron 启动位置

正式调用位于 `main.js` 的 `grabWithApp(...)`。触发条件为：

1. 处理的是详情页或分类页中的整剧。
2. App 抓取选项未显式关闭。
3. 能从 `episode_cnt` 或 `vid_list.length` 确定大于 0 的总集数。
4. 输出目录中尚未实际存在从第 1 集到总集数的全部非空分集。
5. 未收到取消请求。
6. 能解析到包含 `hongguo_grab.py` 的工具目录。

单播放页下载不会启动 Python。整剧网页路径只保存封面，不会捕获或下载网页分集。

## 3. Python 组件目录解析

`resolveGrabDir(configured)` 按下列顺序查找，并以目录内存在 `hongguo_grab.py` 为命中条件：

1. UI 传入的组件目录。
2. 环境变量 `HONGGUO_GRAB_DIR`。
3. 统一项目默认目录：
   - 开发态：`<project-root>/python`。
   - 打包态：`<resources>/python`。
开发态的 Electron `__dirname` 是项目根目录。打包态的 JavaScript 位于 ASAR 中，因此 Python 不能以 ASAR 内路径执行；`electron-builder.js` 使用 `extraResources` 将 Python 文件复制到真实的 `process.resourcesPath/python`。

## 4. 抓取前环境准备

正式 Python 子进程启动前，Electron 依次执行：

1. 根据 `process.platform` 选择主机流程：`darwin` 为 macOS，`win32` 为 Windows；其他系统明确拒绝 App 抓取自动准备。
2. 验证 Python 3.11+、`frida==17.16.4` 和 `cryptography>=41`；需要时在开发项目 `.venv/` 或打包应用用户数据目录创建隔离环境（失败时会清除并 `--clear` 重建）。缺少 Python 时，macOS 使用 Homebrew，Windows 使用 WinGet 安装 Python 3.12。
3. 验证系统 `ffmpeg`/`ffprobe`；缺失时经用户确认，macOS 使用 Homebrew，Windows 使用 WinGet，并在安装后重新校验两个命令。
4. macOS 调用 `start_avd.sh`，Windows 调用 `start_avd.ps1`。先以 check 模式探测，已有设备直接复用；已有但停止的 `hongguo` AVD 自动启动；缺少 SDK/AVD 时经用户确认后以 install-missing 模式准备。
5. 将脚本返回的设备序列号写入 Python 子进程的 `ANDROID_SERIAL`。
6. 将应用用户数据目录下的 `runtime/android` 通过 `HONGGUO_RUNTIME_DIR` 传给 Python，作为所有抓取缓存的可写根目录。
7. Python 检查设备 Frida Server。缺少或版本不匹配时，从官方 Frida Release 下载到应用用户数据缓存（长超时、多镜像重试；可选 `SHORTDRAMA_GITHUB_PROXY` / `SHORTDRAMA_FRIDA_SERVER`），然后推送并启动。

环境准备进程也受 Electron 取消操作管理。取消期间不会启动正式 Python 抓取进程。

网页链路另外在 Playwright 无法启动 Chrome、Edge 或开发态 Chromium 时按同一平台判定询问安装 Chrome。Homebrew 或 WinGet/Microsoft App Installer 是主机软件安装入口，不随应用捆绑；入口本身缺失时应用会报出明确前置条件，不会把其他系统的安装命令拿来兜底。

## 5. 子进程命令

CLI 参数和工作目录如下；解释器使用已经过版本和依赖验证的路径或命令：

```text
executable: <validated Python 3.11+>
cwd:        解析出的 Python 组件目录
environment: buildGrabEnv() 返回的当前环境、补充 PATH、ANDROID_SERIAL 和 HONGGUO_RUNTIME_DIR

arguments:
  hongguo_grab.py
  --series-name <seriesName>
  --start-ep 1
  --end-ep <totalEpisodeCount>
  --output-dir <absolute series directory>
```

Electron 没有向正式调用传 `--series-id`、`--dwell`、`--keep-download` 或 `--prefer-1080p`，但 Python CLI 继续接受这些兼容参数：

| 参数 | 必填 | 当前语义 |
|---|---|---|
| `--series-name` | 是 | App 内搜索使用的剧名 |
| `--series-id` | 否 | 保留兼容，App 端按剧名搜索，当前忽略 |
| `--start-ep` | 是 | 起始集，包含端点 |
| `--end-ep` | 是 | 结束集，包含端点；超过总集数时截断 |
| `--output-dir` | 是 | 成品输出绝对目录 |
| `--dwell` | 否 | 每个采集窗口等待秒数，默认 `8.0`，最小 `3.0` |
| `--keep-download` | 否 | 不删除 App 离线下载 |
| `--prefer-1080p` | 否 | 所有集都用服务端 1080p 源；默认仅在离线副本是 ByteVC2 时换源 |

### 出片源的选择（ByteVC2）

App 的离线下载**固定走 720p 档**，与播放器里选的清晰度无关（下载任务 id 即 `<vid>_720p`；把播放清晰度调到 1080P 再重下，拿回来的仍是同一个文件）。服务端为每集准备 5 个档位，其中 **1080p 档是标准 HEVC**，而 720p 档有一部分集是 **ByteVC2**（字节私有编码，ffmpeg 既无解码器也无封装标签，`-c copy` 会以 `Could not find tag for codec none` 失败，产出 0 字节）。

因此 `_flush_ready()` 在出片前先读离线副本的真实编码（`stsd` 加密条目里的 `sinf/frma`）：

- `hvc1` → 直接用 App 的 `.mdl` 出片；
- `bvc2` → 只把这一集的 key 记进 `DEFERRED`，推迟到抓取结束、恢复联网后由 `produce_from_cdn()` 下载 1080p 档再出片。

换源之所以成立，靠两点（均已实测验证）：同一集各清晰度档位共用同一个 `kid`，即同一把 AES key；每个样本的 IV 直接写在文件自己的 `senc` box 里（与早期用 frida 密文锚点反推的 base 一致，24/24 条轨吻合），因此解密不再要求“这个文件本身被播放过”。

`produce_from_cdn()` 必须排在 `delete_downloads()` 之前——播放地址读自 App 下载库的 `t_series_video_model`，删下载会连表一起清掉。

`buildGrabEnv()` 保留当前进程环境并按系统补 PATH。macOS 增加 Homebrew、MacPorts 与 `~/Library/Android/sdk`；Windows 增加 WinGet Links/Packages、用户 Python 目录与 `%LOCALAPPDATA%\Android\Sdk`。两端都识别 `ANDROID_HOME`、`ANDROID_SDK_ROOT` 与 `SHORTDRAMA_SDK_ROOT`。Windows 同时维护大小写可能不同的继承 PATH 键，避免 GUI 进程环境丢失新安装工具。

多设备选择通过 `ANDROID_SERIAL` 传给 ADB 和 Frida。未设置时，Python 仅在多设备中存在唯一 `emulator-*` 时自动选择它。

## 6. stdout JSON Lines 协议

stdout 必须保持 UTF-8 JSON Lines：每行一个完整 JSON 对象，以换行结束。调试文本不得写入 stdout。

| 事件 | 必有/可能字段 | 语义 |
|---|---|---|
| `init` | `device`, `total` | 初始化完成；`total` 是扣除已有非空文件后的实际待抓数 |
| `episode_start` | `ep` | 开始解密和输出某一集 |
| `progress` | `ep`, `percent` | 粗粒度进度；当前正式代码在准备解密时发出 `80.0` |
| `episode_done` | `ep`, `file` | 该集成功，`file` 是最终分集文件名 |
| `episode_failed` | `ep`, `error` | 该集失败；后续集继续处理 |
| `log` | `level`, `message` | 人类可读日志，`level` 使用 `info`、`warn` 或 `error` |
| `done` | `ok`, `failed` | 正常或部分失败的最终汇总；环境错误和取消不发送 |

示例：

```json
{"event":"init","device":"<serial>","total":56}
{"event":"episode_start","ep":1}
{"event":"progress","ep":1,"percent":80.0}
{"event":"episode_done","ep":1,"file":"第01集.mp4"}
{"event":"episode_failed","ep":3,"error":"decrypt/repack failed"}
{"event":"done","ok":55,"failed":[3]}
```

Electron 对 stdout 做按行缓冲，并按 `event` 映射到现有 `download:*` UI 通道。无法解析的行会被忽略作为防御性兜底，但这不代表可以向 stdout 添加其他内容。

## 7. stderr

stderr 专用于调试和诊断：

- Python `dbg(...)` 输出。
- Python traceback。
- `decrypt_mdl.py` 的捕获输出经主入口转发。
- Frida JavaScript `console.log` 通过 `set_log_handler` 改写到 stderr，避免污染 stdout。

Electron 只把匹配 `error|exception|traceback|failed|refused|not found` 的 stderr 行以 warning 显示。stderr 内容不是机器协议，不能用它判断成功集数。

## 8. 退出码

| 退出码 | 语义 | 是否有最终 `done` |
|---|---|---|
| `0` | 全部成功，或断点续传后无待抓集 | 是 |
| `2` | 部分失败或业务处理未完成 | 是 |
| `3` | 环境错误，如设备、App、依赖、Frida 或映射前置条件不满足 | 否 |
| `130` | 收到 `SIGTERM`/`SIGINT` 后安全退出 | 否 |

Electron 将退出码 `3` 降级为“保留封面和已有分集”，不会把已保存的内容删除。退出码 `130`、Electron 已设置取消标志或子进程由 `SIGTERM` 关闭时，Electron 统一进入取消分支。

## 9. SIGTERM 取消流程

1. 用户点击“取消”。
2. Electron 设置 `isCanceled = true`。
3. Electron 关闭 Playwright、终止 ffmpeg、Abort Node 下载，并对当前 Python 子进程调用 `kill('SIGTERM')`。
4. Python 信号处理器只设置取消标志，不在处理器中执行复杂清理。
5. 正常控制流发现取消后：
   - detach Frida session；
   - 删除当前 `.tmp_第NN集.mp4` 及相关临时解密文件；
   - 恢复设备 Wi-Fi 和移动数据；
   - 释放设备锁；
   - 不发送 `done`；
   - 以 `130` 退出。
6. Electron 发出 `download:canceled`。

不得用 `SIGKILL` 代替正式取消协议。硬杀不能保证恢复网络、清理临时文件或释放锁。上述清理时序已在 macOS 链路沿用；Node 在 Windows 上对 `child.kill('SIGTERM')` 的实现语义不同，因此 Windows 必须把“Electron 已进入取消分支”和“Python 已恢复设备网络并释放锁”作为两个独立的端到端验收项，当前静态检查不能证明后者。

## 10. 分集命名与断点续传

命名规则在 Electron `epName(ep, total)` 与 Python `epname(ep, width)` 两端保持一致：

```text
total < 100:  第01集.mp4
total >= 100: 第001集.mp4
```

输出目录中已存在且大小大于 0 的同名文件视为完成并跳过。Python 解密时先写 `.tmp_<final-name>`，成功后使用原子替换成为最终文件；失败或取消会清理临时文件。

## 11. `.complete` 语义

Electron 负责 `.complete`，Python 不读写它：

- 只有磁盘上从第 1 集到总集数的全部非空分集都存在时，写入 `total/total`。
- App 抓取关闭、组件/环境不可用、取消或部分失败时，不写完成标记。
- 如果发现旧版 `free/total` 或任何其他不完整标记，当前运行会将其移除。

分类批量只有在 `.complete` 内容是有效 `total/total` 时才跳过该剧。无效或旧版标记不会阻止重跑；已有非空分集仍按断点续传跳过。

## 12. Python 运行时依赖闭包

| 文件/目录 | 来源 | 运行时用途 |
|---|---|---|
| `hongguo_grab.py` | 仓库 | 正式 CLI 入口 |
| `capture_final.js` | 仓库 | `frida_attach()` 动态读取和加载 |
| `start_avd.sh` | 仓库 | macOS 抓取前检查、安装并启动支持 root 的 AVD |
| `start_avd.ps1` | 仓库 | Windows 抓取前检查、安装并启动支持 root 的 AVD |
| `decrypt_mdl.py` | 仓库 | 主入口通过当前 `sys.executable` 的绝对路径启动 |
| `mp4parse.py` | 仓库 | `decrypt_mdl.py` 静态导入；主入口建密文索引时动态导入 |
| 用户数据 `runtime/android/ADBKeyboard.apk` | 运行时下载 | 从固定上游 commit 下载并校验 SHA-256；设备缺少输入法时条件安装 |
| `requirements.txt` | 仓库 | 安装 Frida 和 cryptography 依赖 |
| 用户数据 `runtime/android/allmdl/` | 运行时生成 | 从设备拉取的临时 `.mdl` 文件 |
| 用户数据 `runtime/android/.appdb/` | 运行时生成 | App SQLite 数据库及 WAL 快照 |
| 用户数据 `runtime/android/captured_grab.jsonl` | 运行时生成 | Frida CRYPT 事件追加文件 |
| 用户数据 `runtime/android/frida-server-*` | 运行时下载 | 设备缺失或版本不匹配时的官方 Frida Server 缓存 |
| `frida-server` / `frida-server-<abi>` | 用户可选提供 | 无网络时的兼容推送源 |

`frida-server` 不随仓库和安装包分发，运行时缓存位于应用用户数据目录。打包态的 `resources/python` 视为只读，`allmdl/`、`.appdb/` 和捕获文件不得写入安装目录。开发态未提供 `HONGGUO_RUNTIME_DIR` 时仍以 `python/` 作为兼容回退，这些目录均被 Git 忽略；数据库、密钥、日志和媒体不得提交。

## 13. Python 包依赖

正式第三方 Python 依赖：

- `frida==17.16.4`：Python API，用于按设备序列号 attach 并加载 Hook（含 macOS Intel dyld/SG_READ_ONLY 修复）。
- `frida-tools==14.10.4`：固定版本的 CLI 工具集，用于安装和诊断。
- `cryptography>=41`：AES-128-CTR 解密。

Python 标准库依赖包括 `argparse`、`json`、`os`、`re`、`shutil`、`signal`、`sqlite3`、`struct`、`subprocess`、`sys`、`tempfile`、`threading` 和 `time`，不应写进 requirements。

## 14. 外部命令与设备资源

| 外部项 | 调用方 | 说明 |
|---|---|---|
| `adb` | `hongguo_grab.py` | 设备选择、UI、网络、文件、数据库、Frida Server |
| Frida Server | Android 设备 | 必须匹配 Python Frida 版本与 ABI |
| `ffmpeg` | `decrypt_mdl.py` | 解密后 MP4 重封装 |
| `ffprobe` | 主入口和解密辅助 | 成片时长读取与完整性终检 |
| Python 3.11+ | Electron 与主入口 | 启动正式入口；辅助脚本复用同一个 `sys.executable` |
| `sdkmanager` / `avdmanager` / `emulator` | Electron 环境准备脚本 | 按需安装 Android 组件、创建并启动 AVD |
| Chrome/Edge | Playwright | 网页媒体请求捕获的优先浏览器 |
| 系统 `ffmpeg` | Electron | 用于网页 HLS/DASH；从 PATH、Homebrew 或 WinGet 安装目录解析 |

## 15. 打包资源

`electron-builder.js` 的 `extraResources` 只复制确认过的正式闭包：

```text
python/hongguo_grab.py
python/decrypt_mdl.py
python/mp4parse.py
python/capture_final.js
python/start_avd.sh
python/start_avd.ps1
python/requirements.txt
```

安装包不复制 FFmpeg 二进制。网页 HLS/DASH 首次使用前与 Android 链路复用系统依赖检查：
macOS 通过 Homebrew 安装当前 CPU 的原生版本，Windows 通过 WinGet 安装 x64 版本。
这样 universal App 不会携带来自构建主机的单架构 FFmpeg。

它不复制：

- 项目运行闭包之外的脚本或依赖目录。
- Python `.venv/`。
- Frida Server。
- App 数据库、日志、抓取记录或 `.mdl`。
- 用户视频。
- 未纳入正式运行闭包的批处理、修复、封面和调试脚本。

## 16. 稳定协议边界

除非同步更新 Electron/Python 两端并完成设备验证，否则不得修改：

- Electron 触发 Python 的业务条件。
- CLI 参数名、含义、包含端点规则和默认值。
- stdout 事件名称、字段和 JSON Lines 约束。
- stderr 的诊断用途。
- 退出码 `0/2/3/130`。
- `SIGTERM` 安全取消路径。
- 分集位宽和文件名。
- 非空文件断点续传语义。
- `.complete` 语义。
- ADB 设备选择与单设备锁。
- App 包名、Activity、UI 匹配、剧名校验和 SQLite 查询，除非因已验证的 App 版本变化必须适配。
- `.mdl` 样本映射和 AES-128-CTR 参数。
- Frida Hook 的符号、key/IV 读取、限流复位和事件内容。
- ffmpeg/ffprobe 的解密后处理和时长终检。

目录调整应优先修改路径定位和打包清单，而不是移动或重写上述业务实现。

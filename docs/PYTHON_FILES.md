# Python 运行文件清单

## 分析范围与方法

分析起点是 `shortdrama-dl/main.js` 中所有 `child_process` 调用。正式链只有一处 Python `spawn`，入口为 `hongguo_grab.py`。随后递归检查：

- Python 静态和函数内动态 import。
- `subprocess.run(...)` 启动的 Python 文件和外部命令。
- `open(...)` 动态读取的 JavaScript 与运行时文件。
- SQLite 数据库名和运行时生成目录。
- ADB 条件安装/推送资源。
- Frida Script 加载。
- Electron 的 `cwd`、环境变量、参数和打包资源。

运行时生成并由 Git 忽略的数据不作为代码依赖或打包输入。

## 保留文件

| 目标文件 | 保留原因 | 被谁调用/读取 |
|---|---|---|
| `python/hongguo_grab.py` | Electron 正式 App 抓取入口；实现 CLI、ADB、Frida、SQLite 映射、任务状态和事件协议 | `main.js` 的 `grabWithApp(...)` 通过已验证的 Python 解释器启动 |
| `python/decrypt_mdl.py` | 单文件 AES-128-CTR 解密、ffmpeg 重封装、ffprobe 时长与轨道校验；接受 `.mdl` 或自行下载的同集分片，`--key` 可显式指定密钥 | `hongguo_grab.py` 的 `decrypt_to(...)` 通过绝对路径启动 |
| `python/mp4parse.py` | 解析 `moov/trak/stsz/stco/co64/stsc` 展开样本 offset/size；另读 `sinf/frma` 真实编码与 `senc` 起始计数器，据此识别 ByteVC2 | `decrypt_mdl.py` 与 `hongguo_grab.py` 静态 import |
| `python/capture_final.js` | Frida Hook `libttffmpeg.so` AES CTR 函数，向 Python 发送 CRYPT 事件 | `hongguo_grab.py` 的 `frida_attach()` 使用 `open(...).read()` 动态加载 |
| `python/start_avd.sh` | macOS 检查 Android SDK/设备，按需安装 API 34 Google APIs AVD，并在抓取前启动到 root 就绪 | `main.js` 的 `ensureAndroidDevice(...)`；支持独立 `--check`/`--ensure` |
| `python/start_avd.ps1` | Windows 检查 Android SDK/设备，校验官方 command-line tools 下载，并在 Windows x64 创建 root-capable AVD | `main.js` 经 `runtime-platform.js` 调用；支持独立 `-Check`/`-Ensure` |
| `python/requirements.txt` | 只声明正式链真实使用的第三方 Python 依赖及当前版本约束 | 安装脚本和使用者 |

## 运行时生成或用户提供，不纳入 Git

| 文件/目录 | 处理方式 | 判断依据 |
|---|---|---|
| 开发态 `python/allmdl/`；打包态用户数据 `runtime/android/allmdl/` | 运行时创建，Git 忽略/不涉及 | `hongguo_grab.py` 拉取设备 `.mdl` 的临时目录 |
| 开发态 `python/.appdb/`；打包态用户数据 `runtime/android/.appdb/` | 运行时创建，Git 忽略/不涉及 | 拉取 `series_download_db`、WAL 和 `TTVideoEngine_download_database_v01` |
| 开发态 `python/captured_grab.jsonl`；打包态用户数据 `runtime/android/captured_grab.jsonl` | 运行时创建，Git 忽略/不涉及 | Frida CRYPT 事件的追加记录 |
| 应用用户数据目录 `runtime/android/frida-server-*` | 自动下载并缓存，Git 不涉及 | 设备 Frida Server 缺失或版本不匹配时，从官方 Frida Release 获取 |
| 应用用户数据目录 `runtime/android/ADBKeyboard.apk` | 从固定上游 commit 下载并校验 SHA-256，Git 不涉及 | 设备缺少 `com.android.adbkeyboard` 时条件安装；上游为 GPL-2.0、debuggable/debug-signed APK |
| `python/frida-server` / `python/frida-server-<abi>` | 离线用户可提供，Git 忽略 | 自动下载失败时的兼容候选推送文件 |
| 临时 MP4、数据库、日志、截图和 UI XML | 运行时数据，Git 忽略 | 不属于代码，可能含设备或媒体信息 |

## 不纳入运行闭包

正式 Python 仓库运行闭包仅包含上表列出的七个文件。未被 Electron 调用、未被 Python import、未被 `subprocess` 启动，也未被运行时动态读取的独立批处理、实验、修复和调试脚本不属于 `shortdrama-dl`。

静态分析没有发现无法确认的代码或模板动态依赖。`frida-server*` 和 `ADBKeyboard.apk` 不随仓库提交；运行时下载固定来源并校验，离线用户提供文件只作为后备来源。

## 外部命令，不是 Python 文件

| 命令 | 调用位置 | 是否随项目分发 |
|---|---|---|
| Python 3.11+ | Electron 启动正式入口；正式入口通过 `sys.executable` 启动 `decrypt_mdl.py` | 否；Electron 可按系统安装 Python、创建隔离 venv 并安装包依赖 |
| `sdkmanager` / `avdmanager` / `emulator` | `start_avd.sh` / `start_avd.ps1` 安装 SDK 包、创建和启动 AVD | 否；macOS/Windows 首次使用可在确认后按系统准备 |
| Java 17 | Windows `sdkmanager.bat` 运行时 | 否；Windows 缺少时经确认通过 WinGet 安装 Eclipse Temurin JDK 17 |
| `adb` | Python 设备、UI、文件、数据库和 Frida Server 操作 | 否 |
| `ffmpeg` | `decrypt_mdl.py` 重封装 | 否 |
| `ffprobe` | 解密脚本读取时长；正式入口做成片终检 | 否 |
| Frida Server | Android 设备端 native instrumentation 服务 | 否 |

## 第三方 Python 依赖

| 依赖 | 版本 | 使用依据 |
|---|---|---|
| `frida` | `17.16.4` | `hongguo_grab.py` 函数内 import，按序列号获取设备、attach 和加载 Script |
| `frida-tools` | `14.10.4` | 项目固定的配套工具版本，用于 CLI 诊断 |
| `cryptography` | `>=41` | `decrypt_mdl.py` 从 `cryptography.hazmat.primitives.ciphers` 导入 AES/CTR |

`sqlite3`、`argparse`、`json`、`struct`、`subprocess` 等属于 Python 标准库，不进入 requirements。

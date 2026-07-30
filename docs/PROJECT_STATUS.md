# shortdrama-dl 项目状态

本文档记录 `shortdrama-dl` 当前实现、运行边界、验证结果和已知限制。文中相对路径均以本仓库根目录为基准。

## 当前组成

桌面端以 Electron 为主进程，负责网页解析、单播放页媒体请求捕获、封面下载、任务状态、环境准备和 Python 子进程编排。详情页/分类页的整剧流程不会下载网页分集，只解析剧名、总集数和封面，再由 App 从第 1 集抓取全集。`series-workflow.js` 集中保存总集数、App 区间和完成标记规则。Android 抓取组件位于 `python/`，负责 ADB 设备控制、App 离线下载、SQLite 映射、Frida 数据采集、`.mdl` 解密、MP4 重封装和时长终检。

正式 Python 仓库运行资源共七个：

```text
python/hongguo_grab.py
python/decrypt_mdl.py
python/mp4parse.py
python/capture_final.js
python/start_avd.sh
python/start_avd.ps1
python/requirements.txt
```

文件依赖依据见 [PYTHON_FILES.md](PYTHON_FILES.md)，Electron/Python 的参数、事件和退出码见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 运行路径

`main.js` 通过 `resolveGrabDir(...)` 按以下顺序查找 `hongguo_grab.py`：

1. 界面明确指定的组件目录。
2. 环境变量 `HONGGUO_GRAB_DIR`。
3. 开发态的 `<project-root>/python`，或打包态的 `<resources>/python`。

Python 组件随应用打包到真实文件系统中的 `resources/python`，不会从 ASAR 内直接执行。
该目录只保存七个只读程序文件。打包态所有 `.mdl`、SQLite 快照、捕获日志和下载缓存写入 Electron 应用用户数据目录下的 `runtime/android/`；`afterPack` 在 macOS/Windows 制品生成前清除白名单之外的 Python 资源，防止运行数据进入安装包或破坏签名。

## 主机环境

- macOS 使用 Homebrew、Bash 和 `python/start_avd.sh`。
- Windows 使用 WinGet、Windows PowerShell 和 `python/start_avd.ps1`。
- Linux 不会误用 macOS 或 Windows 安装流程，App 抓取环境自动准备会明确报告不支持。
- 抓取前会验证 Python 3.11+、Python 依赖（`frida==17.16.4`）、ffmpeg/ffprobe、Android SDK、ADB 设备和 AVD。
- 已安装但未启动的 AVD 会自动启动；缺少 SDK 或 AVD 时，经用户确认后安装并创建。
- Windows 自动创建 AVD 当前只支持 x64 主机和 `x86_64` 系统镜像。
- 设备端 Frida Server 缺失或版本不匹配时，应用从官方 Release 下载匹配版本并缓存到应用用户数据目录。

目标 App 安装、账号登录、USB 调试授权和非标准真机 root 仍属于用户与设备条件，通用安装包不会替代这些步骤。

## 抓取稳定性

当前 Python 主流程使用 App 下载数据库建立剧集与 `.mdl` 的确定性映射，并以解密事件判断正在播放的集号。主要恢复机制包括：

- 整剧固定接收 `--start-ep 1 --end-ep <总集数>`；输出目录内已有非空分集自动跳过。
- 只有磁盘实际存在全集时写入 `total/total` 完成标记；旧版不完整标记不会导致分类任务误跳过。
- 多设备环境下选择明确的模拟器序列号并传递 `ANDROID_SERIAL`。
- 同一设备进程锁，避免并发任务互相控制 UI。
- 搜索进入后核对剧名；恢复阶段核对失败作为可恢复提示处理。
- 播放器停滞时执行有界的上滑、清缓存、恢复播放和重新定位。
- 识别“广告”“上滑继续观看短剧”等 UI 文本，最多上滑两次回到下一集。
- 每集出片前核对下载库集号，出片后使用 ffprobe 校验时长。
- `SIGTERM`/`SIGINT` 时删除半成品、恢复设备网络并释放设备锁。

## 打包与签名

`electron-builder.js` 只把正式 Python 运行资源复制到应用包。

```bash
npm run pack                    # 当前平台未安装目录包
npm run pack:mac:universal      # macOS universal 未安装目录包
npm run dist:mac                # macOS universal ad-hoc 签名 DMG
npm run dist:mac:arm64          # Apple Silicon ad-hoc 签名 DMG
npm run dist:mac:x64            # Intel ad-hoc 签名 DMG
npm run dist:mac:signed         # universal Developer ID 签名并提交 Apple 公证
npm run dist:win                # Windows x64 NSIS 安装包
```

安装包不分发 FFmpeg，网页 HLS/DASH 和 Android 链路在首次需要时检查系统 FFmpeg，并经用户确认后由 Homebrew/WinGet 安装当前主机原生版本。macOS universal 包只需验证 Electron 主程序和内层框架均包含 `x86_64 arm64`。默认 macOS 构建明确禁用证书自动发现，由 `build/afterPack.js` 完成一次完整的 ad-hoc 签名。正式签名模式要求有效的 Developer ID Application 证书，以及 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 或对应的 App Store Connect API 凭据。

## 当前验证

截至 2026-07-29，已完成：

- Node.js、Bash、Python 和 PowerShell 合同静态检查。
- `python/hongguo_grab.py --help` 参数检查。
- 36 项自动化测试全部通过，包括整剧网页视频为零、App 从第 1 集开始、无网页分集列表时的元数据解析、完成标记、macOS/Windows 路由、安装器选择、AVD 状态与创建 mock、Windows SDK 下载校验合同、运行目录隔离、打包资源清理、浏览器 sandbox、广告页恢复，以及 ByteVC2 离线副本改用标准 HEVC 档位出片。
- Electron 43.2.0 / electron-builder 26.15.3 成功生成 macOS arm64 App、universal App 和 universal DMG。
- 打包内七个 Python 资源与项目文件逐字节一致；ADBKeyBoard 不随包分发，运行时固定来源下载并校验。
- universal App 检查到的 16 个 Mach-O 文件均为 `x86_64 arm64`；隔离构建的 arm64 App 主程序、Framework 和 Helper 均为 `arm64`。
- App 和挂载 DMG 内的 `codesign --verify --deep --strict` 均通过，`hdiutil verify` 通过。当前 universal DMG SHA-256 为 `584e597260980d697ebbb3ab933e9a742e6d66184186de6b776e172b2e69adb0`。
- `npm audit --omit=dev` 报告生产依赖 0 个已知漏洞。
- 完整 `npm audit` 报告 electron-builder 构建期传递链 16 个 high advisory；当前无兼容的非破坏性修复，发布应使用锁文件和可信隔离构建机。
- 当前 DMG 为 ad-hoc 测试包，Gatekeeper 拒绝且没有 stapled 公证票据；本次未提供 Apple 公证凭据，不能作为正式签名公证包发布。

## 数据边界

以下内容不进入 Git 或应用安装资源：

- `node_modules/`、Python `.venv/` 和构建输出。
- App SQLite 本地副本、WAL、UI dump、截图和运行日志。
- `.mdl`、MP4、音频/视频采集数据和临时媒体。
- Frida Server 缓存文件。
- AES key、设备数据、账号数据、Cookie、Token 和 Apple 公证凭据。

## 尚需实机验证

静态测试、mock 和打包成功不能替代所有端到端设备验证。发布前仍应覆盖：

- macOS 与 Windows 各自的全新用户首次环境安装。
- 单设备、多设备和显式 `ANDROID_SERIAL`。
- AVD 首次创建、停止后重启、root 就绪和目标 App 登录。
- 单集成功、连续多集、广告插入、部分失败与断点续传。
- 取消任务后的网络恢复、临时文件清理和设备锁释放。
- App 新版本的 UI、SQLite schema、native 符号和完整成片时长。
- Developer ID DMG 的签名、公证、staple 和另一台 Mac 的 Gatekeeper 验证。

当前仓库尚无首个 Git 提交，文件保持未跟踪状态；未执行暂存、提交或推送。

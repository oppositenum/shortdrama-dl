# shortdrama-dl

[English](README.en.md)

> ## ⚠️ 免责声明
>
> **本项目仅供技术学习与研究使用。**
>
> 它公开的是移动应用安全、Android 插桩（Frida）、MP4 容器解析与 CENC 加密机制的实现原理，用途限于个人学习、安全研究和技术交流。
>
> **使用者必须自行承担全部法律责任。** 你只能用它处理自己拥有合法权利、或已获得权利人明确授权的内容。任何将本项目用于以下行为的，均与作者无关，由使用者本人承担相应的民事、行政乃至刑事责任：
>
> - 未经授权规避技术保护措施，或下载、复制、传播受版权保护的作品
> - 违反目标平台的用户协议或服务条款
> - 从事任何形式的盗版、牟利、商业分发或其他侵权活动
>
> **作者不提供任何担保，也不对使用本项目造成的任何直接或间接损失承担责任。** 若你所在国家或地区的法律禁止此类工具，请立即停止使用并删除本项目。下载本项目即视为你已阅读、理解并同意本声明。
>
> 详见 [安全与合规](#安全与合规)。

`shortdrama-dl` 是一个由 Electron 桌面应用和 Python Android 抓取/解密组件组成的短剧下载工具，提供两种链接处理路径：

- 单播放页：Electron 使用 Playwright 捕获该播放页的媒体请求，并用 Node.js 或 ffmpeg 下载这一集。
- 整剧详情页/分类页：网页只解析剧名、总集数并保存封面，不下载任何网页分集；Electron 随后启动 `python/hongguo_grab.py`，由 Android App 从第 1 集开始抓取全集。

Electron 与 Python 通过稳定的命令行和 JSON Lines 协议协作。运行边界、参数和打包资源见 [架构文档](docs/ARCHITECTURE.md)。

## 功能

- Electron 图形界面和下载任务状态管理
- 单个播放页视频下载
- 详情页/分类页网页元数据解析和封面下载
- 分类/榜单页多剧批量处理及失败补漏
- 已有分集跳过和断点续传
- 剧集封面下载
- `.complete` 完成状态记录和批量跳过
- 系统 Chrome、Edge 或 Playwright Chromium 驱动
- MP4 直连下载，以及 HLS/DASH 的 ffmpeg 合并
- Android App 从第 1 集开始的全集抓取
- 多 ADB 设备环境下的目标设备选择
- 单设备任务锁，防止两个抓取进程争用同一设备
- Frida AES 上下文数据采集
- App SQLite 下载记录与 `.mdl` 文件的确定性映射
- `.mdl` AES-128-CTR 逐样本解密
- ffmpeg 重封装与 ffprobe 时长终检
- Electron 与 Python 间的 JSON Lines 事件通信
- 通过 `SIGTERM` 安全取消 Python 任务

Android 链路依赖已 root 的受控设备和特定 App 运行环境。它不是通用 Android 下载方案，App 升级、UI 改版、库结构变化或 Frida Hook 符号变化都可能使该链路失效。

## 项目结构

```text
shortdrama-dl/
├── main.js                         # Electron 主进程、网页下载和 Python 编排
├── runtime-platform.js             # macOS/Windows 平台识别和安装命令选择
├── series-workflow.js              # 整剧总集数、App 区间和完成标记规则
├── preload.js                      # contextBridge 白名单 IPC
├── renderer/                       # 现有 Electron UI
├── electron-builder.js             # 打包、签名及 Python 资源清单
├── build/                          # 图标、macOS entitlement、afterPack
├── python/
│   ├── hongguo_grab.py             # Electron 正式调用的 Python 入口
│   ├── decrypt_mdl.py              # 单个 .mdl 解密和重封装
│   ├── mp4parse.py                 # MP4 样本表解析
│   ├── capture_final.js            # Frida Hook 脚本
│   ├── start_avd.sh                # macOS Android 环境检查、安装与启动
│   ├── start_avd.ps1               # Windows Android 环境检查、安装与启动
│   └── requirements.txt            # 正式 Python 依赖
├── scripts/
│   ├── setup-python.sh             # macOS/Linux Python 环境准备
│   └── setup-python.ps1            # Windows PowerShell Python 环境准备
├── docs/
│   ├── ARCHITECTURE.md             # 进程边界和运行协议
│   ├── PYTHON_FILES.md             # Python 文件保留/排除依据
│   └── PROJECT_STATUS.md            # 当前实现、验证状态和已知限制
├── README.md
├── README.en.md
└── LICENSE
```

开发态直接运行 Python 时生成的 `python/allmdl/`、`python/.appdb/`、`captured_grab.jsonl`，以及日志、数据库快照、Frida Server 和媒体文件均被 `.gitignore` 排除。打包应用会把同类缓存写入应用用户数据目录，不会修改 `<resources>/python` 或破坏 macOS 代码签名。

## 工作原理

```text
Electron UI
  │
  ├─ 单个网页播放页
  │    └─ Playwright 捕获这一集的媒体请求
  │         ├─ MP4 -> Node fetch
  │         └─ HLS/DASH -> 当前系统原生 FFmpeg
  │
  └─ 详情页/分类页 -> 解析剧名、总集数并保存封面
       └─ 从第 1 集启动 python/hongguo_grab.py
            ├─ ADB 控制已 root Android 设备
            ├─ 读取 App SQLite 下载库
            ├─ 定位并拉取本剧 .mdl
            ├─ Frida 加载 capture_final.js 获取解密上下文
            ├─ decrypt_mdl.py + mp4parse.py 执行 AES-128-CTR 解密
            ├─ 系统 ffmpeg/ffprobe 重封装和时长核对
            └─ stdout JSON Lines -> Electron 更新 UI
```

Python 使用 `__file__` 定位同目录资源，因此 `hongguo_grab.py`、`capture_final.js`、`decrypt_mdl.py` 与 `mp4parse.py` 必须保持在同一个 `python/` 目录内。

## 支持平台

| 发布目标 | 支持状态 | 建议产物 |
|---|---|---|
| macOS 12+ Apple Silicon（M1/M2/M3/M4，`arm64`） | 支持 | universal DMG，或体积更小的 arm64 DMG |
| macOS 12+ Intel（`x64`） | 支持构建 | universal DMG，或 x64 DMG；正式发布前仍应在 Intel 真机验收 |
| macOS universal（`x64 + arm64`） | 支持，推荐公开发布架构 | 测试包用 `npm run dist:mac`；公开包用 `npm run dist:mac:signed` |
| Windows 10/11 x64 | 支持构建 | 在 Windows x64 上生成并验收 NSIS 安装包 |
| Windows ARM64 | 不支持自动创建 AVD | 不发布；脚本会明确返回架构不支持 |
| Linux | 无正式安装包 | 仅可用于有限的源码开发，Android 自动准备不支持 |

单播放页下载和整剧封面解析本身无需 Android、ADB、Frida 或 Python，最终用户也不需要安装 Node.js 或 npm；但详情页/分类页的视频全集现在全部依赖 Android App 链路。单播放页的直连 MP4 使用 Electron 自带的 Node.js 网络栈，遇到 HLS/DASH 时需要系统 FFmpeg。系统 Chrome/Edge 是网页解析的首选浏览器。浏览器或 FFmpeg 缺失时，应用会先确认，再调用当前系统的包管理器安装与本机 CPU 匹配的版本。

Android App 抓取链路还需要 Python 3.11+、`adb`、支持 `adb root` 的 Android 设备/模拟器、匹配版本的 Frida（当前锁 `17.16.4`）、`cryptography`，以及系统 `ffmpeg`/`ffprobe`。应用根据 `process.platform` 和 CPU 架构选择安装路径：

- macOS 使用 Homebrew、Bash 和 `~/Library/Android/sdk`；Apple Silicon AVD 使用 `arm64-v8a`，Intel AVD 使用 `x86_64`。
- Windows x64 使用 WinGet、Windows PowerShell 和 `%LOCALAPPDATA%\Android\Sdk`，AVD 使用 `x86_64`。
- Linux、Windows ARM64 或未知架构不会套用错误的安装器或镜像，而是明确停止并报告不支持。

当前构建主机是 Apple Silicon macOS。macOS arm64 和 universal 包可以在本机执行验证；x64 产物可以检查 Mach-O 架构并在 Rosetta 环境做有限冒烟测试，但这不等于 Intel 真机验收。Windows 路径有 Node 测试和静态契约覆盖，尚未在真实 Windows x64 的 AVD、目标 App、Frida 链路完成端到端验收。

## 新电脑运行前提与自动安装边界

公开分发应优先提供已 Developer ID 签名并通过 Apple 公证的 macOS DMG（universal、arm64、x64 三个都发布，方便用户按自己 CPU 架构选择体积更小的单架构包），以及在 Windows x64 上构建和验收的 NSIS 安装包。新电脑至少需要网络、足够磁盘空间和允许启动虚拟化；Android SDK 和系统镜像会占用数 GB。

| 项目 | 安装包是否内置 | 应用能否自动准备 | 用户仍需完成的操作 |
|---|---|---|---|
| Electron | 是，按安装包架构提供 | 无需安装 | 无 |
| Chrome/Edge | 否 | 用户确认后通过 Homebrew/WinGet 安装 Chrome | 系统没有包管理器时先安装包管理器 |
| Python 与 Python 包 | 否 | 用户确认后安装 Python，并在应用用户数据目录创建隔离环境 | 无网络或包管理器不可用时手动安装 |
| 系统 ffmpeg/ffprobe | 否；HLS/DASH 需要 ffmpeg，Android 链路还需要 ffprobe | 用户确认后通过 Homebrew/WinGet 安装本机架构版本 | 安装器不可用时手动安装 |
| Android SDK、Emulator、AVD、Java 17 | 否 | 用户确认后安装官方组件、接受 SDK License、创建并启动 AVD | 确保磁盘、网络和硬件虚拟化可用 |
| Frida Server | 否 | 按 Python Frida 版本和设备 ABI 从官方 Release 下载、校验、缓存并推送 | 离线时手动提供匹配二进制 |
| ADBKeyBoard | 否 | 设备缺少中文输入法时，从固定上游 commit 下载并校验 SHA-256 后安装 | 离线时用 `SHORTDRAMA_ADB_KEYBOARD_APK` 提供同一哈希文件 |
| 目标 App、账号与授权 | 否 | 否 | 用户自行安装 App、登录账号，并只访问有权处理的内容 |
| 真机 root、USB 调试授权 | 否 | 否 | 用户自行准备和授权；普通未 root 真机不能执行 App 链路 |

“自动准备”不是静默安装：应用会先检测，再显示确认框，用户确认后才运行系统安装器。项目不会自动安装 Homebrew 本身，也不会自动安装 WinGet/Microsoft App Installer 本身。macOS 缺少 Homebrew 时需先按 [brew.sh](https://brew.sh/) 安装；Windows 缺少 WinGet 时需先从 Microsoft Store 安装“应用安装程序”。代理、公司策略、管理员权限、网络中断、磁盘不足或上游下载不可用都可能让安装失败，应用会重新校验依赖，不会只凭安装命令退出码宣称环境已就绪。

因此不能承诺“任意全新 macOS/Windows 电脑完全无人值守即可运行”。网页模式所需条件较少；Android 模式必须满足包管理器、网络、虚拟化、root AVD、目标 App 安装与人工登录等边界。

## 安装

### 1. 克隆并安装 Node.js 依赖

源码开发和打包要求 Node.js 22 或更高版本（建议当前 LTS）及 npm；这一要求不适用于安装 DMG/NSIS 的最终用户。

```bash
git clone git@github.com:oppositenum/shortdrama-dl.git
cd shortdrama-dl
npm ci
```

安装完成后，系统已有 Chrome 或 Edge 即可使用网页链路。若需要开发环境的 Playwright Chromium 回退：

```bash
npm run fetch-browser
```

该命令只下载 Chromium。打包配置默认不把约 500 MB 的 Playwright 浏览器放进安装包，安装包运行时仍优先使用目标机器上的 Chrome 或 Edge。

### 2. 准备 Python 环境（仅 Android 链路需要）

macOS/Linux：

```bash
./scripts/setup-python.sh
source .venv/bin/activate
```

等价手动命令：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r python/requirements.txt
```

Windows PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-python.ps1
.\.venv\Scripts\Activate.ps1
```

上述命令仍适合开发者提前准备环境。正式应用在第一次使用 App 抓取时也会自检：优先复用版本合格的 Python 3.11+；缺少或无法 import 锁定版本的 Frida/cryptography 时，开发态在项目 `.venv/`、打包态在应用用户数据目录清除并重建隔离环境，再按 `requirements.txt` 安装。没有合格 Python 时，应用征得确认后在 macOS 使用 Homebrew 安装 Python，在 Windows 使用 WinGet 安装 Python 3.12；Windows 同时识别 `py -3.12`/`py -3.11`/`py -3` 和常见的用户级 Python 安装目录。

### 3. 安装系统 ffmpeg（HLS/DASH 与 Android 链路需要）

macOS：

```bash
brew install ffmpeg
```

Ubuntu/Debian：

```bash
sudo apt update
sudo apt install ffmpeg
```

Windows PowerShell：

```powershell
winget install --exact --id Gyan.FFmpeg --source winget
```

正式应用在网页 HLS/DASH 下载前检查 `ffmpeg`，在 Android 抓取前同时检查 `ffmpeg`/`ffprobe`。缺少时会先征得确认，再按当前系统调用 Homebrew 或 WinGet；安装后重新执行所需命令的版本检查，安装命令退出成功但工具仍不可用时不会报告环境就绪。Homebrew 会在 Apple Silicon 和 Intel Mac 上选择各自原生架构，WinGet 路径限定 Windows x64。

验证：

```bash
ffmpeg -version
ffprobe -version
```

注意：直连 MP4 不依赖 FFmpeg；网页 HLS/DASH 和 Android 链路复用系统 FFmpeg，Android Python 代码另外需要 `ffprobe`。

## Android 设备准备

勾选 App 抓取后，应用按系统执行 `python/start_avd.sh`（macOS）或 `python/start_avd.ps1`（Windows）：已有可用设备则直接复用；`hongguo` AVD 已安装但未运行则自动启动；没有 AVD 或 SDK 组件时，界面会先确认一次，再安装 Android platform-tools、Emulator 和 API 34 Google APIs 系统镜像并创建 AVD。镜像为数 GB。

macOS 可在终端单独检查或准备：

```bash
./python/start_avd.sh --check
./python/start_avd.sh --ensure --install-missing
```

Windows PowerShell：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\python\start_avd.ps1 -Check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\python\start_avd.ps1 -Ensure -InstallMissing
```

Windows 脚本优先复用 Android Studio/环境变量指定的 SDK。缺少 command-line tools 时，它从 Google 官方 `repository2-1.xml` 解析 Windows 下载包，只接受 `dl.google.com` 的 HTTPS 地址，并核对官方 SHA-1/SHA-256；缺少 Java 17 时通过 WinGet 安装 Eclipse Temurin JDK 17。Windows 自动创建 AVD 当前支持 x64，并使用 `x86_64` 镜像；ARM64 等其他架构会明确退出，不会误装 x64 镜像。macOS 按 Apple Silicon/Intel 分别选择 `arm64-v8a`/`x86_64`。

自动创建的是支持 `adb root` 的 Google APIs 镜像，不是禁止 `adb root` 的 Google Play 镜像。目标 App 的安装、账号登录和授权不能由项目代替用户完成。

1. 在设备上启用开发者选项和 USB 调试。
2. 连接设备并在设备端确认电脑授权。
3. 确认设备状态：

   ```bash
   adb version
   adb devices -l
   adb shell id
   ```

4. `adb devices -l` 中目标设备必须是 `device`，不能是 `unauthorized` 或 `offline`。
5. 设备必须已 root。脚本会执行 `adb root`，并需要读取 `/data/data/com.phoenix.read/databases/`。
6. 安装并登录目标 App。当前包名在正式代码中固定为 `com.phoenix.read`。
7. 确认设备 ABI：

   ```bash
   adb shell getprop ro.product.cpu.abi
   ```

8. 确认 PC 端 Frida 版本：

   ```bash
   python3 -c "import frida; print(frida.__version__)"
   frida --version
   ```

9. Python 会检查设备端 Frida Server 版本。设备缺少或版本不匹配时，会从 Frida 官方 GitHub Release 下载与 Python Frida 版本、设备 ABI 匹配的二进制，缓存到应用用户数据目录并推送。离线环境仍可采用任一手动方式：

   - 将二进制放到设备 `/data/local/tmp/frida-server`；脚本会尝试启动它。
   - 将二进制放到 `python/frida-server-<abi>`，例如 `python/frida-server-arm64-v8a`；脚本在设备缺失时会自动推送。

10. 验证 Frida 连接：

    ```bash
    adb shell "chmod 755 /data/local/tmp/frida-server && /data/local/tmp/frida-server >/dev/null 2>&1 &"
    frida-ps -U
    ```

如果同时连接多台设备，建议在启动 Electron 前明确设置：

```bash
export ANDROID_SERIAL="<target-serial>"
npm start
```

未设置时，Python 会在多设备列表中自动选择唯一的 `emulator-*`；无法唯一选择时会返回环境错误。不要把真实设备序列号提交到仓库或文档。

## 启动与使用

### 开发启动

```bash
npm start
```

需要 Electron 调试日志时：

```bash
npm run dev
```

### 链接处理模式

1. 在输入框粘贴受支持的 URL：
   - `/player/...`：下载单个播放页。
   - `/detail?series_id=...`：网页解析剧名、总集数和封面，再由 App 从第 1 集抓取全集。
   - `/category?...`：解析分类页内多部剧，逐部保存封面并从 App 抓取全集。
2. 点击“选择文件夹”指定保存位置；不指定时使用系统下载目录。
3. 取消勾选“用 App 抓取全集”时，详情页/分类页只保存封面，不会退回网页分集下载。
4. 点击“开始下载”。
5. Python 会自动跳过现有非空分集文件。分类批量只跳过 `.complete` 内容为有效 `total/total` 的剧目；旧版 `free/total` 标记不再代表完成。

直连 MP4 使用 Node.js `fetch` 流式下载；HLS/DASH 使用系统原生 FFmpeg 进行无重编码合并，首次缺失时会触发确认安装。媒体请求会复用 Playwright 捕获到的必要浏览器请求头。

### Android App 抓取模式

1. 确保目标 App 已安装并登录。Python、ffmpeg、ADB、AVD 和 Frida 会在第一次 App 抓取时自动检查；需要系统级安装或数 GB 镜像下载时会先显示确认框。
2. 保持“用 App 抓取全集”处于勾选状态，工具目录输入框留空即可使用项目内置 `python/`。
3. Electron 从网页取得剧名、总集数和封面后直接启动 Python，固定传入 `--start-ep 1 --end-ep <总集数>`，不会打开网页分集播放器。
4. Python 自动搜索目标剧、跳过输出目录内已有非空分集、下载 App 离线文件、读取 SQLite 映射、离线播放采集解密上下文、拉取 `.mdl`、解密并输出到同一个剧名目录。
5. 正常使用不需要手工执行 `hongguo_grab.py`。界面中的工具目录和 `HONGGUO_GRAB_DIR` 可用于显式覆盖内置目录。

单设备必须串行使用。Python 会在临时目录创建按设备序列号区分的进程锁，并在正常结束或安全取消时恢复网络和释放锁。

App 的离线下载固定走 720p 档，其中一部分集是 ffmpeg 认不出的 ByteVC2 编码。抓取时一旦发现某集是 ByteVC2，会立刻记下已经拿到的解密 key，但改用服务端 1080p 源（标准 HEVC）出片这一步会推迟到整部剧抓取结束、统一联网时才做——原因和权衡见下方 FAQ「日志出现『改用服务端 1080p 源出片』」。

### 文件命名和完成标记

- 总集数小于 100：`第01集.mp4`、`第02集.mp4`。
- 总集数大于等于 100：`第001集.mp4`、`第002集.mp4`。
- 该命名规则在 Electron 与 Python 两端必须完全一致。
- 只有磁盘上从第 1 集到总集数的全部非空文件都存在时，`.complete` 才写入 `total/total`。
- App 链路关闭、环境不可用或仍有缺集时不写 `.complete`，并会移除旧版 `free/total` 等不完整标记；已有非空分集仍会在下次运行时跳过。

## 开发命令

| 命令 | 作用 |
|---|---|
| `npm start` | 启动 Electron 应用 |
| `npm run dev` | 启动 Electron 并开启 Electron 日志 |
| `npm test` | 运行不连接真实设备的环境启动 mock 测试 |
| `npm run fetch-browser` | 下载开发用 Playwright Chromium 到 `ms-playwright/` |
| `npm run pack` | 生成当前平台的未安装目录包 |
| `npm run pack:mac:universal` | 生成 macOS universal 未安装目录包 |
| `npm run dist` | 生成当前平台分发包 |
| `npm run dist:win` | 在 Windows x64 构建 NSIS 安装包 |
| `npm run dist:mac` | 构建 ad-hoc 签名的 macOS universal DMG（推荐测试包） |
| `npm run dist:mac:arm64` | 构建 ad-hoc 签名的 Apple Silicon DMG |
| `npm run dist:mac:x64` | 构建 ad-hoc 签名的 Intel DMG |
| `npm run dist:mac:signed` | Developer ID 签名、公证并构建 universal DMG |
| `npm run dist:mac:signed:arm64` | Developer ID 签名、公证并构建 arm64 DMG |
| `npm run dist:mac:signed:x64` | Developer ID 签名、公证并构建 x64 DMG |

Python 与 Electron 的边界是子进程协议，不是 Python 模块导入。不要在 Electron 进程中导入 Python，也不要向 Python stdout 添加调试文本。

## 构建和打包

```bash
npm run pack
npm run dist
```

macOS 架构构建：

```bash
npm run dist:mac          # universal: Intel + Apple Silicon，公开发布首选
npm run dist:mac:arm64    # Apple Silicon only
npm run dist:mac:x64      # Intel only
```

Windows x64 构建应在 Windows x64 主机执行：

```powershell
npm ci
npm test
npm run dist:win
```

`electron-builder.js` 将以下 Python 资源复制到打包后的 `<resources>/python/`：

```text
hongguo_grab.py
decrypt_mdl.py
mp4parse.py
capture_final.js
start_avd.sh
start_avd.ps1
requirements.txt
```

开发态默认入口为 `<project-root>/python/hongguo_grab.py`，打包态默认入口为 `<resources>/python/hongguo_grab.py`。安装包不直接内置 Python 解释器、Android 系统镜像、系统 ffmpeg/ffprobe、Frida Server、Chrome 或 Edge；具体边界见前面的“新电脑运行前提与自动安装边界”。

`<resources>/python` 只读保存上面的七个程序文件。打包态的 `.mdl`、SQLite 快照、Frida 捕获日志、Frida Server 和 ADBKeyBoard 缓存统一写入：

- macOS：`~/Library/Application Support/shortdrama-dl/runtime/android/`
- Windows：`%APPDATA%\shortdrama-dl\runtime\android\`

隔离 Python 环境位于同一应用用户数据目录的 `runtime/python/`。`build/afterPack.js` 会在 macOS 和 Windows 制品生成前再次把 `<resources>/python` 校验并清理为固定七文件白名单，缺文件时构建直接失败。构建前应退出正在从 `release/` 目录运行的旧测试 App，避免旧进程继续写入正在重建的目录。

安装包不分发第三方 FFmpeg 二进制，避免把构建主机的单架构文件装进另一种 CPU 的包，也避免捆绑不可再分发的上游构建。运行时从 PATH、Homebrew 的 Apple Silicon 路径 `/opt/homebrew/bin`、Intel 路径 `/usr/local/bin`，以及 Windows 常见 WinGet 目录解析 FFmpeg；也可用 `SHORTDRAMA_WEB_FFMPEG` 指定绝对路径。macOS universal 包本身只需要 Electron 双架构，系统 FFmpeg 由目标机器安装原生版本。

### macOS 签名与公证

默认 `dist:mac*` 使用 `build/afterPack.js` 做 ad-hoc 签名，适合本机测试，不包含 Apple 公证，不应作为面向普通用户的最终安装包。公开发布建议使用 `dist:mac:signed`，要求：

- 钥匙串中存在有效的 `Developer ID Application` 证书及私钥。
- 使用 Apple ID 方式时设置 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。
- 或按 electron-builder 支持的 App Store Connect API Key 方式设置 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。
- 不把任何密码、私钥或 API Key 写入仓库、README、`.env` 样例或构建日志。

正式构建与验证：

```bash
npm ci
npm test
npm run dist:mac:signed
codesign --verify --deep --strict --verbose=2 "release/mac-universal/红果短剧下载器.app"
spctl --assess --type execute --verbose=4 "release/mac-universal/红果短剧下载器.app"
xcrun stapler validate "release/mac-universal/红果短剧下载器.app"
hdiutil verify "release/红果短剧下载器-1.0.0-universal.dmg"
```

实际输出目录可能随 electron-builder 版本变化，应以 `release/` 中生成的路径为准。electron-builder 提交并装订公证票据的是 DMG 内的 `.app`；DMG 本身再做 `hdiutil verify`，正式工作流还会挂载 DMG 并重新检查其中的 App。只有 `codesign`、Gatekeeper (`spctl`)、App 的 stapler 和 DMG 完整性全部通过，才可以宣称安装包内应用已签名并公证；仅检测到证书或仅构建成功不够。

## GitHub Actions 自动版本与 Release

仓库包含两个工作流：

- `.github/workflows/ci.yml` 在 Pull Request 和 `main` 推送时运行。它在 `macos-15`（Apple Silicon）、`macos-15-intel`（Intel）和 `windows-2022` 上执行测试、生产依赖审计和语法检查，并分别做 macOS universal 与 Windows x64 打包冒烟验证。
- `.github/workflows/release.yml` 在 `main` 推送时运行 Release Please。普通功能提交只会创建或更新 Release PR；合并 Release PR 后，同一个工作流创建草稿 Release，并行构建正式签名公证的 macOS universal/arm64/x64 三个 DMG 和 Windows x64 NSIS，生成 `SHA256SUMS.txt`，全部验证通过后才把草稿公开。

所有第三方 Action 都固定到完整 commit SHA。CI 不读取签名 Secrets；正式构建 Job 使用名为 `release` 的 GitHub Environment。

### 自动版本规则

不要手工修改 `package.json`、`package-lock.json` 或 `.release-please-manifest.json` 的版本。提交信息使用 Conventional Commits：

| 提交前缀 | 版本变化 | 示例 |
|---|---|---|
| `fix:` | patch，例如 `1.0.0 -> 1.0.1` | `fix: recover after an advertisement` |
| `feat:` | minor，例如 `1.0.0 -> 1.1.0` | `feat: add Windows AVD setup` |
| `feat!:`、`fix!:` 或正文 `BREAKING CHANGE:` | major，例如 `1.0.0 -> 2.0.0` | `feat!: change task protocol` |
| `docs:`、`test:`、`chore:` 等 | 默认不单独触发版本发布 | `docs: clarify setup boundary` |

首次发布已经显式配置为 `1.0.0`：初始 `.release-please-manifest.json` 必须保持 `{}`，`release-please-config.json` 的 `initial-version` 为 `1.0.0`。因此首个可发布的 `feat:` 或 `fix:` 提交会生成 `v1.0.0` Release PR，而不是跳到 `v1.1.0`。Release PR 合并后，Release Please 同步更新 `package.json`、`package-lock.json`、`CHANGELOG.md` 和 manifest；`scripts/verify-release-version.js` 会在两个构建 Job 和最终发布 Job 再次拒绝任何版本或标签不一致。

正常发布流程：

1. 使用 Conventional Commit 信息合并普通代码到 `main`。首次提交应使用类似 `feat: initial shortdrama-dl release` 的可发布提交信息。
2. 等待 `release-please` 自动创建或更新 Release PR，审查其版本与 CHANGELOG。
3. 合并 Release PR。Release Please 创建 `v<version>` 标签和草稿 Release；由于 `GITHUB_TOKEN` 创建的标签不会触发另一个工作流，两个平台的构建和发布都在当前 Release 工作流内继续执行。
4. macOS 和 Windows Job 均成功后，`publish` Job 上传 DMG、NSIS 和 `SHA256SUMS.txt`，核对草稿、标签 SHA、版本及资产数量，然后公开 Release。

任一构建、签名、公证或校验失败时，Release 保持草稿状态，不会对外发布。修复临时 Runner/Apple 服务问题时，在 GitHub Actions 页面选择 **Re-run failed jobs**，这样会保留成功的 Release Please Job 输出并重跑失败链路。不要用 **Re-run all jobs** 代替；后者再次发现已有标签时可能不会重新输出 `release_created=true`。如果失败来自源码而非临时环境，应先决定是完成该草稿版本，还是删除草稿 Release 和对应标签后再走新的 Release PR，不能把另一个提交的安装包覆盖到旧标签。

### GitHub 仓库设置与 Secrets

在 GitHub 仓库完成以下一次性配置：

1. 确认默认分支为 `main`。在 **Settings > Actions > General > Workflow permissions** 允许工作流读写仓库，并启用 **Allow GitHub Actions to create and approve pull requests**；组织策略如果禁止该权限，需要由组织管理员放行。
2. 在 **Settings > Environments** 创建 `release` Environment。可以为最终发布设置 required reviewers；构建 Job 会在该 Environment 下读取 Secrets。
3. 在 `release` Environment Secrets（或仓库 Secrets）中配置下表。不要把值写入 Git、README、Actions 变量或日志。

| Secret | 必需 | 用途 |
|---|---|---|
| `MAC_CSC_LINK` | 是 | Developer ID Application 的 `.p12` Base64、HTTPS URL 或 electron-builder 支持的证书来源 |
| `MAC_CSC_KEY_PASSWORD` | 是 | `.p12` 私钥密码 |
| `APPLE_ID` | 二选一 | Apple ID 公证账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 与 `APPLE_ID` 同组 | Apple app-specific password |
| `APPLE_TEAM_ID` | 与 `APPLE_ID` 同组 | Apple Developer Team ID |
| `APPLE_API_KEY_BASE64` | 二选一，推荐 | App Store Connect `.p8` 文件的单行 Base64；Runner 只在临时目录解码 |
| `APPLE_API_KEY_ID` | 与 API Key 同组 | App Store Connect API Key ID |
| `APPLE_API_ISSUER` | 与 API Key 同组 | App Store Connect Issuer ID |
| `WINDOWS_CSC_LINK` | 否但推荐公开发布配置 | Windows Authenticode `.pfx` 的 Base64、URL 或 electron-builder 支持的证书来源 |
| `WINDOWS_CSC_KEY_PASSWORD` | 配置 Windows 证书时需要 | `.pfx` 私钥密码 |

Apple ID 三项和 API Key 三项只能完整配置其中一组，缺项或同时配置都会让 macOS Job 在接触证书前失败。生成 API Key 单行 Base64 的示例：

```bash
openssl base64 -A -in AuthKey_KEYID.p8
```

Windows Secrets 未配置时仍会构建未签名 NSIS，并在 Job Summary 明确标记；该安装包会出现 SmartScreen 警告，不应描述为已签名 Windows 正式包。若面向普通用户公开发布，建议把 Windows Authenticode 证书也设为发布前提。

GitHub Runner 能证明源码在 Intel Mac、Apple Silicon Mac 和 Windows x64 环境完成自动测试与打包，也会检查 universal 二进制的双架构；它不能替代目标用户新电脑上的 UI、系统包管理器、硬件虚拟化、AVD、ADB、真实 Android App 抓取及任务取消验收。正式发布前仍应至少在一台 Intel Mac、一台 Apple Silicon Mac 和一台 Windows x64 机器安装 Release 资产并执行端到端验收。

### 当前已验证的 macOS 构建

截至 2026-07-29，当前源码使用 Node.js 24.12.0、Electron 43.2.0 和 electron-builder 26.15.3 完成了以下本机验证：

- 36 项自动化测试全部通过；Node、Python 和 Bash 语法检查通过；`npm audit --omit=dev` 报告 0 个漏洞。
- arm64 App 的主程序为 `arm64`，严格 `codesign` 校验通过。
- universal App 内检查到的 16 个 Mach-O 文件均同时包含 `x86_64 arm64`，包括主程序、Electron Framework、所有 Helper、`fsevents.node` 和 Electron 内层动态库。
- universal DMG 通过 `hdiutil verify`；挂载后的 App 再次通过严格 `codesign`、双架构和七个 Python 资源检查。
- ASAR 内 `main.js`、`ffmpeg-runner.js`、`runtime-platform.js`、`preload.js` 和 `series-workflow.js` 与当前源码逐字节一致；包内 `hongguo_grab.py`、`decrypt_mdl.py`、`mp4parse.py` 同样与源码逐字节一致。
- 当前 ad-hoc universal DMG 为 `release/红果短剧下载器-1.0.0-universal.dmg`（约 214 MiB），SHA-256 为 `584e597260980d697ebbb3ab933e9a742e6d66184186de6b776e172b2e69adb0`。

这个 DMG 只是经过完整性验证的 ad-hoc 测试包：其签名没有 Team ID，Gatekeeper 会拒绝，且 stapler 没有公证票据。它不能被描述为正式签名公证包。当前主机虽然有 Developer ID Application 证书，但本次环境未提供 Apple 公证凭据，因此没有执行 `dist:mac:signed`。

### 发布到 Git 前检查

```bash
npm ci
npm test
npm audit --omit=dev
node --check main.js
node --check runtime-platform.js
node --check electron-builder.js
node --check scripts/verify-release-version.js
python3 -m py_compile python/hongguo_grab.py python/decrypt_mdl.py python/mp4parse.py
bash -n python/start_avd.sh scripts/setup-python.sh
git status --short
git check-ignore -v release/ python/allmdl/ python/.appdb/
```

还应检查 Git 暂存区不含账号、Cookie、Token、设备序列号、AES key/IV、数据库、抓取日志、`.mdl`、媒体、Frida Server、Apple 凭据或构建缓存。Windows 正式包必须补做 Windows x64 真机验收；Intel 公布前应补做 Intel Mac 验收。

`npm audit --omit=dev` 必须为 0。当前完整 `npm audit` 还会报告 electron-builder 打包期传递依赖中的 16 个 high advisory，生产运行依赖不受这 16 项影响；npm 给出的强制修复会把 electron-builder 降级到旧主版本，不能作为无风险修复。发布构建应在可信、隔离的构建机上使用锁定的 `package-lock.json` 和 `npm ci`，不要让不受信任的路径或文件名进入打包输入，并在上游发布兼容修复后及时升级。

## Python 子进程协议概述

Electron 当前启动形式为：

```text
<validated-python> hongguo_grab.py
  --series-name <name>
  --start-ep 1
  --end-ep <总集数>
  --output-dir <absolute-series-directory>
```

工作目录是包含 `hongguo_grab.py` 的 Python 组件目录。stdout 每行只能有一个 JSON 对象；stderr 用于调试信息。主要事件：

| `event` | 字段 | 含义 |
|---|---|---|
| `init` | `device`, `total` | 环境就绪，本次实际待抓数量 |
| `episode_start` | `ep` | 开始处理某集 |
| `progress` | `ep`, `percent` | 粗粒度分集进度 |
| `episode_done` | `ep`, `file` | 分集成功 |
| `episode_failed` | `ep`, `error` | 分集失败，但后续集继续 |
| `log` | `level`, `message` | 可展示日志 |
| `done` | `ok`, `failed` | 正常或部分失败结束汇总 |

退出码：`0` 全成功或无需处理，`2` 部分失败，`3` 环境错误，`130` 收到终止信号。完整契约和不可修改边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 常见问题

### 找不到 Python

Electron 会先找合格的隔离环境，再检查系统解释器。macOS 可验证：

```bash
which python3
python3 --version
```

Windows 可执行 `py -3 --version` 或 `python.exe --version`。应用找不到 Python 时，macOS 通过 Homebrew、Windows 通过 WinGet 询问安装；也可设置 `SHORTDRAMA_PYTHON` 指向解释器绝对路径。系统没有对应包管理器时，应用会明确提示先安装 Homebrew 或 Microsoft App Installer。

### Python 依赖缺失

```bash
source .venv/bin/activate
python -m pip install -r python/requirements.txt
python -c "import frida, cryptography; print(frida.__version__)"
```

### `adb: command not found`

应用会搜索 Android Studio 默认目录、`ANDROID_HOME`、`ANDROID_SDK_ROOT`、`SHORTDRAMA_SDK_ROOT` 和当前平台常见路径。macOS/Windows 缺少 SDK 组件时均可在确认后自动安装。

### 设备显示 `unauthorized`

解锁设备并确认 USB 调试授权弹窗。必要时撤销设备上的 USB 调试授权、重新连接，再执行 `adb devices -l`。

### 设备显示 `offline`

重连设备或重启 ADB Server：

```bash
adb kill-server
adb start-server
adb devices -l
```

不要在设备仍为 `offline` 时开始抓取。

### 同时连接多个 ADB 设备

设置 `ANDROID_SERIAL=<目标序列号>` 后再启动应用。未指定时仅在“恰好只有一个模拟器”时自动选择，否则 Python 返回退出码 `3`。

### Frida 版本不匹配或 `frida-ps -U` 失败

PC 端 `frida` 与设备端 `frida-server` 必须完全同版本，设备二进制还必须匹配 ABI。重新核对 `python3 -c "import frida; print(frida.__version__)"` 和 `adb shell getprop ro.product.cpu.abi`。

### 找不到 Frida Server

联网时应用会从 Frida 官方 Release 下载正确版本并缓存（超时 180s、多源重试，并内置若干 GitHub 镜像回退）。直连 GitHub 很慢时，可设置环境变量 `SHORTDRAMA_GITHUB_PROXY`（例如 `https://ghfast.top`）优先走代理；离线时可设置 `SHORTDRAMA_FRIDA_SERVER` 指向本机二进制，或预先推送到 `/data/local/tmp/frida-server`，或放入 `python/frida-server-<abi>`。二进制仍不纳入 Git 和 Electron 安装包。

### 日志出现"改用服务端 1080p 源出片(抓取结束后统一下载)"

App 的离线下载固定走 720p 档，其中一部分集用 ByteVC2 编码——ffmpeg 既没有解码器也没有封装标签，这些集没法直接用 720p 副本出片。好在同一集各清晰度档位共用同一把 AES key（每个样本的 IV 写在文件自己的 `senc` 里，不要求"这个文件被播放过"），所以拿 App 播 720p 副本抓到的 key，可以直接解密自己从服务端下载的 1080p 源（标准 HEVC），顺带还把画质从 720x1280 提到 1080x1920。

这一步之所以要等到"抓取结束后统一下载"，不是随手实现的，而是抓 key 这条链路本身的硬约束：

- 整个抓取阶段（`run_harvest`）全程断网，靠的就是"App 只能播本地已完整下载好的文件"这个前提，来确保每次解密事件都能准确对应到具体第几集——这是集号判定的地基。一旦联网，播放器可能改去拉 CDN 缓存的分片，集号就可能对不上。
- 下载 1080p 源本身需要联网，如果发现即下载，就得在抓取循环中途反复切换联网状态。代码里唯一一处循环中途临时联网的先例（重新进入选集页）每次都要停顿几秒钟等网络状态稳定下来；ByteVC2 集数在一部剧里可能占到一半，频繁切网仅等待时间就会累积到几分钟，且徒增集号判定出错的风险。
- 收尾阶段的批量下载本身没有做并发优化，是逐集顺序下载；也就是说改成"发现即下载"并不会让总下载耗时变短，只是把切网开销从"一次"变成"很多次"。

所以看到这条日志属于正常现象：对应集的 key 已经拿到手了，只是画面文件要等这部剧全部集数抓完、统一联网后才会一次性下载产出。

### 没有 root 权限

正式整剧视频链路需要 `adb root`、读取 App 私有 SQLite 数据库、启动 Frida Server，以及访问离线文件。不能满足这些权限时，只能使用网页单播放页下载，或让详情页/分类页只保存封面。

### 找不到 ffmpeg 或 ffprobe

网页 HLS/DASH 使用系统 `ffmpeg`，Android 解密链路使用系统 `ffmpeg` 和 `ffprobe`。缺少时，应用会询问并在 macOS 使用 Homebrew、Windows 使用 WinGet 安装，也可分别运行 `ffmpeg -version` 和 `ffprobe -version` 验证。网页 FFmpeg 可用 `SHORTDRAMA_WEB_FFMPEG` 显式覆盖。

### Playwright 报找不到浏览器

应用会先尝试 Chrome、Edge 和开发态 Playwright Chromium；都不可用时，会询问并在 macOS 使用 Homebrew、Windows 使用 WinGet 安装 Chrome。开发目录也可运行 `npm run fetch-browser`。安装包默认不携带 Playwright Chromium。

### Python 脚本路径不存在

开发态检查 `python/hongguo_grab.py`。打包态检查 macOS 的 `红果短剧下载器.app/Contents/Resources/python/`，或 Windows 安装目录下的 `resources\python\`。也可在 UI 选择组件目录或设置 `HONGGUO_GRAB_DIR` 临时覆盖。

### 开发模式能用，打包后找不到 Python 文件

先确认 `electron-builder.js` 的 `extraResources` 未被移除，再用 `npm run pack` 检查 `<resources>/python/` 的七个文件，其中应同时包含 `start_avd.sh` 和 `start_avd.ps1`。文件被打包不代表 Python 解释器、Android 系统镜像或 ADBKeyBoard 也被打包；这些由首次使用时检查和按需安装。

### 出现“恢复定位时暂未通过 UI 核对”

这是抓取中播放器暂时没有新的解密事件后触发的恢复导航提示，不等于已完成分集失效。脚本会继续用 SQLite 映射和解密事件核对实际剧集；只有随后出现 `episode_failed`、退出码 `2` 或明确的环境错误才代表存在缺集。旧日志“搜索进入连续 3 次没核对上”在恢复路径中容易被误解为分集失败，现已改成上述说明性提示，导航和终检逻辑未改变。

### stdout 出现非 JSON 内容

不要向 `hongguo_grab.py` stdout 添加 `print` 调试。正式脚本把人类调试信息写入 stderr，并把 Frida JavaScript 日志重定向到 stderr。Electron 会忽略无法解析的 stdout 行，但这代表协议已被污染，应恢复纯 JSON Lines。

### 下载任务无法取消

Electron 向 Python 子进程请求终止。macOS 上沿用已验证的 `SIGTERM` 清理协议：Python 设置取消标志，清理临时文件、恢复网络并以 `130` 退出。Node 在 Windows 上的子进程终止语义不同，当前实现保持同一调用，但尚未在 Windows 真机链路验证网络恢复和设备锁释放；Windows 验收前不要把“界面已取消”当作设备清理完成的证明。

### 找不到 `.mdl` 文件

确认 App 离线下载已经完成、目标 App 包名和离线目录未因版本升级变化，并检查设备存储权限。脚本会比较 App 下载库中的本剧映射，不能用其他剧残留文件凑数量。

### SQLite 记录找不到对应文件

正式链路会拉取 `series_download_db`、WAL 和 `TTVideoEngine_download_database_v01`，通过剧名、集数、视频 ID 与播放源 ID 建立映射。App 数据库 schema 变化、下载未完成或旧幽灵记录都会导致映射失败。不要绕过这项检查，否则可能产出错集。

### App 升级后 Hook 或 UI 操作失效

当前实现依赖 App 包名、Activity、资源 ID、SQLite schema、`libttffmpeg.so` 导出符号和播放器交互。升级后应在受控设备上重新做兼容性验证；不要在未验证时修改 JSON 协议或解密参数来掩盖问题。

## 安全与合规

本项目**仅供技术学习与研究**。使用者需自行确保其使用方式合法，并**自行承担由此产生的全部法律责任**；作者不对任何滥用行为负责，亦不提供任何形式的担保。完整声明见本文档开头的「免责声明」。

- 仅处理你有权访问和下载的内容。
- 遵守当地法律、平台服务条款和版权要求。
- 不要将本项目用于绕过未获授权的访问控制，也不要传播未经授权的内容。
- Android Hook、root 和 App 私有文件访问具有设备与版本风险，应只在你拥有或明确获准测试的环境中使用。
- 不要提交账号信息、设备序列号、Cookie、Token、AES 密钥、数据库快照、Frida 抓取日志、`.mdl` 或解密后媒体。
- Electron 渲染进程保持 `contextIsolation: true`、`nodeIntegration: false` 和 `sandbox: true`，拒绝新窗口与页面导航；Playwright 不禁用浏览器 sandbox。

ADBKeyBoard 来自 `senzhk/ADBKeyBoard` 固定 commit `4b513f3313b8392b316b37e9c08b0be2def79dda`，上游许可证为 GPL-2.0，固定 APK SHA-256 为 `e698adea5633135a067b038f9a0cf41baa4de09888713a81593fb2b9682cdc59`。该上游 APK 带 `application-debuggable` 且由 Android Debug 证书签名，因此项目不把它放进 Git 或安装包，只在用户启用 Android 抓取、设备又缺少输入法时按固定哈希下载。它是输入法组件，能够接收输入内容，只应安装在专用受控模拟器，不应安装在处理个人密码或敏感数据的日常设备。

## License

本项目使用 MIT License，完整文本见 [LICENSE](LICENSE)。FFmpeg 由最终用户通过系统包管理器单独安装，ADBKeyBoard 由最终用户从固定上游地址下载；这些独立第三方组件分别遵循其发行包许可证。

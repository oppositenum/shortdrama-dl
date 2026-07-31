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

- **单播放页**：Electron 用 Playwright 捕获该播放页的媒体请求，用 Node.js 或 ffmpeg 下载这一集。
- **整剧详情页/分类页**：网页只解析剧名、总集数并保存封面，随后由 Android App 从第 1 集开始抓取全集。

Electron 与 Python 通过稳定的命令行和 JSON Lines 协议协作；运行边界、参数和打包资源见 [架构文档](docs/ARCHITECTURE.md)。

## 功能

- Electron 图形界面、下载任务状态管理，以及「环境检查」面板（一打开就只读探测 Python/ffmpeg/模拟器/App/Frida Server 状态，不装不下载不弹窗）
- 记住上次填写的链接、保存目录和各项开关
- 单个播放页视频下载，MP4 直连或 HLS/DASH 走 ffmpeg
- 详情页/分类页元数据解析、封面下载、多剧批量处理及失败补漏
- 已有分集跳过、断点续传、`.complete` 完成状态记录
- Android App 从第 1 集开始的全集抓取：Frida 采集解密上下文、`.mdl` 逐样本解密、ffmpeg 重封装、ffprobe 时长终检
- 多 ADB 设备环境下的目标设备选择，单设备任务锁防止并发抓取互相干扰
- 通过 `SIGTERM` 安全取消 Python 任务

Android 链路依赖已 root 的受控设备和特定 App 运行环境，不是通用 Android 下载方案；App 升级、UI 改版或 Frida Hook 符号变化都可能使该链路失效。

## 项目结构

```text
shortdrama-dl/
├── main.js                 # Electron 主进程、网页下载和 Python 编排
├── preload.js               # contextBridge 白名单 IPC
├── renderer/                 # Electron UI
├── electron-builder.js       # 打包、签名及 Python 资源清单
├── python/
│   ├── hongguo_grab.py       # Electron 正式调用的 Python 入口
│   ├── decrypt_mdl.py        # 单个 .mdl 解密和重封装
│   ├── mp4parse.py           # MP4 样本表解析
│   ├── capture_final.js      # Frida Hook 脚本
│   ├── start_avd.sh          # macOS Android 环境检查、安装与启动
│   ├── start_avd.ps1         # Windows Android 环境检查、安装与启动
│   └── requirements.txt      # 正式 Python 依赖
├── docs/                     # 架构、文件清单、项目状态、发布流程
├── README.md / README.en.md
└── LICENSE
```

开发态直接运行 Python 时生成的缓存、日志、数据库快照和媒体文件均被 `.gitignore` 排除；打包应用把同类缓存写入应用用户数据目录，不会修改安装包内容或破坏 macOS 代码签名。

## 支持平台

| 发布目标 | 支持状态 | 建议产物 |
|---|---|---|
| macOS 12+ Apple Silicon（`arm64`） | 支持 | universal DMG，或体积更小的 arm64 DMG |
| macOS 12+ Intel（`x64`） | 支持 | universal DMG，或体积更小的 x64 DMG |
| Windows 10/11 x64 | 支持 | NSIS 安装包 |
| Windows ARM64 / Linux | 不支持自动准备 Android 环境 | 仅可源码开发，网页单播放页链路仍可用 |

单播放页下载和整剧封面解析本身无需 Android、ADB、Frida 或 Python；详情页/分类页的整剧下载依赖 Android App 链路，还需要 Python 3.11+、`adb`、支持 `adb root` 的 Android 设备/模拟器、匹配版本的 Frida（当前锁 `17.16.4`）和系统 `ffmpeg`/`ffprobe`。这些依赖第一次使用时会自动检测，缺失时弹确认框、征得同意后再安装——不会静默改动系统。

## 安装

```bash
git clone git@github.com:oppositenum/shortdrama-dl.git
cd shortdrama-dl
npm ci
npm start
```

源码开发和打包要求 Node.js 22+ 及 npm；这一要求不适用于安装 DMG/NSIS 的最终用户。系统已有 Chrome 或 Edge 即可使用网页链路；需要开发环境的 Playwright Chromium 回退时运行 `npm run fetch-browser`（安装包默认不含它）。

只用网页单播放页/封面下载可以跳过下面这两步——它们只是 Android App 抓取链路需要，而且应用本身会在第一次使用时自动检测并询问是否安装：

```bash
# Python 环境（macOS/Linux）
./scripts/setup-python.sh && source .venv/bin/activate
# Python 环境（Windows PowerShell）
.\scripts\setup-python.ps1; .\.venv\Scripts\Activate.ps1

# 系统 ffmpeg
brew install ffmpeg                                   # macOS
sudo apt install ffmpeg                                # Ubuntu/Debian
winget install --exact --id Gyan.FFmpeg --source winget # Windows
```

## Android 设备准备

勾选「用 App 抓取全集」后，应用会自动检查/启动模拟器（`hongguo` AVD 已装但未启动会自动开机；完全没有时征得确认后安装 Android SDK、Emulator 和系统镜像）。也可以在终端手动检查：

```bash
./python/start_avd.sh --check                 # macOS
./python/start_avd.sh --ensure --install-missing

powershell -File .\python\start_avd.ps1 -Check          # Windows
powershell -File .\python\start_avd.ps1 -Ensure -InstallMissing
```

真机准备：打开开发者选项和 USB 调试、连接后在设备端确认授权、设备必须已 root（自动创建的模拟器镜像默认支持 `adb root`）、安装并登录目标 App（包名 `com.phoenix.read`）。多台设备同时连接时设置 `ANDROID_SERIAL=<序列号>` 指定目标设备。常见连接问题见下方 [常见问题](#常见问题)。

## 使用

- **开发启动**：`npm start`（`npm run dev` 额外开启 Electron 调试日志）。
- **单播放页**：粘贴 `/player/...` 链接，选择保存目录，点「开始下载」。
- **整剧**：粘贴 `/detail?series_id=...` 或 `/category?...` 链接；网页只解析剧名/总集数/封面，取消勾选「用 App 抓取全集」则只保存封面。勾选时 Python 自动搜索目标剧、跳过已存在的分集、抓取全集并解密输出到同名目录。
- 已有分集跳过和 `.complete` 完成标记见 [架构文档](docs/ARCHITECTURE.md)。

## 开发与打包

| 命令 | 作用 |
|---|---|
| `npm start` / `npm run dev` | 启动应用（后者带调试日志） |
| `npm test` | 运行不连接真实设备的 mock 测试 |
| `npm run pack` | 生成当前平台的未安装目录包 |
| `npm run dist` | 生成当前平台分发包 |
| `npm run dist:mac` / `:mac:arm64` / `:mac:x64` | macOS ad-hoc 签名 DMG（universal / arm64 / x64） |
| `npm run dist:mac:signed` / `:signed:arm64` / `:signed:x64` | Developer ID 签名并公证的 DMG |
| `npm run dist:win` | Windows x64 NSIS 安装包 |

安装包不内置 Python 解释器、Android 系统镜像、系统 ffmpeg、Frida Server、Chrome 或 Edge——这些由应用首次使用时按需检测和安装。CI 自动发版、Apple 签名公证配置和发布前检查清单见 [docs/RELEASE.md](docs/RELEASE.md)。

## 常见问题

### 找不到 Python / Python 依赖缺失

应用会先找合格的隔离环境，再检查系统解释器；找不到时 macOS 通过 Homebrew、Windows 通过 WinGet 询问安装，也可设置 `SHORTDRAMA_PYTHON` 指向解释器绝对路径。手动排查：

```bash
source .venv/bin/activate
python -m pip install -r python/requirements.txt
python -c "import frida, cryptography; print(frida.__version__)"
```

### `adb` 找不到 / 设备显示 `unauthorized` 或 `offline`

应用会自动搜索常见 SDK 路径。`unauthorized` 需要解锁设备并确认 USB 调试授权弹窗；`offline` 尝试重连或 `adb kill-server && adb start-server`，不要在设备仍为 `offline` 时开始抓取。

### 同时连接多台 ADB 设备

设置 `ANDROID_SERIAL=<目标序列号>` 后再启动应用。未指定时仅在“恰好只有一个模拟器”时自动选择。

### Frida 版本不匹配 / 找不到 Frida Server

PC 端 `frida` 与设备端 `frida-server` 必须完全同版本且匹配 ABI。联网时应用会自动下载缓存并推送；直连 GitHub 慢可设 `SHORTDRAMA_GITHUB_PROXY`（如 `https://ghfast.top`），离线可设 `SHORTDRAMA_FRIDA_SERVER` 指向本机二进制。

### 日志出现"改用服务端 1080p 源出片(抓取结束后统一下载)"

App 离线下载固定走 720p 档，其中一部分集是 ffmpeg 认不出的 ByteVC2 编码。这些集的 key 已经拿到手，只是画面文件要等整部剧抓完、统一联网后才批量下载——因为抓 key 全程要求断网（保证每次解密事件都能对应到正确集号），联网下载必须放到收尾统一做，属于正常现象。

### 没有 root 权限 / 找不到 ffmpeg 或 ffprobe

正式整剧链路需要 `adb root`；不满足时只能用网页单播放页下载，或让详情页/分类页只保存封面。ffmpeg/ffprobe 缺失时应用会询问并自动安装，网页 FFmpeg 也可用 `SHORTDRAMA_WEB_FFMPEG` 显式覆盖。

### 下载任务无法取消 / 打包后找不到 Python 文件

取消走 `SIGTERM`：Python 清理半截文件、恢复网络后以退出码 `130` 结束。找不到 Python 组件目录时，可在 UI 里选择组件目录，或设置 `HONGGUO_GRAB_DIR` 临时覆盖；开发态默认 `python/`，打包态默认安装目录下的 `resources/python/`。

## 安全与合规

本项目**仅供技术学习与研究**。使用者需自行确保其使用方式合法，并**自行承担由此产生的全部法律责任**；作者不对任何滥用行为负责，亦不提供任何形式的担保。完整声明见本文档开头的「免责声明」。

- 仅处理你有权访问和下载的内容；遵守当地法律、平台服务条款和版权要求。
- 不要将本项目用于绕过未获授权的访问控制，也不要传播未经授权的内容。
- Android Hook、root 和 App 私有文件访问具有设备与版本风险，应只在你拥有或明确获准测试的环境中使用。
- 不要提交账号信息、设备序列号、Cookie、Token、AES 密钥、数据库快照、Frida 抓取日志、`.mdl` 或解密后媒体。
- Electron 渲染进程保持 `contextIsolation: true`、`nodeIntegration: false` 和 `sandbox: true`，拒绝新窗口与页面导航。

ADBKeyBoard 来自 `senzhk/ADBKeyBoard` 固定 commit（GPL-2.0，固定 SHA-256 校验），仅在设备缺少中文输入法时按需下载，不随 Git 或安装包分发；它能接收输入内容，只应安装在专用受控模拟器。

## License

本项目使用 MIT License，完整文本见 [LICENSE](LICENSE)。FFmpeg 由最终用户通过系统包管理器单独安装，ADBKeyBoard 由最终用户从固定上游地址下载；这些独立第三方组件分别遵循其发行包许可证。

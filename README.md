# shortdrama-dl

[中文](README.md)

> ## ⚠️ Disclaimer
>
> **This project is provided for technical study and research purposes only.**
>
> It documents the implementation of mobile application security, Android instrumentation (Frida), MP4 container parsing, and CENC encryption mechanisms. Its intended use is limited to personal learning, security research, and technical discussion.
>
> **Users bear full legal responsibility for how they use it.** You may only process content that you own the rights to, or for which you have obtained explicit authorization from the rights holder. The author is not associated with, and accepts no responsibility for, any use of this project to:
>
> - Circumvent technological protection measures without authorization, or download, reproduce, or distribute copyrighted works
> - Violate the user agreement or terms of service of any target platform
> - Engage in piracy, commercial distribution, or any other infringing activity
>
> **The software is provided without warranty of any kind, and the author is not liable for any direct or indirect damages arising from its use.** If tools of this kind are prohibited where you live, stop using this project and delete it immediately. By downloading this project you acknowledge that you have read, understood, and accepted this disclaimer.
>
> See [Safety and Compliance](#safety-and-compliance) for details.

`shortdrama-dl` is a short-drama download tool composed of an Electron desktop application and a Python Android capture/decryption component. It provides two URL-handling paths:

- **Single player page**: Electron uses Playwright to capture that page's media request and downloads that episode through Node.js or ffmpeg.
- **Whole-series detail/category page**: the website only resolves the series name, total episode count, and cover. The Android App then captures the whole series starting at episode 1.

Electron and Python cooperate through a stable command-line and JSON Lines protocol; see [Architecture](docs/ARCHITECTURE.md) for runtime boundaries, arguments, and packaged resources.

## Features

- Electron desktop UI, download task management, and an "environment check" panel (read-only probe of Python/ffmpeg/emulator/App/Frida Server on launch — never installs, downloads, or pops a dialog on its own)
- Remembers the last-entered link, save directory, and other form fields
- Single player-page downloads: direct MP4, or ffmpeg for HLS/DASH
- Detail/category page metadata parsing, cover downloads, multi-series batch processing with retry rounds
- Existing-file skip, resumable runs, `.complete` markers
- Android App whole-series capture from episode 1: Frida-captured decryption context, per-sample `.mdl` decryption, ffmpeg remuxing, ffprobe duration validation
- Target selection in multi-device ADB environments, with a per-device lock preventing concurrent capture
- Safe Python task cancellation through `SIGTERM`

The Android workflow requires a controlled rooted device and a compatible app environment — it is not a generic Android downloader. App UI changes, SQLite schema changes, or Frida hook symbol changes can break it.

## Project Layout

```text
shortdrama-dl/
├── main.js                 # Electron main process, web flow, Python orchestration
├── preload.js               # Allowlisted contextBridge IPC API
├── renderer/                 # Electron UI
├── electron-builder.js       # Packaging, signing, Python resources
├── python/
│   ├── hongguo_grab.py       # Production Python entry point
│   ├── decrypt_mdl.py        # Single .mdl decryption and remux
│   ├── mp4parse.py           # MP4 sample-table parser
│   ├── capture_final.js      # Frida hook
│   ├── start_avd.sh          # macOS Android checks, installation, and startup
│   ├── start_avd.ps1         # Windows Android checks, installation, and startup
│   └── requirements.txt      # Production Python dependencies
├── docs/                     # Architecture, file inventory, project status, release process
├── README.md / README.en.md
└── LICENSE
```

Runtime data generated while running Python directly in development is excluded by `.gitignore`; a packaged application writes equivalent caches under application user data and never modifies the packaged contents or invalidates the macOS code signature.

## Supported Platforms

| Release target | Status | Recommended artifact |
|---|---|---|
| macOS 12+ Apple Silicon (`arm64`) | Supported | Universal DMG, or the smaller arm64 DMG |
| macOS 12+ Intel (`x64`) | Supported | Universal DMG, or the smaller x64 DMG |
| Windows 10/11 x64 | Supported | NSIS installer |
| Windows ARM64 / Linux | Automatic Android setup unsupported | Source development only; the web single-player-page path still works |

Single player-page downloads and whole-series cover parsing do not themselves require Android, ADB, Frida, or Python. Whole-series video from a detail/category page depends on the Android App workflow and additionally needs Python 3.11+, `adb`, an Android device/emulator capable of `adb root`, matching Frida components (currently pinned to `17.16.4`), and system `ffmpeg`/`ffprobe`. These are detected automatically on first use; missing pieces trigger a confirmation dialog before anything is installed — nothing happens silently.

## Installation

```bash
git clone git@github.com:oppositenum/shortdrama-dl.git
cd shortdrama-dl
npm ci
npm start
```

Source development and packaging require Node.js 22+ and npm; end users installing the DMG/NSIS artifact do not need Node.js. If Chrome or Edge is installed, the web workflow uses it directly; run `npm run fetch-browser` for the development Playwright Chromium fallback (not included in packaged builds).

Skip the next two steps if you only use the web single-player-page/cover path — they're only needed for Android App capture, and the app detects and offers to install them itself on first use:

```bash
# Python environment (macOS/Linux)
./scripts/setup-python.sh && source .venv/bin/activate
# Python environment (Windows PowerShell)
.\scripts\setup-python.ps1; .\.venv\Scripts\Activate.ps1

# System ffmpeg
brew install ffmpeg                                    # macOS
sudo apt install ffmpeg                                 # Ubuntu/Debian
winget install --exact --id Gyan.FFmpeg --source winget  # Windows
```

## Android Device Preparation

With "Use App to capture the whole series" enabled, the app automatically checks/starts the emulator (an installed but stopped `hongguo` AVD is booted; if nothing is installed, it asks before installing the Android SDK, Emulator, and system image). You can also check manually:

```bash
./python/start_avd.sh --check                  # macOS
./python/start_avd.sh --ensure --install-missing

powershell -File .\python\start_avd.ps1 -Check           # Windows
powershell -File .\python\start_avd.ps1 -Ensure -InstallMissing
```

For a physical device: enable Developer Options and USB debugging, connect and approve the host authorization prompt, the device must be rooted (the auto-created emulator image supports `adb root` by default), and install/sign in to the target app (package `com.phoenix.read`). With multiple connected devices, set `ANDROID_SERIAL=<serial>` to pick one. Common connection issues are covered in [Troubleshooting](#troubleshooting).

## Usage

- **Development launch**: `npm start` (`npm run dev` adds Electron debug logging).
- **Single player page**: paste a `/player/...` link, choose a save folder, click Start Download.
- **Whole series**: paste a `/detail?series_id=...` or `/category?...` link. The website only resolves the name/total-count/cover; clearing "Use App to capture the whole series" saves covers only. When enabled, Python searches for the series, skips existing episodes, captures the whole series, and writes decrypted output into the same series directory.
- Existing-episode skipping and the `.complete` marker are described in [Architecture](docs/ARCHITECTURE.md).

## Development and Packaging

| Command | Purpose |
|---|---|
| `npm start` / `npm run dev` | Start the app (the latter with debug logging) |
| `npm test` | Run environment-startup mocks without a real device |
| `npm run pack` | Create an unpacked app directory for the current platform |
| `npm run dist` | Build a distribution for the current platform |
| `npm run dist:mac` / `:mac:arm64` / `:mac:x64` | macOS ad-hoc signed DMG (universal / arm64 / x64) |
| `npm run dist:mac:signed` / `:signed:arm64` / `:signed:x64` | Developer ID signed and notarized DMG |
| `npm run dist:win` | Windows x64 NSIS installer |

Packaged builds do not bundle a Python interpreter, Android system image, system ffmpeg, Frida Server, Chrome, or Edge — the app detects and installs these on demand. CI auto-versioning, Apple signing/notarization setup, and the pre-release checklist live in [docs/RELEASE.md](docs/RELEASE.md).

## Troubleshooting

### Python is not found / Python dependencies are missing

The app first checks an isolated environment, then system interpreters. When missing, it offers Homebrew (macOS) or WinGet (Windows) installation; `SHORTDRAMA_PYTHON` can point to an interpreter directly. Manual check:

```bash
source .venv/bin/activate
python -m pip install -r python/requirements.txt
python -c "import frida, cryptography; print(frida.__version__)"
```

### `adb` is not found / device is `unauthorized` or `offline`

The app searches common SDK paths automatically. `unauthorized` needs the device unlocked with its USB-debugging prompt approved; for `offline`, reconnect or run `adb kill-server && adb start-server` — don't start capture while the device is still `offline`.

### Multiple ADB devices are connected

Set `ANDROID_SERIAL=<serial>` before launch. Without it, automatic selection only succeeds when exactly one emulator candidate exists.

### Frida versions do not match / Frida Server is missing

The PC `frida` package and device `frida-server` must be the exact same version and match the device ABI. When online, the app downloads and pushes the matching binary automatically; set `SHORTDRAMA_GITHUB_PROXY` (e.g. `https://ghfast.top`) if GitHub is slow, or `SHORTDRAMA_FRIDA_SERVER` to use a local binary offline.

### Log shows "switching to a server-side 1080p source (batched for download after capture finishes)"

The app's offline downloads are always the 720p rung, and some episodes in that rung use ByteVC2, which ffmpeg cannot decode. The decryption key for those episodes is already captured — only the actual video file is deferred until the whole series finishes and the device goes back online for one batch download. This is required because key capture depends on the device staying offline the entire time (so every decryption event maps to the correct episode); downloading requires networking, so it has to happen in one batch at the end rather than mid-capture.

### Root is unavailable / ffmpeg or ffprobe is missing

The production workflow needs `adb root`; without it, use the web single-player-page path, or save covers only for detail/category pages. Missing ffmpeg/ffprobe triggers an install prompt; `SHORTDRAMA_WEB_FFMPEG` can override the web executable explicitly.

### A task cannot be cancelled / the packaged app cannot find Python files

Cancellation uses `SIGTERM`: Python removes partial output, restores networking, and exits with code `130`. If the Python component directory can't be found, set it explicitly in the UI or via `HONGGUO_GRAB_DIR`; development defaults to `python/`, packaged builds to `resources/python/` under the install directory.

## Safety and Compliance

This project is **for technical study and research only**. Users must ensure their use is lawful and **bear full legal responsibility for it**; the author is not responsible for misuse and provides no warranty of any kind. See the disclaimer at the top of this document for the complete statement.

- Process only content you are authorized to access and download; follow local law, platform terms, and copyright requirements.
- Do not use this project to bypass access controls without authorization or distribute unauthorized content.
- Root, hooking, and app-private file access should be used only on devices and applications you own or are explicitly authorized to test.
- Never commit account data, device serials, cookies, tokens, AES keys, SQLite snapshots, Frida capture logs, `.mdl` files, or decrypted media.
- Electron keeps `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`; new windows and renderer navigation are denied.

ADBKeyBoard is fetched from a pinned `senzhk/ADBKeyBoard` commit (GPL-2.0, pinned SHA-256 verified), downloaded only when the device lacks a Chinese IME, and never redistributed with Git or the packaged app. As an input method it can receive typed content, so install it only on a dedicated controlled emulator.

## License

This project uses the MIT License. See [LICENSE](LICENSE). FFmpeg is installed separately through the system package manager and ADBKeyBoard is downloaded by the end user from its pinned upstream location; those independent components remain subject to their distribution licenses.

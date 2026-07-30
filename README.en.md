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

- Single player page: Electron uses Playwright to capture that page's media request and downloads that one episode through Node.js or ffmpeg.
- Whole-series detail/category page: the website is used only to resolve the series name, total episode count, and cover. No web episode is downloaded. Electron then starts `python/hongguo_grab.py`, and the Android App captures the whole series beginning with episode 1.

Electron and Python cooperate through a stable command-line and JSON Lines protocol. See [Architecture](docs/ARCHITECTURE.md) for runtime boundaries, arguments, and packaged resources.

## Features

- Electron desktop UI and download task management
- Single player-page downloads
- Detail/category page metadata parsing and cover downloads
- Multi-series category/ranking processing with retry rounds
- Existing-file skip and resumable runs
- Series cover downloads
- `.complete` markers for batch skipping
- System Chrome, Edge, or a development Playwright Chromium
- Direct MP4 downloads and ffmpeg-based HLS/DASH merging
- Android App whole-series capture beginning with episode 1
- Target selection in multi-device ADB environments
- Per-device process lock to prevent concurrent UI/device control
- Frida capture of AES context data
- Deterministic mapping from app SQLite records to `.mdl` files
- Per-sample AES-128-CTR `.mdl` decryption
- ffmpeg remuxing and ffprobe duration validation
- JSON Lines events between Python and Electron
- Safe Python task cancellation through `SIGTERM`

The Android workflow requires a controlled rooted device and a compatible app environment. It is not a generic Android downloader. App UI, SQLite schema, native symbols, or media implementation changes can break that workflow.

## Project Layout

```text
shortdrama-dl/
├── main.js                         # Electron main process, web flow, Python orchestration
├── runtime-platform.js             # macOS/Windows detection and installer selection
├── series-workflow.js              # Whole-series count, App range, completion-marker rules
├── preload.js                      # Allowlisted contextBridge IPC API
├── renderer/                       # Existing Electron UI
├── electron-builder.js             # Packaging, signing, Python resources
├── build/                          # Icon, macOS entitlements, afterPack hook
├── python/
│   ├── hongguo_grab.py             # Production Python entry point
│   ├── decrypt_mdl.py              # Single .mdl decryption and remux
│   ├── mp4parse.py                 # MP4 sample-table parser
│   ├── capture_final.js            # Frida hook
│   ├── start_avd.sh                # macOS Android checks, installation, and startup
│   ├── start_avd.ps1               # Windows Android checks, installation, and startup
│   └── requirements.txt            # Production Python dependencies
├── scripts/
│   ├── setup-python.sh             # macOS/Linux Python setup
│   └── setup-python.ps1            # Windows PowerShell Python setup
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PYTHON_FILES.md
│   └── PROJECT_STATUS.md
├── README.md
├── README.en.md
└── LICENSE
```

When Python runs directly in development, runtime data such as `python/allmdl/`, `python/.appdb/`, and `captured_grab.jsonl` is excluded by `.gitignore`, together with logs, SQLite snapshots, Frida Server binaries, and media. A packaged application writes equivalent caches under application user data and never modifies `<resources>/python` or invalidates the macOS code signature.

## How It Works

```text
Electron UI
  |
  +-- Single web player page
  |    +-- Playwright captures this episode's media request
  |         +-- MP4 -> Node fetch
  |         +-- HLS/DASH -> native system FFmpeg
  |
  +-- Detail/category page -> resolve name, total count, and cover
       +-- Start python/hongguo_grab.py at episode 1
            +-- Control a rooted Android device through ADB
            +-- Read the app's SQLite download databases
            +-- Locate and pull the series .mdl files
            +-- Load capture_final.js through Frida
            +-- Decrypt with decrypt_mdl.py and mp4parse.py
            +-- Remux and validate with system ffmpeg/ffprobe
            +-- Emit stdout JSON Lines for Electron UI updates
```

Python resolves its companion resources relative to `__file__`. Keep `hongguo_grab.py`, `capture_final.js`, `decrypt_mdl.py`, and `mp4parse.py` together in `python/`.

## Supported Platforms

| Release target | Status | Recommended artifact |
|---|---|---|
| macOS 12+ Apple Silicon (M1/M2/M3/M4, `arm64`) | Supported | Universal DMG, or the smaller arm64 DMG |
| macOS 12+ Intel (`x64`) | Build supported | Universal DMG, or x64 DMG; final acceptance on Intel hardware is still required |
| macOS universal (`x64 + arm64`) | Supported and recommended public-release architecture | `npm run dist:mac` for testing; `npm run dist:mac:signed` for public distribution |
| Windows 10/11 x64 | Build supported | NSIS installer built and accepted on Windows x64 |
| Windows ARM64 | Automatic AVD creation unsupported | Do not publish; setup exits with an explicit unsupported-architecture error |
| Linux | No official package | Limited source development only; automatic Android setup is unsupported |

Single player-page downloads and whole-series cover parsing do not themselves require Android, ADB, Frida, or Python, and end users do not need Node.js or npm. Whole-series video from a detail/category page now depends entirely on the Android App workflow. Direct MP4 downloads from a single player page use Electron's Node.js network stack; only HLS/DASH requires system FFmpeg. System Chrome or Edge is preferred for page inspection. If the browser or FFmpeg is missing, the app asks before invoking the host package manager to install the build matching the current CPU.

The Android App workflow additionally requires Python 3.11+, `adb`, an Android device or emulator capable of `adb root`, matching Frida components (currently pinned to `17.16.4`), `cryptography`, and system `ffmpeg`/`ffprobe`. Platform and CPU detection controls setup:

- macOS uses Homebrew, Bash, and `~/Library/Android/sdk`; Apple Silicon AVDs use `arm64-v8a`, while Intel AVDs use `x86_64`.
- Windows x64 uses WinGet, Windows PowerShell, and `%LOCALAPPDATA%\Android\Sdk`; its AVD uses `x86_64`.
- Linux, Windows ARM64, and unknown architectures stop explicitly instead of installing another platform's tools or image.

The current build host is Apple Silicon macOS. arm64 and universal artifacts can be executed locally. x64 artifacts can be inspected as Mach-O files and receive a limited Rosetta smoke test, but that is not equivalent to acceptance on Intel hardware. Windows behavior is covered by Node tests and static contracts, but the real Windows x64 AVD, target-app, and Frida workflow has not yet passed end-to-end acceptance.

## New-Computer Prerequisites and Automatic Setup Boundary

Public distribution should use a Developer ID signed and Apple-notarized universal DMG, plus an NSIS installer built and accepted on Windows x64. A new computer needs network access, adequate disk space, and working hardware virtualization. Android SDK components and the system image consume several GB.

| Item | Bundled | Can the app prepare it? | User responsibility |
|---|---|---|---|
| Electron | Yes, per artifact architecture | No installation required | None |
| Chrome/Edge | No | After confirmation, install Chrome through Homebrew/WinGet | Install the package manager first if it is absent |
| Python and Python packages | No | After confirmation, install Python and create an isolated environment under app user data | Install manually when offline or when the package manager is unavailable |
| System ffmpeg/ffprobe | No; HLS/DASH needs ffmpeg and Android also needs ffprobe | After confirmation, install the native build through Homebrew/WinGet | Install manually if the package manager cannot be used |
| Android SDK, Emulator, AVD, Java 17 | No | After confirmation, install official components, accept SDK licenses, create and start the AVD | Provide disk space, network access, and hardware virtualization |
| Frida Server | No | Download from the official release for the Python Frida version and device ABI, verify, cache, and push | Provide a matching binary for offline setup |
| ADBKeyBoard | No | If the device lacks a Chinese-input IME, download from a pinned upstream commit, verify SHA-256, and install | For offline use, provide the same hash through `SHORTDRAMA_ADB_KEYBOARD_APK` |
| Target app, account, and authorization | No | No | Install the app, sign in, and process only content the user is authorized to access |
| Physical-device root and USB authorization | No | No | Prepare and authorize the device; an ordinary unrooted device cannot run the App workflow |

Automatic setup is not silent. The app detects missing components, displays a confirmation dialog, and only then invokes the system installer. It does not install Homebrew itself and does not install WinGet/Microsoft App Installer itself. If Homebrew is absent, install it from [brew.sh](https://brew.sh/). If WinGet is absent, install “App Installer” from Microsoft Store. Proxies, enterprise policies, permissions, interrupted downloads, low disk space, and upstream outages can still cause failure. The app revalidates every executable instead of treating a zero installer exit code as proof of readiness.

The project therefore does not promise fully unattended operation on every clean macOS or Windows machine. Web mode has a smaller dependency boundary. Android mode still requires the package manager, network, virtualization, a root-capable AVD, target-app installation, and interactive account sign-in.

## Installation

### 1. Clone and install Node.js dependencies

Source development and packaging require Node.js 22 or newer (use the current LTS) and npm. End users installing the DMG/NSIS artifact do not need Node.js.

```bash
git clone git@github.com:oppositenum/shortdrama-dl.git
cd shortdrama-dl
npm ci
```

If Chrome or Edge is installed, the web workflow can use it directly. To install the development Chromium fallback:

```bash
npm run fetch-browser
```

Only Chromium is installed. The approximately 500 MB Playwright browser directory is not included in production packages; packaged builds still prefer Chrome or Edge on the target machine.

### 2. Prepare Python (Android workflow only)

macOS/Linux:

```bash
./scripts/setup-python.sh
source .venv/bin/activate
```

Equivalent manual commands:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r python/requirements.txt
```

Windows PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-python.ps1
.\.venv\Scripts\Activate.ps1
```

These commands remain useful for developers who want to prepare the environment in advance. On first App capture, Electron validates Python 3.11+ and its package versions. If the pinned Frida/cryptography import fails, development uses `<project>/.venv` and packaged apps clear and recreate an isolated environment under the user-data directory, then install from `requirements.txt`. If a suitable Python is missing, the app asks before installing it through Homebrew on macOS or installing Python 3.12 through WinGet on Windows. Windows discovery also supports `py -3.12` / `py -3.11` / `py -3` and common per-user Python locations.

### 3. Install system ffmpeg (HLS/DASH and Android workflows)

macOS:

```bash
brew install ffmpeg
```

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install ffmpeg
```

Windows PowerShell:

```powershell
winget install --exact --id Gyan.FFmpeg --source winget
```

Before web HLS/DASH, the app checks `ffmpeg`; before Android capture, it checks both `ffmpeg` and `ffprobe`. Missing commands trigger confirmation before Homebrew or WinGet runs, followed by fresh version checks. A zero installer exit code is not treated as readiness unless the required executables can run. Homebrew selects the native build on Apple Silicon and Intel, while the WinGet path is limited to Windows x64.

Verify both commands:

```bash
ffmpeg -version
ffprobe -version
```

Direct MP4 does not require FFmpeg. Web HLS/DASH and the Android workflow share system FFmpeg; the Android Python code additionally requires `ffprobe`.

## Android Device Preparation

App capture runs `python/start_avd.sh` on macOS or `python/start_avd.ps1` on Windows. A ready device is reused, an installed but stopped `hongguo` AVD is started, and missing SDK/AVD components trigger confirmation before Android platform-tools, Emulator, and an API 34 Google APIs image are installed. The system image is several GB.

Run the macOS flow manually with:

```bash
./python/start_avd.sh --check
./python/start_avd.sh --ensure --install-missing
```

Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\python\start_avd.ps1 -Check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\python\start_avd.ps1 -Ensure -InstallMissing
```

The Windows script reuses Android Studio or an SDK selected through environment variables. When command-line tools are missing, it resolves the Windows archive from Google's official `repository2-1.xml`, accepts only an HTTPS `dl.google.com` URL, and verifies the advertised SHA-1/SHA-256. It installs Eclipse Temurin JDK 17 through WinGet when required. Automated Windows AVD creation currently supports x64 and uses an `x86_64` image; ARM64 and other architectures stop explicitly instead of installing the wrong image. macOS selects `arm64-v8a` on Apple Silicon and `x86_64` on Intel.

The generated image is a root-capable Google APIs image, not a Google Play image. The target app installation, account sign-in, and authorization remain user responsibilities.

1. Enable Developer Options and USB debugging.
2. Connect the device and approve the host authorization prompt.
3. Verify the connection:

   ```bash
   adb version
   adb devices -l
   adb shell id
   ```

4. The selected device must be in the `device` state, not `unauthorized` or `offline`.
5. Root is mandatory. The script calls `adb root` and reads `/data/data/com.phoenix.read/databases/`.
6. Install and sign in to the target app. The production code currently uses package name `com.phoenix.read`.
7. Check the device ABI:

   ```bash
   adb shell getprop ro.product.cpu.abi
   ```

8. Check the PC Frida version:

   ```bash
   python3 -c "import frida; print(frida.__version__)"
   frida --version
   ```

9. Python checks the device Frida Server version. When it is missing or mismatched, it downloads the matching binary from the official Frida GitHub Release, caches it under application user data, and pushes it to the selected device. For offline setup, either:
   - install it as `/data/local/tmp/frida-server` on the device, or
   - place it at `python/frida-server-<abi>`, such as `python/frida-server-arm64-v8a`, so the script can push it when needed.
10. Verify Frida connectivity:

    ```bash
    adb shell "chmod 755 /data/local/tmp/frida-server && /data/local/tmp/frida-server >/dev/null 2>&1 &"
    frida-ps -U
    ```

With multiple connected devices, select one before starting Electron:

```bash
export ANDROID_SERIAL="<target-serial>"
npm start
```

Without `ANDROID_SERIAL`, Python selects the only `emulator-*` device if exactly one exists. Otherwise it returns an environment error. Never commit real device serials or account data.

## Running and Usage

### Development launch

```bash
npm start
```

For Electron logging:

```bash
npm run dev
```

### URL Handling Modes

1. Paste a supported URL:
   - `/player/...` downloads one player page.
   - `/detail?series_id=...` resolves the series name, total count, and cover, then captures the whole series from the App beginning with episode 1.
   - `/category?...` resolves multiple series, saves each cover, and captures each whole series from the App.
2. Use **Choose Folder** to select the destination. The system Downloads folder is the fallback.
3. Clear **Use App to capture the whole series** to save covers only for detail/category URLs. The app does not fall back to web episode downloads.
4. Select **Start Download**.
5. Python skips existing non-empty episode files. In category mode, a series is skipped only when `.complete` contains a valid `total/total` value.

Direct MP4 sources use streaming Node.js `fetch`. HLS and DASH use native system FFmpeg without re-encoding and trigger confirmed installation when it is missing. Required request headers captured by Playwright are forwarded to the downloader.

### Android App Capture Mode

1. Install and sign in to the target app. Python, ffmpeg, ADB, the AVD, and Frida are checked automatically on first App capture; system installs and multi-GB downloads require confirmation.
2. Leave **Use App to capture the whole series** enabled. Leave the component directory empty to use the bundled project `python/` directory.
3. After resolving the name, total count, and cover, Electron starts Python with `--start-ep 1 --end-ep <total-count>`. It does not open web episode players.
4. Python searches for the series, skips existing non-empty output episodes, downloads app offline files, reads the SQLite mapping, captures decryption context during offline playback, pulls `.mdl`, and writes decrypted episodes into the same series directory.
5. Users normally do not run `hongguo_grab.py` directly. The UI directory field and `HONGGUO_GRAB_DIR` can explicitly override the bundled directory.

Only one task may control a device at a time. Python creates a per-device lock in the host temporary directory and releases it after a normal finish or safe cancellation.

### Episode Names and Completion Marker

- Fewer than 100 episodes: `第01集.mp4`, `第02集.mp4`.
- 100 or more episodes: `第001集.mp4`, `第002集.mp4`.
- Electron and Python must keep this rule identical.
- `.complete` contains `total/total` only when every non-empty file from episode 1 through the total episode count exists on disk.
- If App capture is disabled, its environment is unavailable, or episodes are still missing, no `.complete` marker is retained. Old incomplete markers such as `free/total` are removed. Existing non-empty episode files remain resumable and are skipped on the next run.

## Development Commands

| Command | Purpose |
|---|---|
| `npm start` | Start Electron |
| `npm run dev` | Start Electron with Electron logging |
| `npm test` | Run environment-startup mocks without a real device |
| `npm run fetch-browser` | Install development Chromium under `ms-playwright/` |
| `npm run pack` | Create an unpacked app directory for the current platform |
| `npm run pack:mac:universal` | Create an unpacked universal macOS app |
| `npm run dist` | Build a distribution for the current platform |
| `npm run dist:win` | Build a Windows x64 NSIS installer on Windows x64 |
| `npm run dist:mac` | Build an ad-hoc signed universal DMG (recommended test artifact) |
| `npm run dist:mac:arm64` | Build an ad-hoc signed Apple Silicon DMG |
| `npm run dist:mac:x64` | Build an ad-hoc signed Intel DMG |
| `npm run dist:mac:signed` | Developer ID sign, notarize, and build a universal DMG |
| `npm run dist:mac:signed:arm64` | Developer ID sign, notarize, and build an arm64 DMG |
| `npm run dist:mac:signed:x64` | Developer ID sign, notarize, and build an x64 DMG |

The Electron/Python boundary is a subprocess protocol, not an imported Python module. Do not add human-readable debug output to Python stdout.

## Build and Packaging

```bash
npm run pack
npm run dist
```

macOS architecture builds:

```bash
npm run dist:mac          # universal: Intel + Apple Silicon, preferred for public distribution
npm run dist:mac:arm64    # Apple Silicon only
npm run dist:mac:x64      # Intel only
```

Build the Windows x64 artifact on a Windows x64 host:

```powershell
npm ci
npm test
npm run dist:win
```

`electron-builder.js` copies these files into `<resources>/python/`:

```text
hongguo_grab.py
decrypt_mdl.py
mp4parse.py
capture_final.js
start_avd.sh
start_avd.ps1
requirements.txt
```

Development resolves `<project-root>/python/hongguo_grab.py`; packaged builds resolve `<resources>/python/hongguo_grab.py`. The package does not include a Python interpreter, an Android system image, system ffmpeg/ffprobe, Frida Server, Chrome, or Edge. See “New-Computer Prerequisites and Automatic Setup Boundary” for the complete contract.

`<resources>/python` is read-only and contains only the seven program files listed above. In packaged builds, `.mdl` files, SQLite snapshots, Frida capture logs, Frida Server, and ADBKeyBoard caches are written under:

- macOS: `~/Library/Application Support/shortdrama-dl/runtime/android/`
- Windows: `%APPDATA%\shortdrama-dl\runtime\android\`

The isolated Python environment is stored under `runtime/python/` in the same application user-data directory. Before macOS or Windows artifacts are created, `build/afterPack.js` cleans and validates `<resources>/python` against the exact seven-file allowlist; a missing file fails the build. Quit any old test application running directly from `release/` before rebuilding so that an old process cannot write into the output directory while it is being replaced.

The application does not redistribute a third-party FFmpeg executable. This prevents a host-only binary from entering an artifact for another CPU and avoids bundling an upstream build that is not legally redistributable. At runtime it resolves FFmpeg from PATH, Homebrew's Apple Silicon `/opt/homebrew/bin` or Intel `/usr/local/bin` location, and common Windows WinGet directories. `SHORTDRAMA_WEB_FFMPEG` can provide an explicit absolute path. A universal macOS artifact only needs dual-architecture Electron; the target machine installs its native system FFmpeg.

### macOS Signing and Notarization

The default `dist:mac*` commands use `build/afterPack.js` for ad-hoc signing. These artifacts are useful for local testing but are not notarized and should not be the final download for ordinary users. Public distribution should use `dist:mac:signed`, which requires:

- A valid `Developer ID Application` certificate and private key in Keychain.
- For Apple ID authentication: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- Or electron-builder's App Store Connect API key variables: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
- No passwords, private keys, or API keys committed to source, documentation, sample environment files, or build logs.

Build and verify a formal release with:

```bash
npm ci
npm test
npm run dist:mac:signed
codesign --verify --deep --strict --verbose=2 "release/mac-universal/红果短剧下载器.app"
spctl --assess --type execute --verbose=4 "release/mac-universal/红果短剧下载器.app"
xcrun stapler validate "release/mac-universal/红果短剧下载器.app"
hdiutil verify "release/红果短剧下载器-1.0.0-universal.dmg"
```

Exact output directories can vary by electron-builder version; use the paths actually created under `release/`. electron-builder submits and staples the `.app` contained by the DMG. The DMG is separately checked with `hdiutil verify`, and the formal workflow mounts it and verifies the contained app again. Do not claim that the installer contains a signed and notarized app until `codesign`, Gatekeeper (`spctl`), app stapler validation, and DMG integrity all pass. Finding a certificate or completing the build alone is insufficient.

## GitHub Actions Versioning and Releases

The repository contains two workflows:

- `.github/workflows/ci.yml` runs for pull requests and pushes to `main`. It tests, audits production dependencies, and checks syntax on `macos-15` (Apple Silicon), `macos-15-intel` (Intel), and `windows-2022`; it also performs macOS universal and Windows x64 packaging smoke builds.
- `.github/workflows/release.yml` runs Release Please on pushes to `main`. Ordinary feature commits only create or update a Release PR. After that PR is merged, the same workflow creates a draft Release, builds the formal macOS universal DMG and Windows x64 NSIS installer, generates `SHA256SUMS.txt`, and publishes the draft only after all validation succeeds.

Every third-party Action is pinned to a full commit SHA. CI cannot read signing secrets. Formal build jobs use the GitHub Environment named `release`.

### Automatic version rules

Do not manually edit versions in `package.json`, `package-lock.json`, or `.release-please-manifest.json`. Use Conventional Commit messages:

| Commit prefix | Version change | Example |
|---|---|---|
| `fix:` | patch, such as `1.0.0 -> 1.0.1` | `fix: recover after an advertisement` |
| `feat:` | minor, such as `1.0.0 -> 1.1.0` | `feat: add Windows AVD setup` |
| `feat!:`, `fix!:`, or `BREAKING CHANGE:` in the body | major, such as `1.0.0 -> 2.0.0` | `feat!: change task protocol` |
| `docs:`, `test:`, `chore:`, and similar types | does not trigger a release by itself | `docs: clarify setup boundary` |

The first release is explicitly configured as `1.0.0`: the initial `.release-please-manifest.json` must remain `{}`, while `release-please-config.json` sets `initial-version` to `1.0.0`. The first releasable `feat:` or `fix:` commit therefore creates a `v1.0.0` Release PR instead of skipping to `v1.1.0`. After a Release PR is merged, Release Please updates `package.json`, `package-lock.json`, `CHANGELOG.md`, and the manifest together. `scripts/verify-release-version.js` makes both build jobs and the final publishing job reject any mismatch between those files, the Git tag, and the Action outputs.

Normal release flow:

1. Merge ordinary work into `main` using Conventional Commit messages. The initial commit should use a releasable message such as `feat: initial shortdrama-dl release`.
2. Wait for `release-please` to create or refresh the Release PR, then review its version and changelog.
3. Merge the Release PR. Release Please creates the `v<version>` tag and draft Release. Tags created by `GITHUB_TOKEN` do not trigger another workflow, so both platform builds and publishing continue inside the current Release workflow.
4. After both builds pass, the `publish` job uploads the DMG, NSIS installer, and `SHA256SUMS.txt`; checks draft state, tag SHA, version, and asset count; then publishes the Release.

If any build, signing, notarization, or verification step fails, the Release remains a draft. For transient Runner or Apple-service failures, choose **Re-run failed jobs** in GitHub Actions so the successful Release Please output is retained. Do not substitute **Re-run all jobs**: a second Release Please run may find the existing tag and no longer emit `release_created=true`. If the failure is in source rather than infrastructure, decide whether to finish that draft version or delete its draft Release and tag before using a new Release PR. Never overwrite an old tag with installers built from another commit.

### Repository settings and secrets

Perform these one-time GitHub repository settings:

1. Confirm that `main` is the default branch. Under **Settings > Actions > General > Workflow permissions**, allow read/write workflow access and enable **Allow GitHub Actions to create and approve pull requests**. An organization policy may require an administrator to permit these settings.
2. Create a `release` Environment under **Settings > Environments**. Optional required reviewers can gate formal builds and publishing; build jobs read their secrets in this Environment.
3. Configure the following as `release` Environment Secrets or repository Secrets. Never store their values in Git, documentation, Actions variables, or logs.

| Secret | Required | Purpose |
|---|---|---|
| `MAC_CSC_LINK` | Yes | Developer ID Application `.p12` as Base64, HTTPS URL, or another electron-builder-supported certificate source |
| `MAC_CSC_KEY_PASSWORD` | Yes | `.p12` private-key password |
| `APPLE_ID` | One method | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | With `APPLE_ID` | Apple app-specific password |
| `APPLE_TEAM_ID` | With `APPLE_ID` | Apple Developer Team ID |
| `APPLE_API_KEY_BASE64` | One method, recommended | Single-line Base64 of the App Store Connect `.p8`; decoded only under the Runner temporary directory |
| `APPLE_API_KEY_ID` | With API key | App Store Connect API Key ID |
| `APPLE_API_ISSUER` | With API key | App Store Connect Issuer ID |
| `WINDOWS_CSC_LINK` | Optional, but recommended for public distribution | Windows Authenticode `.pfx` as Base64, a URL, or another electron-builder-supported certificate source |
| `WINDOWS_CSC_KEY_PASSWORD` | With a Windows certificate | `.pfx` private-key password |

Configure exactly one complete Apple ID or API key credential group. Missing members or both complete groups fail the macOS job before certificate use. Generate single-line API key Base64 with:

```bash
openssl base64 -A -in AuthKey_KEYID.p8
```

Without Windows signing secrets, the workflow still creates an unsigned NSIS installer and marks that fact in the job summary. SmartScreen warnings are expected, and that asset must not be described as a signed Windows release. Public distribution to ordinary users should treat an Authenticode certificate as a release prerequisite.

GitHub Runners prove that tests and packaging complete in Intel macOS, Apple Silicon macOS, and Windows x64 environments, and the release workflow verifies both architectures in the universal app. They do not replace end-to-end acceptance of UI behavior, package-manager setup, hardware virtualization, AVD, ADB, real Android app capture, or cancellation on clean user machines. Before a formal release, install the Release assets and run an end-to-end acceptance pass on at least one Intel Mac, one Apple Silicon Mac, and one Windows x64 machine.

### Currently Verified macOS Build

As of 2026-07-29, the current source was built on Node.js 24.12.0 with Electron 43.2.0 and electron-builder 26.15.3, with these results:

- All 36 automated tests passed, together with Node, Python, and Bash syntax checks; `npm audit --omit=dev` reported 0 vulnerabilities.
- The arm64 app main binary is `arm64`; strict `codesign` verification passed.
- All 16 Mach-O files inspected in the universal app contain both `x86_64 arm64`, including the main binary, Electron Framework, every Helper, `fsevents.node`, and Electron's embedded dynamic libraries.
- `hdiutil verify` passed for the universal DMG. The mounted app again passed strict `codesign`, dual-architecture, and seven-file Python resource checks.
- `main.js`, `ffmpeg-runner.js`, `runtime-platform.js`, `preload.js`, and `series-workflow.js` inside ASAR are byte-for-byte identical to the current sources, as are the packaged `hongguo_grab.py`, `decrypt_mdl.py`, and `mp4parse.py`.
- The current ad-hoc artifact is `release/红果短剧下载器-1.0.0-universal.dmg` (about 214 MiB), SHA-256 `584e597260980d697ebbb3ab933e9a742e6d66184186de6b776e172b2e69adb0`.

This DMG is an integrity-checked ad-hoc test artifact only. Its signature has no Team ID, Gatekeeper rejects it, and it has no stapled notarization ticket. Do not describe it as formally signed or notarized. Although the current host has a Developer ID Application identity, notarization credentials were not supplied to this build environment, so `dist:mac:signed` was not run.

### Pre-Publication Checks

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

Also verify that the Git index contains no accounts, Cookies, Tokens, device serials, AES keys/IVs, databases, capture logs, `.mdl` files, media, Frida Server, Apple credentials, or build caches. A formal Windows artifact still requires Windows x64 acceptance. An Intel artifact should receive final acceptance on Intel Mac hardware before publication.

`npm audit --omit=dev` must remain at zero. The current full `npm audit` still reports 16 high advisories in electron-builder's packaging-only transitive dependency chain; production runtime dependencies are not affected by those 16 findings. npm's forced remediation would downgrade electron-builder to an older major version and is not a safe fix. Build releases on a trusted isolated machine with the committed `package-lock.json` and `npm ci`, keep untrusted paths and filenames out of packaging inputs, and upgrade when upstream provides a compatible remediation.

## Python Subprocess Protocol

Electron launches:

```text
<validated-python> hongguo_grab.py
  --series-name <name>
  --start-ep 1
  --end-ep <total-episode-count>
  --output-dir <absolute-series-directory>
```

The working directory is the directory containing `hongguo_grab.py`. stdout contains one JSON object per line, while stderr carries debug output.

| `event` | Fields | Meaning |
|---|---|---|
| `init` | `device`, `total` | Environment ready and actual remaining episode count |
| `episode_start` | `ep` | Episode processing started |
| `progress` | `ep`, `percent` | Coarse episode progress |
| `episode_done` | `ep`, `file` | Episode completed |
| `episode_failed` | `ep`, `error` | Episode failed; later episodes continue |
| `log` | `level`, `message` | Displayable log event |
| `done` | `ok`, `failed` | Normal or partial-failure summary |

Exit codes are `0` for complete/no work, `2` for partial failure, `3` for an environment error, and `130` after a termination signal. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full compatibility contract.

## Troubleshooting

### Python is not found

Electron first checks an isolated environment, then checks system interpreters. On macOS:

```bash
which python3
python3 --version
```

On Windows, use `py -3 --version` or `python.exe --version`. When Python is missing, the app offers Homebrew installation on macOS or WinGet installation on Windows. You can also set `SHORTDRAMA_PYTHON` to an absolute interpreter path. If the corresponding package manager is unavailable, the app explicitly requests Homebrew or Microsoft App Installer.

### Python dependencies are missing

```bash
source .venv/bin/activate
python -m pip install -r python/requirements.txt
python -c "import frida, cryptography; print(frida.__version__)"
```

### `adb` is not found

The app searches Android Studio defaults, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `SHORTDRAMA_SDK_ROOT`, and platform-specific common paths. It can install missing SDK components after confirmation on both macOS and Windows.

### Device is `unauthorized`

Unlock the device and approve its USB debugging prompt. Revoke USB debugging authorizations on the device and reconnect if the prompt does not reappear.

### Device is `offline`

```bash
adb kill-server
adb start-server
adb devices -l
```

Do not start capture until the device returns to `device`.

### Multiple ADB devices are connected

Set `ANDROID_SERIAL=<serial>` before launch. Without it, automatic selection succeeds only when there is one unique emulator candidate.

### Frida versions do not match

The Python package and Android Frida Server must have the exact same version, and the server binary must match the device ABI. Recheck Python Frida and `ro.product.cpu.abi`.

### Frida Server is missing

When online, the app downloads the correct binary from the official Frida Release and caches it (180s socket timeout, multi-source retries, plus built-in GitHub mirror fallbacks). If GitHub is slow, set `SHORTDRAMA_GITHUB_PROXY` (for example `https://ghfast.top`) to prefer a proxy prefix. Offline, set `SHORTDRAMA_FRIDA_SERVER` to a local binary, push it to `/data/local/tmp/frida-server`, or place it at `python/frida-server-<abi>`. The binary remains absent from Git and packaged applications.

### Root is unavailable

The production workflow needs `adb root`, app-private SQLite access, Frida Server, and offline-file access. Use web-only mode when those permissions are unavailable.

### ffmpeg or ffprobe is missing

Web HLS/DASH uses system `ffmpeg`; the Android Python workflow uses system `ffmpeg` and `ffprobe`. When commands are missing, the app offers Homebrew installation on macOS or WinGet installation on Windows and revalidates them. `SHORTDRAMA_WEB_FFMPEG` can override the web executable.

### Playwright cannot find a browser

The app first tries Chrome, Edge, and development Playwright Chromium. If none can launch, it asks before installing Chrome through Homebrew on macOS or WinGet on Windows. A development checkout can also run `npm run fetch-browser`; packaged builds do not include Playwright Chromium by default.

### The Python component path is missing

Check `python/hongguo_grab.py` in development. In a package, check `Contents/Resources/python/` on macOS or `resources\python\` on Windows. The UI directory field or `HONGGUO_GRAB_DIR` can temporarily override the default.

### Development works but the packaged app cannot find Python files

Ensure `extraResources` remains in `electron-builder.js`, run `npm run pack`, and inspect the seven files under `<resources>/python/`, including both `start_avd.sh` and `start_avd.ps1`. Bundled scripts do not imply an embedded Python interpreter, Android system image, or ADBKeyBoard APK; those are checked and installed on demand.

### “Recovery navigation could not verify the title” appears

This is a recoverable navigation message after the player temporarily stops producing new decryption events. It does not invalidate completed episodes. SQLite mappings and later decryption events continue to verify the actual episode. A real missing episode is reported through `episode_failed`, exit code `2`, or a specific environment error.

### stdout contains non-JSON text

Do not use `print` for debugging in `hongguo_grab.py`. Human diagnostics and Frida JavaScript logs belong on stderr. Electron ignores malformed stdout lines as a fallback, but such output is still a protocol violation.

### A task cannot be cancelled cleanly

Electron requests termination of the Python child. On macOS, the verified `SIGTERM` protocol lets Python set its cancellation flag, remove partial output, restore device networking, release its lock, and exit with `130`. Node's child-termination semantics differ on Windows; the same call remains in place, but network restoration and lock release have not yet been proven in a real Windows App-capture run. Treat UI cancellation and device cleanup as separate acceptance checks on Windows.

### `.mdl` files are missing

Confirm the app offline download completed, the app package and storage paths remain compatible, and the device grants the required access. The script counts only files mapped to the current series.

### SQLite records do not map to files

The workflow reads `series_download_db`, its WAL, and `TTVideoEngine_download_database_v01`, then joins series video IDs, source IDs, and file paths. Schema changes, incomplete downloads, and stale app records can invalidate the mapping. Do not bypass this check because it prevents mislabeled episodes.

### An app upgrade breaks the hook or UI automation

The implementation depends on the app package, Activity, resource IDs, SQLite schema, `libttffmpeg.so` symbols, and player behavior. Revalidate a new app version on a controlled device; do not change the JSON protocol or AES parameters to hide a compatibility failure.

## Safety and Compliance

This project is **for technical study and research only**. Users must ensure their use is lawful and **bear full legal responsibility for it**; the author is not responsible for misuse and provides no warranty of any kind. See the disclaimer at the top of this document for the complete statement.

- Process only content you are authorized to access and download.
- Follow local law, platform terms, and copyright requirements.
- Do not use this project to bypass access controls without authorization or distribute unauthorized content.
- Root, hooking, and app-private file access should be used only on devices and applications you own or are explicitly authorized to test.
- Never commit account data, device serials, cookies, tokens, AES keys, SQLite snapshots, Frida capture logs, `.mdl` files, or decrypted media.
- Keep Electron configured with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`; new windows and renderer navigation are denied, and Playwright does not disable the browser sandbox.

ADBKeyBoard is fetched from pinned `senzhk/ADBKeyBoard` commit `4b513f3313b8392b316b37e9c08b0be2def79dda`. Upstream uses GPL-2.0 and the pinned APK SHA-256 is `e698adea5633135a067b038f9a0cf41baa4de09888713a81593fb2b9682cdc59`. That upstream APK is marked `application-debuggable` and signed with an Android Debug certificate. The project therefore does not commit or package it; it is downloaded only when Android capture is enabled and the device lacks the IME. As an input method it can receive typed content, so install it only on a dedicated controlled emulator, never a daily-use device that handles passwords or sensitive data.

## License

This project uses the MIT License. See [LICENSE](LICENSE). FFmpeg is installed separately through the system package manager and ADBKeyBoard is downloaded by the end user from its pinned upstream location; those independent components remain subject to their distribution licenses.

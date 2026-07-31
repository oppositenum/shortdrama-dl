# 发布流程

本文档记录仓库的自动发版机制、一次性 GitHub 仓库配置，以及发布前的本地检查清单。日常使用或二次开发不需要读这份文档；`README.md` 已经覆盖普通安装和使用。

## 两个工作流

- `.github/workflows/ci.yml` 在 Pull Request 和 `main` 推送时运行：在 `macos-15`（Apple Silicon）、`macos-15-intel`（Intel）和 `windows-2022` 上执行测试、生产依赖审计和语法检查，并分别做 macOS universal 与 Windows x64 打包冒烟验证。
- `.github/workflows/release.yml` 在 `main` 推送时运行 Release Please。普通功能提交只会创建或更新 Release PR；合并 Release PR 后，同一个工作流创建草稿 Release，并行构建正式签名公证的 macOS universal/arm64/x64 三个 DMG 和 Windows x64 NSIS，生成 `SHA256SUMS.txt`，全部验证通过后才把草稿公开。

所有第三方 Action 都固定到完整 commit SHA。CI 不读取签名 Secrets；正式构建 Job 使用名为 `release` 的 GitHub Environment。

## 自动版本规则

不要手工修改 `package.json`、`package-lock.json` 或 `.release-please-manifest.json` 的版本。提交信息使用 Conventional Commits：

| 提交前缀 | 版本变化 | 示例 |
|---|---|---|
| `fix:` | patch，例如 `1.0.0 -> 1.0.1` | `fix: recover after an advertisement` |
| `feat:` | minor，例如 `1.0.0 -> 1.1.0` | `feat: add Windows AVD setup` |
| `feat!:`、`fix!:` 或正文 `BREAKING CHANGE:` | major，例如 `1.0.0 -> 2.0.0` | `feat!: change task protocol` |
| `docs:`、`test:`、`chore:` 等 | 默认不单独触发版本发布 | `docs: clarify setup boundary` |

首次发布已经显式配置为 `1.0.0`：初始 `.release-please-manifest.json` 必须保持 `{}`，`release-please-config.json` 的 `initial-version` 为 `1.0.0`。Release PR 合并后，Release Please 同步更新 `package.json`、`package-lock.json`、`CHANGELOG.md` 和 manifest；`scripts/verify-release-version.js` 会在两个构建 Job 和最终发布 Job 再次拒绝任何版本或标签不一致。

正常发布流程：

1. 使用 Conventional Commit 信息合并普通代码到 `main`。
2. 等待 `release-please` 自动创建或更新 Release PR，审查其版本与 CHANGELOG。
3. 合并 Release PR。Release Please 创建 `v<version>` 标签和草稿 Release；由于 `GITHUB_TOKEN` 创建的标签不会触发另一个工作流，两个平台的构建和发布都在当前 Release 工作流内继续执行。
4. macOS 和 Windows Job 均成功后，`publish` Job 上传 DMG、NSIS 和 `SHA256SUMS.txt`，核对草稿、标签 SHA、版本及资产数量，然后公开 Release。

任一构建、签名、公证或校验失败时，Release 保持草稿状态，不会对外发布。修复临时 Runner/Apple 服务问题时，在 GitHub Actions 页面选择 **Re-run failed jobs**，这样会保留成功的 Release Please Job 输出并重跑失败链路。不要用 **Re-run all jobs** 代替；后者再次发现已有标签时可能不会重新输出 `release_created=true`。如果失败来自源码而非临时环境，应先决定是完成该草稿版本，还是删除草稿 Release 和对应标签后再走新的 Release PR，不能把另一个提交的安装包覆盖到旧标签。

## GitHub 仓库设置与 Secrets

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

## macOS 签名与公证

默认 `dist:mac*` 使用 `build/afterPack.js` 做 ad-hoc 签名，适合本机测试，不包含 Apple 公证，不应作为面向普通用户的最终安装包。公开发布使用 `dist:mac:signed`（及 `:arm64`/`:x64`），要求：

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
hdiutil verify "release/红果短剧下载器-<version>-universal.dmg"
```

实际输出目录可能随 electron-builder 版本变化，应以 `release/` 中生成的路径为准。electron-builder 提交并装订公证票据的是 DMG 内的 `.app`；DMG 本身再做 `hdiutil verify`，正式工作流还会挂载 DMG 并重新检查其中的 App。只有 `codesign`、Gatekeeper (`spctl`)、App 的 stapler 和 DMG 完整性全部通过，才可以宣称安装包内应用已签名并公证。

## 发布前本地检查清单

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

`npm audit --omit=dev` 必须为 0。发布构建应在可信、隔离的构建机上使用锁定的 `package-lock.json` 和 `npm ci`，不要让不受信任的路径或文件名进入打包输入。

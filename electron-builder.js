/**
 * electron-builder 打包配置（JS 形式，便于按环境切换「ad-hoc 签名」与「正式 Developer ID 签名 + 公证」）
 *
 * - 默认（npm run dist:mac）：ad-hoc 签名，无需 Apple 开发者账号，装机需清隔离属性。
 * - 正式签名（npm run dist:mac:signed，设置了 SIGN_MAC=1）：用 Developer ID 证书签名并公证。
 *   最终仍需 codesign、Gatekeeper 和 stapler 验证。需要：
 *     · 钥匙串里已安装「Developer ID Application」证书
 *     · 提供公证凭据环境变量（APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID，或 API Key）
 */

'use strict';

const SIGN_MAC = process.env.SIGN_MAC === '1';

/** 正式签名时追加的 mac 配置（公证要求 hardenedRuntime + entitlements） */
const macSigning = SIGN_MAC
  ? {
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.inherit.plist',
      notarize: true,
    }
  : {
      // afterPack 会做完整的 ad-hoc 签名；禁止 builder 再自动发现本机证书并改写内层组件。
      identity: null,
    };

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.oppositenum.shortdramadl',
  productName: '红果短剧下载器',
  artifactName: '${productName}-${version}-${arch}.${ext}',
  // 【绝不让 electron-builder 自己发布】。package.json 里有 repository 字段,builder 会据此
  // 自动配置 GitHub publisher,在 CI 里可能顺手把产物推上去——而 .github/workflows/release.yml
  // 走的是另一条【带校验】的路:先确认 Release 仍是草稿、校验 tag 指向、比对资产数量、生成
  // SHA256SUMS,最后才取消草稿。自动发布会绕开这一整套,所以在这里显式关死。
  publish: null,
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  afterPack: 'build/afterPack.js',
  files: [
    'main.js',
    'runtime-platform.js',
    'series-workflow.js',
    'ffmpeg-runner.js',
    'grab-protocol.js',
    'notify.js',
    'preload.js',
    'renderer/**/*',
    'package.json',
  ],
  extraResources: [
    {
      from: 'python',
      to: 'python',
      filter: [
        'hongguo_grab.py',
        'api_grab.py',
        'api_client.py',
        'metasec_offline.py',
        'spade_keys.py',
        'ttnet_signer.py',
        'decrypt_mdl.py',
        'mp4parse.py',
        'capture_final.js',
        'start_avd.sh',
        'start_avd.ps1',
        'requirements.txt',
        'sign_samples/gorgon_mid_key_oracle.json',
      ],
    },
  ],
  // 不再随包分发 Playwright Chromium（约 540MB）：运行时优先驱动系统已装的
  // Chrome / Edge（main.js 的 launchBrowser），包体从 ~886MB 降到 ~350MB
  win: {
    target: ['nsis'],
    artifactName: '${productName}-${version}-setup.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: '红果短剧下载器',
  },
  mac: {
    target: ['dmg'],
    category: 'public.app-category.utilities',
    ...macSigning,
  },
  dmg: {
    title: '红果短剧下载器',
  },
};

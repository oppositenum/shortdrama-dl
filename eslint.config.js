'use strict';

/**
 * ESLint 扁平配置。
 *
 * 定位是「挡住真会出事的写法」，不是统一代码风格：缩进、引号、分号这类交给
 * 人和 review，规则集里一条都不放，免得一次格式化把整个 git blame 洗掉。
 * 重点是那些实际踩过的坑——未定义的变量（CDN_ROUNDS 那次线上报错就是这类）、
 * 没 await 的 Promise、写了没用的变量。
 */
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'release/**',
      'ms-playwright/**',
      '.venv/**',
      'python/**',
      'docs/**',
    ],
  },
  {
    // Electron 主进程、构建脚本、测试：Node 环境
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2023,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // —— 真正的错误 ——
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrors: 'none', // catch (e) 里不用 e 是常见且无害的写法
      }],
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // —— 异步相关：这个项目里大量 spawn / fetch / Promise，最容易在这里出错 ——
      'require-atomic-updates': 'off', // 误报多（对 currentGrab 这类模块级状态）
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off', // 批量下载本来就要串行
      'no-promise-executor-return': 'error',

      // —— 可读性，但不碰格式 ——
      'no-var': 'error',
      // ignoreReadBeforeAssign：先 let 声明、闭包里先读、之后再赋值是合法写法
      // （测试里的 harness 就是这样自引用的），不该被要求改成 const。
      'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // page.evaluate(() => ...) 的回调是被序列化后送进浏览器执行的，
    // 里面的 window / document 指的是页面，不是主进程。规则看不出这层边界，
    // 只能在这里声明成只读全局；主进程自己误用 document 的话，运行时立刻就炸，
    // 不指望 lint 兜住。
    files: ['main.js', 'web-capture.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    // 渲染进程跑在浏览器里，window / document 是全局的
    files: ['renderer/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
  },
];

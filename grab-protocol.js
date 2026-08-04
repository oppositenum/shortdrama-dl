'use strict';

/**
 * grab-protocol.js —— Python 抓取子进程的事件协议
 *
 * `hongguo_grab.py`（App 抓取）和 `api_grab.py`（纯协议 / 本机签名）向 stdout 写
 * 同一套 JSON Lines 事件，stderr 是调试噪声。两边在 main.js 里各有一份几乎一样的
 * 读取代码，改一处忘另一处只是时间问题——这里把协议本身收成一份，两个入口只保留
 * 各自真正不同的部分（起哪个脚本、日志前缀、退出码怎么解释）。
 *
 * 这个模块不碰 Electron：读事件、拼日志文案都是纯逻辑，可以直接单测。
 */

/** stderr 里够得上"值得看一眼"的行；其余全是调试噪声，不往界面上倒。 */
const STDERR_NOISE = /(error|exception|traceback|failed|refused|not found)/i;

/**
 * 按行切 stdout，逐条交给 onEvent。
 *
 * 子进程的 stdout 是流：一次 data 可能是半行，也可能是好几行粘在一起，
 * 直接 JSON.parse(chunk) 必然出错。返回没处理完的残余，由调用方带进下一次。
 *
 * 单条事件的处理异常不影响后面的事件——一条日志格式没对上，不该把整轮抓取带停。
 *
 * @param {string} buffer 上次剩下的 + 这次新到的
 * @param {(event: object) => void} onEvent
 * @returns {string} 还没凑成整行的残余
 */
function consumeJsonLines(buffer, onEvent) {
  let rest = String(buffer);
  let nl;
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 契约保证 stdout 纯净，这里只是防脏字节
    }
    try {
      onEvent(event);
    } catch {
      /* 单条事件处理异常不影响后续 */
    }
  }
  return rest;
}

/**
 * 把一条事件翻译成要对界面做的动作。返回的是描述，不直接调 IPC，
 * 这样事件语义可以脱离 Electron 单测。
 *
 * @param {object} event   Python 发来的事件
 * @param {object} ctx     { label 模式名（"App 抓取"/"本机签名"）, logTag 日志前缀,
 *                           total 总集数, showDevice 就绪行里报不报设备,
 *                           fallbackTotal 事件里没给待抓数时用它 }
 * @returns {{logs: Array<{message: string, level: string}>, status?: string,
 *            episode?: {current: number, total: number},
 *            progress?: {percent: number}, okDelta?: number,
 *            ok?: number, failed?: number[], initTotal?: number}}
 */
function describeGrabEvent(event, { label, logTag, total, showDevice = false, fallbackTotal = 0 }) {
  const out = { logs: [] };
  switch (event && event.event) {
    case 'init': {
      out.initTotal = event.total != null ? Number(event.total) : null;
      // Python 没报待抓数时退回调用方按区间算出来的数，别在日志里写个问号
      const pending = out.initTotal ?? fallbackTotal;
      out.logs.push({
        level: 'info',
        message: showDevice
          ? `${label}就绪：设备 ${event.device || '?'}，本次待抓 ${pending} 集`
          : `${label}就绪：本次待抓 ${pending} 集`,
      });
    }
      break;
    case 'episode_start':
      out.episode = { current: event.ep, total };
      out.status = `${label} 第 ${event.ep}/${total} 集…`;
      out.progress = { percent: 0 };
      break;
    case 'progress':
      out.progress = { percent: Math.max(0, Math.min(100, Number(event.percent) || 0)) };
      break;
    case 'episode_done':
      out.okDelta = 1;
      out.progress = { percent: 100 };
      out.logs.push({
        level: 'success',
        message: `${label} 第 ${event.ep} 集完成（${event.file || ''}）`,
      });
      break;
    case 'episode_failed':
      out.logs.push({
        level: 'error',
        message: `${label} 第 ${event.ep} 集失败：${event.error || ''}`,
      });
      break;
    case 'log':
      out.logs.push({
        level: event.level || 'info',
        message: `[${logTag}] ${event.message || ''}`,
      });
      break;
    case 'done':
      if (typeof event.ok === 'number') out.ok = event.ok;
      if (Array.isArray(event.failed)) out.failed = event.failed;
      break;
    default:
      break;
  }
  return out;
}

/** stderr 里挑出值得报的行；extra 让纯协议那边把 110001 也算进来。 */
function pickStderrLines(chunk, extra = null) {
  const out = [];
  for (const raw of String(chunk).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (STDERR_NOISE.test(line) || (extra && extra.test(line))) out.push(line);
  }
  return out;
}

module.exports = {
  STDERR_NOISE,
  consumeJsonLines,
  describeGrabEvent,
  pickStderrLines,
};

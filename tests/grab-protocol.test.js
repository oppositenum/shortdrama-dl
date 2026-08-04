'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const {
  consumeJsonLines,
  describeGrabEvent,
  pickStderrLines,
} = require(path.join(projectRoot, 'grab-protocol.js'));

function collect(chunks) {
  const events = [];
  let rest = '';
  for (const chunk of chunks) rest = consumeJsonLines(rest + chunk, (e) => events.push(e));
  return { events, rest };
}

// 子进程的 stdout 是流，一次 data 事件既可能是半行也可能是好几行粘在一起。
test('半行、粘包、空行都能正确切出事件', () => {
  const { events, rest } = collect([
    '{"event":"init","total":3}\n{"event":"episode_start","ep":1}\n',
    '\n{"event":"episode_do',
    'ne","ep":1,"file":"第01集.mp4"}\n{"event":"progress"',
  ]);
  assert.deepEqual(events.map((e) => e.event), ['init', 'episode_start', 'episode_done']);
  assert.equal(events[2].file, '第01集.mp4');
  assert.equal(rest, '{"event":"progress"', '没凑成整行的残余要留给下一次');
});

test('脏字节不影响后面的事件', () => {
  const { events } = collect(['这不是 JSON\n{"event":"done","ok":7}\n']);
  assert.deepEqual(events, [{ event: 'done', ok: 7 }]);
});

// 一条事件处理出错，不该把整轮抓取带停。
test('单条事件的处理异常被隔离', () => {
  const seen = [];
  let rest = '';
  rest = consumeJsonLines('{"event":"a"}\n{"event":"b"}\n', (e) => {
    seen.push(e.event);
    if (e.event === 'a') throw new Error('boom');
  });
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(rest, '');
});

const CTX = { label: '本机签', logTag: 'API', total: 82 };

test('episode_start 同时给出集数、状态栏文案和进度归零', () => {
  const act = describeGrabEvent({ event: 'episode_start', ep: 6 }, CTX);
  assert.deepEqual(act.episode, { current: 6, total: 82 });
  assert.equal(act.status, '本机签 第 6/82 集…');
  assert.deepEqual(act.progress, { percent: 0 });
});

test('进度百分比夹在 0–100，脏值当 0', () => {
  const pct = (v) => describeGrabEvent({ event: 'progress', percent: v }, CTX).progress.percent;
  assert.equal(pct(42.5), 42.5);
  assert.equal(pct(-1), 0);
  assert.equal(pct(1000), 100);
  assert.equal(pct('abc'), 0);
  assert.equal(pct(undefined), 0);
});

test('episode_done 记一集、进度打满；episode_failed 是 error 级', () => {
  const done = describeGrabEvent({ event: 'episode_done', ep: 6, file: '第06集.mp4' }, CTX);
  assert.equal(done.okDelta, 1);
  assert.deepEqual(done.progress, { percent: 100 });
  assert.equal(done.logs[0].level, 'success');
  assert.match(done.logs[0].message, /第 6 集完成（第06集\.mp4）/);

  const failed = describeGrabEvent({ event: 'episode_failed', ep: 6, error: 'cdn timeout' }, CTX);
  assert.equal(failed.logs[0].level, 'error');
  assert.match(failed.logs[0].message, /第 6 集失败：cdn timeout/);
});

// done.ok 是本轮新生成的数量，会覆盖累加值；失败集号列表原样带出。
test('done 覆盖计数并带出失败集号', () => {
  const act = describeGrabEvent({ event: 'done', ok: 77, failed: [98] }, CTX);
  assert.equal(act.ok, 77);
  assert.deepEqual(act.failed, [98]);
});

test('只有 App 抓取的就绪行报设备', () => {
  const app = describeGrabEvent(
    { event: 'init', total: 5, device: 'emulator-5554' },
    { label: 'App 抓取', logTag: 'App', total: 5, showDevice: true }
  );
  assert.match(app.logs[0].message, /设备 emulator-5554，本次待抓 5 集/);

  const api = describeGrabEvent({ event: 'init', total: 5 }, CTX);
  assert.equal(api.logs[0].message, '本机签就绪：本次待抓 5 集');
  assert.equal(api.initTotal, 5);
});

// Python 偶尔不报待抓数（比如全部已存在时），日志里写个问号没意义。
test('就绪行在事件缺 total 时退回调用方按区间算的数', () => {
  const act = describeGrabEvent({ event: 'init' }, { ...CTX, fallbackTotal: 77 });
  assert.equal(act.logs[0].message, '本机签就绪：本次待抓 77 集');
  assert.equal(act.initTotal, null);
});

test('Python 的 log 事件带上来源前缀，级别照搬', () => {
  const act = describeGrabEvent({ event: 'log', level: 'warn', message: '风控 110001' }, CTX);
  assert.deepEqual(act.logs, [{ level: 'warn', message: '[API] 风控 110001' }]);
  const dflt = describeGrabEvent({ event: 'log', message: 'x' }, CTX);
  assert.equal(dflt.logs[0].level, 'info');
});

test('未知事件和空事件安全忽略', () => {
  for (const ev of [{ event: 'whatever' }, {}, null, undefined]) {
    const act = describeGrabEvent(ev, CTX);
    assert.deepEqual(act.logs, []);
    assert.equal(act.status, undefined);
  }
});

// stderr 全量往界面倒会把日志淹掉，只挑真正像错误的行。
test('stderr 只放行像错误的那些行', () => {
  const lines = pickStderrLines(
    ['[dbg] ep1 rung=1080p', 'Traceback (most recent call last):', '', '  ok', 'connection refused']
      .join('\n')
  );
  assert.deepEqual(lines, ['Traceback (most recent call last):', 'connection refused']);
});

// 纯协议的致命错误常常只带一个业务码，默认噪声正则里没有 110001。
test('额外模式让纯协议把 110001 也算作值得报的行', () => {
  const raw = '[ep16] code=110001 message=未知异常';
  assert.deepEqual(pickStderrLines(raw), []);
  assert.deepEqual(pickStderrLines(raw, /110001/), [raw]);
});

// 两个抓取入口共用这套协议——重复实现过一次，改一处忘另一处只是时间问题。
test('两个抓取入口都走同一个 runner，没有各自再实现一遍', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const appFn = src.slice(src.indexOf('function grabWithApp('), src.indexOf('function grabWithApi('));
  const apiFn = src.slice(src.indexOf('function grabWithApi('), src.indexOf('function killGrab('));
  for (const [name, fn] of [['grabWithApp', appFn], ['grabWithApi', apiFn]]) {
    assert.match(fn, /return runGrabChild\(child, \{/, `${name} 应该交给共用 runner`);
    assert.equal(/stdoutBuf|JSON\.parse\(line\)/.test(fn), false, `${name} 里不该再有自己的行解析`);
    assert.equal(/switch \(ev\.event\)/.test(fn), false, `${name} 里不该再有自己的事件分发`);
  }
  // 取消语义留在 runner 里，两边一致
  assert.match(src, /if \(code === 130 \|\| isCanceled \|\| signal === 'SIGTERM'\)/);
});

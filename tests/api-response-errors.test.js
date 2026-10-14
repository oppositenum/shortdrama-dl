'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function runPython(probe) {
  const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-B', '-c', probe], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, SHORTDRAMA_PROJECT_ROOT: root, SHORTDRAMA_DEVICE_SIGN_AUTO: '0' },
    });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('API diagnoses bad responses on each host, retries and preserves valid JSON', () => {
  runPython(String.raw`
import sys, os, json, urllib.error
sys.path.insert(0, os.path.join(os.environ['SHORTDRAMA_PROJECT_ROOT'], 'python'))
import api_client as m
m.time.sleep = lambda _: None

class Resp:
    status = 200
    headers = {'Content-Type': 'application/json'}
    def __init__(self, raw): self.raw = raw
    def read(self): return self.raw
    def __enter__(self): return self
    def __exit__(self, *args): return False

class OfflineSigner:
    def sign_headers(self, url, body): return {'X-Gorgon': 'REQUEST_SECRET'}
    def post_json(self, *args): raise AssertionError('should sign headers directly')

for signer in (None, OfflineSigner()):
    client = m.HongguoApiClient(signer=signer, offline_sign=False)
    client.hosts = ['first.example', 'second.example', 'third.example']
    calls = []
    def fail(req, timeout=None):
        calls.append(req.full_url)
        if 'first.example' in req.full_url: return Resp(b'')
        if 'second.example' in req.full_url: return Resp(b'<html>RESPONSE_SECRET</html>')
        raise urllib.error.URLError('https://secret.example/?token=URL_SECRET')
    m.urllib.request.urlopen = fail
    try:
        client.post_json('/detail', {}, retries=2)
        raise AssertionError('expected failure')
    except m.ApiError as e:
        msg = str(e)
        assert '接口返回空正文' in msg and 'HTTP 200' in msg and '响应长度=0' in msg, msg
        assert 'Content-Type=application/json' in msg and '接口返回非 JSON 内容' in msg, msg
        assert all(host in msg for host in client.hosts), msg
        assert msg.count('失败 2 次') == 3, msg
        assert all(secret not in msg for secret in ('REQUEST_SECRET', 'RESPONSE_SECRET', 'URL_SECRET')), msg
    assert len(calls) == 6, calls

    success = {'code': 0, 'data': {'video_data': {'video_list': [{'vid': '123'}]}}}
    responses = iter([b'', json.dumps(success).encode()])
    m.urllib.request.urlopen = lambda *args, **kwargs: Resp(next(responses))
    assert client.video_detail('123') == success['data']['video_data']

    for raw, expected in [(b'  \n', '空正文'), (b'[]', '不是对象'), (b'\xff', '非 JSON')]:
        m.urllib.request.urlopen = lambda *args, **kwargs: Resp(raw)
        try:
            client.post_json('/detail', {}, retries=1)
            raise AssertionError('expected failure')
        except m.ApiError as e:
            assert expected in str(e), e
`);
});

test('grab reports API failures separately from environment failures without downloading', () => {
  runPython(String.raw`
import os, sys, tempfile, contextlib, io
sys.path.insert(0, os.path.join(os.environ['SHORTDRAMA_PROJECT_ROOT'], 'python'))
import api_grab as m

class Client:
    def __init__(self, **kwargs): pass
    def video_detail(self, series): raise m.ApiError('接口返回空正文（HTTP 200, 响应长度=0 字节）')

m.HongguoApiClient = Client
with tempfile.TemporaryDirectory() as out:
    sys.argv = ['api_grab.py', '--series-id', '123', '--output-dir', out, '--no-offline-sign']
    logs = io.StringIO()
    with contextlib.redirect_stdout(logs):
        assert m.main() == 5
    assert '拉取剧详情失败' in logs.getvalue()
    assert os.listdir(out) == []

    def environment_failure(self, series): raise RuntimeError('local dependency unavailable')
    Client.video_detail = environment_failure
    with contextlib.redirect_stdout(io.StringIO()):
        assert m.main() == 3
`);
});

test('offline UI explains API failure without blaming the signing environment', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const start = source.indexOf('function grabWithApi(');
  const end = source.indexOf('/** 终止当前 App 抓取子进程', start);
  const context = {
    process: { env: {} }, API_GRAB_SCRIPT: 'api_grab.py',
    setStatus() {}, log() {}, spawn() { return {}; },
    runGrabChild(_child, options) { return options.explainExit; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const explain = context.grabWithApi({
    seriesId: '123', startEp: 1, endEp: 1, seriesDir: '/unused',
    grabDir: '/unused', pythonBin: 'python', grabEnv: {}, signMode: 'offline',
  });
  assert.match(explain(5), /视频详情 API.*未能获取分集列表/);
  assert.doesNotMatch(explain(5), /环境或参数不可用/);
  assert.match(explain(3), /环境或参数不可用/);
  assert.match(explain(4), /110001/);
});

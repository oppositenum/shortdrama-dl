'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  ffmpegArgs,
  safeUrlForLog,
  sanitizeDiagnostic,
  startFfmpegDownload,
} = require('../ffmpeg-runner');

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

test('FFmpeg arguments preserve headers without invoking a shell', () => {
  const args = ffmpegArgs({
    media: { type: 'hls', url: 'https://cdn.example/video.m3u8?token=secret' },
    outputPath: '/tmp/episode.mp4',
    headers: 'Cookie: session=secret\r\n',
    userAgent: 'test-agent',
  });
  assert.deepEqual(args.slice(0, 6), [
    '-hide_banner', '-nostdin', '-headers', 'Cookie: session=secret\r\n', '-user_agent', 'test-agent',
  ]);
  assert.ok(args.includes('aac_adtstoasc'));
  assert.equal(args.at(-1), '/tmp/episode.mp4');
});

test('media URLs and FFmpeg diagnostics redact query credentials', () => {
  assert.equal(
    safeUrlForLog('https://cdn.example/path/video.m3u8?token=secret&expires=1'),
    'https://cdn.example/path/video.m3u8?<redacted>'
  );
  const diagnostic = sanitizeDiagnostic(
    'HTTP error https://cdn.example/path/video.m3u8?token=secret failed'
  );
  assert.match(diagnostic, /\?<redacted>/);
  assert.doesNotMatch(diagnostic, /secret/);
});

test('FFmpeg runner emits parsed progress and resolves successful output', async () => {
  const child = fakeChild();
  const progress = [];
  const durations = [];
  const task = startFfmpegDownload({
    ffmpegPath: '/usr/local/bin/ffmpeg',
    media: { type: 'dash', url: 'https://cdn.example/video.mpd' },
    outputPath: '/tmp/episode.mp4',
    headers: 'Referer: https://example.test\r\n',
    userAgent: 'test-agent',
    spawnImpl: (command, args, options) => {
      assert.equal(command, '/usr/local/bin/ffmpeg');
      assert.equal(options.windowsHide, true);
      assert.ok(args.includes('pipe:2'));
      return child;
    },
    onDuration: (value) => durations.push(value),
    onProgress: (value) => progress.push(value),
  });

  child.stderr.write('Duration: 00:00:10.00\n');
  child.stderr.write('out_time=00:00:05.00\n');
  child.emit('close', 0, null);

  assert.equal(await task.promise, '/tmp/episode.mp4');
  assert.deepEqual(durations, ['00:00:10.00']);
  assert.equal(progress[0].percent, 50);
  assert.equal(progress.at(-1).percent, 100);
});

test('FFmpeg runner reports only redacted bounded diagnostics on failure', async () => {
  const child = fakeChild();
  const task = startFfmpegDownload({
    ffmpegPath: 'ffmpeg',
    media: { type: 'dash', url: 'https://cdn.example/video.mpd' },
    outputPath: '/tmp/episode.mp4',
    headers: '',
    userAgent: 'test-agent',
    spawnImpl: () => child,
  });
  child.stderr.write('HTTP error https://cdn.example/video.mpd?token=secret failed\n');
  child.emit('close', 1, null);
  await assert.rejects(task.promise, (error) => {
    assert.match(error.message, /\?<redacted>/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

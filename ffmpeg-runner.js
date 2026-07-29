'use strict';

const { spawn } = require('node:child_process');

const DIAGNOSTIC_PATTERN =
  /(error|failed|invalid|forbidden|denied|whitelist|not on whitelist|protocol '|server returned|http error|unauthorized|401|403|404|timed out|timeout|connection reset|handshake|unable to|no such)/i;

function safeUrlForLog(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.origin}${parsed.pathname}${parsed.search ? '?<redacted>' : ''}`;
  } catch {
    return '<invalid-url>';
  }
}

function sanitizeDiagnostic(line) {
  return String(line).replace(/https?:\/\/[^\s'"\]]+/gi, (url) => safeUrlForLog(url));
}

function hmsToSeconds(hms) {
  if (!hms || typeof hms !== 'string') return 0;
  const parts = hms.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  const [h = 0, m = 0, s = 0] = parts;
  return h * 3600 + m * 60 + s;
}

function ffmpegArgs({ media, outputPath, headers, userAgent }) {
  const outputOptions = ['-c', 'copy', '-movflags', '+faststart'];
  if (media.type === 'hls') outputOptions.push('-bsf:a', 'aac_adtstoasc');

  return [
    '-hide_banner',
    '-nostdin',
    '-headers', headers,
    '-user_agent', userAgent,
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data,httpproxy',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',
    '-i', media.url,
    ...outputOptions,
    '-progress', 'pipe:2',
    '-nostats',
    '-y',
    outputPath,
  ];
}

function startFfmpegDownload(options) {
  const {
    ffmpegPath,
    media,
    outputPath,
    headers,
    userAgent,
    isCanceled = () => false,
    onDuration = () => {},
    onProgress = () => {},
    onDiagnostic = () => {},
    spawnImpl = spawn,
  } = options;
  const args = ffmpegArgs({ media, outputPath, headers, userAgent });
  const child = spawnImpl(ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  const promise = new Promise((resolve, reject) => {
    let totalSeconds = 0;
    let stderrBuffer = '';
    const diagnostics = [];
    let settled = false;

    const handleLine = (rawLine) => {
      const line = sanitizeDiagnostic(rawLine.trim());
      if (!line) return;

      const duration = line.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/i);
      if (duration && totalSeconds === 0) {
        totalSeconds = hmsToSeconds(duration[1]);
        if (totalSeconds > 0) onDuration(duration[1]);
      }

      const time = line.match(/^(?:out_time|time)=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/i);
      if (time) {
        const percent = totalSeconds > 0
          ? Math.max(0, Math.min(100, (hmsToSeconds(time[1]) / totalSeconds) * 100))
          : 0;
        onProgress({ percent, timemark: time[1], speed: '' });
      }

      if (/^(?:speed|bitrate)=/i.test(line)) return;
      if (DIAGNOSTIC_PATTERN.test(line)) {
        diagnostics.push(line);
        if (diagnostics.length > 5) diagnostics.shift();
        onDiagnostic(line);
      }
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(isCanceled() ? new Error('__CANCELED__') : error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (stderrBuffer) handleLine(stderrBuffer);
      if (isCanceled() || signal === 'SIGKILL') {
        reject(new Error('__CANCELED__'));
      } else if (code === 0) {
        onProgress({ percent: 100, timemark: '', speed: '' });
        resolve(outputPath);
      } else {
        const detail = diagnostics.length ? `：${diagnostics.join(' | ')}` : '';
        reject(new Error(`ffmpeg 退出码 ${code == null ? 'unknown' : code}${detail}`));
      }
    });
  });

  return { args, child, promise };
}

module.exports = { ffmpegArgs, safeUrlForLog, sanitizeDiagnostic, startFfmpegDownload };

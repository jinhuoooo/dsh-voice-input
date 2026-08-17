/**
 * dsh-voice-input host entry (v2.1.0)
 *
 * Accurate voice-to-text for DSH, powered by Whisper.
 *
 * Architecture:
 *   Client (MediaRecorder) → POST /dsh-voice-input/transcribe → Server
 *   Server tries (in order):
 *     1. Cloud ASR API (Groq / SiliconFlow / OpenAI — OpenAI-compatible)
 *     2. Local Python faster-whisper (persistent server: model loaded ONCE,
 *        reused across requests → fast + low memory; falls back to a
 *        one-shot process if the server cannot start)
 *   Returns { text, source }
 *
 * Config: see config.example.json
 * Without config.json, defaults to local Whisper (small model, Chinese).
 */

export const name = 'dsh-voice-input';

import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execSync, execFileSync } from 'node:child_process';

/* ── Config ──────────────────────────────────────────────────── */

const DEFAULT_TIMEOUT_MS = 120000; // 2 min (first model download can be slow)
const DEFAULT_LOCAL_MODEL = 'small'; // v2.1: small = fast + low RAM (~500MB); use medium for max accuracy
const DEFAULT_LANGUAGE = 'zh';

const CONFIG_CANDIDATES = [
  fileURLToPath(new URL('../config.json', import.meta.url)),
  fileURLToPath(new URL('../../plugins/dsh-voice-input/config.json', import.meta.url)),
];

const PRESET_PROVIDERS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
    display: 'Groq Whisper Large v3 (免费，推荐)',
    note: '去 https://console.groq.com 注册免费获取 API Key',
  },
  siliconflow: {
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    display: 'SiliconFlow SenseVoice (免费额度)',
    note: '去 https://siliconflow.cn 注册免费获取 API Key',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: 'whisper-1',
    display: 'OpenAI Whisper',
  },
};

function loadJsonConfig() {
  for (const p of CONFIG_CANDIDATES) {
    try {
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {
      // broken candidate → try next
    }
  }
  return {};
}

function resolveApiKey(api) {
  if (typeof api.apiKey === 'string' && api.apiKey.trim()) return api.apiKey.trim();
  if (typeof api.apiKeyEnv === 'string' && api.apiKeyEnv.trim()) {
    const fromEnv = process.env[api.apiKeyEnv.trim()];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  }
  return '';
}

/**
 * Resolve the effective ASR config.
 * Returns { provider, baseURL, model, apiKey, language, timeoutMs } for cloud,
 * or { provider: 'local', model, language, device, computeType } for local.
 */
function resolveAsrConfig(config) {
  const api = (config && typeof config.api === 'object' && config.api) || {};
  if (api.enabled === false) return { provider: 'local' };

  const provider = typeof api.provider === 'string' ? api.provider.toLowerCase() : '';

  // Cloud providers
  if (provider && provider !== 'local' && PRESET_PROVIDERS[provider]) {
    const preset = PRESET_PROVIDERS[provider];
    const apiKey = resolveApiKey(api);
    if (apiKey) {
      return {
        provider,
        baseURL: api.baseURL?.trim()?.replace(/\/+$/, '') || preset.baseURL,
        model: api.model?.trim() || preset.model,
        apiKey,
        language: api.language || DEFAULT_LANGUAGE,
        timeoutMs: Number(api.timeoutMs) > 0 ? Number(api.timeoutMs) : 60000,
      };
    }
    // API key missing → fall through to local
  }

  // Custom OpenAI-compatible provider
  if (provider === 'custom' && api.baseURL && resolveApiKey(api)) {
    return {
      provider: 'custom',
      baseURL: api.baseURL.trim().replace(/\/+$/, ''),
      model: api.model || 'whisper-1',
      apiKey: resolveApiKey(api),
      language: api.language || DEFAULT_LANGUAGE,
      timeoutMs: Number(api.timeoutMs) > 0 ? Number(api.timeoutMs) : 60000,
    };
  }

  // Default: local Whisper
  const local = (config && typeof config.local === 'object' && config.local) || {};
  return {
    provider: 'local',
    model: local.model || DEFAULT_LOCAL_MODEL,
    language: local.language || DEFAULT_LANGUAGE,
    device: local.device || 'cpu',
    computeType: local.computeType || 'int8',
    timeoutMs: Number(local.timeoutMs) > 0 ? Number(local.timeoutMs) : DEFAULT_TIMEOUT_MS,
  };
}

/* ── Python detection ────────────────────────────────────────── */

const pythonPathCache = {};

function pythonHasModule(pythonPath, moduleName) {
  try {
    execSync(
      `"${pythonPath}" -c "import ${moduleName}"`,
      { encoding: 'utf8', timeout: 8000, stdio: 'pipe' }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a usable Python interpreter.
 * @param {string} moduleName - required module; we prefer an interpreter that
 *   already has it (e.g. faster_whisper for transcribe, sounddevice for record),
 *   otherwise fall back to any Python 3.9+ (scripts auto-install the module).
 */
function findPython(moduleName = 'faster_whisper') {
  if (pythonPathCache[moduleName]) return pythonPathCache[moduleName];

  // Managed interpreter is pre-installed with faster-whisper + sounddevice;
  // keep it near the top so we don't pick a bare system Python 3.8.
  const candidates = [
    process.env.DSH_PYTHON_PATH,
    'C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe',
    'python',
    'python3',
    'C:\\Program Files\\python\\python.exe',
  ].filter(Boolean);

  const versionOf = (candidate) => {
    try {
      return execSync(`"${candidate}" --version`, {
        encoding: 'utf8', timeout: 5000, stdio: 'pipe',
      });
    } catch {
      return '';
    }
  };

  // Pass 1: an interpreter that already has the required module (fast path).
  for (const candidate of candidates) {
    const ver = versionOf(candidate);
    if (!/Python 3\./.test(ver)) continue;
    if (pythonHasModule(candidate, moduleName)) {
      pythonPathCache[moduleName] = candidate;
      return candidate;
    }
  }

  // Pass 2: any Python 3.9+ (the .py scripts will auto-install the module).
  for (const candidate of candidates) {
    const ver = versionOf(candidate);
    const m = ver.match(/Python (\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 9))) {
      pythonPathCache[moduleName] = candidate;
      return candidate;
    }
  }
  return null;
}

const __scriptDir = dirname(fileURLToPath(import.meta.url));
// Check both node_modules and source plugins dir (npm file: may not sync .py files)
const TRANSCRIBE_PY_CANDIDATES = [
  join(__scriptDir, 'transcribe.py'),
  join(__scriptDir, '../../plugins/dsh-voice-input/lib/transcribe.py'),
];
const TRANSCRIBE_PY = TRANSCRIBE_PY_CANDIDATES.find((p) => existsSync(p)) || TRANSCRIBE_PY_CANDIDATES[0];

// record.py lives next to transcribe.py (check both install locations)
const RECORD_PY_CANDIDATES = [
  join(__scriptDir, 'record.py'),
  join(__scriptDir, '../../plugins/dsh-voice-input/lib/record.py'),
];
const RECORD_PY = RECORD_PY_CANDIDATES.find((p) => existsSync(p)) || RECORD_PY_CANDIDATES[0];

// server.py = persistent Whisper process (model loaded once, reused)
const SERVER_PY_CANDIDATES = [
  join(__scriptDir, 'server.py'),
  join(__scriptDir, '../../plugins/dsh-voice-input/lib/server.py'),
];
const SERVER_PY = SERVER_PY_CANDIDATES.find((p) => existsSync(p)) || SERVER_PY_CANDIDATES[0];

/* ── System-level recording (bypasses webview mic permission) ── */

let activeRecording = null; // { proc, outPath, stopSignal, stderr, level }

function cleanupRecordFiles(record) {
  try { if (record.stopSignal && existsSync(record.stopSignal)) unlinkSync(record.stopSignal); } catch {}
  try { if (record.outPath && existsSync(record.outPath)) rmSync(record.outPath, { force: true }); } catch {}
}

/**
 * Start recording from the OS microphone via Python (sounddevice).
 * Resolves when the recorder process is confirmed running.
 */
function startSystemRecording() {
  return new Promise((resolve, reject) => {
    const pythonPath = findPython('sounddevice');
    if (!pythonPath) {
      reject(new Error('未找到 Python，无法录音'));
      return;
    }

    // If a previous recording was never stopped, ask it to stop first.
    if (activeRecording) {
      try { writeFileSync(activeRecording.stopSignal, 'stop'); } catch {}
    }

    const id = Date.now() + '-' + Math.random().toString(16).slice(2, 8);
    const outPath = join(tmpdir(), `dsh-voice-${id}.wav`);
    const stopSignal = outPath + '.stop';

    let stderr = '';
    let lastLevel = 0;
    const proc = spawn(pythonPath, [
      RECORD_PY,
      '--output', outPath,
      '--max-duration', '60',
      '--stop-signal', stopSignal,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    proc.stderr.on('data', (d) => {
      const chunk = d.toString('utf8');
      stderr += chunk;
      // Record.py emits LVL:<0-100> at ~10Hz for the live mic-level animation
      const m = /LVL:(\d+)/.exec(chunk);
      if (m) lastLevel = Number(m[1]);
    });

    const record = { proc, outPath, stopSignal, stderr: () => stderr, level: () => lastLevel };
    activeRecording = record;

    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve({ ok: true });
    };

    proc.on('error', (err) => {
      if (activeRecording === record) activeRecording = null;
      cleanupRecordFiles(record);
      done(new Error(`Python 启动失败: ${err.message}`));
    });

    proc.on('close', (code) => {
      // Only handle early exits (e.g. no mic device). Normal stop is handled
      // by stopSystemRecording() which nulls activeRecording first.
      if (settled) return;
      if (activeRecording === record) activeRecording = null;
      const detail = stderr.trim().split('\n').pop() || `exit code ${code}`;
      cleanupRecordFiles(record);
      done(new Error(detail));
    });

    // Give the process a moment to fail fast; if still running → success.
    setTimeout(() => {
      if (proc.exitCode === null) done();
    }, 800);
  });
}

/**
 * Stop the active recording, return the audio buffer (16kHz mono WAV).
 * The temp files are cleaned up by the caller after transcription.
 */
function stopSystemRecording() {
  return new Promise((resolve, reject) => {
    const record = activeRecording;
    if (!record) {
      reject(new Error('当前没有正在进行的录音'));
      return;
    }
    activeRecording = null;

    // Signal the recorder to finish
    try { writeFileSync(record.stopSignal, 'stop'); } catch {}

    const waitExit = new Promise((res) => {
      if (record.proc.exitCode !== null) { res(); return; }
      const timer = setTimeout(() => {
        try { record.proc.kill('SIGKILL'); } catch {}
        res();
      }, 15000);
      record.proc.on('close', () => { clearTimeout(timer); res(); });
    });

    waitExit.then(async () => {
      try { if (existsSync(record.stopSignal)) unlinkSync(record.stopSignal); } catch {}
      try {
        const buf = await readFile(record.outPath);
        if (!buf || buf.length < 200) {
          throw new Error('录音数据为空');
        }
        // Rough duration from WAV body: 44-byte header, 16kHz, 16-bit mono
        const duration = (buf.length - 44) / 16000 / 2;
        if (duration < 0.25) {
          throw new Error('录音太短');
        }
        // Remove the temp WAV — buffer is already in memory
        try { rmSync(record.outPath, { force: true }); } catch {}
        resolve(buf);
      } catch (err) {
        const detail = record.stderr().trim().split('\n').pop() || err.message;
        try { rmSync(record.outPath, { force: true }); } catch {}
        reject(new Error(err.message === '录音太短' ? '录音太短，请稍长一点再说' : `录音失败: ${detail}`));
      }
    });
  });
}

/**
 * Cancel the active recording: ask the recorder to stop gracefully, then
 * force-kill after a short grace period. The captured audio is discarded —
 * unlike stopSystemRecording() this does NOT transcribe.
 */
function cancelSystemRecording() {
  return new Promise((resolve, reject) => {
    const record = activeRecording;
    if (!record) {
      resolve({ canceled: false });
      return;
    }
    activeRecording = null;

    // 1) Graceful stop: record.py polls this file every 100ms and exits fast
    try { writeFileSync(record.stopSignal, 'stop'); } catch {}

    // 2) Force-kill fallback (Windows SIGKILL via child.kill is unreliable
    //    for python.exe — use taskkill to guarantee termination)
    const forceKill = () => {
      try {
        execFileSync('taskkill', ['/PID', String(record.proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 5000,
        });
      } catch { /* process already gone */ }
    };

    const killTimer = setTimeout(forceKill, 1500);
    record.proc.on('close', () => clearTimeout(killTimer));

    // 3) Clean up temp files once the process is gone
    record.proc.on('close', () => {
      cleanupRecordFiles(record);
      resolve({ canceled: true });
    });
    // If the process was already dead, resolve now
    if (record.proc.exitCode !== null) {
      clearTimeout(killTimer);
      cleanupRecordFiles(record);
      resolve({ canceled: true });
    }
  });
}

/* ── Local Whisper transcription ─────────────────────────────── */

/**
 * Persistent Whisper server.
 * Loads the model once; subsequent transcriptions reuse the process.
 * Protocol: line-based JSON over stdin/stdout (see server.py).
 */
let whisperServer = null; // { proc, dead, pending }

function whisperEnv(asrConfig) {
  return {
    ...process.env,
    DSH_WHISPER_MODEL: asrConfig.model || DEFAULT_LOCAL_MODEL,
    DSH_WHISPER_LANG: asrConfig.language || DEFAULT_LANGUAGE,
    DSH_WHISPER_DEVICE: asrConfig.device || 'cpu',
    DSH_WHISPER_COMPUTE: asrConfig.computeType || 'int8',
    // Windows pipes default to GBK; force UTF-8 so Chinese text is not garbled
    PYTHONIOENCODING: 'utf-8',
    // Use HF mirror for better connectivity in China
    HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
  };
}

function serverStderrTail(server) {
  const lines = (server?.stderr || '').trim().split('\n').filter(Boolean);
  return lines.pop() || '';
}

/**
 * Start (or reuse) the persistent Whisper server.
 * Resolves when the model is loaded and the server prints READY.
 */
function ensureWhisperServer(asrConfig) {
  const current = whisperServer;
  if (current && !current.dead && current.proc.exitCode === null) {
    return Promise.resolve(current);
  }

  return new Promise((resolve, reject) => {
    const pythonPath = findPython('faster_whisper');
    if (!pythonPath) {
      reject(new Error('未找到 Python，无法使用本地语音识别。请安装 Python 3.10+ 或配置云端 ASR API。'));
      return;
    }

    const proc = spawn(pythonPath, [SERVER_PY], {
      env: whisperEnv(asrConfig),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const server = { proc, dead: false, stderr: '', pending: null, readyWaiters: [] };
    whisperServer = server;

    let lineBuf = '';
    const readyTimer = setTimeout(() => {
      if (!server.pending && !server.dead) {
        try { proc.kill('SIGKILL'); } catch {}
        server.dead = true;
        const tail = serverStderrTail(server);
        const err = new Error(`Whisper 模型加载超时（约 2 分钟）${tail ? `: ${tail}` : ''}`);
        server.readyWaiters.splice(0).forEach((w) => w.reject(err));
        if (server.pending) failPending(server, err);
      }
    }, 120000);

    const handleLine = (line) => {
      if (line === 'READY') {
        server.readyWaiters.splice(0).forEach((w) => w.resolve(server));
        return;
      }
      if (server.pending) {
        let parsed = null;
        try { parsed = JSON.parse(line); } catch { /* not JSON → ignore */ }
        if (parsed) {
          const { resolve, reject, timer } = server.pending;
          server.pending = null;
          clearTimeout(timer);
          if (typeof parsed.text === 'string') resolve(parsed.text);
          else reject(new Error(parsed.error || 'Whisper 服务返回异常'));
        }
      }
    };

    proc.stdout.on('data', (d) => {
      lineBuf += d.toString('utf8');
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        handleLine(lineBuf.slice(0, idx).trim());
        lineBuf = lineBuf.slice(idx + 1);
      }
    });

    proc.stderr.on('data', (d) => { server.stderr += d.toString('utf8'); });

    proc.on('error', (err) => {
      clearTimeout(readyTimer);
      server.dead = true;
      const e = new Error(`Whisper 服务启动失败: ${err.message}`);
      server.readyWaiters.splice(0).forEach((w) => w.reject(e));
      if (server.pending) failPending(server, e);
    });

    proc.on('close', () => {
      clearTimeout(readyTimer);
      server.dead = true;
      const e = new Error(`Whisper 服务意外退出: ${serverStderrTail(server) || 'unknown'}`);
      server.readyWaiters.splice(0).forEach((w) => w.reject(e));
      if (server.pending) failPending(server, e);
    });

    // Timeout for the READY handshake (model load / first download)
    server.readyWaiters.push({ resolve, reject });
  });
}

function failPending(server, err) {
  if (!server.pending) return;
  const { reject, timer } = server.pending;
  server.pending = null;
  clearTimeout(timer);
  reject(err);
}

/**
 * Send one transcription request to the persistent server.
 * Requests are serialized via a promise chain so concurrent calls
 * never clobber the server's single in-flight slot.
 */
function transcribeViaServer(audioPath, asrConfig) {
  return ensureWhisperServer(asrConfig).then((server) => {
    const run = (server.slot || Promise.resolve()).then(() => sendToServer(server, audioPath, asrConfig));
    server.slot = run.catch(() => {}); // keep chain alive after failures
    return run;
  });
}

function sendToServer(server, audioPath, asrConfig) {
  return new Promise((resolve, reject) => {
    const timeout = asrConfig.timeoutMs || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      const err = new Error(`本地转写超时 (${timeout / 1000}s)`);
      try { server.proc.kill('SIGKILL'); } catch {}
      server.dead = true;
      failPending(server, err);
      reject(err);
    }, timeout);

    server.pending = { resolve, reject, timer };
    try {
      server.proc.stdin.write(
        JSON.stringify({ file: audioPath, lang: asrConfig.language || DEFAULT_LANGUAGE }) + '\n'
      );
    } catch (err) {
      failPending(server, err instanceof Error ? err : new Error(String(err)));
      reject(err);
    }
  });
}

/**
 * One-shot transcription (fallback when the persistent server cannot start).
 * Spawns a fresh Python process per request — slower, but always works.
 */
function transcribeLocalOnce(audioBuffer, asrConfig) {
  return new Promise((resolve, reject) => {
    const pythonPath = findPython('faster_whisper');
    if (!pythonPath) {
      reject(new Error('未找到 Python，无法使用本地语音识别。请安装 Python 3.10+ 或配置云端 ASR API。'));
      return;
    }

    const proc = spawn(pythonPath, [TRANSCRIBE_PY], {
      env: whisperEnv(asrConfig),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timeout = asrConfig.timeoutMs || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`本地转写超时 (${timeout / 1000}s)`));
    }, timeout);

    proc.stdout.on('data', (data) => { stdout += data.toString('utf8'); });
    proc.stderr.on('data', (data) => { stderr += data.toString('utf8'); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // Prefer the "ERROR: ..." line (readable) over a raw traceback tail
        const lines = stderr.trim().split('\n');
        const errLine = lines.find((l) => l.startsWith('ERROR:')) || lines.pop() || `exit code ${code}`;
        reject(new Error(`本地转写失败: ${errLine}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Python 启动失败: ${err.message}`));
    });

    // Feed audio data to stdin
    proc.stdin.write(audioBuffer);
    proc.stdin.end();
  });
}

/**
 * Local transcription: persistent server first (fast), one-shot fallback.
 */
async function transcribeLocal(audioBuffer, asrConfig) {
  if (!SERVER_PY || !existsSync(SERVER_PY)) {
    return transcribeLocalOnce(audioBuffer, asrConfig);
  }

  // Write audio to a temp file for the server to read
  const tmpPath = join(tmpdir(), `dsh-voice-tx-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.wav`);
  try {
    writeFileSync(tmpPath, audioBuffer);
  } catch (err) {
    return transcribeLocalOnce(audioBuffer, asrConfig);
  }

  try {
    const text = await transcribeViaServer(tmpPath, asrConfig);
    return text;
  } catch (err) {
    console.error(`[dsh-voice-input] Persistent server failed (${err.message}); falling back to one-shot`);
    return transcribeLocalOnce(audioBuffer, asrConfig);
  } finally {
    try { rmSync(tmpPath, { force: true }); } catch {}
  }
}

/** Stop the persistent server (plugin unload). Releases model RAM. */
function stopWhisperServer() {
  const server = whisperServer;
  whisperServer = null;
  if (!server || !server.proc || server.proc.exitCode !== null) return;
  try {
    server.proc.stdin.end(); // stdin EOF → server exits cleanly
  } catch {}
  const killer = setTimeout(() => {
    try { server.proc.kill('SIGKILL'); } catch {}
  }, 1500);
  if (typeof killer.unref === 'function') killer.unref();
}

/* ── Cloud ASR transcription ─────────────────────────────────── */

/**
 * Build a multipart/form-data body manually (for Node.js compatibility).
 */
function buildMultipartBody(fields) {
  const boundary = '----DSHVoiceInput' + Math.random().toString(16).slice(2);
  const parts = [];

  for (const field of fields) {
    const [name, value, filename, contentType] = field;
    let header = `--${boundary}\r\n`;
    if (filename) {
      header += `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`;
      header += `Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`;
    } else {
      header += `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
    }
    parts.push(Buffer.from(header, 'utf8'));
    parts.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    buffer: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function detectExt(contentType) {
  if (!contentType) return { ext: '.webm', mime: 'audio/webm' };
  if (contentType.includes('webm')) return { ext: '.webm', mime: 'audio/webm' };
  if (contentType.includes('ogg')) return { ext: '.ogg', mime: 'audio/ogg' };
  if (contentType.includes('wav')) return { ext: '.wav', mime: 'audio/wav' };
  if (contentType.includes('mp4') || contentType.includes('m4a')) return { ext: '.m4a', mime: 'audio/mp4' };
  if (contentType.includes('mp3')) return { ext: '.mp3', mime: 'audio/mpeg' };
  return { ext: '.webm', mime: 'audio/webm' };
}

async function transcribeCloud(audioBuffer, audioMime, asrConfig) {
  const { ext } = detectExt(audioMime);
  const filename = 'audio' + ext;

  const fields = [
    ['file', audioBuffer, filename, audioMime || 'audio/webm'],
    ['model', asrConfig.model],
  ];
  if (asrConfig.language) {
    fields.push(['language', asrConfig.language]);
  }
  fields.push(['response_format', 'json']);

  const { buffer, contentType } = buildMultipartBody(fields);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), asrConfig.timeoutMs || 60000);

  try {
    const headers = { 'content-type': contentType };
    if (asrConfig.apiKey) headers.authorization = `Bearer ${asrConfig.apiKey}`;

    const res = await fetch(`${asrConfig.baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: buffer,
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      throw new Error(`ASR API HTTP ${res.status}: ${detail}`);
    }

    const data = await res.json();
    const text = data?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('ASR API returned empty text');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/* ── Orchestration ───────────────────────────────────────────── */

async function transcribe(audioBuffer, audioMime, asrConfig) {
  // 1) Cloud ASR
  if (asrConfig.provider && asrConfig.provider !== 'local') {
    try {
      const text = await transcribeCloud(audioBuffer, audioMime, asrConfig);
      if (text) return { text, source: asrConfig.provider };
    } catch (err) {
      // Cloud failed → try local as fallback
      console.error(`[dsh-voice-input] Cloud ASR (${asrConfig.provider}) failed: ${err.message}`);
    }
  }

  // 2) Local Whisper
  try {
    const text = await transcribeLocal(audioBuffer, asrConfig);
    if (text) return { text, source: 'local' };
  } catch (err) {
    console.error(`[dsh-voice-input] Local ASR failed: ${err.message}`);
    throw err;
  }

  return { text: '', source: 'none' };
}

/* ── HTTP helpers ────────────────────────────────────────────── */

async function readRawBody(request, maxBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('audio too large (max 25MB)');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/* ── Recorder page (standalone HTML for system browser) ─────── */

const RECORDER_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 语音输入</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);
  min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  color:#e0e0e0;user-select:none}
.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border:1px solid rgba(255,255,255,0.1);border-radius:24px;padding:48px 40px;
  display:flex;flex-direction:column;align-items:center;gap:24px;min-width:360px}
.title{font-size:18px;font-weight:600;color:#fff;letter-spacing:0.5px}
.mic-btn{width:96px;height:96px;border-radius:50%;border:none;cursor:pointer;
  background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;
  display:grid;place-items:center;transition:all .3s ease;
  box-shadow:0 8px 32px rgba(102,126,234,0.4)}
.mic-btn:hover{transform:scale(1.05);box-shadow:0 12px 40px rgba(102,126,234,0.6)}
.mic-btn.recording{background:linear-gradient(135deg,#ff3b30,#ff6b5b);box-shadow:0 8px 32px rgba(255,59,48,0.4)}
.mic-btn.recording:hover{box-shadow:0 12px 40px rgba(255,59,48,0.6)}
.mic-btn:disabled{opacity:0.5;cursor:wait}
.mic-btn svg{width:40px;height:40px}
.timer{font-size:24px;font-variant-numeric:tabular-nums;color:#ff3b30;font-weight:600;min-height:28px}
.status{font-size:14px;color:#aaa;min-height:20px;text-align:center}
.result{background:rgba(255,255,255,0.08);border-radius:12px;padding:16px 20px;
  min-width:300px;max-width:500px;min-height:60px;font-size:16px;line-height:1.6;
  color:#fff;word-break:break-all;white-space:pre-wrap;display:none}
.result.show{display:block}
.copy-hint{font-size:13px;color:#4ade80;display:none}
.copy-hint.show{display:block}
.pulse{position:absolute;width:96px;height:96px;border-radius:50%;
  border:2px solid rgba(255,59,48,0.4);animation:pulse 1.5s ease-out infinite;display:none}
.pulse.show{display:block}
@keyframes pulse{0%{transform:scale(1);opacity:1}100%{transform:scale(1.5);opacity:0}}
.spin{animation:sp 0.6s linear infinite;transform-origin:center}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
  <div class="title">DSH 语音输入</div>
  <div style="position:relative;display:grid;place-items:center">
    <div class="pulse" id="pulse"></div>
    <button class="mic-btn" id="btn" onclick="toggle()">
      <svg id="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11Z"/></svg>
    </button>
  </div>
  <div class="timer" id="timer"></div>
  <div class="status" id="status">点击麦克风开始录音</div>
  <div class="result" id="result"></div>
  <div class="copy-hint" id="copyHint"></div>
  <div style="font-size:12px;color:#666;margin-top:8px;text-align:center;max-width:300px;line-height:1.5">
    如果无法录音，请将本页地址复制到 Chrome / Edge 浏览器中打开
  </div>
</div>
<script>
var mediaRecorder,chunks=[],timerInterval,elapsed=0,state="idle";
var btn=document.getElementById("btn"),icon=document.getElementById("icon"),
    timerEl=document.getElementById("timer"),statusEl=document.getElementById("status"),
    resultEl=document.getElementById("result"),copyHint=document.getElementById("copyHint"),
    pulse=document.getElementById("pulse");

// Environment check on load
if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
  setStatus("当前浏览器不支持录音，请用 Chrome / Edge 打开本页");
  btn.disabled=true;
}else if(!window.isSecureContext){
  setStatus("非安全上下文，请用 http://localhost:端口 打开本页");
  btn.disabled=true;
}
var MIC_ICON='<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11Z"/>';
var STOP_ICON='<rect x="7" y="7" width="10" height="10" rx="2"/>';
var SPIN_ICON='<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z" opacity="0.2"/><path d="M12 3a9 9 0 0 1 9 9h-2a7 7 0 0 0-7-7V3z" fill="currentColor"/>';

function pickMime(){
  var types=["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/mp4"];
  for(var i=0;i<types.length;i++){
    if(typeof MediaRecorder!=="undefined"&&MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(types[i]))return types[i];
  }
  return "";
}
function setIcon(d){icon.innerHTML=d;}
function fmt(s){var m=Math.floor(s/60),x=s%60;return m+":"+(x<10?"0"+x:x);}
function setStatus(t){statusEl.textContent=t;}

function toggle(){
  if(state==="recording"){stopRec();}
  else if(state==="idle"){startRec();}
}

async function startRec(){
  resultEl.classList.remove("show");
  copyHint.classList.remove("show");
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    setStatus("浏览器不支持录音");return;
  }
  var mime=pickMime();
  var constraints={audio:{channelCount:1,sampleRate:16000,echoCancellation:true,noiseSuppression:true,autoGainControl:true}};
  try{
    var stream=await navigator.mediaDevices.getUserMedia(constraints);
  }catch(err){
    var n=err&&err.name||"";
    if(n==="NotAllowedError"||n==="PermissionDeniedError"){
      setStatus("麦克风被拒绝，请点击地址栏 🔒 图标允许麦克风后重试");
    }else if(n==="NotFoundError"){setStatus("未检测到麦克风");}
    else if(n==="NotReadableError"){setStatus("麦克风被占用");}
    else{setStatus("无法录音: "+(err.message||n));}
    return;
  }
  chunks=[];
  var opts=mime?{mimeType:mime}:{};
  try{mediaRecorder=new MediaRecorder(stream,opts);}
  catch(e){try{mediaRecorder=new MediaRecorder(stream);}catch(e2){setStatus("录音初始化失败");return;}}
  mediaRecorder.ondataavailable=function(e){if(e.data&&e.data.size>0)chunks.push(e.data);};
  mediaRecorder.onstop=function(){
    var blob=new Blob(chunks,{type:mime||"audio/webm"});
    stream.getTracks().forEach(function(t){try{t.stop();}catch(e){}});
    if(elapsed<1&&blob.size<5000){setStatus("录音太短");state="idle";setIcon(MIC_ICON);btn.disabled=false;return;}
    transcribe(blob,mime||"audio/webm");
  };
  mediaRecorder.onerror=function(){setStatus("录音错误");state="idle";setIcon(MIC_ICON);};
  mediaRecorder.start();
  state="recording";
  btn.classList.add("recording");
  pulse.classList.add("show");
  setIcon(STOP_ICON);
  setStatus("正在录音…");
  elapsed=0;timerEl.textContent="0:00";
  timerInterval=setInterval(function(){
    elapsed++;timerEl.textContent=fmt(elapsed);
    if(elapsed>=60){stopRec();}
  },1000);
}

function stopRec(){
  if(timerInterval){clearInterval(timerInterval);timerInterval=null;}
  if(mediaRecorder&&mediaRecorder.state!=="inactive"){try{mediaRecorder.stop();}catch(e){}}
  pulse.classList.remove("show");
  state="transcribing";
  btn.classList.remove("recording");
  btn.disabled=true;
  setIcon(SPIN_ICON);
  icon.setAttribute("class","spin");
  setStatus("正在转写…");
}

function transcribe(blob,mime){
  fetch("/dsh-voice-input/transcribe",{
    method:"POST",
    headers:{"Content-Type":mime},
    body:blob
  }).then(function(r){
    if(!r.ok)throw new Error("HTTP "+r.status);
    return r.json();
  }).then(function(data){
    if(data.text){
      resultEl.textContent=data.text;
      resultEl.classList.add("show");
      setStatus("已识别 ("+(data.source||"unknown")+")");
      // Copy to clipboard
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(data.text).then(function(){
          copyHint.textContent="已复制到剪贴板，可直接粘贴到 DSH";
          copyHint.classList.add("show");
        }).catch(function(){copyHint.textContent="复制失败，请手动选择文字复制";copyHint.classList.add("show");});
      }else{
        copyHint.textContent="请手动选择文字复制";
        copyHint.classList.add("show");
      }
      // Try to send back to DSH window
      try{
        if(window.opener&&!window.opener.closed){
          window.opener.postMessage({type:"dsh-voice-text",text:data.text},"*");
        }
      }catch(e){}
    }else if(data.error){
      setStatus("转写失败: "+data.error);
    }else{
      setStatus("未识别到语音");
    }
  }).catch(function(err){
    var msg=err.message||String(err);
    if(msg.includes("Failed to fetch")){setStatus("网络错误，请检查 DSH 是否运行");}
    else{setStatus("转写失败: "+msg);}
  }).finally(function(){
    state="idle";
    btn.disabled=false;
    icon.removeAttribute("class");
    setIcon(MIC_ICON);
  });
}
window.addEventListener("beforeunload",function(){
  try{if(window.opener&&!window.opener.closed){
    window.opener.postMessage({type:"dsh-voice-closed"},"*");
  }}catch(e){}
});
</script>
</body>
</html>`;

/* ── Route mounting ──────────────────────────────────────────── */

function mountTranscribeRoute(host) {
  const disposer = host.webServer.register({
    kind: 'prefix',
    path: '/dsh-voice-input',
    handler: async (request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname;

      // ── Serve standalone recorder page ──
      if (pathname === '/dsh-voice-input/recorder') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(RECORDER_HTML);
        return;
      }

      // ── System microphone recording: start ──
      if (pathname === '/dsh-voice-input/record/start') {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' });
          response.end();
          return;
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' });
          return;
        }
        try {
          await startSystemRecording();
          sendJson(response, 200, { ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(response, 500, { ok: false, error: message });
        }
        return;
      }

      // ── System microphone recording: stop + transcribe ──
      if (pathname === '/dsh-voice-input/record/stop') {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' });
          response.end();
          return;
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' });
          return;
        }
        try {
          const audioBuffer = await stopSystemRecording();
          const asrConfig = resolveAsrConfig(loadJsonConfig());
          const result = await transcribe(audioBuffer, 'audio/wav', asrConfig);
          if (result.text) {
            sendJson(response, 200, { ok: true, text: result.text, source: result.source });
          } else {
            sendJson(response, 200, { ok: true, text: '', source: 'none', error: 'no speech detected' });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(response, 500, { ok: false, error: message });
        }
        return;
      }

      // ── System microphone recording: live mic level (for UI animation) ──
      if (pathname === '/dsh-voice-input/record/level') {
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' });
          return;
        }
        const level = activeRecording ? activeRecording.level() : 0;
        sendJson(response, 200, { ok: true, level });
        return;
      }

      // ── System microphone recording: cancel (discard, no transcribe) ──
      if (pathname === '/dsh-voice-input/record/cancel') {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' });
          response.end();
          return;
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' });
          return;
        }
        try {
          const result = await cancelSystemRecording();
          sendJson(response, 200, { ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(response, 500, { ok: false, error: message });
        }
        return;
      }

      // ── Transcribe endpoint ──
      if (pathname !== '/dsh-voice-input/transcribe') {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' });
        return;
      }
      try {
        const audioMime = request.headers['content-type'] || 'audio/webm';
        const audioBuffer = await readRawBody(request);
        if (audioBuffer.length < 100) {
          sendJson(response, 400, { error: 'audio too short' });
          return;
        }

        const asrConfig = resolveAsrConfig(loadJsonConfig());
        const result = await transcribe(audioBuffer, audioMime, asrConfig);

        if (result.text) {
          sendJson(response, 200, { text: result.text, source: result.source });
        } else {
          sendJson(response, 200, { text: '', source: 'none', error: 'no speech detected' });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, { error: message });
      }
    },
  });

  return () => {
    stopWhisperServer();
    disposer?.();
  };
}

/* ── Plugin entry ────────────────────────────────────────────── */

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => mountTranscribeRoute(host), 'dsh-voice-input: http route');
  });
}

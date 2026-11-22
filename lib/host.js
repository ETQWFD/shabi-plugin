/**
 * lib/host.js — 宿主能力适配层。
 *
 * 所有模块只依赖 host 暴露的稳定接口；DSH/Cordis、独立 Node、测试 Mock
 * 都通过 createHost() 归一化，避免把宿主细节散落到业务代码里。
 *
 * 适配点（DSH）：
 *   ctx.screen.capture / ctx.screen.ocr / ctx.screen.blur
 *   ctx.vision.describe
 *   ctx.llm.chat / ctx.llm.embed
 *   ctx.media.ffmpeg / ctx.media.asr
 *   ctx.ui.notify / ctx.ui.confirm / ctx.ui.emit
 *   ctx.chat.send
 *   ctx.http.request / ctx.http.registerRoute
 *   ctx.secrets.get / ctx.secrets.set
 *   ctx.accounts.check
 *   ctx.content.candidates
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashEmbed, withTimeout } from './util.js';

export class HostError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.meta = meta;
  }
}

export const UNSUPPORTED = 'HOST_UNSUPPORTED';

function unsupported(capability, detail = '') {
  throw new HostError(UNSUPPORTED, `宿主未提供能力：${capability}${detail ? `（${detail}）` : ''}`, { capability });
}

/** 运行本机命令，返回 stdout/stderr；超时强杀。 */
export function runCommand(command, args = [], { timeoutMs = 120000, cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
        settled = true;
        reject(new HostError('HOST_TIMEOUT', `命令超时：${command}`, { command }));
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new HostError('HOST_SPAWN', `无法启动命令 ${command}：${err.message}`));
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new HostError('HOST_EXIT', `命令退出码 ${code}：${stderr.slice(-500) || command}`, { code, stdout, stderr }));
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** 检查 PATH 中是否有命令；只用于固定候选命令名。 */
async function hasCommand(command) {
  try {
    await runCommand('/bin/sh', ['-c', `command -v ${command}`], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 用 ffprobe 读取图片宽高；失败返回 0，不影响截屏。 */
async function probeImageSize(file, ffprobe = 'ffprobe') {
  try {
    const { stdout } = await runCommand(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', file,
    ], { timeoutMs: 15000 });
    const json = JSON.parse(stdout || '{}');
    const s = (json.streams || [])[0] || {};
    return { width: Number(s.width || 0), height: Number(s.height || 0) };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 读取当前前台窗口标题；无工具时返回 unknown。 */
async function activeWindowInfo() {
  const platform = process.platform;
  try {
    if (platform === 'linux' && process.env.DISPLAY) {
      if (await hasCommand('xdotool')) {
        const { stdout } = await runCommand('/bin/sh', ['-c', 'xdotool getactivewindow getwindowname 2>/dev/null'], { timeoutMs: 5000 });
        return { window: stdout.trim() || 'unknown', app: 'unknown' };
      }
      if (await hasCommand('xprop')) {
        const { stdout } = await runCommand('/bin/sh', ['-c', 'xprop -root _NET_ACTIVE_WINDOW 2>/dev/null'], { timeoutMs: 5000 });
        return { window: stdout.trim() || 'unknown', app: 'unknown' };
      }
    }
    if (platform === 'darwin' && await hasCommand('osascript')) {
      const { stdout } = await runCommand('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { timeoutMs: 5000 });
      return { window: stdout.trim() || 'unknown', app: stdout.trim() || 'unknown' };
    }
    if (platform === 'win32' && await hasCommand('powershell.exe')) {
      const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -First 1).MainWindowTitle';
      const { stdout } = await runCommand('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 8000 });
      return { window: stdout.trim() || 'unknown', app: 'unknown' };
    }
  } catch {
    // 前台窗口探测是增强项，失败不影响截屏
  }
  return { window: 'unknown', app: 'unknown' };
}

/** 自动截屏：优先原生工具，其次 ImageMagick/xwd，最后 ffmpeg x11grab。 */
async function autoCapture(options = {}, { cfg, ffmpeg = 'ffmpeg' } = {}) {
  const out = options.outPath || path.join(cfg.__paths?.data || '.', 'tmp', `screen-${Date.now()}.png`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const platform = process.platform;
  const attempts = [];
  if (platform === 'darwin') {
    attempts.push(['screencapture', ['-x', out]]);
  } else if (platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)',
      `$bmp.Save('${out.replaceAll("'", "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose();$bmp.Dispose()',
    ].join(';');
    attempts.push(['powershell.exe', ['-NoProfile', '-Command', ps]]);
  } else {
    if (process.env.WAYLAND_DISPLAY && await hasCommand('grim')) {
      attempts.push(['grim', [out]]);
    }
    if (await hasCommand('gnome-screenshot')) attempts.push(['gnome-screenshot', ['-f', out]]);
    if (await hasCommand('scrot')) attempts.push(['scrot', ['-q', '90', '-o', out]]);
    if (await hasCommand('import')) attempts.push(['import', ['-window', 'root', out]]);
    if (process.env.DISPLAY && await hasCommand(ffmpeg)) {
      attempts.push([ffmpeg, ['-y', '-f', 'x11grab', '-i', process.env.DISPLAY, '-frames:v', '1', '-q:v', '2', out]]);
    }
  }
  const errors = [];
  for (const [command, args] of attempts) {
    try {
      await runCommand(command, args, { timeoutMs: 15000 });
      const stat = await fs.stat(out);
      if (!stat.size) throw new Error('截屏文件为空');
      const size = await probeImageSize(out, cfg.media?.ffprobe || 'ffprobe');
      const win = await activeWindowInfo();
      return {
        path: out, ...size, bytes: stat.size, capturedAt: new Date().toISOString(),
        app: win.app, window: win.window, backend: command,
      };
    } catch (err) {
      errors.push(`${command}: ${err.message}`);
    }
  }
  throw new HostError(
    'HOST_CAPTURE_UNAVAILABLE',
    `本机没有可用的截屏工具${errors.length ? `（${errors.join('；').slice(0, 500)}）` : ''}。Linux 请安装 grim/scrot/ImageMagick 或启用 X11；macOS 需要屏幕录制权限；Windows 需允许 PowerShell 截屏。`,
  );
}

async function fetchJson(url, options = {}) {
  const res = await withTimeout(fetch(url, options), options.timeoutMs || 60000, 'HTTP 请求');
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = json?.error?.message || json?.message || text.slice(0, 300) || res.statusText;
    throw new HostError('HOST_HTTP', `HTTP ${res.status}：${message}`, { status: res.status, body: json || text.slice(0, 500) });
  }
  return json ?? { raw: text };
}

async function fileToDataUrl(file) {
  const buf = await fs.readFile(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function normMessages(messages) {
  if (typeof messages === 'string') return [{ role: 'user', content: messages }];
  return messages;
}

export function createHost(raw = {}, { config = {}, logger } = {}) {
  const cfg = config;
  const caps = {
    screen: Boolean(raw.screen?.capture),
    ocr: Boolean(raw.screen?.ocr),
    blur: Boolean(raw.screen?.blur),
    vision: Boolean(raw.vision?.describe),
    llm: Boolean(raw.llm?.chat),
    embed: Boolean(raw.llm?.embed),
    asr: Boolean(raw.media?.asr || cfg.video?.asr?.command),
    ffmpeg: true,
    httpServer: Boolean(raw.http?.registerRoute),
    chat: Boolean(raw.chat?.send),
    ui: Boolean(raw.ui),
    secrets: Boolean(raw.secrets),
    accounts: Boolean(raw.accounts?.check),
    content: Boolean(raw.content?.candidates),
    input: Boolean(raw.input),
  };

  const secretsCache = new Map();
  const secretsFile = config.__paths?.data ? path.join(config.__paths.data, 'host-secrets.json') : null;

  async function readLocalSecrets() {
    if (!secretsFile) return {};
    try {
      return JSON.parse(await fs.readFile(secretsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  const host = {
    raw,
    capabilities: caps,
    env: process.env,
    now: () => new Date(),

    screen: {
      async capture(options = {}) {
        if (raw.screen?.capture) return raw.screen.capture(options);
        const command = cfg.eye?.capture?.command;
        if (command) {
          const out = options.outPath || path.join(cfg.__paths?.data || '.', 'tmp', `screen-${Date.now()}.png`);
          await fs.mkdir(path.dirname(out), { recursive: true });
          const line = command.includes('{out}') ? command.replaceAll('{out}', out) : `${command} ${out}`;
          await runCommand('/bin/sh', ['-c', line], { timeoutMs: Number(cfg.eye?.capture?.timeoutSec || 15) * 1000 });
          const stat = await fs.stat(out);
          const size = await probeImageSize(out, cfg.media?.ffprobe || 'ffprobe');
          return { path: out, ...size, width: options.width, height: options.height, capturedAt: new Date().toISOString(), bytes: stat.size, backend: 'configured-command' };
        }
        // 没有宿主截屏服务、也没有用户命令时，自动探测本机截屏能力。
        return autoCapture(options, { cfg, ffmpeg: cfg.media?.ffmpeg || 'ffmpeg' });
      },

      async ocr(imagePath, options = {}) {
        if (raw.screen?.ocr) return raw.screen.ocr(imagePath, options);
        const command = cfg.eye?.ocr?.command;
        if (command) {
          const args = command.replaceAll('{in}', imagePath);
          const { stdout } = await runCommand('/bin/sh', ['-c', args], { timeoutMs: Number(cfg.eye?.ocr?.timeoutSec || 30) * 1000 });
          return { text: stdout.trim(), blocks: [], degraded: true, engine: 'cli' };
        }
        // 自动探测 tesseract；未安装时返回空结果而不是 null，眼睛仍能输出截图上下文。
        if (await hasCommand('tesseract')) {
          const langs = Array.isArray(options.lang) ? options.lang : Array.isArray(cfg.eye?.ocr?.languages) ? cfg.eye.ocr.languages : ['chi_sim', 'eng'];
          const available = await runCommand('tesseract', ['--list-langs'], { timeoutMs: 5000 })
            .then(({ stdout }) => stdout.split(/\r?\n/).map((s) => s.trim()))
            .catch(() => []);
          const usable = langs.filter((l) => available.includes(l));
          const langArg = usable.length ? usable.join('+') : available.find((l) => l && l !== 'osd') || 'eng';
          const { stdout } = await runCommand('tesseract', [imagePath, 'stdout', '-l', langArg], { timeoutMs: 60000 });
          return { text: stdout.trim(), blocks: [], degraded: true, engine: `tesseract:${langArg}` };
        }
        return { text: '', blocks: [], degraded: true, engine: 'none' };
      },

      async blur(imagePath, regions, outPath, options = {}) {
        if (raw.screen?.blur) return raw.screen.blur(imagePath, regions, outPath, options);
        if (!regions?.length) return imagePath;
        const out = outPath || `${imagePath}.blurred.jpg`;
        const filters = [];
        let last = '0:v';
        regions.forEach((r, i) => {
          const x = Math.max(0, Math.round(r.x * 10000));
          const y = Math.max(0, Math.round(r.y * 10000));
          const w = Math.max(1, Math.round(r.w * 10000));
          const h = Math.max(1, Math.round(r.h * 10000));
          filters.push(`[${last}]split=2[base${i}][src${i}]`);
          filters.push(`[src${i}]crop=iw*${w / 10000}:ih*${h / 10000}:iw*${x / 10000}:ih*${y / 10000},boxblur=20:2[blur${i}]`);
          filters.push(`[base${i}][blur${i}]overlay=iw*${x / 10000}:ih*${y / 10000}[out${i}]`);
          last = `out${i}`;
        });
        await runCommand(cfg.media?.ffmpeg || 'ffmpeg', [
          '-y', '-i', imagePath,
          '-filter_complex', filters.join(';'),
          '-map', `[${last}]`, '-frames:v', '1', '-q:v', '3', out,
        ], { timeoutMs: 60000 });
        return out;
      },
    },

    vision: {
      async describe(imagePath, prompt, options = {}) {
        if (raw.vision?.describe) return raw.vision.describe(imagePath, prompt, options);
        const model = options.model || cfg.llm?.visionModel;
        const endpoint = cfg.llm?.endpoint;
        if (!model || !endpoint) return null;
        const dataUrl = await fileToDataUrl(imagePath);
        const res = await host.llm.chat(
          [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          { model, temperature: 0.2, timeoutMs: cfg.llm?.timeoutSec ? cfg.llm.timeoutSec * 1000 : 60000 },
        );
        if (!res?.text) return null;
        return { text: res.text, raw: res.text, engine: 'openai-vision' };
      },
    },

    llm: {
      async chat(messages, options = {}) {
        if (raw.llm?.chat) return raw.llm.chat(messages, options);
        const endpoint = cfg.llm?.endpoint;
        const apiKey = cfg.llm?.apiKey;
        const model = options.model || cfg.llm?.model;
        if (!endpoint || !model) return null;
        const base = endpoint.replace(/\/$/, '');
        const body = {
          model,
          messages: normMessages(messages),
          temperature: options.temperature ?? cfg.llm?.temperature ?? 0.4,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
          ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        };
        const json = await fetchJson(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body),
          timeoutMs: options.timeoutMs || (cfg.llm?.timeoutSec || 60) * 1000,
        });
        const text = json?.choices?.[0]?.message?.content ?? '';
        return { text: Array.isArray(text) ? text.map((p) => p.text || '').join('') : text, usage: json?.usage, model };
      },

      async json(messages, options = {}) {
        if (raw.llm?.json) return raw.llm.json(messages, options);
        const first = await host.llm.chat(messages, { ...options, responseFormat: { type: 'json_object' } });
        if (!first?.text) return null;
        const { safeJsonParse } = await import('./util.js');
        let parsed = safeJsonParse(first.text);
        if (!parsed) {
          const repair = await host.llm.chat(
            [
              ...normMessages(messages),
              { role: 'assistant', content: first.text.slice(0, 2000) },
              { role: 'user', content: '上面的输出不是合法 JSON。请只输出一个合法 JSON 对象，不要解释、不要代码块。' },
            ],
            { ...options, temperature: 0, responseFormat: { type: 'json_object' } },
          );
          parsed = repair?.text ? safeJsonParse(repair.text) : null;
        }
        return parsed;
      },

      async embed(texts) {
        if (raw.llm?.embed) return raw.llm.embed(texts);
        const endpoint = cfg.llm?.endpoint;
        const model = cfg.llm?.embedModel;
        const apiKey = cfg.llm?.apiKey;
        if (!endpoint || !model) {
          return texts.map((t) => hashEmbed(t));
        }
        const base = endpoint.replace(/\/$/, '');
        const json = await fetchJson(`${base}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, input: texts }),
          timeoutMs: (cfg.llm?.timeoutSec || 60) * 1000,
        });
        const data = json?.data;
        if (!Array.isArray(data)) throw new HostError('HOST_EMBED', 'embedding 响应格式不正确');
        return data.map((d) => d.embedding);
      },
    },

    media: {
      ffmpeg: cfg.media?.ffmpeg || 'ffmpeg',
      ffprobe: cfg.media?.ffprobe || 'ffprobe',
      run: runCommand,

      async ffprobeJson(file, args = []) {
        if (raw.media?.ffprobeJson) return raw.media.ffprobeJson(file, args);
        const { stdout } = await runCommand(
          cfg.media?.ffprobe || 'ffprobe',
          ['-v', 'error', '-print_format', 'json', ...args, file],
          { timeoutMs: 60000 },
        );
        return JSON.parse(stdout);
      },

      async asr(audioPath, options = {}) {
        if (raw.media?.asr) return raw.media.asr(audioPath, options);
        const command = cfg.video?.asr?.command;
        if (!command) return null;
        const out = `${audioPath}.asr.json`;
        const line = command.replaceAll('{input}', audioPath).replaceAll('{output}', out).replaceAll('{language}', options.language || 'zh');
        await runCommand('/bin/sh', ['-c', line], { timeoutMs: options.timeoutMs || 600000 });
        const json = JSON.parse(await fs.readFile(out, 'utf8'));
        return json;
      },
    },

    ui: {
      async notify(text, meta = {}) {
        if (raw.ui?.notify) return raw.ui.notify(text, meta);
        if (logger) logger.info(`[通知] ${text}`, meta);
        return { ok: true, degraded: !raw.ui };
      },

      async confirm(request) {
        if (raw.ui?.confirm) return raw.ui.confirm(request);
        if (process.env.SHABI_AUTO_CONFIRM === '1') return { approved: true, by: 'env' };
        if (logger) logger.warn(`[待确认] ${request.title}：${request.detail}`);
        return { approved: false, reason: '宿主无确认界面，已按安全默认拒绝' };
      },

      emit(event, payload) {
        if (raw.ui?.emit) return raw.ui.emit(event, payload);
        return false;
      },
    },

    chat: {
      async send(text, meta = {}) {
        if (raw.chat?.send) return raw.chat.send(text, meta);
        if (logger) logger.info(`[聊天] ${text}`, { image: meta.image });
        return { ok: true, degraded: true };
      },
    },

    http: {
      async request(url, options = {}) {
        if (raw.http?.request) return raw.http.request(url, options);
        const { timeoutMs, ...rest } = options;
        const res = await withTimeout(fetch(url, rest), timeoutMs || 60000, 'HTTP');
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json, buffer: buf };
      },

      registerRoute(routePath, handler, kind = 'exact') {
        if (raw.http?.registerRoute) return raw.http.registerRoute(routePath, handler, kind);
        return null;
      },
    },

    secrets: {
      async get(key) {
        if (raw.secrets?.get) return raw.secrets.get(key);
        if (secretsCache.has(key)) return secretsCache.get(key);
        const local = await readLocalSecrets();
        return local[key] ?? null;
      },

      async set(key, value) {
        if (raw.secrets?.set) return raw.secrets.set(key, value);
        secretsCache.set(key, value);
        if (!secretsFile) return false;
        const local = await readLocalSecrets();
        local[key] = value;
        await fs.mkdir(path.dirname(secretsFile), { recursive: true });
        await fs.writeFile(secretsFile, `${JSON.stringify(local, null, 2)}\n`, { mode: 0o600 });
        return true;
      },
    },

    accounts: {
      async check(platform) {
        if (raw.accounts?.check) return raw.accounts.check(platform);
        return { ok: false, platform, reason: '当前运行环境没有浏览器会话，请在 DSH 中登录后检查', checkedAt: new Date().toISOString() };
      },
    },

    content: {
      async candidates(query) {
        if (raw.content?.candidates) return raw.content.candidates(query);
        return [];
      },
    },

    input: {
      async run(action) {
        if (raw.input?.run) return raw.input.run(action);
        unsupported('input.run', '鼠标键盘需宿主显式授权');
      },
    },
  };

  return host;
}

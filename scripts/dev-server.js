/**
 * scripts/dev-server.js — 无 DSH 时的本地设置页与 API 服务器。
 *
 * 用法：npm start  或  node scripts/dev-server.js [--port 3579]
 * 打开：http://127.0.0.1:3579/shabi/settings
 *
 * 注意：这是开发/独立运行模式，不提供真实截屏/LLM 能力；
 * 完整能力请在 DSH 宿主中安装插件。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShabiPlugin } from '../main.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = '/shabi/api';
const UI_PREFIX = '/shabi/ui';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.SHABI_PORT || 3579);

const routes = new Map();
const rawHost = {
  http: {
    registerRoute(routePath, handler) {
      routes.set(routePath, handler);
      return () => routes.delete(routePath);
    },
  },
  ui: {
    notify(text, meta) { console.log(`[notify] ${text}`, meta || ''); },
    async confirm(request) {
      console.log(`[confirm] ${request.title}\n${request.detail || ''}`);
      return { approved: false, reason: 'dev-server 无交互确认，默认拒绝' };
    },
  },
  chat: {
    async send(text) { console.log(`[chat] ${text}`); return { ok: true }; },
  },
};

const app = await createShabiPlugin({ root: ROOT, rawHost });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/' || url.pathname === '/shabi') {
      res.writeHead(302, { location: '/shabi/settings' });
      res.end();
      return;
    }
    if (url.pathname === '/shabi/settings' || url.pathname === '/shabi/settings/') {
      await sendFile(res, path.join(ROOT, 'ui', 'settings.html'), 'text/html; charset=utf-8');
      return;
    }
    if (url.pathname.startsWith(`${UI_PREFIX}/`)) {
      const rel = url.pathname.slice(UI_PREFIX.length + 1);
      const file = path.resolve(ROOT, 'ui', rel);
      if (!file.startsWith(path.join(ROOT, 'ui') + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      await sendFile(res, file, mimeOf(file));
      return;
    }

    const handler = routes.get(url.pathname);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'not found', path: url.pathname }));
      return;
    }
    const body = await readBody(req);
    const result = await handler({
      method: req.method,
      url: req.url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    });
    const status = result?.status || 200;
    const headers = { ...(result?.headers || {}) };
    if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
    res.writeHead(status, headers);
    if (Buffer.isBuffer(result?.body)) res.end(result.body);
    else res.end(result?.body === undefined ? '' : typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
  } catch (err) {
    console.error('[dev-server]', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`沙币设置页：http://127.0.0.1:${PORT}/shabi/settings`);
  console.log(`API 基址：http://127.0.0.1:${PORT}${API}`);
  console.log('提示：独立模式无截屏/LLM 能力；完整能力请在 DSH 中安装。');
});

server.on('error', (err) => {
  console.error('[dev-server] 启动失败', err);
  process.exitCode = 1;
});

async function shutdown(signal) {
  console.log(`\n[dev-server] 收到 ${signal}，正在关闭…`);
  server.close();
  await app.dispose();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function sendFile(res, file, contentType) {
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

function mimeOf(file) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.json': 'application/json; charset=utf-8',
  }[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('请求体超过 16MB');
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

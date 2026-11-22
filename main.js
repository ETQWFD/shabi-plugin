/**
 * main.js — 沙币（shabi-plugin）DSH / Cordis 插件入口，同时支持独立运行与 API 服务。
 *
 * Cordis 约定：导出 name / apply；资源通过 ctx.effect 自动清理。
 * 不声明 inject，保证在缺少截屏/LLM 等能力的 profile 中也能降级加载。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createHost } from './lib/host.js';
import { createLogger } from './lib/logger.js';
import { CryptoBox } from './lib/cryptoBox.js';
import {
  loadBaseConfig, buildPaths, validateConfig, loadSecrets, saveConfig,
  redactConfigForUi, isMaskedSecret, SECRET_PATHS, applyEnvOverrides, ConfigError,
} from './lib/config.js';
import { deepMerge, getByPath, setByPath, nowIso } from './lib/util.js';
import { Safety } from './core/safety.js';
import { MemoryStore } from './core/memory.js';
import { PersonalityStore } from './core/personality.js';
import { Eye } from './core/eye.js';
import { VideoAnalyzer } from './core/videoAnalyzer.js';
import { KnowledgeEngine } from './core/knowledge.js';
import { InterestEngine } from './core/interest.js';
import { ContentHub } from './core/content.js';
import { ImageApi } from './core/imageApi.js';
import { QQBot } from './core/qqBot.js';
import { DecisionEngine } from './core/decision.js';
import { Autonomy } from './core/autonomy.js';
import { createChatEnhance, registerChatEnhance } from './ui/chatEnhance.js';

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url));
export const name = 'shabi-plugin';
export const version = '1.1.1';
// Cordis 的服务可见性：声明 tools 后，Web profile 才允许直接 ctx.tools.register。
export const inject = ['tools'];

/**
 * 创建插件实例（不依赖 Cordis，可直接在测试/CLI 中使用）。
 */
export async function createShabiPlugin({ root = PLUGIN_ROOT, config: overrides = {}, rawHost = null, ctx = null, env = process.env } = {}) {
  const loaded = await loadBaseConfig({ root, env, dataDir: overrides?.dataDir });
  let config = deepMerge(loaded.config, overrides || {});
  config = applyEnvOverrides(config, env);
  const paths = buildPaths(root, config);
  config.__paths = paths;

  await fs.mkdir(paths.data, { recursive: true });
  await fs.mkdir(paths.logs, { recursive: true });
  await fs.mkdir(paths.memory, { recursive: true });
  await fs.mkdir(paths.archive, { recursive: true });

  const logger = createLogger({ dir: paths.logs, ...(config.logging || {}) });
  const validation = validateConfig(config);
  for (const w of validation.warnings) logger.warn(`配置警告：${w}`);
  if (!validation.ok) throw new ConfigError(`配置校验失败：${validation.errors.join('；')}`, validation.errors);

  const crypto = await new CryptoBox({ dataDir: paths.data, secrets: null }).init();
  await loadSecrets(config, crypto);

  const normalizedRaw = normalizeRawHost(rawHost || {}, ctx);
  const host = createHost(normalizedRaw, { config, logger });

  const app = {
    name, version, root, config, paths, host, logger, crypto,
    startedAt: nowIso(), disposed: false, disposers: [], warnings: validation.warnings, schema: null,
  };

  try {
    app.safety = new Safety(app);
    app.memory = new MemoryStore(app);
    await app.memory.initMemory();
    app.personality = new PersonalityStore(app);
    await app.personality.init();
    app.eye = new Eye(app);
    app.video = new VideoAnalyzer(app);
    await app.video.init();
    app.knowledge = new KnowledgeEngine(app);
    await app.knowledge.init();
    app.interest = new InterestEngine(app);
    await app.interest.init();
    app.content = new ContentHub(app);
    await app.content.init();
    app.imageApi = new ImageApi(app);
    await app.imageApi.init();
    app.qq = new QQBot(app);
    await app.qq.init();
    app.decision = new DecisionEngine(app);
    app.autonomy = new Autonomy(app);
    await app.autonomy.init();
    app.chatEnhance = createChatEnhance(app);

    app.schema = await readJson(path.join(root, 'config', 'settings.schema.json'), null);
    app.routes = setupApiRoutes(app);

    if (config.eye?.enabled && config.eye?.mode !== 'manual') {
      await app.eye.start().catch((err) => logger.warn('眼睛启动失败，已降级', { error: err.message }));
    }
    if (config.autonomy?.enabled) {
      await app.autonomy.startLoop().catch((err) => logger.warn('自主循环启动失败', { error: err.message }));
    }
    if (config.qqBot?.enabled) {
      await app.qq.startBot().catch((err) => logger.warn('QQ 机器人启动失败', { error: err.message }));
    }

    if (ctx) {
      attachCordis(app, ctx);
      app.chatHooks = registerChatEnhance(app, ctx);
    }

    app.dispose = async () => {
      if (app.disposed) return;
      app.disposed = true;
      app.eye.stop();
      app.autonomy.stopLoop();
      await app.qq.stopBot().catch(() => {});
      for (const d of app.disposers) {
        try { await d(); } catch { /* ignore */ }
      }
      for (const d of app.chatHooks || []) {
        try { await d(); } catch { /* ignore */ }
      }
      await app.memory.close().catch(() => {});
      await logger.flush().catch(() => {});
      logger.info('沙币插件已卸载');
    };

    logger.info('沙币插件已启动', {
      version,
      capabilities: host.capabilities,
      memoryEntries: app.memory.getStats().entries,
      personality: app.personality.getActive()?.id,
    });
    return app;
  } catch (err) {
    app.disposed = true;
    await app.memory?.close?.().catch(() => {});
    logger.error('沙币插件初始化失败', { error: err.message });
    throw err;
  }
}

/** Cordis 入口：异步启动 + 注册自动清理。 */
export function apply(ctx, config = {}) {
  const boot = () => createShabiPlugin({ ctx, rawHost: ctx, config }).then((app) => {
    try { ctx.shabi = app; } catch { /* context may be sealed */ }
    safeLog(resolveService(ctx, 'logger'), 'info', '沙币插件已挂载（DSH）');
    return app;
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      let app = null;
      const ready = boot()
        .then((a) => { app = a; })
        .catch((err) => {
          safeLog(resolveService(ctx, 'logger'), 'error', `沙币插件启动失败：${err.message}`);
          console.error('[shabi-plugin] 启动失败', err);
        });
      return async () => {
        await ready;
        if (app) await app.dispose();
      };
    });
  } else {
    boot().catch((err) => console.error('[shabi-plugin] 启动失败', err));
  }
}

// ───────────────────────── DSH 适配 ─────────────────────────

function resolveService(ctx, name) {
  if (!ctx || !name) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name, false);
      if (value !== undefined) return value;
    }
  } catch { /* service not ready or context sealed */ }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

function normalizeRawHost(raw = {}, ctx = null) {
  const out = { ...raw };
  if (!ctx) return out;
  const services = {
    screen: resolveService(ctx, 'screen'),
    vision: resolveService(ctx, 'vision'),
    llm: resolveService(ctx, 'llm'),
    media: resolveService(ctx, 'media'),
    secrets: resolveService(ctx, 'secrets'),
    accounts: resolveService(ctx, 'accounts'),
    content: resolveService(ctx, 'content'),
    input: resolveService(ctx, 'input'),
    ui: resolveService(ctx, 'ui'),
    chat: resolveService(ctx, 'chat'),
    http: resolveService(ctx, 'http'),
    logger: resolveService(ctx, 'logger'),
  };
  if (!out.screen && services.screen) out.screen = services.screen;
  if (!out.vision && services.vision) out.vision = services.vision;
  if (!out.llm && typeof services.llm?.chat === 'function') out.llm = services.llm;
  if (!out.media && services.media) out.media = services.media;
  if (!out.secrets && services.secrets) out.secrets = services.secrets;
  if (!out.accounts && services.accounts) out.accounts = services.accounts;
  if (!out.content && services.content) out.content = services.content;
  if (!out.input && services.input) out.input = services.input;

  if (!out.ui) {
    const ui = {};
    const uiService = services.ui;
    const notifyFn = uiService?.notify || resolveService(ctx, 'notify');
    const confirmFn = uiService?.confirm || resolveService(ctx, 'confirm');
    const emitFn = uiService?.emit || resolveService(ctx, 'emit');
    if (typeof notifyFn === 'function') ui.notify = (text, meta) => notifyFn(text, meta);
    else if (typeof services.logger?.info === 'function') ui.notify = (text, meta) => services.logger.info(text, meta);
    if (typeof confirmFn === 'function') ui.confirm = (req) => confirmFn(req);
    if (typeof emitFn === 'function') ui.emit = (event, payload) => emitFn(event, payload);
    if (Object.keys(ui).length) out.ui = ui;
  }
  if (!out.chat && typeof services.chat?.send === 'function') out.chat = services.chat;

  out.http = out.http || {};
  const httpService = services.http;
  if (!out.http.request && typeof httpService?.request === 'function') {
    out.http.request = (url, opts) => httpService.request(url, opts);
  }
  if (!out.http.registerRoute) {
    const registrar = findRouteRegistrar(ctx);
    if (registrar) out.http.registerRoute = registrar;
  }
  return out;
}

function findRouteRegistrar(ctx) {
  const http = resolveService(ctx, 'http');
  const webServer = resolveService(ctx, 'webServer');
  const server = resolveService(ctx, 'server');
  const webApp = resolveService(ctx, 'webApp');
  const router = resolveService(ctx, 'router');
  // DSH Web 的真实接口是 ctx.webServer.register({kind,path,handler})。
  // 兼容旧实现里常见的 registerRoute/route 两种形状。
  if (webServer && typeof webServer.register === 'function') {
    return (routePath, handler, kind = 'exact') => {
      const clean = String(routePath || '').replace(/\/+$/, '') || '/';
      return webServer.register({ kind, path: clean, handler: wrapNodeHandler(handler) });
    };
  }
  const candidates = [
    [http, 'registerRoute'], [http, 'route'],
    [server, 'registerRoute'], [server, 'route'],
    [webApp, 'registerRoute'], [webApp, 'route'],
    [webApp?.server, 'registerRoute'],
    [router, 'register'], [router, 'registerRoute'],
  ];
  for (const [obj, method] of candidates) {
    if (obj && typeof obj[method] === 'function') {
      return (routePath, handler) => obj[method](routePath, wrapNodeHandler(handler));
    }
  }
  return null;
}

/** 兼容 Node(req,res)、Fastify(reply)、直接返回对象的三种路由形态。 */
function wrapNodeHandler(handler) {
  return async (req, res) => {
    const normalized = normalizeRequest(req);
    normalized.body = await readRequestBody(req, normalized.method, normalized.body);
    const result = await handler(normalized);
    if (res && typeof res.setHeader === 'function') {
      const status = result?.status || 200;
      res.statusCode = status;
      for (const [k, v] of Object.entries(result?.headers || {})) res.setHeader(k, v);
      if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
      const body = result?.body === undefined ? '' : typeof result.body === 'string' ? result.body : Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body);
      res.end(req?.method === 'HEAD' ? undefined : body);
      return undefined;
    }
    if (res && typeof res.code === 'function' && typeof res.send === 'function') {
      res.code(result?.status || 200);
      for (const [k, v] of Object.entries(result?.headers || {})) res.header?.(k, v);
      res.send(result?.body ?? '');
      return undefined;
    }
    return result;
  };
}

/**
 * 兼容 DSH Web 的 Node IncomingMessage 与 Fetch Request：
 * 读取 POST JSON 请求体。已经解析过的 body 直接返回。
 */
async function readRequestBody(req, method, existing) {
  if (existing !== undefined) return existing;
  if (method === 'GET' || method === 'HEAD') return undefined;
  if (req && typeof req.json === 'function') {
    try { return await req.json(); } catch { return undefined; }
  }
  const stream = req?.raw && typeof req.raw.on === 'function' ? req.raw : req;
  if (!stream || typeof stream.on !== 'function') return undefined;
  const chunks = [];
  try {
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  } catch {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

function normalizeRequest(req) {
  const raw = req?.raw || req;
  const url = new URL(req?.url || raw?.url || '/', 'http://localhost');
  let body = req?.body ?? raw?.body;
  if (typeof body === 'string' && body) {
    try { body = JSON.parse(body); } catch { /* keep string */ }
  }
  return {
    method: String(req?.method || raw?.method || 'GET').toUpperCase(),
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req?.headers || raw?.headers || {},
    body,
    raw: req,
  };
}

function attachCordis(app, ctx) {
  // 与 DSH 官方工具插件一致：直接读 ctx.tools。ctx.inject 在 Web 启动阶段
  // 可能因为服务时序抛错，不能当成唯一入口。
  const tools = resolveService(ctx, 'tools');
  if (tools) {
    registerTools(app, { tools }).catch((err) => app.logger.warn('工具注册失败', { error: err.message }));
  } else if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (toolsCtx) => registerTools(app, toolsCtx));
    } catch (err) {
      app.logger.warn('工具注册注入失败', { error: err.stack || err.message });
    }
  }

  // 在 DSH Web 首页注入一个明确入口，保证设置页不是“藏在端口里的独立页面”。
  try {
    if (typeof ctx.on === 'function') {
      const inject = (table) => {
        table.push({
          kind: 'script', placement: 'body', text: `(() => {
  const ID = 'shabi-settings-entry';
  const add = () => {
    if (!document.body || document.getElementById(ID)) return;
    const a = document.createElement('a');
    a.id = ID;
    a.href = '/shabi/settings';
    a.textContent = '沙币设置';
    a.title = '打开沙币设置：眼睛、B站/小说、视频学习、记忆与人格';
    Object.assign(a.style, {
      position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483000',
      padding: '10px 14px', borderRadius: '12px', textDecoration: 'none',
      font: '600 13px/1.2 system-ui, -apple-system, sans-serif',
      color: '#fff', background: '#111827', boxShadow: '0 8px 24px rgba(0,0,0,.28)'
    });
    document.body.appendChild(a);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add, { once: true });
  else add();
  const timer = setInterval(() => { add(); if (document.getElementById(ID)) clearInterval(timer); }, 1000);
  setTimeout(() => clearInterval(timer), 15000);
})();`,
        });
      };
      const off = ctx.on('webserver/index-inject', inject);
      if (typeof off === 'function') app.disposers.push(off);
    }
  } catch (err) {
    app.logger.debug?.('Web 入口注入不可用（可能不是 Web profile）', { error: err.message });
  }
}

// ───────────────────────── 工具（DSH Agent 可调用） ─────────────────────────

async function registerTools(app, ctx) {
  if (!ctx?.tools?.register || app.disposed) return;
  const failures = [];
  const tools = [
    {
      name: 'shabi_screen',
      description: '读取沙币的眼睛当前识别的屏幕上下文（应用、窗口、场景、文字、元素）。受隐私开关限制。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        const screen = await app.eye.getScreenContext({ force: true });
        if (!screen) return '当前无法获取屏幕上下文（暂停、无截屏能力或窗口不在白名单）。';
        return JSON.stringify(screen, null, 2);
      },
    },
    {
      name: 'shabi_memory_search',
      description: '检索沙币长期记忆（支持关键词/语义/场景相关性），返回摘要与证据。',
      parameters: {
        query: { type: 'string', required: true, description: '检索关键词或问题' },
        topK: { type: 'number', description: '返回条数，默认 6' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const found = await app.memory.searchMemory(args.query, Math.min(20, Math.max(1, Number(args.topK || 6))));
        return JSON.stringify(found.map((m) => ({ id: m.id, type: m.type, summary: m.summary, importance: m.importance, time: m.time, evidence: m.evidence })), null, 2);
      },
    },
    {
      name: 'shabi_memory_write',
      description: '向沙币长期记忆写入一条信息（自动去重、校验、加密存储）。',
      parameters: {
        content: { type: 'string', required: true, description: '要记住的内容' },
        type: { type: 'string', description: 'knowledge/observation/chat/todo/emotion/event/preference' },
        tags: { type: 'string', description: '逗号分隔标签' },
        importance: { type: 'number', description: '0..1，默认 0.5' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const entry = await app.memory.writeMemory({
          type: args.type || 'observation', content: args.content, summary: args.content,
          tags: args.tags || [], importance: args.importance ?? 0.5, source: { kind: 'tool' },
        });
        return JSON.stringify({ id: entry.id, type: entry.type, summary: entry.summary });
      },
    },
    {
      name: 'shabi_selfie',
      description: '按当前人格生成一张 AI 自拍（必须标注 AI 生成）。返回本地图片路径。',
      parameters: {
        scene: { type: 'string', description: '场景描述' },
        mood: { type: 'string', description: '情绪' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const result = await app.imageApi.generateSelfie({ personality: app.personality.getActive(), scene: args.scene || '室内', mood: args.mood || '' });
        if (!result.ok) return result.message;
        return JSON.stringify({ caption: result.caption, images: result.images, aiGenerated: true });
      },
    },
    {
      name: 'shabi_video_analyze',
      description: '登记并后台分析一个视频（本地路径或用户已授权会话中的 URL）。返回 videoId，可轮询 shabi_video_status。',
      parameters: {
        source: { type: 'string', required: true, description: '视频路径/URL' },
        mode: { type: 'string', description: 'frame/keyframe/hybrid' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const entry = await app.video.registerVideo(args.source, { mode: args.mode });
        app.video.run(entry.videoId, { mode: args.mode }).catch(() => {});
        return JSON.stringify({ videoId: entry.videoId, title: entry.title, status: entry.status });
      },
    },
    {
      name: 'shabi_video_status',
      description: '查询视频分析进度、覆盖率、完整性报告与摘要。',
      parameters: { videoId: { type: 'string', required: true, description: '视频 id' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const status = await app.video.getStatus(args.videoId);
        return status ? JSON.stringify(status, null, 2) : '找不到该视频';
      },
    },
    {
      name: 'shabi_personality',
      description: '列出、切换或新增人格。',
      parameters: {
        action: { type: 'string', required: true, description: 'list/switch/add' },
        name: { type: 'string', description: '人格名称' },
        definition: { type: 'object', additionalProperties: true, description: '新增时的定义对象' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        if (args.action === 'list') return JSON.stringify(app.personality.listPersonalities(), null, 2);
        if (args.action === 'switch') {
          const p = await app.personality.setActive(args.name);
          return `已切换到 ${p.name}`;
        }
        if (args.action === 'add') {
          const p = await app.personality.addPersonality(args.definition || { name: args.name });
          return `已新增人格 ${p.name}（${p.id}）`;
        }
        return '未知 action';
      },
    },
    {
      name: 'shabi_goal',
      description: '为沙币设置一个目标/待办，自主循环会在合适时机提醒或推进。',
      parameters: {
        title: { type: 'string', required: true, description: '目标标题' },
        due: { type: 'string', description: 'ISO 截止时间' },
        priority: { type: 'number', description: '0..10' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const goal = await app.autonomy.setGoal({ title: args.title, due: args.due, priority: args.priority });
        return JSON.stringify(goal);
      },
    },
    {
      name: 'shabi_content',
      description: '内容执行层：刷 B 站推荐、学一条 B 站视频、打开/翻页/学习小说。使用用户本人登录 Cookie，遇风控立即停止。',
      parameters: {
        action: { type: 'string', required: true, description: 'feed/next/bilibiliLearn/novelOpen/novelNext/novelLearn/learnText' },
        bvid: { type: 'string', description: 'B 站 BV 号或视频链接' },
        url: { type: 'string', description: '小说页面地址' },
        text: { type: 'string', description: 'learnText 的文本' },
        title: { type: 'string', description: 'learnText 的标题' },
        limit: { type: 'number', description: '推荐条数，默认 12' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        if (args.action === 'feed') return JSON.stringify(await app.content.bilibiliFeed({ limit: args.limit, fresh: true }), null, 2);
        if (args.action === 'next') return JSON.stringify(await app.content.bilibiliNext({ limit: args.limit }), null, 2);
        if (args.action === 'bilibiliLearn') return JSON.stringify(await app.content.bilibiliLearn(args.bvid || args.url), null, 2);
        if (args.action === 'novelOpen') return JSON.stringify(await app.content.novelOpen(args.url), null, 2);
        if (args.action === 'novelNext') return JSON.stringify(await app.content.novelNext(), null, 2);
        if (args.action === 'novelLearn') return JSON.stringify(await app.content.novelLearn(), null, 2);
        if (args.action === 'learnText') return JSON.stringify(await app.content.learnText({ title: args.title || '文本学习', text: args.text || '', source: 'tool', tags: ['学习'] }), null, 2);
        return '未知 action';
      },
    },
    {
      name: 'shabi_status',
      description: '查看沙币的宿主能力、记忆、视频、人格、自主循环与 QQ 连接状态。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        return JSON.stringify(buildStatus(app), null, 2);
      },
    },
  ];

  for (const tool of tools) {
    try {
      const def = withJsonSchema(tool);
      const dispose = ctx.tools.register(def);
      if (typeof dispose === 'function') app.disposers.push(dispose);
    } catch (err) {
      app.logger.warn('工具注册失败', { tool: tool.name, error: err.message });
      failures.push(tool.name);
    }
  }
  app.logger.info('工具注册完成', { registered: tools.length - failures.length, total: tools.length, failures });
}

/**
 * 把插件内部的简易参数描述转成 DSH ToolsService 能接受、可投影的 JSON Schema。
 * 这样不需要在插件包里硬依赖 @deepseek-ai/dsh-tools，也能在 Web/headless 使用。
 */
function withJsonSchema(tool) {
  if (tool.parameters && tool.parameters.type === 'object' && tool.parameters.properties) return tool;
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(tool.parameters || {})) {
    const item = { type: spec.type || 'string' };
    if (spec.description) item.description = spec.description;
    if (spec.additionalProperties !== undefined) item.additionalProperties = spec.additionalProperties;
    if (spec.type === 'object') item.additionalProperties = spec.additionalProperties ?? true;
    properties[key] = item;
    if (spec.required) required.push(key);
  }
  return {
    ...tool,
    parameters: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
  };
}

// ───────────────────────── HTTP 设置 API ─────────────────────────

function setupApiRoutes(app) {
  const disposers = [];
  const register = (routePath, handler, kind = 'exact') => {
    try {
      if (!app.host.http.registerRoute) {
        app.logger.debug?.('当前 profile 没有 HTTP 服务，设置页将在独立 dev-server 中运行');
        return;
      }
      const disposer = app.host.http.registerRoute(routePath, safeHandler(app, handler), kind);
      if (typeof disposer === 'function') disposers.push(disposer);
      else if (disposer) disposers.push(() => {});
    } catch (err) {
      app.logger.warn('注册设置 API 失败', { path: routePath, error: err.message });
    }
  };

  register('/shabi/settings', async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { ok: false, error: 'method not allowed' });
    let html = await fs.readFile(path.join(app.root, 'ui', 'settings.html'), 'utf8');
    html = html.replace('<head>', '<head>\n  <base href="/shabi/ui/" />');
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: html };
  });

  register('/shabi/ui', async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { ok: false, error: 'method not allowed' });
    const pathname = req.path || new URL(String(req.url || '/'), 'http://localhost').pathname;
    const encoded = String(pathname).replace(/^\/shabi\/ui\/?/, '');
    let rel = '';
    try { rel = decodeURIComponent(encoded); } catch { return json(400, { ok: false, error: 'bad path' }); }
    if (!rel || rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) return json(404, { ok: false, error: 'not found' });
    const file = path.join(app.root, 'ui', rel);
    const mime = mimeForUi(file);
    if (!mime) return json(404, { ok: false, error: 'not found' });
    try {
      const body = await fs.readFile(file);
      return { status: 200, headers: { 'content-type': mime, 'cache-control': 'no-store' }, body };
    } catch {
      return json(404, { ok: false, error: 'not found' });
    }
  }, 'prefix');

  register('/shabi/api/settings', async (req) => {
    if (req.method === 'GET') {
      return json({ ok: true, config: redactConfigForUi(app.config), schema: app.schema, status: buildStatus(app), personality: app.personality.listPersonalities(), warnings: app.warnings });
    }
    if (req.method === 'POST') return saveSettings(app, req.body);
    return json(405, { ok: false, error: 'method not allowed' });
  });

  register('/shabi/api/status', async () => json({ ok: true, status: buildStatus(app) }));

  register('/shabi/api/eye', async (req) => {
    if (req.method === 'GET') return json({ ok: true, eye: app.eye.getStatus() });
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
    const action = req.body?.action || 'test';
    if (action === 'pause') return json({ ok: true, result: app.eye.pause('settings') });
    if (action === 'resume') return json({ ok: true, result: app.eye.resume() });
    if (action === 'test') {
      const context = await app.eye.getScreenContext({ force: true });
      return json({ ok: Boolean(context), result: context, error: context ? null : '眼睛当前暂停，或没有拿到屏幕内容' });
    }
    return json(400, { ok: false, error: '未知 action' });
  });

  register('/shabi/api/memory', async (req) => {
    if (req.method === 'GET') return memoryList(app, req.query);
    if (req.method === 'POST') return memoryAction(app, req.body);
    return json(405, { ok: false, error: 'method not allowed' });
  });

  register('/shabi/api/personalities', async (req) => personalityApi(app, req));

  register('/shabi/api/image', async (req) => {
    if (req.method === 'GET') return json({ ok: true, status: app.imageApi.getStatus() });
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
    const action = req.body?.action;
    if (action === 'test') {
      const cfg = deepMerge(app.config.imageApi, req.body.config || {});
      const result = await app.imageApi.testConnection(cfg);
      return json({ ok: result.ok, result });
    }
    if (action === 'generate') {
      const cfg = deepMerge(app.config.imageApi, req.body.config || {});
      const result = await app.imageApi.generateSelfie(cfg, app.personality.getActive(), { scene: req.body.scene, mood: req.body.mood });
      return json({ ok: result.ok, result });
    }
    return json(400, { ok: false, error: '未知 action' });
  });

  register('/shabi/api/content', async (req) => contentApi(app, req));

  register('/shabi/api/video', async (req) => videoApi(app, req));

  register('/shabi/api/qq', async (req) => qqApi(app, req));

  register('/shabi/api/safety', async (req) => safetyApi(app, req));

  register('/shabi/api/accounts', async (req) => accountsApi(app, req));

  register('/shabi/api/interest', async (req) => interestApi(app, req));

  register('/shabi/api/knowledge', async (req) => knowledgeApi(app, req));

  register('/shabi/api/logs', async (req) => {
    const lines = await app.logger.tail(Math.min(500, Number(req.query.lines || 100)));
    return json({ ok: true, lines });
  });

  register('/shabi/api/file', async (req) => {
    if (req.method !== 'GET') return json(405, { ok: false, error: 'method not allowed' });
    const target = String(req.query.path || '');
    if (!target) return json(400, { ok: false, error: '缺少 path' });
    const allowed = await app.safety.isPathAllowed(target, { write: false, internal: true });
    if (!allowed.ok) return json(403, { ok: false, error: allowed.reason });
    const resolved = allowed.resolved;
    const roots = [app.paths.selfies, app.paths.frames, path.join(app.paths.data, 'screenshots')];
    if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
      return json(403, { ok: false, error: '只允许读取插件生成的图片' });
    }
    const mime = mimeFor(resolved);
    if (!mime) return json(403, { ok: false, error: '不允许的文件类型' });
    const body = await fs.readFile(resolved);
    return { status: 200, headers: { 'content-type': mime, 'cache-control': 'no-store' }, body };
  });

  register('/shabi/api/selfcheck', async (req) => {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
    const { runSelfcheck } = await import('./scripts/selfcheck.js');
    const report = await runSelfcheck(app);
    return json({ ok: Boolean(report.ok), report });
  });

  register('/shabi/api/command', async (req) => {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
    const result = await app.chatEnhance.handleCommand(String(req.body?.text || ''));
    return json({ ok: true, result });
  });

  app.apiDisposers = disposers;
  return disposers;
}

function safeHandler(app, fn) {
  return async (req) => {
    try {
      return await fn(req);
    } catch (err) {
      app.logger.error('设置 API 处理失败', { path: req?.path, error: err.message });
      return json(500, { ok: false, error: err.message });
    }
  };
}

async function saveSettings(app, body) {
  const incoming = body?.config || body || {};
  const next = mergeIncomingConfig(app.config, incoming);
  if (incoming.dataDir && String(incoming.dataDir) !== String(app.config.dataDir)) {
    app.logger.warn('dataDir 变更需重启宿主后生效；本次仍使用旧目录', { from: app.config.dataDir, to: incoming.dataDir });
  }
  const validation = validateConfig(next);
  if (!validation.ok) return json(400, { ok: false, errors: validation.errors, warnings: validation.warnings });
  await saveConfig(next, { crypto: app.crypto, logger: app.logger });
  const runtimeWarnings = await applyRuntimeConfig(app, next);
  return json({
    ok: true,
    config: redactConfigForUi(app.config),
    warnings: [...validation.warnings, ...runtimeWarnings],
    status: buildStatus(app),
  });
}

function mergeIncomingConfig(base, incoming) {
  const cleaned = JSON.parse(JSON.stringify({ ...base, __paths: undefined }));
  const out = mergeValue(cleaned, incoming || {});
  out.__paths = base.__paths;
  for (const p of SECRET_PATHS) {
    if (isMaskedSecret(getByPath(out, p))) setByPath(out, p, getByPath(base, p));
  }
  if (!out.dataDir) out.dataDir = base.dataDir;
  return out;
}

function mergeValue(base, incoming) {
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(incoming)) {
    if (k === '__paths') continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeValue(out[k], v) : v;
  }
  return out;
}

async function applyRuntimeConfig(app, next) {
  const prev = app.config;
  const warnings = [];
  next.__paths = prev.__paths;
  app.config = next;
  app.memory.config = next.memory;
  app.video.config = next.video;
  app.knowledge.config = next.knowledge;
  app.interest.config = next.interest;
  app.autonomy.config = next.autonomy;
  app.qq.config = next.qqBot;
  app.imageApi.config = next.imageApi;
  app.eye.config = next.eye;
  app.eye.privacy = next.eye?.privacy || app.eye.privacy;
  app.logger.setLevel(next.logging?.level || app.logger.level);
  app.safety = new Safety(app);
  try {
    if (next.personality?.active && next.personality.active !== prev.personality?.active) {
      await app.personality.setActive(next.personality.active);
    }
  } catch (err) {
    warnings.push(`人格切换失败：${err.message}`);
  }

  const eyeChanged = next.eye?.enabled !== prev.eye?.enabled || next.eye?.intervalSec !== prev.eye?.intervalSec || next.eye?.mode !== prev.eye?.mode;
  if (eyeChanged) {
    app.eye.stop();
    if (next.eye?.enabled && next.eye?.mode !== 'manual') {
      await app.eye.start().catch((err) => warnings.push(`眼睛重启失败：${err.message}`));
    }
  }
  if (next.eye?.privacy?.paused !== undefined) {
    if (next.eye.privacy.paused) app.eye.pause('settings'); else app.eye.resume();
  }

  if (next.autonomy?.enabled) {
    await app.autonomy.startLoop({ enabled: true }).catch((err) => warnings.push(`自主循环启动失败：${err.message}`));
  } else {
    app.autonomy.stopLoop();
  }

  if (next.qqBot?.enabled) {
    await app.qq.startBot(next.qqBot).catch((err) => warnings.push(`QQ 机器人启动失败：${err.message}`));
  } else {
    await app.qq.stopBot().catch(() => {});
  }
  return warnings;
}

function buildStatus(app) {
  const personality = app.personality.getActive();
  return {
    name, version, startedAt: app.startedAt, disposed: app.disposed,
    capabilities: app.host.capabilities,
    config: {
      dataDir: app.config.dataDir,
      eye: { enabled: app.config.eye?.enabled, mode: app.config.eye?.mode, intervalSec: app.config.eye?.intervalSec },
      video: app.config.video,
      autonomy: app.config.autonomy,
      personality: personality ? { id: personality.id, name: personality.name } : null,
      image: app.imageApi.getStatus(),
      qq: app.qq.getStatus(),
      llmConfigured: Boolean(app.config.llm?.endpoint && app.config.llm?.model),
      coverageThreshold: app.config.video?.coverageThreshold,
    },
    eye: app.eye.getStatus(),
    memory: app.memory.getStats(),
    video: { jobs: app.video.listVideos({ limit: 20 }) },
    knowledge: app.knowledge.getStats(),
    autonomy: app.autonomy.getStatus(),
    qq: app.qq.getStatus(),
    interest: app.interest.getStatus(),
    content: app.content?.getStatus?.(),
    safety: app.safety.getStatus(),
    personalities: app.personality.listPersonalities(),
    accounts: app.config.accounts?.platforms || [],
    routes: app.routes?.length || 0,
  };
}

async function memoryList(app, query) {
  const q = query.q || query.query;
  const limit = Math.min(100, Number(query.limit || 30));
  if (q) {
    return app.memory.searchMemory(q, limit, { touch: false }).then((items) => json({ ok: true, items, mode: 'search' }));
  }
  if (query.archive === '1') {
    const items = await app.memory.readArchiveEntries();
    return json({ ok: true, items: items.slice(0, limit), total: items.length, mode: 'archive' });
  }
  const list = app.memory.listMemories({ type: query.type, limit, offset: Number(query.offset || 0) });
  return json({ ok: true, ...list, mode: 'list' });
}

async function memoryAction(app, body = {}) {
  const action = body.action;
  const id = body.id;
  if (action === 'delete') {
    const result = await app.memory.deleteMemory(id);
    await app.safety.logAction({ action: 'delete_memory', risk: 'medium', detail: { id }, approved: true, approvedBy: 'settings-ui', result });
    return json({ ok: result.ok, result });
  }
  if (action === 'archive') return json({ ok: true, result: await app.memory.archiveMemory(id, 'manual') });
  if (action === 'unarchive') return json({ ok: true, result: await app.memory.unarchiveMemory(id) });
  if (action === 'forget') return json({ ok: true, result: await app.memory.forgetTick() });
  if (action === 'compress') return json({ ok: true, result: await app.memory.compressMemory() });
  if (action === 'consolidate') return json({ ok: true, result: await app.memory.consolidate(id) });
  if (action === 'export') {
    const target = body.path || path.join(app.paths.memory, 'export');
    const result = await app.memory.exportMemory(target, { format: body.format || 'ini' });
    return json({ ok: true, result });
  }
  if (action === 'resurface') {
    const result = await app.memory.resurfaceMemory(body.query || '');
    return json({ ok: Boolean(result), result, message: result ? '突然想起来了' : '归档里没有匹配的记忆' });
  }
  if (action === 'archived') {
    const items = await app.memory.readArchiveEntries();
    return json({ ok: true, items: items.map((x) => ({ id: x.id, summary: x.summary, type: x.type, archivedAt: x.archivedAt, archiveReason: x.archiveReason })) });
  }
  return json(400, { ok: false, error: '未知 action' });
}

async function personalityApi(app, req) {
  if (req.method === 'GET') {
    return json({
      ok: true,
      active: app.personality.getActive()?.id,
      items: app.personality.listPersonalities(),
      definition: app.personality.getActive(),
      definitions: Object.values(app.personality.custom || {}),
    });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  const { action, id, definition } = req.body || {};
  if (action === 'add') return json({ ok: true, personality: await app.personality.addPersonality(definition) });
  if (action === 'update') return json({ ok: true, personality: await app.personality.updatePersonality(id, definition) });
  if (action === 'remove') return json({ ok: true, result: await app.personality.removePersonality(id) });
  if (action === 'active') {
    const p = await app.personality.setActive(req.body.name || id);
    app.config.personality.active = p.id;
    await saveConfig(app.config, { crypto: app.crypto, logger: app.logger });
    return json({ ok: true, personality: p });
  }
  return json(400, { ok: false, error: '未知 action' });
}

async function contentApi(app, req) {
  if (req.method === 'GET') {
    if (req.query.action === 'feed') return json({ ok: true, ...(await app.content.bilibiliFeed({ limit: req.query.limit })) });
    if (req.query.action === 'next') return json({ ok: true, ...(await app.content.bilibiliNext({ limit: req.query.limit })) });
    if (req.query.action === 'novel') {
      if (!app.content.state.novel?.current) return json({ ok: false, error: '还没有打开小说' });
      const cur = app.content.state.novel.current;
      const page = await fs.readFile(cur.file, 'utf8').then(JSON.parse).catch(() => null);
      return page ? json({ ok: true, ...page }) : json(404, { ok: false, error: '小说缓存丢失' });
    }
    return json({ ok: true, status: app.content.getStatus() });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  const { action } = req.body || {};
  if (action === 'feed') return json({ ok: true, ...(await app.content.bilibiliFeed({ limit: req.body.limit, fresh: true })) });
  if (action === 'next') return json({ ok: true, ...(await app.content.bilibiliNext({ limit: req.body.limit })) });
  if (action === 'bilibiliLearn') return json({ ok: true, ...(await app.content.bilibiliLearn(req.body.bvid || req.body.url, { download: req.body.download })) });
  if (action === 'novelOpen') return json({ ok: true, ...(await app.content.novelOpen(req.body.url)) });
  if (action === 'novelNext') return json({ ok: true, ...(await app.content.novelNext()) });
  if (action === 'novelLearn') return json({ ok: true, ...(await app.content.novelLearn()) });
  if (action === 'learnText') return json({ ok: true, ...(await app.content.learnText(req.body)) });
  return json(400, { ok: false, error: '未知 action' });
}

async function videoApi(app, req) {
  if (req.method === 'GET') {
    if (req.query.id) {
      const status = await app.video.getStatus(req.query.id);
      return status ? json({ ok: true, video: status }) : json(404, { ok: false, error: '视频不存在' });
    }
    const artifacts = req.query.artifactsOf ? await app.video.readArtifacts(req.query.artifactsOf) : null;
    return json({ ok: true, videos: app.video.listVideos({ limit: Number(req.query.limit || 30) }), artifacts });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  const { action, source, mode, id } = req.body || {};
  if (action === 'register') {
    if (!source) return json(400, { ok: false, error: '缺少 source' });
    const entry = await app.video.registerVideo(source, { mode, title: req.body.title });
    if (req.body.run !== false) {
      app.video.run(entry.videoId, { mode }).catch((err) => app.logger.error('视频分析失败', { videoId: entry.videoId, error: err.message }));
    }
    return json({ ok: true, video: entry, started: req.body.run !== false });
  }
  if (action === 'run') {
    if (!id) return json(400, { ok: false, error: '缺少 id' });
    app.video.run(id, { mode, force: Boolean(req.body.force) }).catch((err) => app.logger.error('视频分析失败', { videoId: id, error: err.message }));
    return json({ ok: true, started: true, videoId: id });
  }
  if (action === 'cancel') {
    const result = await app.video.cancel(id);
    return json({ ok: true, result });
  }
  if (action === 'register-and-run') {
    const entry = await app.video.registerVideo(source, { mode, title: req.body.title });
    const result = await app.video.run(entry.videoId, { mode });
    return json({ ok: true, video: result });
  }
  return json(400, { ok: false, error: '未知 action' });
}

async function qqApi(app, req) {
  if (req.method === 'GET') return json({ ok: true, status: app.qq.getStatus() });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  const action = req.body?.action;
  if (action === 'start') {
    const result = await app.qq.startBot({ ...app.config.qqBot, enabled: true });
    app.config.qqBot.enabled = true;
    await saveConfig(app.config, { crypto: app.crypto, logger: app.logger });
    return json({ ok: true, result, status: app.qq.getStatus() });
  }
  if (action === 'stop') {
    await app.qq.stopBot();
    return json({ ok: true, status: app.qq.getStatus() });
  }
  if (action === 'test') return json({ ok: true, result: await app.qq.testConnection(), status: app.qq.getStatus() });
  if (action === 'status') return json({ ok: true, status: app.qq.getStatus() });
  return json(400, { ok: false, error: '未知 action' });
}

async function safetyApi(app, req) {
  if (req.method === 'GET') {
    return json({ ok: true, status: app.safety.getStatus(), actions: await app.safety.listActions(Number(req.query.limit || 50)) });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  const { action, path: targetPath, logId } = req.body || {};
  if (action === 'checkPath') return json({ ok: true, result: await app.safety.isPathAllowed(targetPath, { write: Boolean(req.body.write) }) });
  if (action === 'rollback') {
    const result = await app.safety.rollback(logId);
    return json({ ok: true, result });
  }
  if (action === 'confirm') return json({ ok: true, result: await app.safety.confirmAction(req.body.request || {}) });
  return json(400, { ok: false, error: '未知 action' });
}

async function accountsApi(app, req) {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  const platform = req.body?.platform;
  if (!platform) return json(400, { ok: false, error: '缺少 platform' });
  const result = await app.host.accounts.check(platform);
  const platforms = app.config.accounts?.platforms || [];
  const entry = platforms.find((p) => p.platform === platform);
  if (entry) {
    entry.authorized = Boolean(result.ok);
    entry.lastCheckedAt = result.checkedAt || nowIso();
    entry.note = result.reason || result.message || '';
    await saveConfig(app.config, { crypto: app.crypto, logger: app.logger });
  }
  return json({ ok: Boolean(result.ok), result, platforms });
}

async function interestApi(app, req) {
  if (req.method === 'GET') return json({ ok: true, status: app.interest.getStatus() });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  const { action, id, feedback, tags, title } = req.body || {};
  if (action === 'feedback') return json({ ok: true, result: await app.interest.feedback(id, feedback, { tags, title }) });
  if (action === 'clearBlock') return json({ ok: true, result: await app.interest.clearBlock() });
  if (action === 'ingest') return json({ ok: true, result: await app.interest.ingestFromMemory() });
  return json(400, { ok: false, error: '未知 action' });
}

async function knowledgeApi(app, req) {
  if (req.method === 'GET') {
    if (req.query.id) {
      const item = await app.knowledge.getKnowledge(req.query.id);
      return item ? json({ ok: true, item }) : json(404, { ok: false, error: '知识不存在' });
    }
    if (req.query.graph === '1') return json({ ok: true, graph: app.knowledge.getGraph({ limit: Number(req.query.limit || 50) }), stats: app.knowledge.getStats() });
    if (req.query.q) return json({ ok: true, items: await app.knowledge.searchKnowledge(req.query.q, Number(req.query.limit || 8)) });
    return json({ ok: true, stats: app.knowledge.getStats() });
  }
  return json(405, { ok: false, error: 'method not allowed' });
}

function json(status, body, headers = {}) {
  if (typeof status === 'object') {
    headers = body || {};
    body = status;
    status = 200;
  }
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body };
}

function mimeFor(file) {
  const ext = path.extname(String(file)).toLowerCase();
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  }[ext] || null;
}

function mimeForUi(file) {
  const ext = path.extname(String(file)).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }[ext] || null;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeLog(logger, level, message) {
  try {
    if (logger && typeof logger[level] === 'function') logger[level](message);
    else console.log(`[${level}] ${message}`);
  } catch {
    // ignore
  }
}

// ───────────────────────── CLI ─────────────────────────

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error('[shabi-plugin]', err);
    process.exitCode = 1;
  });
}

async function runCli(argv) {
  const cmd = argv[0] || 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`沙币 shabi-plugin v${version}

用法：
  node main.js selfcheck               运行自检（不需要宿主）
  node main.js init                    初始化数据目录与记忆库
  node main.js video <路径或URL> [mode] 分析一个视频
  node main.js settings                启动本地设置页（另开终端运行 scripts/dev-server.js）

环境变量：
  SHABI_LLM_ENDPOINT / SHABI_LLM_API_KEY / SHABI_LLM_MODEL
  SHABI_IMAGE_ENDPOINT / SHABI_IMAGE_API_KEY
  SHABI_CAPTURE_COMMAND / SHABI_ASR_COMMAND
  SHABI_MASTER_KEY（32 字节 base64/hex，可选）
`);
    return;
  }
  const app = await createShabiPlugin({});
  try {
    if (cmd === 'selfcheck') {
      const { runSelfcheck } = await import('./scripts/selfcheck.js');
      const report = await runSelfcheck(app);
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    } else if (cmd === 'init') {
      console.log(JSON.stringify({ ok: true, paths: app.paths, memory: app.memory.getStats(), personality: app.personality.getActive()?.id }, null, 2));
    } else if (cmd === 'video') {
      const source = argv[1];
      if (!source) throw new Error('缺少视频路径或 URL');
      const mode = argv[2] || 'hybrid';
      const entry = await app.video.registerVideo(source, { mode });
      const result = await app.video.run(entry.videoId, { mode });
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`未知命令：${cmd}`);
      process.exitCode = 1;
    }
  } finally {
    await app.dispose();
  }
}

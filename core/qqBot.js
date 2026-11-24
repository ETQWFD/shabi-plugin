/**
 * core/qqBot.js — QQ 官方机器人接入（Webhook / WebSocket）。
 *
 * 明确边界：只使用 QQ 官方机器人平台，不实现个人号自动化、不读取他人私聊、
 * 不批量私信/评论/刷量；收到 @ 后走与桌面端一致的人格+记忆链路。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DedupeSet, RateLimiter, nowIso, clamp, shortHash, sleep, inQuietHours } from '../lib/util.js';
import { readFile as readIoshb, writeFileAtomic } from '../lib/ioshb.js';

const DEFAULT_INTENTS = (1 << 25) | (1 << 30); // GROUP_AT_MESSAGE_CREATE | PUBLIC_MESSAGES

export class QQBot {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.qqBot;
    this.host = ctx.host;
    this.logger = ctx.logger;
    this.dedupe = new DedupeSet({ max: 10000, ttlMs: Number(this.config.rateLimit?.dedupeWindow || 600) * 1000 });
    this.userLimiter = null;
    this.channelLimiter = null;
    this.ws = null;
    this.heartbeat = null;
    this.tokenCache = null;
    this.contexts = new Map();
    this.msgSeq = new Map();
    this.routeDisposer = null;
    this.mediaRoute = null;
    this.running = false;
    this.reconnectAttempts = 0;
    this.stats = { received: 0, replied: 0, skipped: 0, errors: 0, lastAt: null, lastError: null };
    this.lastC2C = null;
    this.proactiveState = null;
    this.qqStateFile = path.join(ctx.paths.data, 'qq_state.ioshb');
  }

  async init() {
    this.#buildLimiters();
    this.proactiveState = (await readIoshb(this.qqStateFile).catch(() => null)) || {
      format: 'IOSHB1', version: 1, lastC2C: null,
      proactive: { day: null, count: 0, lastAt: null, suppressedUntil: null, unanswered: 0, finalSentAt: null, awayMode: false, lastUserAt: null },
    };
    this.lastC2C = this.proactiveState.lastC2C || null;
    this.proactiveState.proactive = this.proactiveState.proactive || {};
    return this;
  }

  async #saveState() {
    this.proactiveState = this.proactiveState || { format: 'IOSHB1', version: 1, lastC2C: null, proactive: {} };
    this.proactiveState.lastC2C = this.lastC2C || null;
    this.proactiveState.updatedAt = nowIso();
    await writeFileAtomic(this.qqStateFile, this.proactiveState).catch(() => {});
  }

  #buildLimiters() {
    const rl = this.config.rateLimit || {};
    const perUser = Number(rl.perUserPerMin || 6);
    const perChannel = Number(rl.perChannelPerMin || 20);
    this.userLimiter = new RateLimiter({ capacity: perUser, refillPerSec: perUser / 60 });
    this.channelLimiter = new RateLimiter({ capacity: perChannel, refillPerSec: perChannel / 60 });
  }

  async startBot(config = {}) {
    this.config = { ...this.config, ...config };
    if (!this.config.enabled && config.enabled !== true) return { running: false, reason: 'qqBot.enabled=false' };
    if (!this.config.appId || !this.config.appSecret) throw new Error('QQ 机器人缺少 appId/appSecret');
    this.#buildLimiters();
    await this.init();
    this.running = true;
    if (this.config.mode === 'webhook') {
      const routePath = this.config.webhookPath || '/shabi/qq/webhook';
      const disposer = this.host.http.registerRoute(routePath, (req) => this.handleWebhook(req));
      if (!disposer) throw new Error('宿主未提供 HTTP 路由能力，无法使用 Webhook 模式');
      this.routeDisposer = disposer;
      await this.#ensureMediaRoute();
      this.logger?.info('QQ Webhook 已启动', { path: routePath });
      return { running: true, mode: 'webhook', path: routePath };
    }
    await this.#connectWebSocket();
    this.logger?.info('QQ WebSocket 已启动');
    return { running: true, mode: 'websocket' };
  }

  async stopBot() {
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
    this.ws = null;
    if (this.routeDisposer) {
      try { this.routeDisposer(); } catch { /* ignore */ }
    }
    this.routeDisposer = null;
    this.logger?.info('QQ 机器人已停止');
    return { running: false };
  }

  // ───────────────────────── Webhook ─────────────────────────

  async handleWebhook(req = {}) {
    const headers = normalizeHeaders(req.headers || {});
    const rawBody = typeof req.rawBody === 'string'
      ? req.rawBody
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body || {});
    const signature = headers['x-signature-ed25519'];
    const timestamp = headers['x-signature-timestamp'];
    if (!signature || !timestamp || !this.#verifySignature(rawBody, signature, timestamp)) {
      this.logger?.warn('QQ Webhook 验签失败', { ip: req.ip });
      return { status: 401, body: { error: 'invalid signature' } };
    }
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'invalid json' } };
    }

    // 回调地址校验
    if (event.op === 13 && event.d?.plain_token) {
      const eventTs = event.d.event_ts || headers['x-signature-timestamp'] || '';
      const sign = this.#signPlainToken(event.d.plain_token, eventTs);
      return { status: 200, body: { plain_token: event.d.plain_token, signature: sign } };
    }
    if (event.op === 0 && event.t && event.d) {
      setImmediate(() => {
        this.#dispatch(event.t, event.d).catch((err) => this.logger?.error('QQ 事件处理失败', { error: err.message }));
      });
    }
    return { status: 200, body: { op: 12 } };
  }

  #seed() {
    const secret = String(this.config.appSecret || '');
    const buf = Buffer.from(secret, 'utf8');
    if (buf.length === 32) return buf;
    return crypto.createHash('sha256').update(secret).digest();
  }

  #privateKey() {
    const seed = this.#seed();
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }

  #publicKey() {
    const priv = this.#privateKey();
    const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
    return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), spki.subarray(-32)]), format: 'der', type: 'spki' });
  }

  #verifySignature(body, signatureHex, timestamp) {
    try {
      const message = Buffer.from(`${timestamp}${body}`, 'utf8');
      const sig = Buffer.from(String(signatureHex), 'hex');
      return crypto.verify(null, message, this.#publicKey(), sig);
    } catch {
      return false;
    }
  }

  #signPlainToken(plainToken, eventTs) {
    const message = Buffer.from(`${plainToken}${eventTs}`, 'utf8');
    return crypto.sign(null, message, this.#privateKey()).toString('hex');
  }

  // ───────────────────────── WebSocket ─────────────────────────

  async #connectWebSocket() {
    const token = await this.#getAccessToken(true);
    const apiBase = this.#apiBase();
    const gatewayRes = await this.host.http.request(`${apiBase}/gateway`, {
      method: 'GET',
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      timeoutMs: 30000,
    });
    const url = gatewayRes.json?.url;
    if (!url) throw new Error(`获取 QQ WebSocket 网关失败：HTTP ${gatewayRes.status}`);
    if (typeof WebSocket === 'undefined') throw new Error('当前 Node 运行时没有 WebSocket，请升级到 Node 22+ 或使用 Webhook 模式');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.logger?.info('QQ WebSocket 已连接');
    });
    ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.#handleWsPayload(payload, token).catch((err) => this.logger?.error('QQ WS 事件失败', { error: err.message }));
    });
    ws.addEventListener('error', (err) => {
      this.stats.errors += 1;
      this.stats.lastError = err?.message || 'websocket error';
      this.logger?.warn('QQ WebSocket 错误', { error: this.stats.lastError });
    });
    ws.addEventListener('close', (code) => {
      this.logger?.warn('QQ WebSocket 关闭', { code });
      if (this.running) this.#scheduleReconnect();
    });
  }

  async #handleWsPayload(payload, token) {
    const op = payload.op;
    if (payload.s) this.lastSeq = payload.s;
    switch (op) {
      case 10: {
        const interval = Number(payload.d?.heartbeat_interval || 30000);
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.#sendWs({ op: 1, d: this.lastSeq || null }), interval);
        if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
        if (this.sessionId && this.lastSeq) {
          this.#sendWs({ op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq } });
        } else {
          this.#sendWs({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: Number(this.config.intents || DEFAULT_INTENTS),
              shard: [0, 1],
              properties: { $os: 'linux', $browser: 'shabi-plugin', $device: 'desktop' },
            },
          });
        }
        break;
      }
      case 0:
        if (payload.t === 'READY') {
          this.sessionId = payload.d?.session_id;
          this.logger?.info('QQ 机器人已就绪', { sessionId: this.sessionId });
        } else if (payload.t) {
          this.#dispatch(payload.t, payload.d).catch((err) => this.logger?.error('QQ WS 事件处理失败', { error: err.message }));
        }
        break;
      case 11:
        break;
      case 7:
        this.logger?.warn('QQ 网关要求重连');
        this.ws?.close();
        break;
      case 9:
        this.sessionId = null;
        this.lastSeq = null;
        this.ws?.close();
        break;
      default:
        break;
    }
  }

  #sendWs(obj) {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.logger?.warn('QQ WS 发送失败', { error: err.message });
    }
  }

  #scheduleReconnect() {
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 5) {
      this.logger?.error('QQ WebSocket 重连次数用尽');
      this.running = false;
      return;
    }
    const delay = Math.min(30000, 1500 * 2 ** this.reconnectAttempts);
    setTimeout(() => {
      if (!this.running) return;
      this.#connectWebSocket().catch((err) => {
        this.logger?.error('QQ WebSocket 重连失败', { error: err.message });
        this.running && this.#scheduleReconnect();
      });
    }, delay).unref?.();
  }

  // ───────────────────────── 事件归一化 ─────────────────────────

  async #dispatch(type, data) {
    let msg = null;
    if (type === 'AT_MESSAGE_CREATE') {
      msg = {
        type: 'guild',
        id: data.id,
        channelId: `guild:${data.channel_id}`,
        target: data.channel_id,
        userId: data.author?.id,
        userName: data.author?.username,
        content: data.content || '',
        mentions: data.mentions || [],
        guildId: data.guild_id,
        raw: data,
      };
    } else if (type === 'GROUP_AT_MESSAGE_CREATE') {
      msg = {
        type: 'group',
        id: data.id,
        channelId: `group:${data.group_openid}`,
        target: data.group_openid,
        userId: data.author?.member_openid,
        userName: data.author?.member_openid,
        content: data.content || '',
        raw: data,
      };
    } else if (type === 'C2C_MESSAGE_CREATE') {
      msg = {
        type: 'c2c',
        id: data.id,
        channelId: `c2c:${data.author?.user_openid}`,
        target: data.author?.user_openid,
        userId: data.author?.user_openid,
        content: data.content || '',
        raw: data,
      };
    }
    if (!msg) return { ignored: true, type };
    return this.onMention(msg);
  }

  async onMention(msg) {
    this.stats.received += 1;
    this.stats.lastAt = nowIso();
    if (!msg?.id || !msg?.channelId) return { skipped: true, reason: 'bad-message' };
    if (this.dedupe.has(`${msg.type}:${msg.id}`)) {
      this.stats.skipped += 1;
      return { skipped: true, reason: 'duplicate' };
    }
    this.dedupe.add(`${msg.type}:${msg.id}`);
    if (!this.running) return { skipped: true, reason: 'not-running' };
    if (!this.#channelAllowed(msg)) {
      this.stats.skipped += 1;
      this.logger?.info('QQ 消息频道不在白名单', { channelId: msg.channelId });
      return { skipped: true, reason: 'channel-not-allowed' };
    }
    if (!this.userLimiter.take(msg.userId || msg.channelId)) {
      this.stats.skipped += 1;
      return { skipped: true, reason: 'user-rate-limit' };
    }
    if (!this.channelLimiter.take(msg.channelId)) {
      this.stats.skipped += 1;
      return { skipped: true, reason: 'channel-rate-limit' };
    }
    const text = stripMentions(msg.content).trim().slice(0, 2000);
    if (!text) return { skipped: true, reason: 'empty' };
    this.contexts.set(msg.channelId, msg);
    if (this.contexts.size > 500) this.contexts.delete(this.contexts.keys().next().value);
    if (msg.type === 'c2c') {
      this.lastC2C = { type: 'c2c', channelId: msg.channelId, target: msg.target, userId: msg.userId, id: msg.id, at: nowIso() };
      this.proactiveState.proactive = this.proactiveState.proactive || {};
      this.proactiveState.proactive.lastUserAt = this.lastC2C.at;
      this.proactiveState.proactive.unanswered = 0;
      this.proactiveState.proactive.finalSentAt = null;
      this.proactiveState.proactive.awayMode = false;
      await this.#saveState();
    }
    if (this.config.proactive?.enabled && /^(别发了|停止主动|不要主动|别再找我|闭嘴)$/i.test(text)) {
      this.proactiveState.proactive = this.proactiveState.proactive || {};
      this.proactiveState.proactive.suppressedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await this.#saveState();
      await this.sendMessage(msg.channelId, '好，我最近不主动找你了。需要我时再叫我。');
      return { ok: true, channelId: msg.channelId, suppressed: true };
    }

    try {
      const result = await this.#replyPipeline(msg, text);
      if (result?.skip) return { skipped: true, reason: result.reason || 'pipeline-skip' };
      await this.sendMessage(msg.channelId, result.text, result.image);
      this.stats.replied += 1;
      return { ok: true, channelId: msg.channelId, text: result.text };
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = err.message;
      this.logger?.error('QQ 回复失败', { channelId: msg.channelId, error: err.message });
      try {
        await this.sendMessage(msg.channelId, '刚刚走神了，稍后再试。');
      } catch {
        // ignore
      }
      return { ok: false, error: err.message };
    }
  }

  #channelAllowed(msg) {
    const allowed = this.config.allowedChannels || [];
    if (allowed.length === 0) return true;
    return allowed.includes(msg.channelId) || allowed.includes(msg.target);
  }

  async #replyPipeline(msg, text) {
    const personality = this.ctx.personality.getActive();
    const memories = await this.ctx.memory.searchMemory(text, 5).catch(() => []);

    if (/^(帮助|help|命令)$/i.test(text)) {
      return {
        text: [
          '我能做的事：',
          '· 记住：<内容> —— 写入长期记忆',
          '· 你记得什么 / 还记得… —— 检索记忆',
          '· 忘掉：<关键词> —— 归档相关记忆',
          '· 发自拍 —— 生成一张 AI 自拍',
          '· 其他问题直接问我',
          '注意：QQ 端不能读取你电脑的屏幕，这是隐私边界。',
        ].join('\n'),
      };
    }
    if (/^(看屏幕|屏幕截图|截屏)$/i.test(text)) {
      return { text: 'QQ 端不能读取你电脑的屏幕。需要屏幕辅助请在桌面端使用。' };
    }
    let m = text.match(/^记住[:：]?\s*([\s\S]+)$/);
    if (m) {
      const entry = await this.ctx.memory.writeMemory({
        type: 'chat', summary: m[1].slice(0, 200), content: m[1], importance: 0.7,
        tags: ['qq', msg.type], source: { kind: 'qq', channelId: msg.channelId, userId: msg.userId },
      });
      return { text: `记住了。${personality?.id === 'tsundere' ? '……别、别以为我特意记的。' : ''}`.trim(), memoryId: entry.id };
    }
    m = text.match(/^忘掉[:：]?\s*([\s\S]+)$/);
    if (m) {
      const found = await this.ctx.memory.searchMemory(m[1], 3, { touch: false });
      if (!found.length) return { text: '没找到相关的记忆。' };
      for (const f of found) await this.ctx.memory.archiveMemory(f.id, 'user-qq-forget').catch(() => {});
      return { text: `已归档 ${found.length} 条相关记忆。` };
    }
    if (/^(你记得|还记得|记得什么|回忆)/.test(text)) {
      if (!memories.length) return { text: '我这儿暂时没有相关记忆。' };
      return { text: memories.slice(0, 3).map((x, i) => `${i + 1}. ${x.summary}`).join('\n') };
    }
    if (/^(发自拍|自拍|拍一张|拍照)/.test(text)) {
      const image = await this.ctx.imageApi.generateSelfie({ personality, scene: 'QQ 聊天中，室内自然光', mood: '轻松' });
      if (!image.ok) return { text: '拍糊了，等会儿再拍。' };
      return { text: image.caption || '给你，刚拍的。（AI 生成）', image: image.images?.[0] };
    }

    const system = [
      this.ctx.personality.buildSystemPrompt(personality, memories, null),
      '',
      '# QQ 场景',
      '- 你现在通过 QQ 官方机器人与用户对话；回复要短，适合手机阅读，尽量不超过 300 字。',
      '- 不读取用户电脑屏幕，不声称看到了 QQ 之外的内容。',
      '- 不主动私信、不群发、不刷屏；只回复 @ 你的这条消息。',
      '- 图片必须标注“AI 生成”。',
    ].join('\n');
    let reply = null;
    try {
      const res = await this.ctx.host.llm.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        { temperature: 0.5, maxTokens: 500 },
      );
      reply = res?.text?.trim();
    } catch (err) {
      this.logger?.warn('QQ LLM 回复失败，使用降级', { error: err.message });
    }
    if (!reply) {
      const snippet = memories[0]?.summary ? `我记得：${memories[0].summary}` : '我在。';
      reply = `${personality?.catchphrases?.[0] ? `${personality.catchphrases[0]} ` : ''}${snippet}`;
    }
    if (this.config.includeScreen && this.ctx.config.privacy?.qqReadScreen === true) {
      const screen = await this.ctx.eye.getScreenContext().catch(() => null);
      if (screen) reply += `\n（桌面当前：${screen.app} - ${screen.window}）`;
    }
    const max = Number(this.config.maxReplyChars || 800);
    if (reply.length > max) reply = `${reply.slice(0, max)}…`;
    return { text: reply };
  }

  // ───────────────────────── 发送 ─────────────────────────

  getProactiveStatus() {
    const p = this.proactiveState?.proactive || {};
    return {
      enabled: Boolean(this.config.proactive?.enabled),
      lastC2C: this.lastC2C ? { channelId: this.lastC2C.channelId, at: this.lastC2C.at } : null,
      lastAt: p.lastAt || null,
      count: resetDay(p).count,
      maxPerDay: Number(this.config.proactive?.maxPerDay || 7),
      minGapMin: Number(this.config.proactive?.minGapMin || 30),
      suppressedUntil: p.suppressedUntil || null,
      unanswered: Number(p.unanswered || 0),
      unansweredBeforeFinal: Number(this.config.proactive?.unansweredBeforeFinal || 6),
      finalSentAt: p.finalSentAt || null,
      awayMode: Boolean(p.awayMode),
    };
  }

  /** 主动 QQ 消息：必须显式开启、仅 C2C、限额、安静时段、用户可一句话停止。 */
  async sendProactive(text, { reason = 'idle' } = {}) {
    const cfg = this.config.proactive || {};
    if (!cfg.enabled) return { ok: false, reason: 'proactive-disabled' };
    if (!this.running) return { ok: false, reason: 'qq-not-running' };
    if (!this.lastC2C?.channelId) return { ok: false, reason: 'no-c2c-context' };
    const now = new Date();
    this.proactiveState.proactive = resetDay(this.proactiveState.proactive || {}, now);
    const p = this.proactiveState.proactive;
    if (p.suppressedUntil && now.getTime() < new Date(p.suppressedUntil).getTime()) return { ok: false, reason: 'user-suppressed' };
    if (p.awayMode) return { ok: false, reason: 'away-mode' };
    if (inQuietHours(cfg.quietHours || ['23:00', '07:00'], now)) return { ok: false, reason: 'quiet-hours' };
    const beforeFinal = Number(cfg.unansweredBeforeFinal || 6);
    if (p.finalSentAt && Number(p.unanswered || 0) >= beforeFinal && !p.awayMode) return { ok: false, reason: 'final-nudge-sent' };
    const isFinal = !p.finalSentAt && Number(p.unanswered || 0) >= beforeFinal;
    if (!isFinal && p.count >= Number(cfg.maxPerDay || 7)) return { ok: false, reason: 'daily-limit' };
    if (p.lastAt && now.getTime() - new Date(p.lastAt).getTime() < Number(cfg.minGapMin || 30) * 60000) return { ok: false, reason: 'gap-limit' };
    const ageHours = (now.getTime() - new Date(this.lastC2C.at || now).getTime()) / 3600000;
    if (ageHours > Number(cfg.maxAgeHours || 72)) return { ok: false, reason: 'context-too-old' };
    const content = String(text || '').trim().slice(0, Number(cfg.maxChars || 160));
    if (!content) return { ok: false, reason: 'empty' };
    try {
      await this.sendMessage(this.lastC2C, content, undefined, { proactive: true });
      p.count = Number(p.count || 0) + 1;
      p.unanswered = Number(p.unanswered || 0) + 1;
      p.lastAt = nowIso();
      p.lastReason = isFinal ? 'final-nudge' : reason;
      if (isFinal && cfg.awayAfterFinal !== false) p.awayMode = true;
      if (isFinal) p.finalSentAt = p.lastAt;
      await this.#saveState();
      this.stats.replied += 1;
      return { ok: true, channelId: this.lastC2C.channelId, reason: p.lastReason, final: isFinal };
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = err.message;
      return { ok: false, reason: 'send-failed', error: err.message };
    }
  }

  async sendMessage(channelId, content, image, { proactive = false } = {}) {
    const ctx = typeof channelId === 'object' ? channelId : this.contexts.get(channelId) || parseChannel(channelId);
    const msgId = ctx.id || ctx.msgId;
    if (!ctx?.target) throw new Error(`QQ 发送缺少目标：${channelId}`);
    const token = await this.#getAccessToken();
    const apiBase = this.#apiBase();
    const text = String(content || '').slice(0, Number(this.config.maxReplyChars || 800));
    let media = null;
    if (image) media = await this.#prepareMedia(ctx, image, token).catch((err) => {
      this.logger?.warn('QQ 图片准备失败，降级为文字', { error: err.message });
      return null;
    });

    let url;
    let body;
    if (ctx.type === 'group') {
      url = `${apiBase}/v2/groups/${ctx.target}/messages`;
      body = media
        ? { content: text || ' ', msg_type: 7, media, ...(proactive ? {} : { msg_id: msgId, msg_seq: this.#nextSeq(msgId) }) }
        : { content: text, msg_type: 0, ...(proactive ? {} : { msg_id: msgId, msg_seq: this.#nextSeq(msgId) }) };
    } else if (ctx.type === 'c2c') {
      url = `${apiBase}/v2/users/${ctx.target}/messages`;
      body = media
        ? { content: text || ' ', msg_type: 7, media, ...(proactive ? {} : { msg_id: msgId, msg_seq: this.#nextSeq(msgId) }) }
        : { content: text, msg_type: 0, ...(proactive ? {} : { msg_id: msgId, msg_seq: this.#nextSeq(msgId) }) };
    } else {
      url = `${apiBase}/channels/${ctx.target}/messages`;
      body = { content: text, ...(media?.url ? { image: media.url } : {}) };
      if (msgId) body.msg_id = msgId;
    }

    const result = await this.#apiRequest(url, token, body);
    if (image && !media) {
      this.logger?.info('QQ 图片未发送（缺少公网 URL 或上传能力），已发文字');
    }
    return { ok: true, response: result };
  }

  async #prepareMedia(ctx, image, token) {
    const publicUrl = await this.#publicUrl(image);
    if (!publicUrl) throw new Error('图片需要公网 URL 才能通过 QQ 官方接口发送');
    if (ctx.type === 'guild') return { url: publicUrl };
    if (ctx.type !== 'group' && ctx.type !== 'c2c') throw new Error(`不支持的消息类型：${ctx.type}`);
    const apiBase = this.#apiBase();
    const base = ctx.type === 'group' ? `${apiBase}/v2/groups/${ctx.target}/files` : `${apiBase}/v2/users/${ctx.target}/files`;
    const res = await this.#apiRequest(base, token, { file_type: 1, url: publicUrl, srv_send_msg: false });
    const fileInfo = res?.file_info;
    if (!fileInfo) throw new Error('QQ 富媒体上传未返回 file_info');
    return { file_info: fileInfo };
  }

  async #publicUrl(image) {
    if (typeof image === 'string' && /^https?:\/\//i.test(image)) return image;
    if (typeof image !== 'string') return null;
    const base = this.config.publicBaseUrl;
    if (!base) return null;
    await this.#ensureMediaRoute();
    const dir = path.join(this.ctx.paths.data, 'public', 'qq');
    await fs.mkdir(dir, { recursive: true });
    const name = `${shortHash(image)}${path.extname(image) || '.png'}`;
    const dest = path.join(dir, name);
    await fs.copyFile(image, dest);
    return `${base.replace(/\/$/, '')}/shabi/media/${name}`;
  }

  async #ensureMediaRoute() {
    if (this.mediaRoute || !this.host.capabilities.httpServer) return;
    this.mediaRoute = this.host.http.registerRoute('/shabi/media/', async (req) => {
      const name = path.basename(String(req.path || req.url || '').split('?')[0]);
      if (!/^[a-f0-9]{8,64}\.(png|jpg|jpeg|webp)$/i.test(name)) return { status: 404, body: 'not found' };
      const file = path.join(this.ctx.paths.data, 'public', 'qq', name);
      try {
        const buf = await fs.readFile(file);
        return { status: 200, headers: { 'content-type': mimeOf(name), 'cache-control': 'public, max-age=300' }, body: buf };
      } catch {
        return { status: 404, body: 'not found' };
      }
    });
  }

  #nextSeq(msgId) {
    const key = msgId || 'default';
    const n = (this.msgSeq.get(key) || 0) + 1;
    this.msgSeq.set(key, n);
    if (this.msgSeq.size > 500) this.msgSeq.delete(this.msgSeq.keys().next().value);
    return n;
  }

  async #apiRequest(url, token, body, attempt = 0) {
    try {
      const res = await this.host.http.request(url, {
        method: 'POST',
        headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json', 'x-union-appid': String(this.config.appId || '') },
        body: JSON.stringify(body),
        timeoutMs: 30000,
      });
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await sleep(1000 * (attempt + 1));
          return this.#apiRequest(url, token, body, attempt + 1);
        }
        throw new Error(res.json?.message || res.json?.error || res.text?.slice(0, 200) || `HTTP ${res.status}`);
      }
      return res.json || {};
    } catch (err) {
      if (attempt < 2 && !/HTTP 4\d\d/.test(err.message)) {
        await sleep(1000 * (attempt + 1));
        return this.#apiRequest(url, token, body, attempt + 1);
      }
      throw err;
    }
  }

  async #getAccessToken(force = false) {
    if (!force && this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30000) return this.tokenCache.value;
    const url = this.config.tokenUrl || 'https://bots.qq.com/app/getAppAccessToken';
    const res = await this.host.http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: String(this.config.appId), clientSecret: String(this.config.appSecret) }),
      timeoutMs: 30000,
    });
    const token = res.json?.access_token;
    if (!token) throw new Error(`获取 QQ access_token 失败：HTTP ${res.status}`);
    const expiresIn = Number(res.json?.expires_in || 7200);
    this.tokenCache = { value: token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }

  #apiBase() {
    if (this.config.apiBase) return String(this.config.apiBase).replace(/\/$/, '');
    return this.config.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
  }

  /** 只读测试：用 AppID/AppSecret 换取 access_token，不发送任何消息。 */
  async testConnection() {
    if (!this.config?.appId || !this.config?.appSecret) {
      return { ok: false, error: '缺少 appId 或 appSecret' };
    }
    try {
      const token = await this.#getAccessToken(true);
      return {
        ok: Boolean(token),
        appId: `${String(this.config.appId).slice(0, 4)}…`,
        tokenPreview: token ? `${token.slice(0, 6)}…` : '',
        mode: this.config.mode,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  getStatus() {
    return {
      enabled: Boolean(this.config.enabled),
      running: this.running,
      mode: this.config.mode,
      sandbox: Boolean(this.config.sandbox),
      appId: this.config.appId ? `${String(this.config.appId).slice(0, 4)}…` : '',
      stats: this.stats,
      webhookPath: this.config.webhookPath,
      mediaRoute: Boolean(this.mediaRoute),
    };
  }
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

function stripMentions(content) {
  return String(content || '').replace(/<@[!&]?\d+>/g, '').replace(/@\S+\s*/g, '').trim();
}

function resetDay(p, now = new Date()) {
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (p.day !== day) {
    p.day = day;
    p.count = 0;
  }
  return p;
}

function parseChannel(channelId) {
  const s = String(channelId || '');
  const idx = s.indexOf(':');
  if (idx < 0) return { type: 'guild', target: s };
  return { type: s.slice(0, idx), target: s.slice(idx + 1) };
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

export function createQQBot(ctx) {
  return new QQBot(ctx);
}

export { DEFAULT_INTENTS, stripMentions };

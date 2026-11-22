/**
 * core/autonomy.js — 自主行为循环与目标队列。
 *
 * 感知 → 检索记忆 → 决策 → 二次确认 → 执行白名单动作 → 记录 → 冷却。
 * 所有计数与冷却持久化到 data/autonomy_state.ioshb。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFile as readIoshb, writeFileAtomic } from '../lib/ioshb.js';
import { id as makeId, nowIso, clamp, inQuietHours, randomBetween, sleep, shortHash } from '../lib/util.js';

export class Autonomy {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.autonomy;
    this.stateFile = ctx.paths.autonomyState;
    this.host = ctx.host;
    this.logger = ctx.logger;
    this.timer = null;
    this.running = false;
    this.ticking = false;
    this.blockedUntil = 0;
    this.state = null;
    this.tickCount = 0;
  }

  async init() {
    this.state = (await readIoshb(this.stateFile).catch(() => null)) || {
      format: 'IOSHB1', version: 1, goals: [], daily: {}, hourly: {}, cooldowns: {},
      recentKeys: [], stats: { ticks: 0, actions: 0, denied: 0, skipped: 0 }, createdAt: nowIso(),
    };
    this.state.goals = Array.isArray(this.state.goals) ? this.state.goals : [];
    this.state.recentKeys = Array.isArray(this.state.recentKeys) ? this.state.recentKeys : [];
    return this;
  }

  async #save() {
    this.state.updatedAt = nowIso();
    await writeFileAtomic(this.stateFile, this.state);
  }

  async startLoop(overrides = {}) {
    if (!this.state) await this.init();
    this.config = { ...this.config, ...overrides };
    if (!this.config.enabled) return { running: false, reason: 'autonomy.enabled=false' };
    this.stopLoop();
    this.running = true;
    this.#schedule(0);
    this.logger?.info('自主循环启动', { intervalSec: this.config.intervalSec, dailyLimit: this.config.dailyLimit });
    return { running: true, intervalSec: this.config.intervalSec };
  }

  #schedule(delayMs = null) {
    if (!this.running) return;
    const base = Math.max(10, Number(this.config.intervalSec || 180)) * 1000;
    const jitter = Math.max(0, Number(this.config.jitterSec || 0)) * 1000;
    const delay = delayMs != null ? delayMs : randomBetween(base, base + jitter);
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        this.logger?.error('自主循环 tick 失败', { error: err.message });
      } finally {
        this.#schedule();
      }
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stopLoop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const was = this.running;
    this.running = false;
    if (was) this.logger?.info('自主循环已停止');
    return { running: false };
  }

  // ───────────────────────── 目标队列 ─────────────────────────

  async setGoal(goal) {
    if (!this.state) await this.init();
    const title = String(goal?.title || '').trim();
    if (!title) throw new Error('目标标题不能为空');
    if (title.length > 120) throw new Error('目标标题过长');
    const max = Number(this.config.maxGoals || 50);
    if (this.state.goals.filter((g) => g.status !== 'done').length >= max) throw new Error(`目标队列已达上限 ${max}`);
    const entry = {
      id: goal.id || makeId('goal'),
      title,
      detail: String(goal.detail || '').slice(0, 500),
      priority: clamp(Number(goal.priority ?? 5), 0, 10),
      due: goal.due ? new Date(goal.due).toISOString() : null,
      status: ['queued', 'active', 'done'].includes(goal.status) ? goal.status : 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const existing = this.state.goals.findIndex((g) => g.id === entry.id || (g.title === title && g.status !== 'done'));
    if (existing >= 0) this.state.goals[existing] = { ...this.state.goals[existing], ...entry, id: this.state.goals[existing].id };
    else this.state.goals.push(entry);
    await this.#save();
    this.host.ui.emit?.('shabi:goal-set', entry);
    return entry;
  }

  async updateGoal(goalId, patch) {
    const goal = this.state.goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`目标不存在：${goalId}`);
    if (patch.title !== undefined) goal.title = String(patch.title).slice(0, 120);
    if (patch.status !== undefined) goal.status = ['queued', 'active', 'done'].includes(patch.status) ? patch.status : goal.status;
    if (patch.priority !== undefined) goal.priority = clamp(Number(patch.priority), 0, 10);
    if (patch.due !== undefined) goal.due = patch.due ? new Date(patch.due).toISOString() : null;
    goal.updatedAt = nowIso();
    await this.#save();
    return goal;
  }

  async removeGoal(goalId) {
    this.state.goals = this.state.goals.filter((g) => g.id !== goalId);
    await this.#save();
    return { ok: true };
  }

  listGoals() {
    return [...(this.state?.goals || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.due || '').localeCompare(b.due || ''));
  }

  // ───────────────────────── 循环 ─────────────────────────

  /** 一次完整 tick；manual 跳过开关/安静时段/限额，但仍保留确认与冷却。 */
  async tick({ manual = false } = {}) {
    if (!this.state) await this.init();
    if (this.ticking) return { skipped: true, reason: 'tick-running' };
    this.ticking = true;
    const startedAt = Date.now();
    try {
      const now = new Date();
      this.tickCount += 1;
      this.state.stats.ticks = (this.state.stats.ticks || 0) + 1;

      if (!manual) {
        if (!this.config.enabled || !this.running) return this.#skip('disabled');
        if (inQuietHours(this.config.quietHours, now)) return this.#skip('quiet-hours');
        if (Date.now() < this.blockedUntil) return this.#skip('blocked-after-platform-signal');
        if (!this.#withinLimits(now)) return this.#skip('rate-limit');
      }

      const personality = this.ctx.personality.getActive();
      let screen = null;
      try {
        screen = await this.ctx.eye.getScreenContext();
      } catch (err) {
        this.logger?.debug('获取屏幕上下文失败', { error: err.message });
      }

      let memories = [];
      try {
        memories = screen
          ? await this.ctx.memory.recallByScene(screen, 6)
          : await this.ctx.memory.searchMemory('最近的事', 6);
      } catch (err) {
        this.logger?.debug('记忆召回失败', { error: err.message });
      }

      // 周期性“突然记起来”
      let resurfaced = null;
      if (this.tickCount % Math.max(5, Number(this.config.resurfaceEveryTicks || 20)) === 0 && screen) {
        try {
          resurfaced = await this.ctx.memory.resurfaceMemory(`${screen.window} ${screen.text?.slice(0, 120) || ''}`);
        } catch (err) {
          this.logger?.debug('归档召回失败', { error: err.message });
        }
      }

      const goals = this.listGoals().filter((g) => g.status !== 'done');
      let decision = resurfaced
        ? {
          action: 'speak', args: { text: `……我突然想起来了。之前记过：${resurfaced.summary}` },
          reason: '归档记忆被唤醒', confidence: 0.7, source: 'resurface', risk: 'low',
          dedupeKey: `resurface:${resurfaced.id}`,
        }
        : await this.ctx.decision.decide({ screen, memories, goals, personality, now });

      const validation = this.ctx.decision.validateDecision(decision);
      if (!validation.ok) {
        this.state.stats.skipped += 1;
        await this.#save();
        return { skipped: true, reason: `invalid-action:${validation.reason}` };
      }
      if (decision.action === 'noop') {
        this.state.lastTickAt = nowIso();
        await this.#save();
        return { skipped: true, reason: 'noop' };
      }
      if (!manual && this.#isDuplicate(decision, now)) return this.#skip('duplicate');
      if (!manual && this.#onCooldown(decision.action, now)) return this.#skip('cooldown');

      // 中高风险动作即使规则产生，也必须用户确认
      const needsConfirm = validation.risk !== 'low';
      let approved = true;
      let token = null;
      let approvedBy = 'auto-low';
      if (needsConfirm) {
        const confirmation = await this.ctx.safety.confirmAction({
          action: decision.action,
          detail: decision.args,
        });
        if (!confirmation.approved) {
          this.state.stats.denied += 1;
          this.state.lastTickAt = nowIso();
          await this.#save();
          this.logger?.info('动作被拒绝', { action: decision.action, reason: confirmation.reason });
          return { skipped: true, reason: 'user-denied', action: decision.action };
        }
        approved = true;
        token = confirmation.token;
        approvedBy = confirmation.approvedBy || 'user';
        if (!this.ctx.safety.verifyToken(token, { action: decision.action, detail: decision.args })) {
          throw new Error('确认 token 校验失败，动作已中止');
        }
      }

      const result = await this.#execute(decision, { screen, personality, memories, token, approvedBy, manual });
      await this.ctx.safety.logAction({
        action: decision.action,
        risk: validation.risk,
        detail: decision.args,
        approved: true,
        approvedBy,
        result: { ok: true, summary: summarizeResult(result) },
      });
      const at = nowIso();
      this.state.lastTickAt = at;
      this.state.lastAction = { action: decision.action, args: decision.args, at, result: summarizeResult(result) };
      this.state.stats.actions = (this.state.stats.actions || 0) + 1;
      this.state.cooldowns = this.state.cooldowns || {};
      this.state.cooldowns[decision.action] = at;
      this.#count(now);
      this.#rememberKey(decision, now);
      await this.#save();

      if (decision.args?.stopWatching) {
        this.blockedUntil = Date.now() + 30 * 60 * 1000;
        this.ctx.interest?.handlePlatformSignal?.({ type: 'screen-risk', detail: decision.args });
        this.logger?.warn('检测到平台限制信号，暂停自主操作 30 分钟');
      }
      this.host.ui.emit?.('shabi:autonomy-action', { decision, result, at });
      this.logger?.info('自主动作已执行', { action: decision.action, source: decision.source, ms: Date.now() - startedAt });
      return { ok: true, decision, result, at };
    } finally {
      this.ticking = false;
    }
  }

  async #execute(decision, { screen, personality, memories, token, approvedBy, manual }) {
    const args = decision.args || {};
    switch (decision.action) {
      case 'notify':
        await this.host.ui.notify(args.text, { source: 'autonomy', action: decision.action });
        return { delivered: 'notify' };
      case 'speak':
      case 'suggest':
        await this.host.chat.send(args.text, { source: 'autonomy', action: decision.action, risk: 'low' });
        return { delivered: 'chat', text: args.text };
      case 'remind':
        await this.host.ui.notify(args.text, { source: 'todo' });
        await this.host.chat.send(args.text, { source: 'autonomy', action: 'remind' });
        return { delivered: 'remind' };
      case 'save_note': {
        const entry = await this.ctx.memory.writeMemory({
          type: 'todo',
          summary: args.content,
          content: args.content,
          importance: 0.5,
          tags: args.tags || ['autonomy'],
          source: { kind: 'autonomy', screen: screen?.app || null },
        });
        return { memoryId: entry.id };
      }
      case 'generate_selfie': {
        const generated = await this.ctx.imageApi.generateSelfie({ personality, scene: args.scene || screen?.scene, mood: args.mood });
        if (!generated.ok) {
          await this.host.chat.send('拍糊了，等会儿再拍。', { source: 'autonomy', aiGenerated: true });
          return { ok: false, fallback: true };
        }
        await this.host.chat.send(generated.caption || '给你，刚拍的。', { image: generated.images?.[0], source: 'autonomy', aiGenerated: true });
        return { ok: true, image: generated.images?.[0] };
      }
      case 'watch_video': {
        const registered = await this.ctx.video.registerVideo(args.source);
        await this.host.ui.notify(`开始分析视频：${registered.title}`, { source: 'autonomy' });
        // 后台跑，避免阻塞 tick
        this.ctx.video.run(registered.videoId).catch((err) => this.logger?.error('自动观看视频失败', { videoId: registered.videoId, error: err.message }));
        return { videoId: registered.videoId, background: true };
      }
      case 'open_app': {
        this.ctx.safety.assertInputAllowed(args.app);
        const result = await this.ctx.host.input.run({ type: 'open_app', app: args.app });
        return { opened: args.app, result };
      }
      default:
        throw new Error(`执行层拒绝未知动作：${decision.action}`);
    }
  }

  // ───────────────────────── 限额 / 去重 / 冷却 ─────────────────────────

  #dayKey(now) {
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  }

  #hourKey(now) {
    return `${this.#dayKey(now)}-${now.getHours()}`;
  }

  #withinLimits(now) {
    const day = this.#dayKey(now);
    if (!this.state.daily || this.state.daily.key !== day) this.state.daily = { key: day, count: 0 };
    const hour = this.#hourKey(now);
    if (!this.state.hourly || this.state.hourly.key !== hour) this.state.hourly = { key: hour, count: 0 };
    if (this.state.daily.count >= Number(this.config.dailyLimit || 0)) return false;
    if (this.state.hourly.count >= Number(this.config.hourlyLimit || 0)) return false;
    return true;
  }

  #count(now) {
    this.state.daily.count += 1;
    this.state.hourly.count += 1;
  }

  #onCooldown(action, now) {
    const last = this.state.cooldowns?.[action];
    if (!last) return false;
    const dt = now.getTime() - new Date(last).getTime();
    return dt < Number(this.config.cooldownSec || 0) * 1000;
  }

  #isDuplicate(decision, now) {
    if (!decision.dedupeKey) return false;
    const keys = this.state.recentKeys || [];
    const hit = keys.find((k) => k.key === decision.dedupeKey && now.getTime() - new Date(k.at).getTime() < 60 * 60 * 1000);
    return Boolean(hit);
  }

  #rememberKey(decision, now) {
    if (!decision.dedupeKey) return;
    this.state.recentKeys.push({ key: decision.dedupeKey, at: now.toISOString() });
    this.state.recentKeys = this.state.recentKeys.filter((k) => now.getTime() - new Date(k.at).getTime() < 2 * 60 * 60 * 1000).slice(-200);
  }

  async #skip(reason) {
    this.state.stats.skipped = (this.state.stats.skipped || 0) + 1;
    this.state.lastSkip = { reason, at: nowIso() };
    await this.#save();
    return { skipped: true, reason };
  }

  getStatus() {
    const day = this.#dayKey(new Date());
    const daily = this.state?.daily?.key === day ? this.state.daily.count : 0;
    return {
      enabled: Boolean(this.config.enabled),
      running: this.running,
      intervalSec: this.config.intervalSec,
      quietHours: this.config.quietHours,
      dailyLimit: this.config.dailyLimit,
      dailyUsed: daily,
      hourlyLimit: this.config.hourlyLimit,
      hourlyUsed: this.state?.hourly?.count || 0,
      cooldownSec: this.config.cooldownSec,
      lastTickAt: this.state?.lastTickAt || null,
      lastAction: this.state?.lastAction || null,
      goals: this.listGoals().slice(0, 20),
      stats: this.state?.stats || {},
      blockedUntil: this.blockedUntil ? new Date(this.blockedUntil).toISOString() : null,
    };
  }

  /** 平台限制/验证码信号：立即停止自动化并提示。 */
  handlePlatformSignal(signal = {}) {
    this.blockedUntil = Date.now() + 30 * 60 * 1000;
    this.host.ui.notify('检测到验证码/风控/访问限制，已立即停止自动操作。请手动处理后，在设置中解除暂停。', { level: 'warn', signal });
    this.logger?.warn('平台限制信号', { type: signal.type, detail: signal.detail });
    return { stopped: true, blockedUntil: new Date(this.blockedUntil).toISOString() };
  }

  async resumeAfterBlock() {
    this.blockedUntil = 0;
    await this.#save();
    return { resumed: true };
  }
}

function summarizeResult(result) {
  if (!result) return null;
  if (result.delivered) return `delivered:${result.delivered}`;
  if (result.memoryId) return `memory:${result.memoryId}`;
  if (result.image) return 'image';
  if (result.videoId) return `video:${result.videoId}`;
  if (result.ok === false) return 'failed';
  return 'done';
}

export function createAutonomy(ctx) {
  return new Autonomy(ctx);
}

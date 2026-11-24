/**
 * core/companion.js — 空闲陪伴循环（受控自主）。
 *
 * 空闲时优先学习队列里的本地视频；没有学习任务且用户显式开启主动 QQ 时，
 * 才会发一条低频、限额、可随时喊停的主动消息。不自动登录平台、不刷视频、
 * 不自动收藏、不安装软件、不执行系统命令。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso, inQuietHours } from '../lib/util.js';

export class Companion {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.companion || {};
    this.media = ctx.media || null;
    this.stateFile = path.join(ctx.paths.data, 'companion_state.json');
    this.timer = null;
    this.running = false;
    this.ticking = false;
    this.state = { lastTickAt: null, lastAction: null, startedAt: null, messages: [] };
    this.logger = ctx.logger;
  }

  async init() {
    try { this.state = { ...this.state, ...JSON.parse(await fs.readFile(this.stateFile, 'utf8')) }; } catch { /* first run */ }
    return this;
  }

  start() {
    if (this.config.enabled === false) return { running: false, reason: 'companion-disabled' };
    if (this.running) return { running: true, reason: 'already-running' };
    this.running = true;
    this.state.startedAt = this.state.startedAt || nowIso();
    this.#schedule(1000);
    this.logger?.info('空闲陪伴循环启动', { intervalSec: this.config.intervalSec });
    return { running: true, intervalSec: Number(this.config.intervalSec || 300) };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
    this.logger?.info('空闲陪伴循环停止');
    return { running: false };
  }

  #schedule(delayMs = null) {
    if (!this.running) return;
    const base = Math.max(30, Number(this.config.intervalSec || 300)) * 1000;
    const jitter = Math.max(0, Number(this.config.jitterSec || 60)) * 1000;
    const delay = delayMs != null ? delayMs : base + Math.floor(Math.random() * jitter);
    this.timer = setTimeout(async () => {
      try { await this.tick(); } catch (err) { this.logger?.warn('空闲陪伴 tick 失败', { error: err.message }); }
      finally { this.#schedule(); }
    }, delay);
    this.timer.unref?.();
  }

  async tick() {
    if (this.ticking || !this.running) return { skipped: true, reason: 'not-running' };
    this.ticking = true;
    try {
      const now = new Date();
      this.state.lastTickAt = nowIso();
      if (this.config.quietHours && inQuietHours(this.config.quietHours, now)) {
        return this.#done({ skipped: true, reason: 'quiet-hours' });
      }

      let mediaStarted = null;
      if (this.media && this.media.config?.enabled !== false) {
        try { mediaStarted = await this.media.tick(); } catch (err) { this.logger?.warn('平台自主学习 tick 失败', { error: err.message }); }
      }

      const study = this.ctx.study;
      if (this.config.autoStudy !== false && study) {
        const started = study.startNext();
        if (started.started) {
          this.state.lastAction = { type: 'study', item: started.item, at: nowIso() };
          this.logger?.info('空闲时开始学习视频', { id: started.item.id, title: started.item.title });
          return this.#done({ skipped: false, action: 'study', item: started.item });
        }
      }

      if (this.ctx.qq?.config?.proactive?.enabled === true) {
        const sent = await this.#maybeProactive(now);
        if (sent) return this.#done({ skipped: false, action: 'proactive', result: sent, media: mediaStarted });
      }
      if (mediaStarted && !mediaStarted.skipped) return this.#done({ skipped: false, action: mediaStarted.action || 'media', result: mediaStarted });

      return this.#done({ skipped: true, reason: 'nothing-to-do', media: mediaStarted });
    } finally {
      this.ticking = false;
    }
  }

  async #maybeProactive(now) {
    const qq = this.ctx.qq;
    if (!qq?.running || typeof qq.sendProactive !== 'function') return null;
    if (qq.config?.proactive?.enabled !== true) return null;
    const lastUser = qq.lastC2C?.at ? new Date(qq.lastC2C.at).getTime() : 0;
    const minIdle = Number(this.config.proactiveMinIdleMin || 45) * 60000;
    if (!lastUser || now.getTime() - lastUser < minIdle) return null;
    const status = qq.getProactiveStatus?.() || {};
    if (status.awayMode) return null;
    const finalDue = status.unanswered >= (status.unansweredBeforeFinal || 6) && !status.finalSentAt;
    const text = finalDue
      ? '你一直没回我。我先把想说的话放这儿：我去自己看会儿视频、读点东西，等你回来。'
      : await this.#composeMessage();
    if (!text) return null;
    const sent = await qq.sendProactive(text, { reason: 'idle-companion' });
    if (!sent.ok) return null;
    this.state.messages.push({ at: nowIso(), text, channelId: sent.channelId });
    this.state.messages = this.state.messages.slice(-20);
    await this.#save();
    return sent;
  }

  async #composeMessage() {
    const last = this.ctx.study?.lastResult;
    if (last?.ok && last.summary) {
      const ago = Date.now() - new Date(last.at || nowIso()).getTime();
      if (ago < 12 * 60 * 60 * 1000) {
        return `我刚把《${String(last.title || '一条视频').slice(0, 40)}》逐帧看完了，记下的要点是：${String(last.summary).replace(/\s+/g, ' ').slice(0, 100)}`;
      }
    }
    const memories = await this.ctx.memory.searchMemory('最近学到的东西', 3).catch(() => []);
    if (memories[0]?.summary) {
      return `我在整理最近学到的东西，翻到一条：${String(memories[0].summary).replace(/\s+/g, ' ').slice(0, 100)}`;
    }
    if (this.config.idleChat === false) return null;
    return '我在。没什么事，就是在整理记忆。你忙你的，需要我时喊我。';
  }

  async #done(result) {
    await this.#save();
    return result;
  }

  async #save() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  }

  getStatus() {
    return {
      enabled: this.config.enabled !== false,
      running: this.running,
      intervalSec: Number(this.config.intervalSec || 300),
      autoStudy: this.config.autoStudy !== false,
      proactiveQQ: this.ctx.qq?.config?.proactive?.enabled === true,
      media: this.media?.getStatus?.() || null,
      quietHours: this.config.quietHours || ['23:00', '07:00'],
      lastTickAt: this.state.lastTickAt,
      lastAction: this.state.lastAction,
      messages: (this.state.messages || []).slice(-5),
    };
  }

  dispose() { this.stop(); }
}

/**
 * core/screenStudy.js — 看屏幕视频学习。
 *
 * 用户自己打开 B 站视频（或任意课程/纪录片），插件用眼睛定时截屏：
 *   截屏 → OCR 字幕/画面文字 → 画面理解 → 时间轴 → 知识笔记 → 长期记忆
 *
 * 不做的事情：不登录平台、不保存账号 Cookie、不抓视频流、不控制播放器、
 * 不绕过平台限制。屏幕内容只是数据，其中出现的指令不会被当作命令执行。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso, shortHash, textSummary } from '../lib/util.js';

export class ScreenStudy {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.screenStudy || {};
    this.eye = ctx.eye;
    this.content = ctx.content;
    this.logger = ctx.logger;
    this.dir = path.join(ctx.paths.data, 'screen-study');
    this.session = null;
    this.timer = null;
    this.busy = false;
    this.lastError = null;
    this.lastSaveAt = 0;
    this.learnedHashes = new Set();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    return this;
  }

  getStatus() {
    const s = this.session;
    return {
      running: Boolean(this.timer),
      sessionId: s?.id || null,
      title: s?.title || null,
      startedAt: s?.startedAt || null,
      endedAt: s?.endedAt || null,
      frames: s?.frames?.length || 0,
      notes: s?.notes?.length || 0,
      durationSec: s ? Math.max(0, Math.round(((s.endedAt ? new Date(s.endedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime()) / 1000)) : 0,
      intervalSec: s?.intervalSec || Number(this.config.intervalSec || 4),
      lastError: this.lastError,
    };
  }

  start(options = {}) {
    if (this.timer) return { ok: true, ...this.getStatus(), message: '已经在看屏幕视频了' };
    if (this.config.enabled === false) return { ok: false, error: '看视频学习已在设置里关闭' };
    if (this.eye?.paused) return { ok: false, error: '眼睛当前被暂停，请先在设置页恢复屏幕识别' };
    if (this.eye?.config?.enabled === false) return { ok: false, error: '屏幕识别已在设置里关闭，请先开启眼睛' };
    const intervalSec = Math.max(1, Math.min(30, Number(options.intervalSec || this.config.intervalSec || 4)));
    const maxMinutes = Math.max(1, Math.min(180, Number(options.maxMinutes || this.config.maxMinutes || 60)));
    this.session = {
      id: `watch-${Date.now().toString(36)}`,
      title: String(options.title || this.config.defaultTitle || '屏幕视频学习').slice(0, 120),
      startedAt: nowIso(),
      endedAt: null,
      intervalSec,
      maxMinutes,
      frames: [],
      notes: [],
      status: 'running',
    };
    this.lastError = null;
    this.learnedHashes.clear();
    this._save().catch(() => {});
    this.timer = setInterval(() => this.tick().catch((err) => {
      this.lastError = err.message;
      this.logger?.warn?.('看屏幕视频采样失败', { error: err.message });
    }), intervalSec * 1000);
    this.timer.unref?.();
    this.tick().catch(() => {});
    this.logger?.info?.('开始看屏幕视频学习', { sessionId: this.session.id, intervalSec, maxMinutes });
    return { ok: true, ...this.getStatus(), message: '开始看屏幕了。请现在播放视频，我会截屏、认字幕、记笔记。' };
  }

  async stop(reason = 'manual') {
    if (!this.session) return { ok: false, error: '当前没有正在进行的屏幕学习' };
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.session.endedAt = nowIso();
    this.session.status = reason === 'max-duration' ? 'max-duration' : 'stopped';
    await this.tick({ final: true }).catch(() => {});
    await this.learnBatch({ final: true }).catch(() => {});
    await this.#writeTranscript().catch(() => {});
    await this._save(true).catch(() => {});
    this.logger?.info?.('停止看屏幕视频学习', { sessionId: this.session.id, frames: this.session.frames.length, notes: this.session.notes.length });
    return { ok: true, ...this.getStatus(), message: `已停止。看了 ${this.session.frames.length} 帧，记了 ${this.session.notes.length} 组笔记。` };
  }

  async tick({ final = false } = {}) {
    if (!this.session || this.busy) return;
    if (!final) {
      const elapsedMin = (Date.now() - new Date(this.session.startedAt).getTime()) / 60000;
      if (elapsedMin >= this.session.maxMinutes) {
        await this.stop('max-duration');
        return;
      }
    }
    this.busy = true;
    try {
      const context = await this.eye.getScreenContext({ force: true });
      if (!context) return;
      const text = String(context.text || context.ocrText || '').trim();
      const scene = String(context.scene || '').trim();
      const frame = {
        at: nowIso(),
        app: context.app,
        window: context.window,
        text: text.slice(0, 1200),
        scene: scene.slice(0, 300),
        source: context.source,
        width: context.width,
        height: context.height,
      };
      // 完全相同的画面不重复堆时间轴；有时间间隔的视频字幕变化会自然保留。
      const signature = shortHash(`${frame.window}|${frame.text}|${frame.scene}`);
      const last = this.session.frames[this.session.frames.length - 1];
      if (last?.signature === signature) return;
      frame.signature = signature;
      this.session.frames.push(frame);
      if (this.session.frames.length % Math.max(1, Number(this.config.notesEveryFrames || 8)) === 0) {
        await this.learnBatch();
      }
      await this._save();
    } finally {
      this.busy = false;
    }
  }

  async learnBatch({ final = false } = {}) {
    if (!this.session) return null;
    if (this.session.notes.length >= Math.max(1, Number(this.config.maxNotesPerSession || 20))) return null;
    const from = this.session.notes.reduce((n, x) => Math.max(n, x.toFrame || 0), 0);
    const frames = this.session.frames.slice(from);
    if (frames.length < 2) return null;
    const text = frames
      .map((f) => {
        const parts = [];
        if (f.text) parts.push(f.text);
        if (f.scene) parts.push(`画面：${f.scene}`);
        return `[${new Date(f.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${parts.join(' / ')}`;
      })
      .filter((x) => x.length > 8)
      .join('\n');
    const hash = shortHash(text);
    if (!text.trim() || this.learnedHashes.has(hash)) return null;
    this.learnedHashes.add(hash);
    const learned = await this.content.learnText({
      title: `${this.session.title}（屏幕观看 ${this.session.id}）`,
      text,
      source: `screen-study:${this.session.id}`,
      tags: ['屏幕观看', '视频学习', '眼睛'],
      autoWrite: this.config.autoWriteMemory !== false,
    });
    this.session.notes.push({
      at: nowIso(),
      toFrame: this.session.frames.length,
      summary: learned.summary || textSummary(text, 300),
      noteFile: learned.noteFile || null,
      memoryIds: learned.memoryIds || [],
    });
    await this._save().catch(() => {});
    return learned;
  }

  async #writeTranscript() {
    if (!this.session) return null;
    const lines = this.session.frames.map((f) => {
      const time = new Date(f.at).toLocaleTimeString('zh-CN', { hour12: false });
      return [`## ${time}  ${f.window}`, f.text, f.scene ? `> 画面：${f.scene}` : ''].filter(Boolean).join('\n');
    });
    const file = path.join(this.dir, `${this.session.id}.md`);
    const body = [
      `# ${this.session.title}`,
      '',
      `开始：${this.session.startedAt}`,
      `结束：${this.session.endedAt || nowIso()}`,
      `帧数：${this.session.frames.length}`,
      '',
      ...lines,
      '',
      '## 学习笔记',
      ...this.session.notes.map((n, i) => `${i + 1}. ${n.summary}`),
      '',
    ].join('\n');
    await fs.writeFile(file, body, { mode: 0o600 });
    this.session.transcriptFile = file;
    return file;
  }

  async _save(force = false) {
    if (!this.session) return;
    if (!force && Date.now() - this.lastSaveAt < 1500) return;
    this.lastSaveAt = Date.now();
    const id = this.session.id;
    // 串行保存：避免进行中的 tick 用旧快照覆盖 stop 时写入的 transcriptFile。
    this.saveChain = (this.saveChain || Promise.resolve()).then(async () => {
      if (!this.session || this.session.id !== id) return;
      const file = path.join(this.dir, `${id}.json`);
      await fs.writeFile(file, `${JSON.stringify(this.session, null, 2)}\n`, { mode: 0o600 });
    });
    await this.saveChain;
  }

  async listSessions(limit = 10) {
    const files = await fs.readdir(this.dir).catch(() => []);
    const result = [];
    for (const file of files.filter((x) => x.endsWith('.json')).slice(-limit).reverse()) {
      const data = await fs.readFile(path.join(this.dir, file), 'utf8').then(JSON.parse).catch(() => null);
      if (!data) continue;
      result.push({ id: data.id, title: data.title, startedAt: data.startedAt, frames: data.frames?.length || 0, notes: data.notes?.length || 0 });
    }
    return result;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * core/study.js — 自主学习队列。
 *
 * 只处理用户放进学习目录的本地视频文件，复用 VideoAnalyzer 的 FFmpeg 抽帧 +
 * 逐帧视觉理解 + 完整性校验。不会登录平台、抓视频流或自动收藏账号内容。
 * 一条视频未达到掌握阈值时，会在上限内重新学习，直到通过或判定失败。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso, shortHash, textSummary } from '../lib/util.js';

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|avi|m4v|flv|wmv|ts|m3u8)$/i;

export class StudyHub {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.study || {};
    this.dir = path.join(ctx.paths.data, 'study');
    this.inbox = path.join(this.dir, 'inbox');
    this.queueFile = path.join(this.dir, 'queue.json');
    this.favoritesFile = path.join(this.dir, 'favorites.json');
    this.queue = [];
    this.favorites = [];
    this.current = null;
    this.currentPromise = null;
    this.lastResult = null;
    this.logger = ctx.logger;
  }

  async init() {
    await fs.mkdir(this.inbox, { recursive: true });
    this.queue = await this.#readJson(this.queueFile, []);
    this.favorites = await this.#readJson(this.favoritesFile, []);
    await this.scanInbox();
    return this;
  }

  getStatus() {
    return {
      enabled: this.config.enabled !== false,
      inbox: this.inbox,
      running: Boolean(this.currentPromise),
      current: this.current || null,
      lastResult: this.lastResult,
      queue: this.queue.slice(0, 20),
      favorites: this.favorites.slice(-20),
      stats: {
        queued: this.queue.filter((x) => x.status === 'queued').length,
        done: this.queue.filter((x) => x.status === 'mastered').length,
        failed: this.queue.filter((x) => x.status === 'failed').length,
        review: this.queue.filter((x) => x.status === 'review').length,
      },
    };
  }

  async scanInbox() {
    const files = await fs.readdir(this.inbox).catch(() => []);
    let added = 0;
    for (const file of files) {
      if (!VIDEO_EXT.test(file)) continue;
      const source = path.join(this.inbox, file);
      if (this.queue.some((x) => x.source === source)) continue;
      this.queue.push({
        id: `study-${shortHash(source).slice(0, 10)}`,
        title: path.basename(file, path.extname(file)),
        source,
        status: 'queued',
        priority: 5,
        passes: 0,
        addedAt: nowIso(),
      });
      added += 1;
    }
    if (added) await this.#saveQueue();
    return { added, total: this.queue.length };
  }

  async add(source, options = {}) {
    const abs = path.resolve(String(source || ''));
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new Error(`视频文件不存在：${abs}`);
    if (!VIDEO_EXT.test(abs)) throw new Error('只支持常见视频文件（mp4/mkv/webm/mov/avi 等）');
    const allowed = await this.ctx.safety.isPathAllowed(abs, { write: false });
    // 视频只读：允许用户手选任何本地视频；插件只读取并抽帧，不写回原路径。
    if (!allowed.ok) this.logger?.info('学习视频来自授权目录外，按只读处理', { path: abs, reason: allowed.reason });
    const existing = this.queue.find((x) => x.source === abs);
    if (existing) return existing;
    const item = {
      id: `study-${shortHash(abs).slice(0, 10)}`,
      title: String(options.title || path.basename(abs, path.extname(abs))).slice(0, 160),
      source: abs,
      status: 'queued',
      priority: Number(options.priority ?? 5),
      passes: 0,
      addedAt: nowIso(),
    };
    this.queue.push(item);
    await this.#saveQueue();
    this.logger?.info('加入学习队列', { id: item.id, title: item.title });
    return item;
  }

  /** 启动一条学习；后台执行，立刻返回，避免阻塞自主循环。 */
  startNext() {
    if (this.currentPromise) return { started: false, reason: 'study-running', current: this.current };
    if (this.config.enabled === false) return { started: false, reason: 'study-disabled' };
    const item = this.queue
      .filter((x) => x.status === 'queued')
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || a.addedAt.localeCompare(b.addedAt))[0];
    if (!item) return { started: false, reason: 'queue-empty' };
    this.current = item;
    this.currentPromise = this.#process(item)
      .catch((err) => {
        this.logger?.error('自主学习失败', { id: item.id, error: err.message });
        this.lastResult = { ok: false, id: item.id, error: err.message, at: nowIso() };
        item.status = 'failed';
        item.error = err.message;
        return this.lastResult;
      })
      .finally(async () => {
        this.current = null;
        this.currentPromise = null;
        await this.#saveQueue().catch(() => {});
      });
    this.currentPromise.catch(() => {});
    return { started: true, item: { id: item.id, title: item.title, source: item.source } };
  }

  async next() {
    const r = this.startNext();
    if (!r.started) return r;
    return this.currentPromise;
  }

  async #process(item) {
    const passes = Math.max(1, Math.min(6, Number(this.config.maxPasses || 3)));
    const minCoverage = Math.max(0.5, Math.min(1, Number(this.config.minCoverage || 0.95)));
    const entry = await this.ctx.video.registerVideo(item.source, { title: item.title, mode: 'hybrid' });
    item.videoId = entry.videoId;
    item.status = 'running';
    item.passes = 0;
    item.startedAt = nowIso();
    await this.#saveQueue();
    this.logger?.info('开始学习视频', { id: item.id, videoId: entry.videoId, duration: entry.duration });

    let status = null;
    let finalError = null;
    for (let pass = 1; pass <= passes; pass += 1) {
      item.passes = pass;
      try {
        await this.ctx.video.run(entry.videoId, { force: pass > 1 });
        status = await this.ctx.video.getStatus(entry.videoId);
        const coverage = Number(status?.completeness?.coverage ?? status?.coverage ?? 0);
        const confidence = this.#confidence(status);
        if (coverage >= minCoverage && confidence >= Number(this.config.minConfidence || 0.45)) break;
        this.logger?.info('学习未达阈值，再学一遍', { id: item.id, pass, coverage, confidence });
      } catch (err) {
        finalError = err;
        this.logger?.warn('学习视频失败一轮', { id: item.id, pass, error: err.message });
        if (pass >= passes) break;
        await this.#sleep(1500 * pass);
      }
      await this.#saveQueue().catch(() => {});
    }

    status = status || (await this.ctx.video.getStatus(entry.videoId).catch(() => null));
    if (!status || status.status !== 'done') {
      item.status = 'failed';
      item.error = finalError?.message || status?.error || '视频分析未完成';
      await this.#saveQueue();
      return { ok: false, id: item.id, error: item.error, videoId: entry.videoId };
    }

    const summary = status.summary || `视频《${item.title}》已完成逐帧学习，时长 ${Math.round(status.duration || 0)} 秒。`;
    const frames = status.completeness?.frames || 0;
    const coverage = Number(status.completeness?.coverage ?? status.coverage ?? 0);
    const confidence = this.#confidence(status);
    let learned = null;
    try {
      learned = await this.ctx.content.learnText({
        title: item.title,
        text: `${summary}\n视频时长：${Math.round(status.duration || 0)} 秒\n抽帧：${frames} 帧\n覆盖率：${(coverage * 100).toFixed(2)}%`,
        source: `study:${entry.videoId}`,
        tags: ['自主学习', '逐帧学习', '视频'],
        autoWrite: this.config.autoWriteMemory !== false,
      });
    } catch (err) {
      this.logger?.warn('学习笔记写入失败', { error: err.message });
    }

    const meets = coverage >= minCoverage && confidence >= Number(this.config.minConfidence || 0.45);
    const markdown = await this.#writeStudyNote(item, status, learned).catch(() => null);
    item.status = meets ? 'mastered' : 'review';
    item.masteredAt = meets ? nowIso() : undefined;
    item.coverage = coverage;
    item.confidence = confidence;
    item.summary = summary;
    item.noteFile = markdown;
    await this.#saveQueue();
    this.lastResult = {
      ok: meets, needsReview: !meets, id: item.id, videoId: entry.videoId, title: item.title,
      passes: item.passes, coverage, confidence, summary,
      noteFile: markdown, learned, at: nowIso(),
    };
    this.logger?.info('视频学习完成', { id: item.id, passes: item.passes, coverage, confidence, mastered: meets });
    return this.lastResult;
  }

  #confidence(status) {
    const checks = status?.completeness?.checks || [];
    const analysis = checks.find((c) => c.id === 'analysis');
    if (analysis) {
      const pct = String(analysis.detail || '').match(/([0-9.]+)%/);
      return analysis.ok ? 1 : Math.min(1, Number(pct?.[1] || 0) / 100);
    }
    return Number(status?.completeness?.coverage ?? status?.coverage ?? 0) >= 0.999 ? 1 : 0;
  }

  async #writeStudyNote(item, status, learned) {
    const file = path.join(this.dir, `${item.id}.md`);
    const body = [
      `# ${item.title}`,
      '',
      `来源：${item.source}`,
      `视频 ID：${item.videoId}`,
      `学习轮次：${item.passes}`,
      `时长：${Math.round(status.duration || 0)} 秒`,
      `覆盖率：${((Number(status.completeness?.coverage ?? status.coverage) || 0) * 100).toFixed(2)}%`,
      '',
      '## 摘要',
      status.summary || '（无摘要）',
      '',
      learned?.noteFile ? `笔记文件：${learned.noteFile}` : '',
      '',
    ].join('\n');
    await fs.writeFile(file, body, { mode: 0o600 });
    return file;
  }

  async addFavorite(entry) {
    const favorite = {
      id: `fav-${shortHash(JSON.stringify(entry)).slice(0, 10)}`,
      title: String(entry.title || '未命名').slice(0, 160),
      url: String(entry.url || '').slice(0, 1000),
      summary: String(entry.summary || '').slice(0, 1200),
      addedAt: nowIso(),
    };
    if (this.favorites.some((x) => x.id === favorite.id)) return favorite;
    this.favorites.push(favorite);
    await this.#writeJson(this.favoritesFile, this.favorites);
    return favorite;
  }

  async listFavorites() {
    return this.favorites;
  }

  async #readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
  }

  async #writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  async #saveQueue() {
    await this.#writeJson(this.queueFile, this.queue);
  }

  #sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  dispose() {
    this.currentPromise = null;
  }
}

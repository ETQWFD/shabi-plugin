/**
 * core/mediaAutonomy.js — 平台自主学习循环。
 *
 * 规则直出：兴趣画像选主题 → 平台搜索 → 选择视频 → 下载/逐帧观看 →
 * 总结写记忆/收藏。连续看若干条后进入休息，休息时读小说。
 *
 * 不登录平台账号；只有用户显式填入 Cookie 时才使用 Cookie。平台搜索/下载
 * 失败只记录，不无限重试，也不绕过验证码或平台限制。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso, inQuietHours, shortHash, textSummary } from '../lib/util.js';

const STOP_TOPICS = new Set([
  '学习', '视频', '知识', 'bilibili', '哔哩哔哩', '抖音', '快手', '小说', '阅读',
  '人工智能', '机器学习', '编程', '科普', '历史', '科技', '生活', '娱乐', '音乐',
]);

export class MediaAutonomy {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.media || {};
    this.stateFile = path.join(ctx.paths.data, 'media_state.json');
    this.current = null;
    this.currentPromise = null;
    this.logger = ctx.logger;
    this.state = {
      format: 'MEDIA1', version: 1, mode: 'idle', paused: false, day: null, videosToday: 0,
      videosSinceRest: 0, restUntil: null, novelsRead: 0, topicIndex: 0,
      recentIds: [], lastTickAt: null, lastVideoAt: null, lastNovelAt: null,
      lastResult: null, current: null, stats: { ticks: 0, videos: 0, novels: 0, failures: 0 },
    };
  }

  async init() {
    try {
      const saved = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      this.state = { ...this.state, ...saved, stats: { ...this.state.stats, ...(saved.stats || {}) } };
    } catch { /* first run */ }
    return this;
  }

  getStatus() {
    return {
      enabled: this.config.enabled !== false,
      paused: Boolean(this.state.paused),
      running: Boolean(this.currentPromise),
      mode: this.state.mode,
      current: this.current || this.state.current || null,
      videosToday: this.#todayCount(),
      maxVideosPerDay: Number(this.config.maxVideosPerDay || 8),
      videosSinceRest: this.state.videosSinceRest,
      restAfterVideos: Number(this.config.restAfterVideos || 3),
      restUntil: this.state.restUntil,
      lastTickAt: this.state.lastTickAt,
      lastVideoAt: this.state.lastVideoAt,
      lastNovelAt: this.state.lastNovelAt,
      lastResult: this.state.lastResult,
      stats: this.state.stats,
      favorites: this.ctx.content?.getStatus?.()?.media || null,
      recentIds: (this.state.recentIds || []).slice(-20),
    };
  }

  async tick({ manual = false } = {}) {
    if (this.config.enabled === false) return { skipped: true, reason: 'media-disabled' };
    if (this.state.paused && !manual) return { skipped: true, reason: 'media-paused' };
    if (this.currentPromise) return { skipped: true, reason: 'media-running', current: this.current };
    const now = new Date();
    if (!manual && inQuietHours(this.config.quietHours || ['23:00', '07:00'], now)) return { skipped: true, reason: 'quiet-hours' };
    this.#rollDay(now);
    this.state.lastTickAt = nowIso();
    this.state.stats.ticks += 1;

    const restActive = this.state.restUntil && new Date(this.state.restUntil).getTime() > now.getTime();
    if (!restActive && this.state.restUntil) {
      // 休息结束后清空本轮计数，避免一直停在“已看累”状态。
      this.state.restUntil = null;
      this.state.videosSinceRest = 0;
      this.state.mode = 'idle';
    }
    if (restActive) {
      const novel = await this.#readNovel({ reason: 'rest' }).catch((err) => {
        this.logger?.warn('休息时读小说失败', { error: err.message });
        return { skipped: true, reason: 'novel-error', error: err.message };
      });
      await this.#save();
      if (!novel.skipped) return { started: false, action: 'novel', ...novel };
      return { skipped: true, reason: 'resting', restUntil: this.state.restUntil };
    }

    if (this.state.videosSinceRest >= Number(this.config.restAfterVideos || 3)) {
      this.state.restUntil = new Date(now.getTime() + Number(this.config.restMinutes || 20) * 60000).toISOString();
      this.state.mode = 'rest';
      const novel = await this.#readNovel({ reason: 'tired' }).catch((err) => ({ skipped: true, reason: 'novel-error', error: err.message }));
      await this.#save();
      return { started: false, action: 'rest', restUntil: this.state.restUntil, novel };
    }

    const today = this.#todayCount();
    if (today >= Number(this.config.maxVideosPerDay || 8)) return { skipped: true, reason: 'daily-video-limit', videosToday: today };

    const candidates = await this.#findCandidates();
    if (!candidates.length) {
      const novel = await this.#readNovel({ reason: 'no-video' }).catch(() => ({ skipped: true, reason: 'novel-error' }));
      await this.#save();
      return novel.skipped
        ? { skipped: true, reason: 'no-candidates', searchError: this.state.lastSearchError || null, novel }
        : { started: false, action: 'novel', ...novel };
    }

    const candidate = candidates[0];
    this.current = candidate;
    this.state.mode = 'video';
    this.state.current = candidate;
    this.state.lastResult = null;
    await this.#save();
    this.currentPromise = this.#watch(candidate)
      .catch((err) => {
        this.state.stats.failures += 1;
        this.logger?.warn('平台视频观看失败', { title: candidate.title, error: err.message });
        this.state.lastResult = { ok: false, title: candidate.title, platform: candidate.platform, error: err.message, at: nowIso() };
        return this.state.lastResult;
      })
      .finally(async () => {
        this.state.current = null;
        this.current = null;
        this.currentPromise = null;
        this.state.mode = this.state.restUntil && new Date(this.state.restUntil).getTime() > Date.now() ? 'rest' : 'idle';
        await this.#save().catch(() => {});
      });
    this.currentPromise.catch(() => {});
    return { started: true, action: 'video', candidate };
  }

  async #findCandidates() {
    this.state.lastSearchError = null;
    const topics = this.#topics();
    const platforms = Array.isArray(this.config.platforms) && this.config.platforms.length
      ? this.config.platforms.filter((p) => ['bilibili', 'douyin', 'kuaishou'].includes(p))
      : ['bilibili'];
    let lastError = null;
    for (let i = 0; i < Math.max(1, Math.min(3, topics.length)); i += 1) {
      const topic = topics[(this.state.topicIndex + i) % topics.length];
      for (const platform of platforms) {
        try {
          const search = await this.ctx.content.platformSearch(platform, topic, { limit: Number(this.config.searchLimit || 10) });
          if (search.ok && search.items?.length) {
            const fresh = search.items.filter((x) => {
              const key = String(x.id || x.bvid || x.url);
              if (!key || (this.state.recentIds || []).includes(key)) return false;
              const sec = Number(x.duration || 0);
              return (!sec || sec >= Number(this.config.minVideoSeconds || 15)) && (!sec || sec <= Number(this.config.maxVideoSeconds || 1800));
            });
            if (fresh.length) {
              const selected = await this.ctx.interest.selectNext(fresh, { limit: 3 }).catch(() => ({ items: fresh.slice(0, 3) }));
              const pick = selected.items?.[0] || fresh[0];
              this.state.topicIndex = (this.state.topicIndex + i + 1) % topics.length;
              this.state.selectedTopic = topic;
              return [pick];
            }
          } else if (search.error) lastError = search.error;
        } catch (err) {
          lastError = err.message;
        }
      }
    }
    if (lastError) { this.state.lastSearchError = String(lastError).slice(0, 300); this.logger?.debug?.('平台搜索没有候选', { error: lastError }); }
    return [];
  }

  #topics() {
    const configured = Array.isArray(this.config.topics) ? this.config.topics.map(String).filter(Boolean) : [];
    if (configured.length) return configured.slice(0, 20);
    const profile = this.ctx.interest?.getProfile?.() || { top: [] };
    const top = (profile.top || []).map((x) => String(x.tag || '')).filter((x) => x && !STOP_TOPICS.has(x));
    const memories = this.ctx.memory?.listMemories?.({ limit: 20 })?.items || [];
    const tags = memories.filter((m) => m.type === 'knowledge').flatMap((m) => m.tags || [])
      .map((x) => String(x || '')).filter((x) => x && !STOP_TOPICS.has(x));
    return Array.from(new Set([...top, ...tags, '人工智能', '科学科普', '编程'])).slice(0, 12);
  }

  async #watch(candidate) {
    this.logger?.info('开始自主观看平台视频', { platform: candidate.platform, title: candidate.title, url: candidate.url });
    const result = candidate.platform === 'bilibili'
      ? await this.ctx.content.bilibiliWatch(candidate.bvid || candidate.id || candidate.url, {
        download: this.config.downloadVideo !== false,
        favorite: this.config.autoFavorite !== false,
        maxMB: Number(this.config.maxDownloadMB || 500),
      })
      : await this.ctx.content.watchUrl(candidate.url, {
        platform: candidate.platform,
        title: candidate.title,
        favorite: this.config.autoFavorite !== false,
        autoWrite: true,
      });
    const key = String(candidate.id || candidate.bvid || candidate.url);
    this.state.recentIds = [...(this.state.recentIds || []), key].slice(-60);
    if (result.ok) {
      this.state.videosToday = this.#todayCount() + 1;
      this.state.videosSinceRest += 1;
      this.state.stats.videos += 1;
      this.state.lastVideoAt = nowIso();
      this.state.lastResult = {
        ok: true, title: result.title || candidate.title, platform: candidate.platform,
        url: candidate.url, videoId: result.videoId, summary: result.summary || result.summary,
        noteFile: result.noteFile, favorite: result.favorite || null, at: nowIso(),
      };
      this.logger?.info('平台视频观看完成', { title: candidate.title, summary: String(result.summary || '').slice(0, 80) });
    } else {
      this.state.stats.failures += 1;
      this.state.lastResult = { ok: false, title: candidate.title, platform: candidate.platform, error: result.error, at: nowIso() };
      this.logger?.warn('平台视频观看失败', { title: candidate.title, error: result.error });
      await this.ctx.interest.feedback(key, 'skip', { tags: [candidate.platform], title: candidate.title }).catch(() => {});
    }
    await this.#save();
    return this.state.lastResult;
  }

  async #readNovel({ reason = 'tired' } = {}) {
    if (this.config.novelWhenTired === false) return { skipped: true, reason: 'novel-disabled' };
    const content = this.ctx.content;
    if (!content) return { skipped: true, reason: 'no-content' };
    const current = content.state?.novel?.current || null;
    let url = String(this.config.novelUrl || '').trim();
    if (!url && current) url = String(current.url || '').trim();
    if (!url) url = String(content.config.novel?.defaultUrl || '').trim();
    if (!url) {
      const found = await content.novelSearch(this.state.selectedTopic || '').catch(() => null);
      const items = found?.items || [];
      if (items.length) url = items[(this.state.novelsRead + this.state.topicIndex + items.length) % items.length].url;
    }
    if (!url) return { skipped: true, reason: 'novel-url-empty' };
    let opened;
    if (current && current.url === url) {
      opened = await content.novelNext();
    } else {
      opened = await content.novelOpen(url);
      if (opened?.ok && opened.chapterLinks?.length) {
        const first = await content.novelNext().catch(() => null);
        if (first?.ok) opened = first;
      }
    }
    if (!opened?.ok) return { skipped: true, reason: 'novel-open-failed', error: opened?.error };
    const chapters = Math.max(1, Math.min(5, Number(this.config.novelChaptersPerRest || 2)));
    let count = 0;
    for (let i = 0; i < chapters; i += 1) {
      const learned = await content.novelLearn().catch((err) => ({ ok: false, error: err.message }));
      if (learned.ok) count += 1;
      if (i < chapters - 1) {
        const next = await content.novelNext().catch(() => null);
        if (!next?.ok) break;
      }
    }
    this.state.novelsRead += 1;
    this.state.stats.novels += count;
    this.state.lastNovelAt = nowIso();
    this.state.lastResult = { ok: count > 0, action: 'novel', reason, title: opened.title, chapters: count, at: nowIso() };
    await this.#save();
    this.logger?.info('休息时读小说', { title: opened.title, chapters: count, reason });
    return { ok: count > 0, title: opened.title, chapters: count, note: content.state.novel?.current?.title };
  }

  #todayKey(now = new Date()) {
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  }

  #rollDay(now = new Date()) {
    const key = this.#todayKey(now);
    if (this.state.day !== key) {
      this.state.day = key;
      this.state.videosToday = 0;
    }
  }

  #todayCount() {
    if (this.state.day !== this.#todayKey()) return 0;
    return Number(this.state.videosToday || 0);
  }

  async #save() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  }

  pause() { this.state.paused = true; return this.getStatus(); }

  resume() { this.state.paused = false; return this.getStatus(); }

  dispose() {
    this.currentPromise = null;
    this.current = null;
  }
}

export function createMediaAutonomy(ctx) {
  return new MediaAutonomy(ctx);
}

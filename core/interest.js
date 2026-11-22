/**
 * core/interest.js — 兴趣画像 + 选择策略 + 反馈闭环 + 平台限制停止。
 *
 * 只做“排序/建议”，实际观看由用户已登录、已授权的宿主会话执行；
 * 遇到验证码/风控/规则限制立即停止，不实现任何反检测或绕过。
 */
import fs from 'node:fs/promises';
import { readFile as readIoshb, writeFileAtomic } from '../lib/ioshb.js';
import { Mutex, nowIso, clamp, cosine, hashEmbed, shortHash } from '../lib/util.js';

const REWARDS = { complete: 1, favorite: 1.2, ask: 0.6, skip: -0.5, dislike: -1, view: 0.3 };

export class InterestEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.interest;
    this.file = ctx.paths.interest;
    this.logger = ctx.logger;
    this.mutex = new Mutex();
    this.profile = null;
    this.blockedUntil = 0;
  }

  async init() {
    this.profile = (await readIoshb(this.file).catch(() => null)) || {
      format: 'IOSHB1', version: 1, createdAt: nowIso(), updatedAt: nowIso(),
      tags: {}, topics: {}, history: [], selections: {}, stats: { selections: 0, feedback: 0 },
      recent: [],
    };
    this.profile.tags = this.profile.tags || {};
    this.profile.history = this.profile.history || [];
    this.profile.selections = this.profile.selections || {};
    this.profile.recent = this.profile.recent || [];
    return this;
  }

  async #save() {
    this.profile.updatedAt = nowIso();
    await writeFileAtomic(this.file, this.profile);
  }

  // ───────────────────────── 画像 ─────────────────────────

  static normalizeTags(tags) {
    const raw = Array.isArray(tags) ? tags : typeof tags === 'string' ? String(tags).split(/[,，、;；\s]+/) : [];
    return Array.from(new Set(raw.map((t) => String(t).trim().toLowerCase()).filter((t) => t.length >= 1 && t.length <= 32))).slice(0, 20);
  }

  async ingest({ history = [], favorites = [], chats = [], knowledge = [] } = {}) {
    return this.mutex.run(async () => {
      if (!this.profile) await this.init();
      const now = Date.now();
      const bump = (tag, weight, meta = {}) => {
        if (!tag) return;
        const cur = this.profile.tags[tag] || { weight: 0, count: 0, lastSeen: null };
        cur.weight = clamp(cur.weight + weight, -10, 20);
        cur.count += 1;
        cur.lastSeen = nowIso();
        cur.sources = Array.from(new Set([...(cur.sources || []), meta.source || 'unknown'])).slice(0, 5);
        this.profile.tags[tag] = cur;
      };
      for (const h of history) {
        const tags = InterestEngine.normalizeTags(h.tags || h.title);
        for (const t of tags) bump(t, 0.4 * (Number(h.reward ?? 0.5)), { source: 'history' });
      }
      for (const f of favorites) for (const t of InterestEngine.normalizeTags(f.tags || f.title)) bump(t, 1.0, { source: 'favorite' });
      for (const c of chats) {
        const tags = extractTopics(String(c.text || c.content || ''));
        for (const t of tags) bump(t, 0.25, { source: 'chat' });
      }
      for (const k of knowledge) for (const t of InterestEngine.normalizeTags(k.tags || k.title)) bump(t, 0.35 * Number(k.importance ?? 0.5), { source: 'knowledge' });
      // 旧兴趣衰减
      for (const [tag, v] of Object.entries(this.profile.tags)) {
        const days = v.lastSeen ? (now - new Date(v.lastSeen).getTime()) / 86400000 : 30;
        v.weight *= Math.exp(-days / 60);
        if (v.weight < 0.05 && v.count < 2) delete this.profile.tags[tag];
      }
      await this.#save();
      return this.getProfile();
    });
  }

  async ingestFromMemory(limit = 100) {
    const memories = this.ctx.memory.listMemories({ limit, includeArchive: false }).items;
    return this.ingest({
      knowledge: memories.filter((m) => m.type === 'knowledge').map((m) => ({ tags: m.tags, importance: m.importance })),
      chats: memories.filter((m) => m.type === 'chat').map((m) => ({ text: m.summary })),
      history: memories.filter((m) => m.type === 'observation').map((m) => ({ tags: m.tags, reward: 0.3 })),
    });
  }

  getProfile() {
    const tags = Object.entries(this.profile?.tags || {})
      .map(([tag, v]) => ({ tag, weight: Number(v.weight.toFixed(3)), count: v.count, lastSeen: v.lastSeen }))
      .sort((a, b) => b.weight - a.weight);
    return { tags, top: tags.slice(0, 12), stats: this.profile?.stats || {}, blockedUntil: this.blockedUntil ? new Date(this.blockedUntil).toISOString() : null };
  }

  preferenceVector(text, dim = 64) {
    const base = hashEmbed(text, dim);
    const weights = this.profile?.tags || {};
    const tags = InterestEngine.normalizeTags(text);
    if (tags.length === 0) return base;
    const tagVec = hashEmbed(tags.join(' '), dim);
    const strength = Math.min(1.5, tags.reduce((s, t) => s + Math.max(0, weights[t]?.weight || 0), 0) / Math.max(1, tags.length));
    return base.map((v, i) => v + tagVec[i] * strength);
  }

  // ───────────────────────── 选择 ─────────────────────────

  /**
   * @param {Array<{id,title,tags,publishedAt,quality,source,url,duration}>} candidates
   */
  async selectNext(candidates, { epsilon = this.config.epsilon ?? 0.1, ucb = this.config.ucb ?? 0.15, limit = 5, rand = Math.random } = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return { ok: false, reason: 'no-candidates', items: [] };
    if (!this.canOperate()) return { ok: false, reason: 'blocked-by-platform-signal', items: [] };
    const tags = this.profile?.tags || {};
    const positiveTags = Object.entries(tags).filter(([, v]) => v.weight > 0).map(([t]) => t);
    const prefVec = hashEmbed(positiveTags.join(' '), 64);
    const recentTags = new Set((this.profile?.recent || []).slice(-5).flatMap((r) => r.tags || []));
    const totalSelections = Object.values(this.profile?.selections || {}).reduce((s, x) => s + (x.n || 0), 0) + 1;
    const scored = candidates.map((c) => {
      const cTags = InterestEngine.normalizeTags(c.tags || c.title);
      const match = cTags.length
        ? cTags.reduce((s, t) => s + Math.max(0, tags[t]?.weight || 0), 0) / cTags.length
        : 0;
      const matchNorm = clamp(match / 3, 0, 1);
      const ageDays = c.publishedAt ? Math.max(0, (Date.now() - new Date(c.publishedAt).getTime()) / 86400000) : 30;
      const freshness = clamp(Math.exp(-ageDays / 14), 0, 1);
      const seen = this.profile?.selections?.[c.id]?.n || 0;
      const novelty = 1 / (1 + seen);
      const quality = clamp(Number(c.quality ?? 0.6), 0, 1);
      const diversityPenalty = cTags.some((t) => recentTags.has(t)) ? 0.25 : 0;
      const ucbBonus = ucb * Math.sqrt(Math.log(totalSelections + 1) / (seen + 1));
      const sim = cTags.length ? cosine(prefVec, hashEmbed(cTags.join(' '), 64)) : 0;
      const score = 0.45 * matchNorm + 0.2 * freshness + 0.15 * novelty + 0.12 * quality + 0.08 * Math.max(0, sim) + ucbBonus - diversityPenalty;
      return { candidate: c, score: Number(score.toFixed(4)), components: { matchNorm, freshness, novelty, quality, sim, ucbBonus, diversityPenalty }, tags: cTags };
    });
    scored.sort((a, b) => b.score - a.score);
    const explore = rand() < epsilon && scored.length > 1;
    let picked;
    if (explore) {
      const pool = scored.slice(0, Math.max(2, Math.ceil(scored.length * 0.25)));
      picked = [pool[Math.floor(rand() * pool.length)]];
    } else {
      picked = scored.slice(0, Math.max(1, limit));
    }
    for (const p of picked) {
      const id = String(p.candidate.id || shortHash(`${p.candidate.title}|${p.candidate.url || ''}`));
      const sel = this.profile.selections[id] || { n: 0, reward: 0, firstAt: nowIso() };
      sel.n += 1;
      sel.lastAt = nowIso();
      sel.title = p.candidate.title;
      sel.tags = p.tags;
      this.profile.selections[id] = sel;
      this.profile.recent.push({ id, tags: p.tags, at: nowIso() });
    }
    this.profile.recent = this.profile.recent.slice(-30);
    this.profile.stats.selections = (this.profile.stats.selections || 0) + picked.length;
    await this.#save();
    return {
      ok: true,
      items: picked.map((p) => ({ ...p.candidate, id: String(p.candidate.id || shortHash(`${p.candidate.title}|${p.candidate.url || ''}`)), _score: p.score, _components: p.components })),
      exploration: explore,
    };
  }

  /** 反馈闭环：看完/跳过/收藏/提问。 */
  async feedback(id, action, { tags = [], title = '', weight = null } = {}) {
    return this.mutex.run(async () => {
      if (!this.profile) await this.init();
      const reward = weight ?? REWARDS[action] ?? 0;
      const sel = this.profile.selections[id] || { n: 1, reward: 0, title, tags };
      sel.reward = Number((sel.reward + reward).toFixed(4));
      sel.lastFeedback = action;
      sel.lastFeedbackAt = nowIso();
      this.profile.selections[id] = sel;
      const itemTags = InterestEngine.normalizeTags(tags.length ? tags : sel.tags || title);
      const lr = 0.12;
      for (const t of itemTags) {
        const cur = this.profile.tags[t] || { weight: 0, count: 0, lastSeen: nowIso(), sources: [] };
        cur.weight = clamp(cur.weight + lr * reward, -10, 20);
        cur.count += 1;
        cur.lastSeen = nowIso();
        cur.sources = Array.from(new Set([...cur.sources, 'feedback']));
        this.profile.tags[t] = cur;
      }
      this.profile.history.push({ id, action, reward, tags: itemTags, at: nowIso() });
      this.profile.history = this.profile.history.slice(-200);
      this.profile.stats.feedback = (this.profile.stats.feedback || 0) + 1;
      await this.#save();
      this.ctx.host.ui.emit?.('shabi:interest-feedback', { id, action, reward });
      return { ok: true, reward, tags: itemTags, profile: this.getProfile() };
    });
  }

  /** 平台限制信号：停止自动观看并提示，不做任何绕过。 */
  handlePlatformSignal(signal = {}) {
    this.blockedUntil = Date.now() + 30 * 60 * 1000;
    if (this.profile) {
      this.profile.blockedUntil = new Date(this.blockedUntil).toISOString();
      this.#save().catch(() => {});
    }
    this.logger?.warn('兴趣观看被平台限制中断', { signal });
    this.ctx.host.ui.notify('遇到验证码/风控/规则限制，已停止自动观看。请手动处理后重试。', { level: 'warn' });
    return { stopped: true, blockedUntil: new Date(this.blockedUntil).toISOString() };
  }

  async clearBlock() {
    this.blockedUntil = 0;
    if (this.profile) {
      delete this.profile.blockedUntil;
      await this.#save().catch(() => {});
    }
    return { ok: true };
  }

  canOperate() {
    if (this.blockedUntil && Date.now() < this.blockedUntil) return false;
    if (this.profile?.blockedUntil && Date.now() < new Date(this.profile.blockedUntil).getTime()) {
      this.blockedUntil = new Date(this.profile.blockedUntil).getTime();
      return false;
    }
    return true;
  }

  getStatus() {
    return { ...this.getProfile(), canOperate: this.canOperate(), blockedUntil: this.blockedUntil ? new Date(this.blockedUntil).toISOString() : null };
  }
}

function extractTopics(text) {
  const tokens = String(text).match(/[\u4e00-\u9fff]{2,6}|[a-zA-Z]{4,}/g) || [];
  const stop = new Set(['这个', '那个', '什么', '怎么', '可以', '我们', '你们', '他们', '就是', '不是', '然后', '因为', '所以']);
  return Array.from(new Set(tokens.filter((t) => !stop.has(t)))).slice(0, 10);
}

export function createInterest(ctx) {
  return new InterestEngine(ctx);
}

export { extractTopics, REWARDS };

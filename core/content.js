/**
 * core/content.js — 内容执行层：B 站推荐/观看/字幕学习 + 小说抓取阅读。
 *
 * 边界：
 *   - 只使用用户本人在设置页填入的 Cookie 或宿主 accounts 服务；
 *   - 不代登录、不保存密码、不做验证码识别、不绕过风控；
 *   - 遇到 403/412/风控码立即停止并返回明确原因；
 *   - 下载默认关闭，开启后受 maxDownloadMB 限制。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Mutex, nowIso, shortHash, textSummary, withTimeout, safeJsonParse, sleep } from '../lib/util.js';
import { runCommand } from '../lib/host.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com/';
// B 站 WBI 混淆表（公开算法，用于生成 w_rid；不涉及登录或反检测）。
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripHtml(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function paragraphsFromHtml(html) {
  const cleaned = String(html || '')
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '');
  const blocks = [];
  const re = /<(p|article|div|section)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(cleaned))) {
    const text = stripHtml(m[2]);
    if (text.length >= 20) blocks.push(text);
  }
  if (blocks.length < 3) {
    const text = stripHtml(cleaned);
    return text.split(/\n+/).map((s) => s.trim()).filter((s) => s.length >= 10);
  }
  return blocks;
}

function parseBiliDuration(value) {
  if (typeof value === 'number') return value;
  const parts = String(value || '').split(':').map(Number);
  if (parts.some((x) => Number.isNaN(x))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function normalizeBiliItem(item = {}) {
  const owner = item.owner || item.up || {};
  const stat = item.stat || {};
  const bvid = item.bvid || item.id || '';
  return {
    platform: 'bilibili',
    id: String(bvid || item.aid || ''),
    bvid: String(bvid || ''),
    title: String(item.title || '').slice(0, 200),
    author: String(owner.name || owner.mid || '').slice(0, 100),
    cover: String(item.pic || item.cover || ''),
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : String(item.url || ''),
    duration: parseBiliDuration(item.duration ?? item.duration_seconds ?? 0),
    desc: String(item.desc || item.description || '').slice(0, 500),
    views: Number(stat.view || item.play || 0),
    tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 8) : [],
    publishedAt: item.pubdate ? new Date(Number(item.pubdate) * 1000).toISOString() : '',
  };
}

export class ContentHub {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.content || {};
    this.logger = ctx.logger;
    this.host = ctx.host;
    this.memory = ctx.memory;
    this.interest = ctx.interest;
    this.video = ctx.video;
    this.dir = path.join(ctx.paths.data, 'content');
    this.novelDir = path.join(this.dir, 'novels');
    this.stateFile = path.join(this.dir, 'state.json');
    this.favoritesFile = path.join(this.dir, 'favorites.json');
    this.favorites = [];
    this.mutex = new Mutex();
    this.state = { bilibili: { lastFeed: [], lastAt: null, lastError: null }, novel: { current: null, history: [] } };
    this.wbiCache = null;
  }

  async init() {
    await fs.mkdir(this.novelDir, { recursive: true });
    this.favorites = await fs.readFile(this.favoritesFile, 'utf8').then(JSON.parse).catch(() => []);
    this.state = (await fs.readFile(this.stateFile, 'utf8').then(JSON.parse).catch(() => null)) || this.state;
    this.state.bilibili ||= { lastFeed: [], lastAt: null, lastError: null };
    this.state.novel ||= { current: null, history: [] };
    return this;
  }

  async #saveState() {
    await fs.writeFile(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  }

  getStatus() {
    return {
      media: { favorites: this.favorites.slice(-20), favoriteCount: this.favorites.length },
      bilibili: {
        enabled: this.config.bilibili?.enabled !== false,
        cookieConfigured: Boolean(this.config.bilibili?.cookie),
        lastAt: this.state.bilibili?.lastAt || null,
        lastError: this.state.bilibili?.lastError || null,
        feedCount: this.state.bilibili?.lastFeed?.length || 0,
        downloadVideo: Boolean(this.config.bilibili?.downloadVideo),
      },
      novel: {
        enabled: this.config.novel?.enabled !== false,
        current: this.state.novel?.current || null,
        history: (this.state.novel?.history || []).slice(0, 10),
      },
    };
  }

  // ───────────────────────── HTTP / B 站 ─────────────────────────

  async #fetch(url, { headers = {}, timeoutMs = 30000, cookie = '', userAgent = UA, ...init } = {}) {
    const h = { accept: '*/*', ...headers };
    if (userAgent) h['user-agent'] = userAgent;
    if (cookie) h.cookie = cookie;
    const res = await withTimeout(fetch(url, { headers: h, redirect: 'follow', ...init }), timeoutMs, '内容请求');
    if (res.status === 412 || res.status === 403) {
      throw new Error(`平台返回 ${res.status}：需要登录或被风控拦截，已停止。请在设置页更新 Cookie 后重试，不要尝试绕过。`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  #biliHeaders(extra = {}) {
    const cookie = String(this.config.bilibili?.cookie || '');
    return {
      referer: BILI_REFERER,
      origin: 'https://www.bilibili.com',
      accept: 'application/json, text/plain, */*',
      ...(cookie ? { cookie } : {}),
      ...extra,
    };
  }

  async #biliJson(url, { params = {}, wbi = false, cookie = true } = {}) {
    const u = new URL(url);
    const q = { ...params };
    if (wbi) {
      const keys = await this.#wbiKeys();
      Object.assign(q, this.#wbiSign(q, keys));
    }
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    // B 站 API 对浏览器 UA 反而会返回 412；这里使用空 UA，仍带 Cookie/WBI。
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await this.#fetch(u, { headers: this.#biliHeaders(), cookie: cookie ? this.config.bilibili?.cookie : '', userAgent: '' });
        const json = await res.json().catch(() => null);
        if (!json) throw new Error('B 站返回了非 JSON 内容');
        if (json.code !== 0) {
          const risk = [-352, -412, -509, -799].includes(json.code);
          const msg = `B 站接口 code=${json.code}：${json.message || '未知错误'}${risk ? '（平台限流，稍后重试）' : ''}`;
          if (risk && attempt < 2) { await sleep(1200 * (attempt + 1)); continue; }
          throw new Error(msg);
        }
        return json.data;
      } catch (err) {
        lastError = err;
        if (attempt < 2 && /限流|412|352|509|799|timeout|fetch|network/i.test(err.message)) { await sleep(1200 * (attempt + 1)); continue; }
        throw err;
      }
    }
    throw lastError || new Error('B 站接口失败');
  }

  async #biliPostForm(pathname, body) {
    const url = `https://api.bilibili.com${pathname}`;
    const cookie = String(this.config.bilibili?.cookie || '');
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: { ...this.#biliHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body || {}).toString(),
      cookie,
      userAgent: '',
    });
    const json = await res.json().catch(() => null);
    if (!json) throw new Error('B 站返回非 JSON');
    if (json.code !== 0) throw new Error(`B 站接口 code=${json.code}：${json.message || '未知错误'}`);
    return json.data;
  }

  async #wbiKeys() {
    if (this.wbiCache && Date.now() - this.wbiCache.at < 3600000) return this.wbiCache;
    const data = await this.#biliJson('https://api.bilibili.com/x/web-interface/nav', { cookie: false });
    const img = String(data?.wbi_img?.img_url || '').split('/').pop()?.split('.')[0] || '';
    const sub = String(data?.wbi_img?.sub_url || '').split('/').pop()?.split('.')[0] || '';
    if (!img || !sub) throw new Error('无法获取 B 站 WBI 密钥（接口未返回 wbi_img）');
    const raw = img + sub;
    const mixin = MIXIN_TAB.map((n) => raw[n] || '').join('').slice(0, 32);
    this.wbiCache = { at: Date.now(), mixin };
    return this.wbiCache;
  }

  #wbiSign(params, keys) {
    const q = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(q)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(q[k]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    return { ...q, w_rid: md5(query + keys.mixin) };
  }

  /** 拉取首页推荐；有 Cookie 走个性化 WBI 接口，否则退回公开排行榜。 */
  async bilibiliFeed({ limit = 12, fresh = false } = {}) {
    const n = Math.max(1, Math.min(30, Number(limit || 12)));
    try {
      let items = [];
      if (this.config.bilibili?.cookie) {
        const data = await this.#biliJson('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd', {
          wbi: true,
          params: { web_location: 1430650, y_num: n, fresh_type: fresh ? 4 : 3, feed_version: 'V8', homepage_ver: '1', ps: n },
        });
        items = data?.item || [];
      }
      if (!items.length) {
        const data = await this.#biliJson('https://api.bilibili.com/x/web-interface/ranking/v2', { params: { rid: 0, type: 'all' } });
        items = data?.list || [];
      }
      const normalized = items.map(normalizeBiliItem).filter((x) => x.bvid).slice(0, n);
      this.state.bilibili.lastFeed = normalized;
      this.state.bilibili.lastAt = nowIso();
      this.state.bilibili.lastError = null;
      await this.#saveState();
      return { ok: true, items: normalized, personalized: Boolean(this.config.bilibili?.cookie), at: this.state.bilibili.lastAt };
    } catch (err) {
      this.state.bilibili.lastError = err.message;
      await this.#saveState().catch(() => {});
      return { ok: false, error: err.message, items: this.state.bilibili.lastFeed || [] };
    }
  }

  /** 公开搜索：不需要登录，返回视频候选；用于自主选择要看的视频。 */
  async bilibiliSearch(keyword, { limit = 12 } = {}) {
    const q = String(keyword || '').trim().slice(0, 80);
    if (!q) return { ok: false, error: '搜索词为空', items: [] };
    try {
      const data = await this.#biliJson('https://api.bilibili.com/x/web-interface/search/type', {
        params: { search_type: 'video', keyword: q, page: 1 },
        cookie: false,
      });
      const raw = data?.result || [];
      const items = raw.map((item) => ({
        platform: 'bilibili',
        id: String(item.bvid || item.aid || ''),
        bvid: String(item.bvid || ''),
        title: stripHtml(item.title || '').slice(0, 200),
        author: String(item.author || '').slice(0, 100),
        cover: String(item.pic || '').startsWith('//') ? `https:${item.pic}` : String(item.pic || ''),
        url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
        duration: parseBiliDuration(item.duration),
        desc: stripHtml(item.description || '').slice(0, 300),
        views: Number(item.play || 0),
        tags: String(item.tag || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8),
        publishedAt: item.pubdate ? new Date(Number(item.pubdate) * 1000).toISOString() : '',
        quality: Math.min(1, Math.log10(Math.max(1, Number(item.play || 0))) / 7),
      })).filter((x) => x.bvid && x.title).slice(0, Math.max(1, Math.min(30, Number(limit || 12))));
      this.state.search = { keyword: q, at: nowIso(), count: items.length };
      await this.#saveState();
      return { ok: true, keyword: q, items, at: nowIso() };
    } catch (err) {
      return { ok: false, keyword: q, error: err.message, items: [] };
    }
  }

  /** 从推荐里挑下一条，使用已有兴趣画像排序；不会自动无限刷。 */
  async bilibiliNext({ limit = 12 } = {}) {
    const feed = await this.bilibiliFeed({ limit, fresh: true });
    if (!feed.ok) return feed;
    const candidates = feed.items.map((x) => ({
      id: x.bvid, title: x.title, tags: [x.author, ...(x.tags || [])], source: 'bilibili', url: x.url, duration: x.duration,
    }));
    const selected = await this.interest.selectNext(candidates, { limit: 3 }).catch(() => ({ items: candidates.slice(0, 3) }));
    const pick = selected.items?.[0] || candidates[0] || null;
    if (pick) {
      this.state.bilibili.lastPick = pick.id;
      this.state.bilibili.lastAt = nowIso();
      await this.#saveState().catch(() => {});
    }
    return { ok: Boolean(pick), pick, items: feed.items, selected: selected.items || [], personalized: feed.personalized };
  }

  async #biliView(bvid) {
    try {
      const data = await this.#biliJson('https://api.bilibili.com/x/web-interface/view', { params: { bvid } });
      if (data?.cid) return data;
    } catch (err) {
      this.logger?.debug?.('B 站 view 接口不可用，回退 detail/pagelist', { bvid, error: err.message });
    }
    // public detail 接口通常仍可用，且包含 pages/cid。
    try {
      const detail = await this.#biliJson('https://api.bilibili.com/x/web-interface/view/detail', { params: { bvid } });
      const view = detail?.View || detail;
      if (view?.cid || view?.pages?.length) return view;
    } catch (err) {
      this.logger?.debug?.('B 站 detail 接口不可用，回退 pagelist', { bvid, error: err.message });
    }
    const pages = await this.#biliJson('https://api.bilibili.com/x/player/pagelist', { params: { bvid } });
    const first = pages?.[0];
    if (!first?.cid) throw new Error('无法取得视频 cid');
    return { bvid, cid: first.cid, pages, title: bvid, duration: first.duration || 0 };
  }

  async #biliSubtitles(bvid, cid) {
    try {
      const data = await this.#biliJson('https://api.bilibili.com/x/player/v2', { params: { bvid, cid } });
      const list = data?.subtitle?.subtitles || [];
      if (!list.length) return null;
      const preferred = list.find((s) => /zh|中文|ai-zh/i.test(`${s.lan || ''} ${s.lan_doc || ''}`)) || list[0];
      let url = String(preferred.subtitle_url || '');
      if (url.startsWith('//')) url = `https:${url}`;
      if (!url) return null;
      const res = await this.#fetch(url, { headers: this.#biliHeaders(), timeoutMs: 30000 });
      const json = await res.json();
      const body = json?.body || [];
      const segments = body.map((x) => ({
        start: Number(x.from || 0), end: Number(x.to || 0), speechText: String(x.content || '').trim(),
      })).filter((x) => x.speechText);
      return { language: preferred.lan || '', segments };
    } catch (err) {
      this.logger?.debug?.('B 站字幕不可用', { bvid, error: err.message });
      return null;
    }
  }

  async #download(url, file, { headers = {}, maxMB = 200, userAgent = UA } = {}) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const res = await this.#fetch(url, { headers, timeoutMs: 120000, userAgent });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxMB * 1024 * 1024) throw new Error(`视频超过下载上限 ${maxMB}MB，已停止`);
    if (!res.body) throw new Error('下载响应没有 body');
    await pipeline(Readable.fromWeb(res.body), (await import('node:fs')).createWriteStream(file));
    const stat = await fs.stat(file);
    if (!stat.size) throw new Error('下载文件为空');
    if (stat.size > maxMB * 1024 * 1024) {
      await fs.rm(file, { force: true });
      throw new Error(`视频超过下载上限 ${maxMB}MB，已删除`);
    }
    return file;
  }

  /**
   * 学一条 B 站视频：优先字幕；没有字幕且开启下载时，下载后交给完整视频管线。
   */
  async bilibiliLearn(bvidOrUrl, { download = null, autoWrite = null } = {}) {
    const bvid = String(bvidOrUrl || '').match(/BV[0-9A-Za-z]+/)?.[0] || String(bvidOrUrl || '').trim();
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) return { ok: false, error: '需要 B 站 BV 号或视频链接' };
    try {
      const view = await this.#biliView(bvid);
      const cid = Number(view?.cid || view?.pages?.[0]?.cid || 0);
      if (!cid) throw new Error('视频没有 cid');
      const subtitles = await this.#biliSubtitles(bvid, cid);
      const title = String(view.title || bvid);
      if (subtitles?.segments?.length) {
        const text = subtitles.segments.map((s) => s.speechText).join('\n');
        const learned = await this.learnText({ title, text, source: `bilibili:${bvid}`, url: `https://www.bilibili.com/video/${bvid}`, tags: ['bilibili', ...(view.tname ? [view.tname] : [])], autoWrite });
        return { ok: true, bvid, title, mode: 'subtitles', language: subtitles.language, ...learned };
      }
      const shouldDownload = download ?? Boolean(this.config.bilibili?.downloadVideo);
      if (!shouldDownload) {
        // 没有字幕也能先学简介/分区/UP 主信息，不再直接判定“不可用”。
        const fallbackText = [
          title,
          view.desc || '',
          view.tname ? `分区：${view.tname}` : '',
          view.owner?.name ? `UP 主：${view.owner.name}` : '',
        ].filter(Boolean).join('\n');
        if (fallbackText.trim().length >= 2) {
          const learned = await this.learnText({ title, text: fallbackText, source: `bilibili:${bvid}`, url: `https://www.bilibili.com/video/${bvid}`, tags: ['bilibili', ...(view.tname ? [view.tname] : [])], autoWrite });
          return {
            ok: true, bvid, title, mode: 'description', ...learned,
            message: '该视频没有可用字幕，已先用标题/简介/分区学习；要逐帧理解请在设置中打开“无字幕时下载视频”或配置 ASR。',
          };
        }
        return {
          ok: false,
          bvid, title, mode: 'no-subtitles',
          error: '该视频没有字幕，简介也为空。可在设置中打开“无字幕时下载视频”，或在 video.asr.command 配置 Whisper 后重试。',
        };
      }
      const play = await this.#biliJson('https://api.bilibili.com/x/player/playurl', {
        params: { bvid, cid, qn: 16, fnval: 0, fourk: 0, platform: 'html5' },
      });
      const durl = play?.durl?.[0]?.url || play?.dash?.video?.[0]?.baseUrl;
      if (!durl) throw new Error('没有拿到可下载的视频地址（可能需要登录 Cookie）');
      const file = path.join(this.dir, 'bilibili', `${bvid}.mp4`);
      await this.#download(durl, file, { headers: this.#biliHeaders(), maxMB: Number(this.config.bilibili?.maxDownloadMB || 200), userAgent: '' });
      const entry = await this.video.registerVideo({ kind: 'file', value: file, title, headers: null }, { title });
      this.video.run(entry.videoId, { mode: 'hybrid' }).catch((err) => this.logger?.warn?.('B 站视频分析失败', { bvid, error: err.message }));
      return { ok: true, bvid, title, mode: 'download', videoId: entry.videoId, file, message: '已下载并开始完整视频分析；完成后可抽取知识。' };
    } catch (err) {
      this.state.bilibili.lastError = err.message;
      await this.#saveState().catch(() => {});
      return { ok: false, error: err.message, bvid };
    }
  }

  async addFavorite(entry = {}) {
    const title = String(entry.title || '').slice(0, 220);
    const url = String(entry.url || '').slice(0, 1200);
    if (!title) throw new Error('收藏标题为空');
    const id = `fav-${shortHash(`${entry.platform || 'local'}|${entry.id || url}|${title}`).slice(0, 12)}`;
    if (this.favorites.some((x) => x.id === id)) return this.favorites.find((x) => x.id === id);
    const favorite = {
      id, platform: String(entry.platform || 'local'), sourceId: String(entry.id || '').slice(0, 120),
      title, url, author: String(entry.author || '').slice(0, 120),
      summary: String(entry.summary || '').slice(0, 1200),
      tags: Array.isArray(entry.tags) ? entry.tags.map(String).slice(0, 12) : [],
      important: entry.important !== false,
      noteFile: entry.noteFile || null,
      addedAt: nowIso(),
    };
    this.favorites.push(favorite);
    this.favorites = this.favorites.slice(-2000);
    await fs.writeFile(this.favoritesFile, `${JSON.stringify(this.favorites, null, 2)}\n`, { mode: 0o600 });
    this.ctx.host.ui?.emit?.('shabi:favorite-added', favorite);
    return favorite;
  }

  async listFavorites(limit = 100) {
    return this.favorites.slice(-Math.max(1, Math.min(500, Number(limit || 100)))).reverse();
  }

  /** 把一个已下载视频完整逐帧看完，写笔记/记忆并收藏。 */
  async #watchAndLearnFile(file, { title, platform = 'bilibili', url = '', id = '', tags = [], autoWrite = null, favorite = true, subtitleText = '', description = '' }) {
    const entry = await this.video.registerVideo({ kind: 'file', value: file, title }, { title, mode: 'hybrid' });
    this.logger?.info('开始观看视频文件', { title, platform, videoId: entry.videoId, duration: entry.duration });
    const status = await this.video.run(entry.videoId, { mode: 'hybrid' });
    const artifacts = await this.video.readArtifacts(entry.videoId).catch(() => null);
    const rawSummary = status?.summary || artifacts?.summary?.summary || '';
    const summary = (!rawSummary || /未能生成摘要|内容较少/.test(rawSummary))
      ? (textSummary([description, subtitleText].filter(Boolean).join(' '), 300) || title || rawSummary)
      : rawSummary;
    const keyPoints = artifacts?.summary?.keyPoints || [];
    const transcript = (artifacts?.transcript?.segments || []).map((s) => s.text).filter(Boolean).join('\n').slice(0, 5000);
    const visual = (artifacts?.segments?.segments || []).filter((s) => s.speechText && s.speechText.length > 8)
      .slice(0, 40).map((s) => `[${Math.floor(Number(s.start || 0))}s] ${s.speechText}`).join('\n');
    const text = [summary, description, keyPoints.length ? `要点：${keyPoints.join('；')}` : '', subtitleText, transcript, visual]
      .filter(Boolean).join('\n\n').slice(0, 16000) || `${title}：视频已完成逐帧观看。`;
    const learned = await this.learnText({
      title, text, source: `${platform}:${id || entry.videoId}`, url,
      tags: ['视频', platform, ...(tags || [])], autoWrite,
    });
    let favoriteEntry = null;
    if (favorite) {
      favoriteEntry = await this.addFavorite({
        platform, id: id || entry.videoId, title, url, author: '',
        summary: summary || learned.summary, tags: ['视频', platform, ...(tags || [])],
        noteFile: learned.noteFile, important: keyPoints.length > 0 || summary.length > 80,
      }).catch((err) => { this.logger?.warn('本地收藏失败', { error: err.message }); return null; });
    }
    if (id) await this.interest.feedback(id, 'complete', { tags: ['视频', platform, ...(tags || [])], title }).catch(() => {});
    this.state.lastWatch = { title, platform, url, videoId: entry.videoId, at: nowIso(), summary: summary.slice(0, 300), favoriteId: favoriteEntry?.id || null };
    await this.#saveState().catch(() => {});
    return {
      ok: true, title, platform, videoId: entry.videoId, mode: 'frame',
      summary, keyPoints, noteFile: learned.noteFile, memoryIds: learned.memoryIds, favorite: favoriteEntry,
      duration: entry.duration,
    };
  }

  /** 用 yt-dlp 处理抖音/快手等平台 URL；不存在时尝试站点 HTML 解析。 */
  async watchUrl(url, { platform = '', title = '', autoWrite = null, favorite = true } = {}) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '需要 http(s) 视频页面地址' };
    if (!platform) platform = /douyin/i.test(target) ? 'douyin' : /kuaishou/i.test(target) ? 'kuaishou' : 'web';
    if (platform === 'bilibili') return this.bilibiliWatch(target, { autoWrite, favorite });
    const maxSeconds = Number(this.config.media?.maxVideoSeconds || this.ctx.config.video?.maxVideoSeconds || 1800);
    const maxMB = Number(this.config.media?.maxDownloadMB || 500);
    try {
      const meta = await this.#ytDlpInfo(target, { platform });
      if (meta.duration && meta.duration > maxSeconds + 5) {
        return { ok: false, error: `视频 ${Math.round(meta.duration)} 秒，超过单次观看上限 ${maxSeconds} 秒`, platform, url: target, title: meta.title || title };
      }
      const file = path.join(this.dir, 'videos', `${platform}-${shortHash(target).slice(0, 10)}.mp4`);
      await this.#ytDlpDownload(target, file, { platform, maxMB });
      return await this.#watchAndLearnFile(file, {
        title: title || meta.title || target, platform, url: target,
        id: meta.id || shortHash(target), tags: meta.tags || [], autoWrite, favorite, description: meta.description || '', subtitleText: meta.subtitles ? Object.values(meta.subtitles).flat().map((x) => x.data || '').join('\n') : '',
      });
    } catch (err) {
      if (platform === 'kuaishou') {
        const fallback = await this.#watchKuaishouHtml(target, { title, autoWrite, favorite }).catch((e2) => ({ ok: false, error: e2.message }));
        if (fallback.ok) return fallback;
      }
      return { ok: false, error: err.message, platform, url: target, title };
    }
  }

  /** 公开搜索；B 站可直接搜，抖音/快手有登录 Cookie 时走站点接口，失败返回明确原因。 */
  async platformSearch(platform, keyword, { limit = 10 } = {}) {
    if (platform === 'bilibili') return this.bilibiliSearch(keyword, { limit });
    if (platform === 'douyin') {
      const cookie = String(this.config.douyin?.cookie || '');
      if (!cookie) return { ok: false, platform, error: '抖音搜索需要登录 Cookie；可先直接给视频链接', items: [] };
      try {
        const res = await this.#fetch('https://www.douyin.com/aweme/v1/web/search/item/?keyword=' + encodeURIComponent(keyword) + '&device_platform=webapp&aid=6383&channel=channel_pc_web&search_channel=aweme_video_web&search_source=normal_search', {
          headers: { referer: 'https://www.douyin.com/', accept: 'application/json' }, cookie, userAgent: UA,
        });
        const json = await res.json();
        const list = json?.data?.data || json?.aweme_list || [];
        const items = list.map((x) => ({
          platform: 'douyin', id: String(x.aweme_id || x.awemeId || ''), title: String(x.desc || '').slice(0, 200),
          author: String(x.author?.nickname || '').slice(0, 100),
          url: x.aweme_id ? `https://www.douyin.com/video/${x.aweme_id}` : '',
          duration: Number(x.video?.duration || 0) / 1000,
          desc: String(x.desc || '').slice(0, 300),
          quality: Math.min(1, Math.log10(Math.max(1, Number(x.statistics?.digg_count || 1))) / 6),
          tags: String(x.desc || '').match(/[\u4e00-\u9fff]{2,6}|[a-zA-Z]{4,}/g)?.slice(0, 8) || [],
        })).filter((x) => x.id && x.url).slice(0, limit);
        return { ok: items.length > 0, platform, keyword, items, error: items.length ? null : '没有搜到视频' };
      } catch (err) {
        return { ok: false, platform, error: err.message, items: [] };
      }
    }
    if (platform === 'kuaishou') {
      const cookie = String(this.config.kuaishou?.cookie || '');
      try {
        const res = await this.#fetch('https://www.kuaishou.com/search/video?searchKey=' + encodeURIComponent(keyword), {
          headers: { accept: 'text/html', referer: 'https://www.kuaishou.com/' }, cookie, userAgent: UA,
        });
        const html = await res.text();
        const items = this.#parseKuaishouSearch(html).slice(0, limit);
        return { ok: items.length > 0, platform, keyword, items, error: items.length ? null : '快手搜索页没有解析到视频（可能需要登录 Cookie）' };
      } catch (err) {
        return { ok: false, platform, error: err.message, items: [] };
      }
    }
    return { ok: false, platform, error: '未知平台', items: [] };
  }

  async #ytDlpInfo(url, { platform = 'web' } = {}) {
    const bin = String(this.config.media?.downloadTool || 'yt-dlp');
    const args = ['--no-warnings', '--no-playlist', '--skip-download', '--dump-json', '--socket-timeout', '30'];
    if (platform === 'douyin' || platform === 'kuaishou') args.push('--user-agent', UA);
    if (this.config[platform]?.cookie) args.push('--add-header', `Cookie:${this.config[platform].cookie}`);
    args.push(url);
    const { stdout } = await runCommand(bin, args, { timeoutMs: 60000 });
    const line = String(stdout || '').split('\n').map((x) => x.trim()).find((x) => x.startsWith('{'));
    if (!line) throw new Error('yt-dlp 没有返回视频信息');
    return safeJsonParse(line, null) || {};
  }

  async #ytDlpDownload(url, file, { platform = 'web', maxMB = 500 } = {}) {
    const bin = String(this.config.media?.downloadTool || 'yt-dlp');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const args = [
      '--no-warnings', '--no-progress', '--no-playlist', '--force-overwrites',
      '--socket-timeout', '30', '--retries', '3', '--max-filesize', `${maxMB}M`,
      '-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4',
      '-o', file,
    ];
    if (platform === 'douyin' || platform === 'kuaishou') args.push('--user-agent', UA);
    if (this.config[platform]?.cookie) args.push('--add-header', `Cookie:${this.config[platform].cookie}`);
    args.push(url);
    await runCommand(bin, args, { timeoutMs: Number(this.config.media?.downloadTimeoutSec || 600) * 1000 });
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.size) throw new Error('yt-dlp 没有生成视频文件');
    return file;
  }

  async #watchKuaishouHtml(url, { title = '', autoWrite = null, favorite = true } = {}) {
    const res = await this.#fetch(url, { headers: { accept: 'text/html', referer: 'https://www.kuaishou.com/' }, cookie: this.config.kuaishou?.cookie || '', userAgent: UA });
    const html = await res.text();
    const photo = html.match(/"(?:photoUrl|playUrl|srcNoWaterMark)"\s*:\s*"([^"]+)"/)?.[1] || '';
    if (!photo) throw new Error('快手页面没有解析到视频流');
    const clean = photo.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/\\/g, '');
    const pageTitle = title || decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()) || '快手视频';
    const file = path.join(this.dir, 'videos', `kuaishou-${shortHash(url).slice(0, 10)}.mp4`);
    await this.#download(clean, file, { headers: { referer: 'https://www.kuaishou.com/' }, maxMB: Number(this.config.media?.maxDownloadMB || 500), userAgent: UA });
    return this.#watchAndLearnFile(file, { title: pageTitle, platform: 'kuaishou', url, id: shortHash(url), tags: ['快手'], autoWrite, favorite });
  }

  #parseKuaishouSearch(html) {
    const items = [];
    const re = /"(?:photoId|id)"\s*:\s*"([a-zA-Z0-9_-]{6,})"[\s\S]{0,3000}?"caption"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) && items.length < 30) {
      items.push({ platform: 'kuaishou', id: m[1], title: decodeEntities(m[2]).slice(0, 200), author: '', url: `https://www.kuaishou.com/short-video/${m[1]}`, duration: 0, tags: [] });
    }
    return items;
  }

  /** B 站：真实下载并逐帧观看；没有流/下载失败时退回字幕或简介学习。 */
  async bilibiliWatch(bvidOrUrl, { download = true, autoWrite = null, favorite = true, maxMB = null } = {}) {
    const bvid = String(bvidOrUrl || '').match(/BV[0-9A-Za-z]+/)?.[0] || String(bvidOrUrl || '').trim();
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) return { ok: false, error: '需要 B 站 BV 号或视频链接' };
    try {
      const view = await this.#biliView(bvid);
      const cid = Number(view?.cid || view?.pages?.[0]?.cid || 0);
      if (!cid) throw new Error('视频没有 cid');
      const title = String(view.title || bvid).slice(0, 220);
      const aid = Number(view.aid || 0);
      const subtitles = await this.#biliSubtitles(bvid, cid).catch(() => null);
      const subtitleText = (subtitles?.segments || []).map((x) => x.speechText).filter(Boolean).join('\n').slice(0, 8000);
      const description = [view.desc || title, view.tname ? `分区：${view.tname}` : '', view.owner?.name ? `UP 主：${view.owner.name}` : ''].filter(Boolean).join('\n');
      const tags = [view.tname, ...(view.pages?.[0]?.part ? [view.pages[0].part] : [])].filter(Boolean);
      if (download !== false) {
        const play = await this.#biliJson('https://api.bilibili.com/x/player/playurl', {
          params: { bvid, cid, qn: 32, fnval: 0, fourk: 0, platform: 'html5' },
          cookie: Boolean(this.config.bilibili?.cookie),
        });
        const durl = play?.durl?.[0]?.url || play?.dash?.video?.[0]?.baseUrl;
        if (!durl) throw new Error('没有拿到视频流地址（可能需要登录 Cookie）');
        const file = path.join(this.dir, 'videos', `${bvid}-${cid}.mp4`);
        await this.#download(durl, file, {
          headers: this.#biliHeaders(),
          maxMB: Number(maxMB || this.config.bilibili?.maxDownloadMB || 300),
          userAgent: '',
        });
        const watched = await this.#watchAndLearnFile(file, {
          title, platform: 'bilibili', url: `https://www.bilibili.com/video/${bvid}`,
          id: bvid, tags, autoWrite, favorite, subtitleText, description,
        });
        let accountFavorite = null;
        if (this.config.bilibili?.autoFavorite !== false && this.config.bilibili?.cookie) {
          accountFavorite = await this.bilibiliFavorite(bvid, { title, aid }).catch((err) => ({ ok: false, error: err.message }));
        }
        return { ...watched, accountFavorite };
      }
      const fallbackSubs = subtitles || await this.#biliSubtitles(bvid, cid).catch(() => null);
      if (fallbackSubs?.segments?.length) {
        const text = fallbackSubs.segments.map((s) => `[${Math.floor(s.start)}s] ${s.speechText}`).join('\n');
        const learned = await this.learnText({ title, text, source: `bilibili:${bvid}`, url: `https://www.bilibili.com/video/${bvid}`, tags: ['bilibili', ...tags], autoWrite });
        await this.addFavorite({ platform: 'bilibili', id: bvid, title, url: `https://www.bilibili.com/video/${bvid}`, summary: learned.summary, tags: ['视频', 'bilibili', ...tags], noteFile: learned.noteFile }).catch(() => {});
        return { ok: true, bvid, title, mode: 'subtitles', ...learned };
      }
      return { ok: false, bvid, title, error: '没有可下载的视频流，且没有字幕', mode: 'no-stream' };
    } catch (err) {
      this.state.bilibili.lastError = err.message;
      await this.#saveState().catch(() => {});
      return { ok: false, bvid, error: err.message };
    }
  }

  /** 写入 B 站「DeepSeek的收藏夹」；需要 Cookie 含 bili_jct。失败只返回错误，不影响本地学习。 */
  async bilibiliFavorite(bvidOrUrl, { title = '', aid = 0 } = {}) {
    const cfg = this.config.bilibili || {};
    const cookie = String(cfg.cookie || '');
    if (!cookie) return { ok: false, reason: 'no-cookie' };
    const csrf = cookie.match(/bili_jct=([^;]+)/)?.[1];
    if (!csrf) return { ok: false, reason: 'no-csrf' };
    const bvid = String(bvidOrUrl || '').match(/BV[0-9A-Za-z]+/)?.[0] || String(bvidOrUrl || '').trim();
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) return { ok: false, reason: 'bad-bvid' };
    let aidValue = Number(aid || 0);
    if (!aidValue) {
      const view = await this.#biliView(bvid).catch(() => null);
      aidValue = Number(view?.aid || 0);
    }
    if (!aidValue) return { ok: false, reason: 'no-aid' };
    const nav = await this.#biliJson('https://api.bilibili.com/x/web-interface/nav', { cookie: true }).catch(() => null);
    const mid = Number(nav?.mid || nav?.mid || 0);
    if (!mid) return { ok: false, reason: 'not-logged-in' };
    const folderTitle = String(cfg.favoriteFolder || 'DeepSeek的收藏夹').slice(0, 40);
    const list = await this.#biliJson('https://api.bilibili.com/x/v3/fav/folder/created/list-all', { params: { up_mid: mid }, cookie: true }).catch(() => null);
    let folder = (list?.list || []).find((x) => String(x.title || '').trim() === folderTitle);
    if (!folder) {
      const created = await this.#biliPostForm('/x/v3/fav/folder/add', { title: folderTitle, privacy: 0, csrf });
      folder = { id: created?.id || created?.data?.id, title: folderTitle };
    }
    if (!folder?.id) return { ok: false, reason: 'no-folder-id' };
    const added = await this.#biliPostForm('/x/v3/fav/resource/deal', {
      rid: aidValue, type: 2, add_media_ids: folder.id, csrf,
    });
    return { ok: true, folder: folderTitle, folderId: folder.id, aid: aidValue, response: added };
  }

  // ───────────────────────── 文本学习 ─────────────────────────

  async learnText({ title, text, source = 'text', url = '', tags = [], autoWrite = null }) {
    const clean = String(text || '').replace(/\r/g, '').trim();
    if (!clean) return { ok: false, error: '没有可学习的文本' };
    const maxNotes = Math.max(1, Math.min(40, Number(this.config.learning?.maxNotesPerItem || 20)));
    const chunks = [];
    const step = 1200;
    for (let i = 0; i < clean.length && chunks.length < maxNotes; i += step) chunks.push(clean.slice(i, i + step));
    const notes = [];
    const useLlm = this.config.learning?.useLlm === true;
    for (const chunk of chunks) {
      const llm = useLlm ? await this.#learnChunkWithLlm(title, chunk).catch((err) => {
        this.logger?.debug?.('学习文本 LLM 不可用', { error: err.message });
        return null;
      }) : null;
      if (llm?.points?.length) {
        for (const p of llm.points.slice(0, 4)) notes.push({ content: String(p).slice(0, 600), tags: ['学习', ...tags].slice(0, 12) });
      } else {
        const sentences = chunk.split(/(?<=[。！？!?；;])|\n+/).map((s) => s.trim()).filter((s) => s.length >= 12).slice(0, 4);
        for (const s of sentences) notes.push({ content: s.slice(0, 600), tags: ['学习', ...tags].slice(0, 12) });
      }
    }
    const summary = notes.length ? textSummary(notes.map((n) => n.content).join(' '), 600) : textSummary(clean, 600);
    const dir = path.join(this.dir, 'notes');
    await fs.mkdir(dir, { recursive: true });
    const id = shortHash(`${source}|${title}|${clean.slice(0, 200)}`);
    const file = path.join(dir, `${id}.md`);
    await fs.writeFile(file, `# ${title}\n\n来源：${url || source}\n\n${notes.map((n, i) => `${i + 1}. ${n.content}`).join('\n')}\n`, { mode: 0o600 });
    const writeMemory = autoWrite ?? this.config.learning?.autoWriteMemory !== false;
    const memoryIds = [];
    if (writeMemory) {
      for (const note of notes.slice(0, 12)) {
        const entry = await this.memory.writeMemory({
          type: 'knowledge',
          summary: textSummary(note.content, 200),
          content: note.content,
          importance: 0.62,
          tags: note.tags,
          source: { kind: 'content', platform: source.split(':')[0], id: source },
          evidence: [{ videoId: '', start: 0, end: 0, quote: note.content.slice(0, 200) }],
        }).catch(() => null);
        if (entry) memoryIds.push(entry.id);
      }
      await this.interest.ingest({ knowledge: notes }).catch(() => {});
    }
    return { ok: true, title, noteFile: file, notes, summary, memoryIds, source, url };
  }

  async #learnChunkWithLlm(title, chunk) {
    const json = await this.host.llm.json([
      { role: 'system', content: '你是严谨的学习笔记抽取器。只依据给定文本，不补充常识，不编造。输出 JSON。' },
      { role: 'user', content: `标题：${title}\n文本：${chunk.slice(0, 3000)}\n输出：{"summary":"一句话","points":["可独立理解的知识点，最多4条"]}` },
    ], { temperature: 0.2, maxTokens: 800 });
    return json && Array.isArray(json.points) ? json : null;
  }

  // ───────────────────────── 小说 ─────────────────────────

  async #novelFetch(url) {
    const res = await this.#fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        ...(this.config.novel?.cookie ? { cookie: this.config.novel.cookie } : {}),
        ...(this.config.novel?.referer ? { referer: this.config.novel.referer } : {}),
      },
      timeoutMs: 30000,
    });
    const html = await res.text();
    const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()) || '未命名小说';
    const paragraphs = paragraphsFromHtml(html)
      .filter((p) => p.length >= 20 && !/^(推荐|诗文|名句|古籍|作者|字词|列表循环|随机播放|单曲循环|下载|扫码|客户端|古文岛|©|\d+(\.\d+)?x)/.test(p.trim()) && !/古诗文网|扫码|下载APP|播放器|字体大小|上一章|下一章/.test(p))
      .slice(0, 200);
    if (paragraphs.length < 2) throw new Error('页面没有提取到正文（可能需要登录 Cookie，或站点使用动态渲染）');
    const chapterLinks = [];
    const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    while ((lm = linkRe.exec(html)) && chapterLinks.length < 2000) {
      const label = stripHtml(lm[2]).replace(/\s+/g, '');
      if (!/第[0-9一二三四五六七八九十百千万]+[章节回卷]|章节目录|下一章|上一章|next|prev/i.test(label)) continue;
      try { chapterLinks.push({ title: label.slice(0, 80), url: new URL(lm[1], url).href }); } catch { /* ignore */ }
    }
    return { url, title, paragraphs, chapterLinks: chapterLinks.slice(0, 500), fetchedAt: nowIso() };
  }

  /** 公版中文小说目录检索：只索引明确的公版站点，避免抓取付费/受版权保护内容。 */
  async novelSearch(keyword = '') {
    const library = [
      { title: '三国演义', author: '罗贯中', aliases: ['三国', 'sanguo', '三国志演义'], url: 'https://www.diancang.xyz/wenxueyishu/sanguoyanyi/' },
      { title: '西游记', author: '吴承恩', aliases: ['西游', 'xiyouji'], url: 'https://www.diancang.xyz/wenxueyishu/xiyouji/' },
      { title: '水浒传', author: '施耐庵', aliases: ['水浒', 'shuihu'], url: 'https://www.diancang.xyz/wenxueyishu/shuihuzhuan/' },
      { title: '红楼梦', author: '曹雪芹', aliases: ['红楼', 'honglou'], url: 'https://www.diancang.xyz/wenxueyishu/hongloumeng/' },
      { title: '聊斋志异', author: '蒲松龄', aliases: ['聊斋', 'liaozhai'], url: 'https://www.diancang.xyz/wenxueyishu/liaozhaizhiyi/' },
    ];
    const q = String(keyword || '').trim().toLowerCase();
    const items = library
      .filter((x) => !q || [x.title, x.author, ...x.aliases].some((v) => String(v).toLowerCase().includes(q)))
      .map((x) => ({ platform: 'diancang', title: x.title, author: x.author, url: x.url }));
    return { ok: items.length > 0, keyword: q, items: items.length ? items : library.map((x) => ({ platform: 'diancang', title: x.title, author: x.author, url: x.url })) };
  }

  async novelOpen(url) {
    const target = String(url || this.config.novel?.defaultUrl || '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '需要 http(s) 小说页面地址' };
    try {
      const page = await this.#novelFetch(target);
      const id = shortHash(target);
      const file = path.join(this.novelDir, `${id}.json`);
      await fs.writeFile(file, `${JSON.stringify(page, null, 2)}\n`, { mode: 0o600 });
      const current = { id, url: target, title: page.title, file, chars: page.paragraphs.join('\n').length, at: nowIso() };
      this.state.novel.current = current;
      this.state.novel.history = [current, ...(this.state.novel.history || []).filter((x) => x.url !== target)].slice(0, 20);
      await this.#saveState();
      const summary = this.config.novel?.autoSummarize ? await this.#summarizeNovel(page).catch(() => null) : null;
      return { ok: true, ...current, paragraphs: page.paragraphs, chapterLinks: page.chapterLinks, summary };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async novelNext() {
    const cur = this.state.novel.current;
    if (!cur) return { ok: false, error: '还没有打开小说，请先给一个小说链接' };
    const page = await fs.readFile(cur.file, 'utf8').then(JSON.parse).catch(() => null);
    if (!page) return { ok: false, error: '小说缓存丢失，请重新打开' };
    const links = page.chapterLinks || [];
    const next = links.find((x) => /下一章|next/i.test(x.title)) || links.find((x) => /第[0-9一二三四五六七八九十百千万]+[章节回]/i.test(x.title) && x.url !== page.url);
    if (!next) return { ok: true, title: page.title, paragraphs: page.paragraphs, chapterLinks: links, note: '没有找到下一章链接，已停在当前页' };
    const result = await this.novelOpen(next.url);
    return result.ok ? { ...result, note: `已翻到：${next.title}` } : result;
  }

  async #summarizeNovel(page) {
    const text = page.paragraphs.join('\n').slice(0, 6000);
    const json = await this.host.llm.json([
      { role: 'system', content: '你是小说阅读助手。只依据文本概括，不编造情节。输出 JSON。' },
      { role: 'user', content: `标题：${page.title}\n正文：${text}\n输出：{"summary":"200字内概括","characters":["人物"],"themes":["主题"]}` },
    ], { temperature: 0.3, maxTokens: 900 });
    return json || null;
  }

  async novelLearn() {
    const cur = this.state.novel.current;
    if (!cur) return { ok: false, error: '还没有打开小说' };
    const page = await fs.readFile(cur.file, 'utf8').then(JSON.parse).catch(() => null);
    if (!page) return { ok: false, error: '小说缓存丢失' };
    return this.learnText({
      title: page.title, text: page.paragraphs.join('\n'), source: `novel:${page.url}`, url: page.url,
      tags: ['小说', '阅读'], autoWrite: this.config.learning?.autoWriteMemory !== false,
    });
  }
}

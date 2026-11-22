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
import { Mutex, nowIso, shortHash, textSummary, withTimeout, safeJsonParse } from '../lib/util.js';

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
    duration: Number(item.duration || item.duration_seconds || 0),
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
    this.mutex = new Mutex();
    this.state = { bilibili: { lastFeed: [], lastAt: null, lastError: null }, novel: { current: null, history: [] } };
    this.wbiCache = null;
  }

  async init() {
    await fs.mkdir(this.novelDir, { recursive: true });
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

  async #fetch(url, { headers = {}, timeoutMs = 30000, cookie = '' } = {}) {
    const h = { 'user-agent': UA, accept: '*/*', ...headers };
    if (cookie) h.cookie = cookie;
    const res = await withTimeout(fetch(url, { headers: h, redirect: 'follow' }), timeoutMs, '内容请求');
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
    const res = await this.#fetch(u, { headers: this.#biliHeaders(), cookie: cookie ? this.config.bilibili?.cookie : '' });
    const json = await res.json().catch(() => null);
    if (!json) throw new Error('B 站返回了非 JSON 内容');
    if (json.code !== 0) {
      const risk = [-352, -412, -509, -799].includes(json.code);
      throw new Error(`B 站接口 code=${json.code}：${json.message || '未知错误'}${risk ? '（触发风控/需要登录，已停止）' : ''}`);
    }
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
    return this.#biliJson('https://api.bilibili.com/x/web-interface/view', { params: { bvid } });
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

  async #download(url, file, { headers = {}, maxMB = 200 } = {}) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const res = await this.#fetch(url, { headers, timeoutMs: 120000 });
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
      await this.#download(durl, file, { headers: this.#biliHeaders(), maxMB: Number(this.config.bilibili?.maxDownloadMB || 200) });
      const entry = await this.video.registerVideo({ kind: 'file', value: file, title, headers: null }, { title });
      this.video.run(entry.videoId, { mode: 'hybrid' }).catch((err) => this.logger?.warn?.('B 站视频分析失败', { bvid, error: err.message }));
      return { ok: true, bvid, title, mode: 'download', videoId: entry.videoId, file, message: '已下载并开始完整视频分析；完成后可抽取知识。' };
    } catch (err) {
      this.state.bilibili.lastError = err.message;
      await this.#saveState().catch(() => {});
      return { ok: false, error: err.message, bvid };
    }
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
    for (const chunk of chunks) {
      const llm = await this.#learnChunkWithLlm(title, chunk).catch((err) => {
        this.logger?.debug?.('学习文本 LLM 不可用', { error: err.message });
        return null;
      });
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
    const paragraphs = paragraphsFromHtml(html).slice(0, 200);
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

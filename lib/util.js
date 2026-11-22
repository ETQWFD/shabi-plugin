/**
 * lib/util.js — 无依赖工具集（哈希、向量、并发、限流、时间、路径语义）。
 * 所有模块共享，不依赖宿主。
 */
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const nowIso = () => new Date().toISOString();

export function id(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function shortHash(input, len = 16) {
  return sha256(String(input)).slice(0, len);
}

/** 稳定 JSON：对象键排序，保证 checksum 可复算。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function checksumOf(value) {
  return sha256(canonicalJson(value));
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export const round = (n, digits = 3) => Number(n.toFixed(digits));

export const sleep = (ms) => delay(ms);

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 离线确定性词袋哈希向量：没有 embedding 服务时仍可做相似度去重。 */
export function hashEmbed(text, dim = 256) {
  const v = new Float64Array(dim);
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const token of tokens) {
    const h = crypto.createHash('sha1').update(token).digest();
    const idx = h.readUInt32BE(0) % dim;
    const sign = (h[4] & 1) === 0 ? 1 : -1;
    v[idx] += sign;
    // 二元组，保留局部语序
    if (token.length >= 2) {
      for (let i = 0; i < token.length - 1; i += 1) {
        const bi = crypto.createHash('sha1').update(token.slice(i, i + 2)).digest();
        v[bi.readUInt32BE(0) % dim] += (bi[4] & 1) === 0 ? 0.5 : -0.5;
      }
    }
  }
  const arr = Array.from(v);
  const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0)) || 1;
  return arr.map((x) => x / norm);
}

/** 互斥锁：串行化内存库/索引写入。 */
export class Mutex {
  #tail = Promise.resolve();

  run(fn) {
    const prev = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    return prev.then(fn).finally(() => release());
  }
}

/** 令牌桶限流（按 key 独立）。 */
export class RateLimiter {
  constructor({ capacity = 10, refillPerSec = 1 / 6 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
  }

  take(key, cost = 1, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, ts: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.ts) / 1000) * this.refillPerSec);
    b.ts = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  reset(key) {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }
}

/** 固定窗口 + LRU 去重集合。 */
export class DedupeSet {
  constructor({ max = 10000, ttlMs = 10 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  has(key, now = Date.now()) {
    const ts = this.map.get(key);
    if (!ts) return false;
    if (now - ts > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  add(key, now = Date.now()) {
    this.map.delete(key);
    this.map.set(key, now);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

export function getByPath(obj, path, fallback) {
  const parts = Array.isArray(path) ? path : String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

export function setByPath(obj, path, value) {
  const parts = Array.isArray(path) ? path : String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

export function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override.slice() : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (override && typeof override === 'object' && !Array.isArray(override)) {
      for (const [k, v] of Object.entries(override)) {
        out[k] = k in base ? deepMerge(base[k], v) : v;
      }
    }
    return out;
  }
  return override === undefined ? base : override;
}

export function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function parseClock(text) {
  // "07:30" / "7:30" -> 450
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function inQuietHours(range, date = new Date()) {
  if (!Array.isArray(range) || range.length !== 2) return false;
  const start = parseClock(range[0]);
  const end = parseClock(range[1]);
  if (start == null || end == null) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  if (start === end) return false;
  // 跨午夜
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export function randomBetween(min, max, rand = Math.random) {
  return min + (max - min) * rand();
}

export function withTimeout(promise, ms, label = 'operation') {
  if (!ms || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

export async function retry(fn, { attempts = 3, baseDelayMs = 500, maxDelayMs = 8000, onError } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (onError) onError(err, i);
      if (i < attempts - 1) {
        const wait = Math.min(maxDelayMs, baseDelayMs * 2 ** i);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/** 归一化 bbox 到 0..1，容忍像素坐标。 */
export function normalizeBbox(bbox, width, height) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  let [x1, y1, x2, y2] = bbox.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (width > 1 && height > 1 && (x1 > 1 || y1 > 1 || x2 > 1 || y2 > 1)) {
    x1 /= width;
    x2 /= width;
    y1 /= height;
    y2 /= height;
  }
  const nx1 = clamp(Math.min(x1, x2), 0, 1);
  const ny1 = clamp(Math.min(y1, y2), 0, 1);
  const nx2 = clamp(Math.max(x1, x2), 0, 1);
  const ny2 = clamp(Math.max(y1, y2), 0, 1);
  return { x: nx1, y: ny1, w: nx2 - nx1, h: ny2 - ny1 };
}

export function safeJsonParse(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 文本摘要（无 LLM 时的兜底，按句截断）。 */
export function textSummary(text, maxLen = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const idx = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('.'), cut.lastIndexOf('，'), cut.lastIndexOf(','));
  return `${idx > maxLen * 0.5 ? cut.slice(0, idx) : cut}…`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function toMs(sec) {
  return Math.round(Number(sec) * 1000);
}

/**
 * core/memory.js — 长期记忆（IOSHB 分卷 + 索引 + 遗忘/巩固/压缩/归档/召回）。
 *
 * 文件：
 *   memory/memory_1.ioshb … memory_N.ioshb   主库分卷
 *   memory/memory_index.ioshb                索引、访问统计、归档墓碑
 *   memory/archive/archive_*.ioshb           归档库
 *
 * 每条记忆字段（checksum 覆盖除自身外的全部字段）：
 *   id, time, type, summary, content, importance, lastAccess, accessCount,
 *   tags, emotion, source, evidence, strength, version, checksum
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Mutex, checksumOf, cosine, id as makeId, nowIso, canonicalJson, clamp,
  textSummary, hashEmbed,
} from '../lib/util.js';
import { readFile as readIoshb, writeFileAtomic, exists } from '../lib/ioshb.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INDEX_VERSION = 1;
const ENTRY_FIELDS = [
  'id', 'time', 'type', 'summary', 'content', 'importance', 'lastAccess', 'accessCount',
  'tags', 'emotion', 'source', 'evidence', 'strength', 'version',
];
const TYPES = new Set(['knowledge', 'observation', 'chat', 'todo', 'emotion', 'event', 'preference', 'selfie']);

function entryChecksum(entry) {
  const payload = {};
  for (const f of ENTRY_FIELDS) payload[f] = entry[f];
  return checksumOf(payload);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 32);
  if (typeof tags === 'string') return tags.split(/[,，\s]+/).filter(Boolean).slice(0, 32);
  return [];
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map((e) => ({
      videoId: String(e.videoId ?? ''),
      start: Number(e.start ?? 0),
      end: Number(e.end ?? 0),
      knowledgeId: e.knowledgeId ? String(e.knowledgeId) : undefined,
      quote: e.quote ? String(e.quote).slice(0, 240) : undefined,
    }))
    .filter((e) => e.videoId || e.knowledgeId);
}

/** 中文/英文混合分词，供无向量时的召回使用。 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const words = s.match(/[a-z0-9_]+/g) || [];
  const cjk = s.match(/[\u4e00-\u9fff]/g) || [];
  const bigrams = [];
  for (let i = 0; i < cjk.length - 1; i += 1) bigrams.push(cjk[i] + cjk[i + 1]);
  return [...new Set([...words, ...bigrams])];
}

function lexicalScore(entry, queryTokens, rawQuery) {
  const summary = String(entry.summary || '').toLowerCase();
  const content = String(entry.content || '').toLowerCase();
  const tags = (entry.tags || []).join(' ').toLowerCase();
  let score = 0;
  for (const t of queryTokens) {
    if (tags.includes(t)) score += 4;
    else if (summary.includes(t)) score += 3;
    else if (content.includes(t)) score += 1.6;
  }
  if (rawQuery && summary.includes(rawQuery.toLowerCase())) score += 2;
  return score;
}

export class MemoryStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.memory;
    this.dir = ctx.paths.memory;
    this.archiveDir = ctx.paths.archive;
    this.logger = ctx.logger;
    this.crypto = ctx.crypto;
    this.host = ctx.host;
    this.mutex = new Mutex();
    this.entries = new Map();
    this.entryFile = new Map();
    this.index = null;
    this.dirty = new Set();
    this.loaded = false;
    this.flushTimer = null;
    this.stats = { checksumRepairs: 0, loaded: 0, archived: 0, forgotten: 0, compressed: 0, resurfaced: 0 };
  }

  async initMemory() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(this.archiveDir, { recursive: true });

    let index = null;
    try {
      index = await readIoshb(path.join(this.dir, 'memory_index.ioshb'));
    } catch {
      index = null;
    }
    if (!index || !Array.isArray(index.files)) {
      this.logger?.warn('记忆索引缺失或损坏，正在扫描重建');
      index = await this.#scanIndex();
    }
    this.index = this.#normalizeIndex(index);
    this.entries.clear();
    this.entryFile.clear();

    for (const file of this.index.files) {
      await this.#loadFile(file.name);
    }
    this.loaded = true;
    this.stats.loaded = this.entries.size;
    await this.#recomputeMaxAccess();
    await this.#writeIndex({ backup: true });
    this.logger?.info('记忆库已加载', { entries: this.entries.size, files: this.index.files.length, repairs: this.stats.checksumRepairs });
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushDirty().catch(() => {}), 5000);
      if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
    }
    return this.getStats();
  }

  #normalizeIndex(index) {
    return {
      format: 'IOSHB1',
      version: INDEX_VERSION,
      createdAt: index.createdAt || nowIso(),
      updatedAt: index.updatedAt || nowIso(),
      files: (index.files || []).map((f) => ({
        name: f.name,
        count: Number(f.count || 0),
        bytes: Number(f.bytes || 0),
        minTime: f.minTime || null,
        maxTime: f.maxTime || null,
      })),
      archiveFiles: (index.archiveFiles || []).map((f) => ({ name: f.name, count: Number(f.count || 0) })),
      maxAccess: Number(index.maxAccess || 1),
      totalCount: Number(index.totalCount || 0),
      tombstones: Array.isArray(index.tombstones) ? index.tombstones : [],
      stats: index.stats || {},
    };
  }

  async #scanIndex() {
    const index = {
      format: 'IOSHB1',
      version: INDEX_VERSION,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      files: [],
      archiveFiles: [],
      maxAccess: 1,
      totalCount: 0,
      tombstones: [],
      stats: {},
    };
    let names = [];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => /^memory_\d+\.ioshb$/.test(n));
    } catch {
      names = [];
    }
    if (names.length === 0) {
      index.files.push({ name: 'memory_1.ioshb', count: 0, bytes: 0, minTime: null, maxTime: null });
      await writeFileAtomic(path.join(this.dir, 'memory_1.ioshb'), { format: 'IOSHB1', version: 1, entries: [], createdAt: nowIso(), updatedAt: nowIso() }, { backup: false });
    }
    for (const name of names.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])) ) {
      const file = path.join(this.dir, name);
      let data;
      try {
        data = await readIoshb(file);
      } catch {
        continue;
      }
      const entries = data.entries || [];
      const stat = await fs.stat(file).catch(() => ({ size: 0 }));
      index.files.push({
        name,
        count: entries.length,
        bytes: stat.size,
        minTime: entries.reduce((m, e) => (!m || e.time < m ? e.time : m), null),
        maxTime: entries.reduce((m, e) => (!m || e.time > m ? e.time : m), null),
      });
      index.totalCount += entries.length;
      index.maxAccess = Math.max(index.maxAccess, ...entries.map((e) => Number(e.accessCount || 0)), 1);
    }
    try {
      const archives = (await fs.readdir(this.archiveDir)).filter((n) => /^archive_\d+\.ioshb$/.test(n));
      for (const name of archives) {
        const data = await readIoshb(path.join(this.archiveDir, name)).catch(() => null);
        if (data) index.archiveFiles.push({ name, count: (data.entries || []).length });
      }
    } catch {
      // ignore
    }
    await writeFileAtomic(path.join(this.dir, 'memory_index.ioshb'), index, { backup: false });
    return index;
  }

  async #loadFile(name) {
    const file = path.join(this.dir, name);
    let data;
    try {
      data = await readIoshb(file);
    } catch (err) {
      this.logger?.error('记忆分卷读取失败，已跳过', { file: name, error: err.message });
      return;
    }
    for (const raw of data.entries || []) {
      let entry;
      try {
        entry = this.#decryptEntry(raw);
      } catch (err) {
        this.logger?.error('记忆解密失败，已跳过', { id: raw?.id, error: err.message });
        continue;
      }
      const expect = entryChecksum(entry);
      if (raw.checksum !== expect) {
        entry.checksum = expect;
        entry.__checksumRepaired = true;
        this.stats.checksumRepairs += 1;
        this.dirty.add(entry.id);
      }
      this.entries.set(entry.id, entry);
      this.entryFile.set(entry.id, name);
    }
  }

  #decryptEntry(raw) {
    const entry = { ...raw };
    for (const f of ['summary', 'content']) {
      if (typeof entry[f] === 'string' && this.crypto) entry[f] = this.crypto.decrypt(entry[f]);
    }
    entry.tags = normalizeTags(entry.tags);
    entry.evidence = normalizeEvidence(entry.evidence);
    entry.accessCount = Math.max(0, Number(entry.accessCount || 0));
    entry.importance = clamp(Number(entry.importance ?? 0.5), 0, 1);
    entry.strength = clamp(Number(entry.strength ?? 1), 0, 1);
    entry.version = Number(entry.version || 1);
    if (!entry.lastAccess) entry.lastAccess = entry.time;
    return entry;
  }

  #encryptEntry(entry) {
    const copy = { ...entry };
    delete copy.__checksumRepaired;
    if (this.crypto && this.config.encrypt) {
      for (const f of ['summary', 'content']) {
        if (typeof copy[f] === 'string') copy[f] = this.crypto.encrypt(copy[f]);
      }
    }
    return copy;
  }

  /** 调用方负责加锁；索引写入本身不再获取 mutex，避免重入死锁。 */
  async #writeIndex({ backup = true } = {}) {
    this.index.updatedAt = nowIso();
    this.index.totalCount = this.entries.size;
    this.index.maxAccess = Math.max(1, ...Array.from(this.entries.values(), (e) => e.accessCount), 1);
    await writeFileAtomic(path.join(this.dir, 'memory_index.ioshb'), this.index, { backup });
  }

  async #recomputeMaxAccess() {
    this.index.maxAccess = Math.max(1, ...Array.from(this.entries.values(), (e) => Number(e.accessCount || 0)), 1);
  }

  #fileMeta(name) {
    let meta = this.index.files.find((f) => f.name === name);
    if (!meta) {
      meta = { name, count: 0, bytes: 0, minTime: null, maxTime: null };
      this.index.files.push(meta);
    }
    return meta;
  }

  async #writeMemoryFile(name, entries) {
    const file = path.join(this.dir, name);
    const encrypted = entries.map((e) => this.#encryptEntry(e));
    const payload = { format: 'IOSHB1', version: 1, createdAt: this.#fileMeta(name).createdAt || nowIso(), updatedAt: nowIso(), entries: encrypted };
    await writeFileAtomic(file, payload, { backup: true });
    const stat = await fs.stat(file).catch(() => ({ size: 0 }));
    const meta = this.#fileMeta(name);
    meta.count = entries.length;
    meta.bytes = stat.size;
    meta.minTime = entries.reduce((m, e) => (!m || e.time < m ? e.time : m), null);
    meta.maxTime = entries.reduce((m, e) => (!m || e.time > m ? e.time : m), null);
    return meta;
  }

  async #persistEntry(entry) {
    const name = this.entryFile.get(entry.id) || this.#currentFileName();
    const ids = Array.from(this.entries.keys()).filter((k) => this.entryFile.get(k) === name);
    const list = ids.map((k) => this.entries.get(k)).filter(Boolean);
    if (!list.some((e) => e.id === entry.id)) list.push(entry);
    this.entryFile.set(entry.id, name);
    await this.#writeMemoryFile(name, list);
    this.dirty.delete(entry.id);
  }

  #currentFileName() {
    const files = this.index.files;
    if (files.length === 0) {
      this.index.files.push({ name: 'memory_1.ioshb', count: 0, bytes: 0, minTime: null, maxTime: null });
    }
    return files[files.length - 1].name;
  }

  async flushDirty() {
    if (!this.loaded || this.dirty.size === 0) return { flushed: 0 };
    return this.mutex.run(async () => {
      const byFile = new Map();
      for (const id of this.dirty) {
        const name = this.entryFile.get(id) || this.#currentFileName();
        if (!byFile.has(name)) byFile.set(name, new Set());
        byFile.get(name).add(id);
      }
      let flushed = 0;
      for (const [name, ids] of byFile) {
        const list = Array.from(this.entries.keys())
          .filter((k) => this.entryFile.get(k) === name)
          .map((k) => this.entries.get(k))
          .filter(Boolean);
        if (list.length) {
          await this.#writeMemoryFile(name, list);
          flushed += ids.size;
          for (const id of ids) this.dirty.delete(id);
        }
      }
      await this.#writeIndex({ backup: true });
      return { flushed };
    });
  }

  normalizeEntry(input = {}) {
    const now = nowIso();
    let type = String(input.type || 'observation');
    if (!TYPES.has(type)) type = 'observation';
    const entry = {
      id: input.id || makeId('mem'),
      time: input.time || now,
      type,
      summary: textSummary(input.summary || input.content || '', 280),
      content: String(input.content || input.summary || ''),
      importance: clamp(Number(input.importance ?? 0.5), 0, 1),
      lastAccess: input.lastAccess || now,
      accessCount: Math.max(0, Number(input.accessCount || 0)),
      tags: normalizeTags(input.tags),
      emotion: String(input.emotion || 'neutral'),
      source: typeof input.source === 'string' ? { kind: input.source } : input.source || { kind: 'manual' },
      evidence: normalizeEvidence(input.evidence),
      strength: clamp(Number(input.strength ?? 1), 0, 1),
      version: Number(input.version || 1),
    };
    entry.checksum = entryChecksum(entry);
    return entry;
  }

  async writeMemory(input) {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.initMemory();
      const entry = this.normalizeEntry(input);
      if (this.entries.has(entry.id)) {
        entry.version = this.entries.get(entry.id).version + 1;
        entry.checksum = entryChecksum(entry);
      }
      const existingFile = this.entries.has(entry.id) ? this.entryFile.get(entry.id) : null;
      let target;
      if (existingFile && this.index.files.some((f) => f.name === existingFile)) {
        // 更新必须写回原分卷，否则旧副本会在重新加载时复活
        target = existingFile;
      } else {
        target = this.#currentFileName();
        const meta = this.#fileMeta(target);
        if (meta.count >= this.config.maxEntriesPerFile || meta.bytes >= this.config.maxFileBytes) {
          target = `memory_${this.index.files.length + 1}.ioshb`;
          this.#fileMeta(target);
        }
      }
      this.entries.set(entry.id, entry);
      this.entryFile.set(entry.id, target);
      const list = Array.from(this.entries.keys())
        .filter((k) => this.entryFile.get(k) === target)
        .map((k) => this.entries.get(k))
        .filter(Boolean);
      if (!list.some((e) => e.id === entry.id)) list.push(entry);
      await this.#writeMemoryFile(target, list);
      await this.#writeIndex({ backup: true });
      this.host?.ui?.emit?.('shabi:memory-written', { id: entry.id, type: entry.type });
      return entry;
    });
  }

  getMemory(memoryId) {
    return this.entries.get(memoryId) || null;
  }

  listMemories({ type, tag, limit = 50, offset = 0, includeArchive = false } = {}) {
    let list = Array.from(this.entries.values());
    if (type) list = list.filter((e) => e.type === type);
    if (tag) list = list.filter((e) => e.tags.includes(tag));
    list.sort((a, b) => (a.time < b.time ? 1 : -1));
    const total = list.length;
    const page = list.slice(offset, offset + limit);
    if (includeArchive) {
      // 仅返回墓碑摘要，正文需 unarchive
      const archived = (this.index.tombstones || []).map((t) => ({ id: t.id, archivedAt: t.archivedAt, archiveFile: t.archiveFile, archived: true }));
      return { total, items: page, archived };
    }
    return { total, items: page };
  }

  markAccess(memoryId, now = new Date()) {
    const entry = this.entries.get(memoryId);
    if (!entry) return null;
    entry.lastAccess = now.toISOString();
    entry.accessCount += 1;
    entry.version += 1;
    entry.checksum = entryChecksum(entry);
    this.index.maxAccess = Math.max(this.index.maxAccess || 1, entry.accessCount);
    this.dirty.add(memoryId);
    return entry;
  }

  async searchMemory(query, topK = 8, { touch = true, filter = null, embedding = null } = {}) {
    if (!this.loaded) await this.initMemory();
    const rawQuery = String(query || '').trim();
    const tokens = tokenize(rawQuery);
    const all = Array.from(this.entries.values()).filter((e) => (filter ? filter(e) : true));
    let queryVec = embedding;
    if (!queryVec && rawQuery) {
      try {
        const vecs = await this.host.llm.embed([rawQuery]);
        queryVec = vecs?.[0];
      } catch {
        queryVec = null;
      }
    }
    const scored = [];
    for (const entry of all) {
      const lex = lexicalScore(entry, tokens, rawQuery);
      let sim = 0;
      if (queryVec) {
        const entryVec = hashEmbed(`${entry.summary} ${entry.content} ${entry.tags.join(' ')}`);
        sim = cosine(queryVec, entryVec);
      }
      const days = Math.max(0, (Date.now() - new Date(entry.lastAccess).getTime()) / DAY_MS);
      const recency = Math.exp(-days / Math.max(1, this.config.halfLifeDays));
      const score = lex * 0.55 + sim * 0.3 + entry.importance * 0.1 + recency * 0.05 + entry.strength * 0.05;
      if (rawQuery && lex === 0 && sim < 0.25) continue;
      scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.entry.time < b.entry.time ? 1 : -1));
    const picked = scored.slice(0, Math.max(1, topK));
    if (touch) for (const p of picked) this.markAccess(p.entry.id);
    return picked.map((p) => ({ ...p.entry, _score: round2(p.score) }));
  }

  async recallByScene(scene, topK = 6) {
    if (!scene) return [];
    const text = [scene.app, scene.window, scene.text, scene.scene, (scene.elements || []).map((e) => e.label).join(' ')]
      .filter(Boolean)
      .join(' ');
    const tokens = tokenize(text);
    const emotion = scene.emotion || null;
    const scored = [];
    for (const entry of this.entries.values()) {
      let score = lexicalScore(entry, tokens, '');
      if (emotion && entry.emotion === emotion) score += 2;
      if ((entry.tags || []).some((t) => text.toLowerCase().includes(t.toLowerCase()))) score += 3;
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, topK);
    for (const p of picked) this.markAccess(p.entry.id);
    return picked.map((p) => ({ ...p.entry, _score: round2(p.score) }));
  }

  /** 遗忘结算：按遗忘分与强度衰减归档。 */
  async forgetTick(now = new Date()) {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.initMemory();
      const halfLife = Math.max(1, this.config.halfLifeDays);
      const tauBase = Math.max(1, this.config.tauBaseDays);
      const tauMax = Math.max(tauBase, this.config.tauMaxDays);
      const toArchive = [];
      let evaluated = 0;
      for (const entry of this.entries.values()) {
        evaluated += 1;
        const deltaDays = Math.max(0, (now.getTime() - new Date(entry.lastAccess).getTime()) / DAY_MS);
        const recency = Math.exp(-deltaDays / halfLife);
        const accessNorm = Math.min(1, Math.log1p(entry.accessCount) / Math.log1p(Math.max(1, this.index.maxAccess)));
        const forgetScore = entry.importance * 0.5 + recency * 0.3 + accessNorm * 0.2;
        const tau = Math.min(tauMax, tauBase * (0.5 + entry.importance * 1.5));
        const decayed = entry.strength * Math.exp(-deltaDays / tau);
        entry.lastDecayAt = now.toISOString();
        entry.forgetScore = round2(forgetScore);
        if (decayed < this.config.strengthThreshold || forgetScore < this.config.forgetThreshold) {
          toArchive.push({ entry, reason: decayed < this.config.strengthThreshold ? 'strength-decayed' : 'forget-score' });
        } else if (Math.abs(entry.strength - decayed) > 0.001) {
          entry.strength = clamp(decayed, 0, 1);
          entry.version += 1;
          entry.checksum = entryChecksum(entry);
          this.dirty.add(entry.id);
        }
      }
      for (const { entry, reason } of toArchive) {
        if (this.config.archiveEnabled) await this.#archiveEntry(entry, reason, { rewrite: false });
        else await this.#deleteEntry(entry.id, { rewrite: false });
      }
      if (toArchive.length) await this.#rewriteAllFiles();
      this.index.stats.lastForgetTick = now.toISOString();
      this.index.stats.evaluated = evaluated;
      if (toArchive.length) this.logger?.info('记忆遗忘结算', { evaluated, archived: toArchive.length });
      await this.#writeIndex({ backup: true });
      return { evaluated, archived: toArchive.length, ids: toArchive.map((t) => t.entry.id) };
    });
  }

  async #nextArchiveFile() {
    if (!this.index.archiveFiles || this.index.archiveFiles.length === 0) {
      const names = (await fs.readdir(this.archiveDir).catch(() => [])).filter((n) => /^archive_\d+\.ioshb$/.test(n));
      this.index.archiveFiles = [];
      for (const name of names.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))) {
        const count = (await readIoshb(path.join(this.archiveDir, name)).catch(() => ({ entries: [] }))).entries?.length || 0;
        this.index.archiveFiles.push({ name, count });
      }
    }
    const files = this.index.archiveFiles;
    if (files.length === 0) files.push({ name: 'archive_1.ioshb', count: 0 });
    let last = files[files.length - 1];
    if (last.count >= this.config.maxEntriesPerFile) {
      const n = Number(last.name.match(/\d+/)[0]) + 1;
      last = { name: `archive_${n}.ioshb`, count: 0 };
      files.push(last);
    }
    return last.name;
  }

  async #archiveEntry(entry, reason, { rewrite = true } = {}) {
    const name = await this.#nextArchiveFile();
    const file = path.join(this.archiveDir, name);
    const data = (await readIoshb(file).catch(() => null)) || { format: 'IOSHB1', version: 1, entries: [] };
    const stored = this.#encryptEntry({ ...entry, archivedAt: nowIso(), archiveReason: reason });
    data.entries = [...(data.entries || []).filter((e) => e.id !== entry.id), stored];
    data.updatedAt = nowIso();
    await writeFileAtomic(file, data, { backup: true });
    const meta = this.index.archiveFiles.find((f) => f.name === name);
    if (meta) meta.count = data.entries.length;
    this.index.tombstones = (this.index.tombstones || []).filter((t) => t.id !== entry.id);
    this.index.tombstones.push({ id: entry.id, archiveFile: name, archivedAt: nowIso(), reason });
    this.entries.delete(entry.id);
    this.entryFile.delete(entry.id);
    this.dirty.delete(entry.id);
    this.stats.archived += 1;
    if (rewrite) await this.#rewriteAllFiles();
  }

  async #deleteEntry(memoryId, { rewrite = true } = {}) {
    const entry = this.entries.get(memoryId);
    if (!entry) return false;
    this.entries.delete(memoryId);
    this.entryFile.delete(memoryId);
    this.dirty.delete(memoryId);
    if (rewrite) await this.#rewriteAllFiles();
    return true;
  }

  async #rewriteAllFiles() {
    const byFile = new Map();
    for (const [entryId, entry] of this.entries) {
      const name = this.entryFile.get(entryId) || this.#currentFileName();
      if (!byFile.has(name)) byFile.set(name, []);
      byFile.get(name).push(entry);
    }
    // 空分卷也必须重写：否则删除最后一条后旧内容仍会留在磁盘上“复活”。
    const names = new Set([
      ...(this.index?.files || []).map((f) => f.name),
      ...byFile.keys(),
      this.#currentFileName(),
    ]);
    for (const name of names) await this.#writeMemoryFile(name, byFile.get(name) || []);
    await this.#writeIndex({ backup: true });
  }

  async archiveMemory(memoryId, reason = 'manual') {
    return this.mutex.run(async () => {
      const entry = this.entries.get(memoryId);
      if (!entry) throw new Error(`记忆不存在：${memoryId}`);
      await this.#archiveEntry(entry, reason);
      return { ok: true, id: memoryId };
    });
  }

  async readArchiveEntries() {
    const out = [];
    const files = (await fs.readdir(this.archiveDir).catch(() => [])).filter((n) => /^archive_\d+\.ioshb$/.test(n));
    for (const name of files.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))) {
      const data = await readIoshb(path.join(this.archiveDir, name)).catch(() => null);
      for (const raw of data?.entries || []) {
        try {
          out.push({ ...this.#decryptEntry(raw), archiveFile: name, archivedAt: raw.archivedAt, archiveReason: raw.archiveReason });
        } catch {
          // 跳过损坏条目
        }
      }
    }
    return out;
  }

  async unarchiveMemory(memoryId, { boost = true } = {}) {
    return this.mutex.run(async () => {
      const tomb = (this.index.tombstones || []).find((t) => t.id === memoryId);
      if (!tomb) throw new Error(`归档中没有该记忆：${memoryId}`);
      const file = path.join(this.archiveDir, tomb.archiveFile);
      const data = await readIoshb(file);
      const raw = (data.entries || []).find((e) => e.id === memoryId);
      if (!raw) throw new Error(`归档文件缺少条目：${memoryId}`);
      const entry = this.#decryptEntry(raw);
      if (boost) {
        entry.importance = clamp(entry.importance + 0.15, 0, 1);
        entry.strength = Math.max(0.8, entry.strength);
        entry.tags = normalizeTags([...entry.tags, 'resurfaced']);
        entry.emotion = entry.emotion || 'surprised';
      }
      entry.lastAccess = nowIso();
      entry.accessCount += 1;
      entry.version += 1;
      entry.checksum = entryChecksum(entry);
      delete entry.__checksumRepaired;

      data.entries = (data.entries || []).filter((e) => e.id !== memoryId);
      data.updatedAt = nowIso();
      await writeFileAtomic(file, data, { backup: true });
      this.index.tombstones = this.index.tombstones.filter((t) => t.id !== memoryId);
      const meta = this.index.archiveFiles.find((f) => f.name === tomb.archiveFile);
      if (meta) meta.count = data.entries.length;

      await this.#persistEntry(entry);
      this.entries.set(memoryId, entry);
      await this.#writeIndex({ backup: true });
      this.stats.resurfaced += 1;
      this.logger?.info('记忆被重新记起', { id: memoryId, importance: entry.importance });
      return entry;
    });
  }

  /** 在归档中检索并唤醒（“突然记起来”）。 */
  async resurfaceMemory(query, { minScore = 0.45 } = {}) {
    const archived = await this.readArchiveEntries();
    const tokens = tokenize(query);
    let best = null;
    for (const entry of archived) {
      const s = lexicalScore(entry, tokens, query);
      if (!best || s > best.score) best = { entry, score: s };
    }
    if (!best || best.score < Math.max(1, minScore * 3)) return null;
    const restored = await this.unarchiveMemory(best.entry.id, { boost: true });
    return { ...restored, _resurfaced: true, _score: best.score };
  }

  async consolidate(memoryId) {
    const entry = this.entries.get(memoryId);
    if (!entry) throw new Error(`记忆不存在：${memoryId}`);
    const related = await this.searchMemory(entry.summary, 5, { touch: false, filter: (e) => e.id !== memoryId });
    let summary = entry.summary;
    try {
      const res = await this.host.llm.chat(
        [
          { role: 'system', content: '你是记忆巩固器。把给定记忆压缩成一句更准确、可复用的话，保留关键事实，不编造。只输出一句话。' },
          { role: 'user', content: `记忆：${entry.summary}\n内容：${entry.content.slice(0, 1200)}` },
        ],
        { temperature: 0.2, maxTokens: 120 },
      );
      if (res?.text) summary = textSummary(res.text.replace(/\s+/g, ' '), 200);
    } catch {
      // 无 LLM 时保留原摘要
    }
    entry.summary = summary || entry.summary;
    entry.tags = normalizeTags([...entry.tags, ...(related.flatMap((r) => r.tags || []))]).slice(0, 32);
    const boost = 0.1 + (Math.abs(emotionValence(entry.emotion)) > 0.6 ? 0.1 : 0) + Math.min(0.1, entry.accessCount * 0.01);
    entry.strength = clamp(entry.strength + boost, 0, 1);
    entry.version += 1;
    entry.checksum = entryChecksum(entry);
    await this.mutex.run(async () => {
      await this.#persistEntry(entry);
      await this.#writeIndex({ backup: true });
    });
    return { ...entry, relatedIds: related.map((r) => r.id) };
  }

  /** 相似记忆合并压缩，证据指针保留。 */
  async compressMemory({ similarity = this.config.compressSimilarity || 0.92 } = {}) {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.initMemory();
      const list = Array.from(this.entries.values());
      if (list.length < 2) return { merged: 0, groups: [] };
      let vecs;
      try {
        vecs = await this.host.llm.embed(list.map((e) => `${e.type} ${e.summary}`));
      } catch {
        vecs = list.map((e) => hashEmbed(`${e.type} ${e.summary}`));
      }
      const used = new Set();
      const groups = [];
      for (let i = 0; i < list.length; i += 1) {
        if (used.has(list[i].id)) continue;
        const group = [list[i]];
        used.add(list[i].id);
        for (let j = i + 1; j < list.length; j += 1) {
          if (used.has(list[j].id) || list[j].type !== list[i].type) continue;
          if (cosine(vecs[i], vecs[j]) >= similarity) {
            group.push(list[j]);
            used.add(list[j].id);
          }
        }
        if (group.length >= 2) groups.push(group);
      }
      const mergedIds = [];
      for (const group of groups) {
        const base = group[0];
        const merged = this.normalizeEntry({
          ...base,
          id: makeId('mem'),
          summary: textSummary(group.map((g) => g.summary).join('；'), 280),
          content: group.map((g) => `- ${g.summary}\n${g.content}`).join('\n').slice(0, 4000),
          importance: Math.max(...group.map((g) => g.importance)),
          accessCount: group.reduce((s, g) => s + g.accessCount, 0),
          tags: normalizeTags(group.flatMap((g) => g.tags)),
          evidence: group.flatMap((g) => g.evidence || []),
          strength: Math.max(...group.map((g) => g.strength)),
          source: { kind: 'compressed', from: group.map((g) => g.id) },
          emotion: group.map((g) => g.emotion).sort((a, b) => emotionValence(b) - emotionValence(a))[0],
        });
        merged.mergedFrom = group.map((g) => g.id);
        merged.version = 1;
        merged.checksum = entryChecksum(merged);
        for (const g of group) {
          await this.#archiveEntryRaw(g, 'compressed');
        }
        this.entries.set(merged.id, merged);
        this.entryFile.set(merged.id, this.#currentFileName());
        await this.#persistEntry(merged);
        mergedIds.push(merged.id);
        this.stats.compressed += group.length;
      }
      await this.#writeIndex({ backup: true });
      this.logger?.info('记忆压缩完成', { groups: groups.length, merged: mergedIds.length });
      return { merged: mergedIds.length, groups: mergedIds };
    });
  }

  /** 归档但不触发全量重写（用于压缩场景，由调用方统一写入）。 */
  async #archiveEntryRaw(entry, reason) {
    const name = await this.#nextArchiveFile();
    const file = path.join(this.archiveDir, name);
    const data = (await readIoshb(file).catch(() => null)) || { format: 'IOSHB1', version: 1, entries: [] };
    data.entries = [...(data.entries || []).filter((e) => e.id !== entry.id), this.#encryptEntry({ ...entry, archivedAt: nowIso(), archiveReason: reason })];
    await writeFileAtomic(file, data, { backup: true });
    const meta = this.index.archiveFiles.find((f) => f.name === name);
    if (meta) meta.count = data.entries.length;
    this.index.tombstones.push({ id: entry.id, archiveFile: name, archivedAt: nowIso(), reason });
    this.entries.delete(entry.id);
    this.entryFile.delete(entry.id);
  }

  async deleteMemory(memoryId) {
    return this.mutex.run(async () => {
      if (!this.entries.has(memoryId)) return { ok: false, reason: 'not-found' };
      await this.#deleteEntry(memoryId);
      this.logger?.warn('记忆被手动删除', { id: memoryId });
      return { ok: true, id: memoryId };
    });
  }

  async exportMemory(targetPath, { format = this.config.exportFormat || 'ini' } = {}) {
    await this.flushDirty();
    let file = targetPath;
    if (!path.extname(file)) await fs.mkdir(file, { recursive: true });
    if ((await fs.stat(file).catch(() => null))?.isDirectory()) {
      let n = 1;
      while (await exists(path.join(file, `memory_export_${n}.ini`))) n += 1;
      file = path.join(file, `memory_export_${n}.ini`);
    }
    if (format === 'ioshb') {
      const payload = { format: 'IOSHB1', exportedAt: nowIso(), entries: Array.from(this.entries.values()) };
      await writeFileAtomic(file, payload, { backup: false });
      return { path: file, count: payload.entries.length };
    }
    const entries = Array.from(this.entries.values()).sort((a, b) => (a.time < b.time ? -1 : 1));
    const lines = [
      '; 沙币记忆导出（INI，序号从 1 开始）',
      `; exported_at=${nowIso()}`,
      `; count=${entries.length}`,
      '',
    ];
    entries.forEach((e, i) => {
      lines.push(`[memory ${i + 1}]`);
      lines.push(`id=${e.id}`);
      lines.push(`time=${e.time}`);
      lines.push(`type=${e.type}`);
      lines.push(`summary=${escapeIni(e.summary)}`);
      lines.push(`content=${escapeIni(e.content)}`);
      lines.push(`importance=${e.importance}`);
      lines.push(`lastAccess=${e.lastAccess}`);
      lines.push(`accessCount=${e.accessCount}`);
      lines.push(`tags=${escapeIni(e.tags.join(','))}`);
      lines.push(`emotion=${e.emotion}`);
      lines.push(`strength=${e.strength}`);
      lines.push(`source=${escapeIni(JSON.stringify(e.source))}`);
      lines.push(`evidence=${escapeIni(JSON.stringify(e.evidence))}`);
      lines.push(`checksum=${e.checksum}`);
      lines.push('');
    });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, lines.join('\n'), { mode: 0o600 });
    return { path: file, count: entries.length };
  }

  getStats() {
    return {
      ...this.stats,
      loaded: this.loaded,
      entries: this.entries.size,
      files: this.index?.files?.length || 0,
      archiveFiles: this.index?.archiveFiles?.length || 0,
      archived: this.index?.tombstones?.length || 0,
      maxAccess: this.index?.maxAccess || 1,
      lastForgetTick: this.index?.stats?.lastForgetTick || null,
    };
  }

  async close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.flushDirty().catch(() => {});
    await this.#writeIndex({ backup: true }).catch(() => {});
  }
}

function escapeIni(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function round2(n) {
  return Number((Number(n) || 0).toFixed(2));
}

function emotionValence(emotion) {
  const map = { joy: 1, excited: 0.9, love: 0.8, surprise: 0.5, surprised: 0.5, neutral: 0, sad: -0.7, angry: -0.8, fear: -0.9, disgust: -0.7 };
  return map[emotion] ?? 0;
}

export function createMemory(ctx) {
  return new MemoryStore(ctx);
}

export const MEMORY_ENTRY_FIELDS = ENTRY_FIELDS;

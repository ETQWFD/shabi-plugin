/**
 * core/knowledge.js — 从视频时间轴抽取知识、结构化、去重、置信度、跨源验证、写记忆与图谱。
 *
 * 产物：
 *   data/knowledge/<videoId>.ioshb   单视频知识条目（证据可回看）
 *   data/knowledge_index.ioshb       knowledgeId -> {videoId,start,end,memoryId}
 *   data/knowledge_graph.ioshb       实体/关系/知识节点与中心度
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  cosine, hashEmbed, id as makeId, nowIso, clamp, textSummary, chunkArray, safeJsonParse,
} from '../lib/util.js';
import { readFile as readIoshb, writeFileAtomic, exists } from '../lib/ioshb.js';

const KNOWLEDGE_TYPES = new Set(['concept', 'step', 'fact', 'opinion', 'data', 'example']);

const TYPE_CUES = [
  { type: 'step', re: /(首先|其次|然后|接着|最后|第一步|第二步|步骤|先.{0,6}再|step\s*\d)/i },
  { type: 'data', re: /(\d+(\.\d+)?\s*(%|％|元|块|年|月|日|人|次|倍|公里|km|kg|秒|分钟))|百分之/i },
  { type: 'opinion', re: /(我觉得|我认为|在我看来|其实|应该说|可能|也许|大概|i think|in my opinion)/i },
  { type: 'example', re: /(比如|例如|举个例子|像是|for example|such as)/i },
  { type: 'concept', re: /(是指|叫做|称为|定义|指的是|means|refers to)/i },
];

const NEGATION = /(不|没|无|并非|不是|\bnever\b|\bnot\b|\bno\b)/i;

function detectNumbers(text) {
  return (String(text).match(/-?\d+(\.\d+)?/g) || []).map(Number);
}

function looksConflicting(a, b) {
  const na = detectNumbers(a);
  const nb = detectNumbers(b);
  if (na.length && nb.length && !na.some((n) => nb.some((m) => Math.abs(n - m) < 1e-6))) return true;
  const negA = NEGATION.test(a);
  const negB = NEGATION.test(b);
  if (negA !== negB) return true;
  return false;
}

export class KnowledgeEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.knowledge;
    this.dir = path.join(ctx.paths.data, 'knowledge');
    this.indexFile = ctx.paths.knowledgeIndex;
    this.graphFile = ctx.paths.knowledgeGraph;
    this.memory = ctx.memory;
    this.video = ctx.video;
    this.host = ctx.host;
    this.logger = ctx.logger;
    this.index = null;
    this.graph = null;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    this.index = (await readIoshb(this.indexFile).catch(() => null)) || {
      format: 'IOSHB1', version: 1, updatedAt: nowIso(), items: [],
    };
    this.graph = (await readIoshb(this.graphFile).catch(() => null)) || {
      format: 'IOSHB1', version: 1, updatedAt: nowIso(), nodes: [], edges: [], stats: { updates: 0 },
    };
    return this;
  }

  async #saveIndex() {
    this.index.updatedAt = nowIso();
    await writeFileAtomic(this.indexFile, this.index);
  }

  async #saveGraph() {
    this.graph.updatedAt = nowIso();
    await writeFileAtomic(this.graphFile, this.graph);
  }

  // ───────────────────────── 抽取 ─────────────────────────

  async extractKnowledge(videoId) {
    const artifacts = await this.video.readArtifacts(videoId);
    if (!artifacts) throw new Error(`视频产物不存在：${videoId}`);
    const segments = artifacts.segments?.segments || [];
    const transcript = artifacts.transcript?.segments || [];
    const events = artifacts.events?.events || [];
    const analysis = artifacts.analysis?.frames || [];
    if (segments.length === 0 && transcript.length === 0) {
      return { videoId, items: [], note: '没有可抽取的时间轴内容' };
    }

    const chunks = chunkArray(segments.length ? segments : transcript, 60);
    const rawItems = [];
    for (const chunk of chunks) {
      const chunkStart = chunk[0]?.start ?? 0;
      const chunkEnd = chunk[chunk.length - 1]?.end ?? chunkStart + 60;
      const llmItems = await this.#extractWithLlm(videoId, chunk, analysis, chunkStart, chunkEnd);
      if (llmItems?.length) {
        rawItems.push(...llmItems);
      } else {
        rawItems.push(...this.#extractHeuristic(videoId, chunk, analysis));
      }
    }

    const items = this.structureKnowledge(rawItems);
    const deduped = await this.dedupeMerge(items);
    const limited = deduped.slice(0, this.config.maxItemsPerVideo || 200);
    const enriched = [];
    for (const item of limited) {
      // 先把“来自哪个视频的哪一段”补成证据，再算置信度；否则来源数永远为 0。
      item.evidence = mergeEvidence(
        item.evidence || [],
        [{ videoId, start: item.start ?? 0, end: item.end ?? item.start ?? 0, knowledgeId: item.id }],
      );
      item.confidence = this.scoreConfidence(item);
      const cross = await this.crossValidate(item);
      if (cross.crossSources.length >= 2) {
        item.crossValidated = true;
        item.crossSources = cross.crossSources;
        item.confidence = clamp(item.confidence + 0.05, 0, 1);
      }
      enriched.push(item);
    }

    const file = path.join(this.dir, `${videoId}.ioshb`);
    await writeFileAtomic(file, {
      format: 'IOSHB1', version: 1, videoId, extractedAt: nowIso(),
      sourceCount: artifacts.summary ? 1 : 0,
      items: enriched,
    });

    const written = [];
    for (const item of enriched) {
      const record = await this.writeKnowledge(item, { videoId });
      await this.updateGraph(item);
      written.push(record);
    }
    await this.#rebuildIndexFromFiles();
    this.logger?.info('知识抽取完成', { videoId, items: written.length });
    return { videoId, items: enriched, written };
  }

  async #extractWithLlm(videoId, chunk, analysis, start, end) {
    const timeline = chunk.map((s) => ({
      start: Number(s.start), end: Number(s.end),
      visual: s.visualSummary || '', speech: s.speechText || '',
      objects: s.objects || [], actions: s.actions || [],
    }));
    const ocr = analysis
      .filter((f) => f.t >= start - 2 && f.t <= end + 2)
      .flatMap((f) => (f.ocr || []).map((o) => (typeof o === 'string' ? o : o.text)).filter(Boolean))
      .slice(0, 40);
    const prompt = [
      '你是严谨的知识抽取器。只依据给定视频时间轴和画面文字抽取知识，不得补充常识或编造。',
      '输出 JSON：{"items":[{"type":"concept|step|fact|opinion|data|example","content":"一句完整、可独立理解的知识","start":秒,"end":秒,"entities":["实体"],"tags":["主题"],"visualSupport":0到1,"transcriptConfidence":0到1,"triples":[{"subject":"","predicate":"","object":""}]}]}',
      `时间轴：${JSON.stringify(timeline).slice(0, 6000)}`,
      `画面OCR：${JSON.stringify(ocr).slice(0, 1500)}`,
    ].join('\n');
    try {
      const json = await this.host.llm.json(
        [
          { role: 'system', content: '你只输出合法 JSON，不输出解释或代码块。' },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.2, maxTokens: 1200 },
      );
      const items = json?.items;
      if (!Array.isArray(items)) return null;
      return items
        .filter((it) => it && KNOWLEDGE_TYPES.has(it.type) && typeof it.content === 'string' && it.content.trim())
        .map((it) => ({
          type: it.type,
          content: it.content.trim().slice(0, 500),
          start: Number.isFinite(Number(it.start)) ? Number(it.start) : start,
          end: Number.isFinite(Number(it.end)) ? Number(it.end) : end,
          entities: Array.isArray(it.entities) ? it.entities.map(String).slice(0, 10) : [],
          tags: Array.isArray(it.tags) ? it.tags.map(String).slice(0, 10) : [],
          visualSupport: clamp(Number(it.visualSupport ?? (ocr.length ? 0.6 : 0.2)), 0, 1),
          transcriptConfidence: clamp(Number(it.transcriptConfidence ?? 0.7), 0, 1),
          triples: Array.isArray(it.triples) ? it.triples.slice(0, 10) : [],
        }));
    } catch (err) {
      this.logger?.warn('LLM 知识抽取失败，改用规则抽取', { videoId, error: err.message });
      return null;
    }
  }

  #extractHeuristic(videoId, chunk, analysis) {
    const out = [];
    for (const seg of chunk) {
      const text = String(seg.speechText || '').trim();
      if (text.length < 6) continue;
      const sentences = text.split(/(?<=[。！？!?；;])|\n+/).map((s) => s.trim()).filter((s) => s.length >= 6);
      for (const sentence of sentences) {
        let type = 'fact';
        for (const cue of TYPE_CUES) {
          if (cue.re.test(sentence)) { type = cue.type; break; }
        }
        const frame = analysis.find((f) => f.t >= (seg.start || 0) - 1 && f.t <= (seg.end || 0) + 1);
        const visualSupport = frame ? clamp((frame.confidence ?? 0.4) + (frame.ocr?.length ? 0.2 : 0), 0, 1) : 0.15;
        out.push({
          type,
          content: sentence.slice(0, 300),
          start: Number(seg.start || 0),
          end: Number(seg.end || 0),
          entities: extractEntities(sentence),
          tags: [],
          visualSupport,
          transcriptConfidence: Number(seg.confidence ?? 0.6),
          triples: [],
        });
      }
    }
    return out.slice(0, 80);
  }

  // ───────────────────────── 结构化 ─────────────────────────

  structureKnowledge(items) {
    return (items || [])
      .filter((it) => it && typeof it.content === 'string' && it.content.trim())
      .map((it) => {
        const content = it.content.trim().replace(/\s+/g, ' ');
        const entities = Array.from(new Set([...(it.entities || []), ...extractEntities(content)]))
          .map((e) => String(e).trim()).filter(Boolean).slice(0, 12);
        const triples = Array.isArray(it.triples) ? it.triples
          .filter((t) => t && t.subject && t.predicate && t.object)
          .map((t) => ({ subject: String(t.subject).slice(0, 80), predicate: String(t.predicate).slice(0, 40), object: String(t.object).slice(0, 120) }))
          .slice(0, 8) : [];
        return {
          id: it.id || makeId('k'),
          type: KNOWLEDGE_TYPES.has(it.type) ? it.type : 'fact',
          content,
          start: Number(it.start ?? 0),
          end: Number(it.end ?? it.start ?? 0),
          evidence: (it.evidence || []).map((e) => ({ ...e })),
          entities,
          tags: Array.isArray(it.tags) ? it.tags.map(String).slice(0, 10) : [],
          triples,
          visualSupport: clamp(Number(it.visualSupport ?? 0.3), 0, 1),
          transcriptConfidence: clamp(Number(it.transcriptConfidence ?? 0.6), 0, 1),
          confidence: 0,
          conflict: Boolean(it.conflict),
          conflictWith: it.conflictWith || [],
          version: 1,
        };
      });
  }

  /** 向量相似度去重合并；冲突保留但打标。 */
  async dedupeMerge(items, { existing = [] } = {}) {
    const all = [...existing, ...items];
    if (all.length <= 1) return items;
    let vectors;
    try {
      vectors = await this.host.llm.embed(all.map((i) => i.content));
    } catch {
      vectors = all.map((i) => hashEmbed(i.content));
    }
    const threshold = this.config.dedupeThreshold || 0.9;
    const merged = [];
    const used = new Set();
    for (let i = 0; i < items.length; i += 1) {
      if (used.has(i)) continue;
      const base = { ...items[i] };
      base.evidence = [...(base.evidence || [])];
      const baseVec = vectors[existing.length + i];
      for (let j = i + 1; j < items.length; j += 1) {
        if (used.has(j)) continue;
        const other = items[j];
        const sim = cosine(baseVec, vectors[existing.length + j]);
        if (sim >= threshold) {
          const conflict = looksConflicting(base.content, other.content) || base.type !== other.type;
          base.evidence = mergeEvidence(base.evidence, other.evidence || []);
          base.content = conflict ? `${base.content}（另有说法：${other.content}）` : base.content;
          base.conflict = Boolean(base.conflict || conflict);
          if (conflict) base.conflictWith = [...new Set([...(base.conflictWith || []), other.id])];
          base.visualSupport = Math.max(base.visualSupport || 0, other.visualSupport || 0);
          base.transcriptConfidence = Math.max(base.transcriptConfidence || 0, other.transcriptConfidence || 0);
          base.entities = Array.from(new Set([...(base.entities || []), ...(other.entities || [])]));
          base.tags = Array.from(new Set([...(base.tags || []), ...(other.tags || [])]));
          base.triples = [...(base.triples || []), ...(other.triples || [])];
          used.add(j);
        }
      }
      merged.push(base);
    }
    return merged;
  }

  scoreConfidence(item) {
    const sources = new Set((item.evidence || []).map((e) => e.videoId).filter(Boolean));
    const sourceScore = clamp(sources.size / 2, 0, 1);
    const visualScore = clamp(Number(item.visualSupport ?? 0.2), 0, 1);
    const transcriptScore = clamp(Number(item.transcriptConfidence ?? 0.6), 0, 1);
    const consistency = clamp(1 - 0.5 * (item.conflict ? 1 : 0) - 0.2 * (item.conflictWith?.length || 0), 0, 1);
    return clamp(0.3 * sourceScore + 0.3 * visualScore + 0.2 * transcriptScore + 0.2 * consistency, 0, 1);
  }

  /** 跨视频验证：相似内容出现在 ≥2 个独立视频则提升。 */
  async crossValidate(item, { threshold = this.config.crossValidateThreshold || 0.85 } = {}) {
    const index = await this.#allIndexItems();
    const candidates = index.filter((x) => x.id !== item.id && x.videoId !== item.evidence?.[0]?.videoId);
    if (candidates.length === 0) return { crossSources: [], score: 0 };
    let vecs;
    try {
      vecs = await this.host.llm.embed([item.content, ...candidates.map((c) => c.content)]);
    } catch {
      vecs = [item.content, ...candidates.map((c) => c.content)].map((t) => hashEmbed(t));
    }
    const sources = [];
    for (let i = 0; i < candidates.length; i += 1) {
      if (cosine(vecs[0], vecs[i + 1]) >= threshold) {
        sources.push(candidates[i].videoId);
        sources.push(...(candidates[i].evidence || []).map((e) => e.videoId));
      }
    }
    const unique = Array.from(new Set(sources.filter(Boolean)));
    return { crossSources: unique, score: unique.length >= 2 ? 0.1 : 0 };
  }

  async writeKnowledge(item, { videoId } = {}) {
    const evidence = mergeEvidence(
      item.evidence || [],
      [{ videoId: videoId || item.evidence?.[0]?.videoId, start: item.start ?? item.evidence?.[0]?.start ?? 0, end: item.end ?? item.evidence?.[0]?.end ?? 0, knowledgeId: item.id }],
    );
    const memoryEntry = await this.memory.writeMemory({
      type: 'knowledge',
      summary: textSummary(item.content, 200),
      content: [
        item.content,
        item.entities?.length ? `实体：${item.entities.join('、')}` : '',
        `类型：${item.type}；置信度：${item.confidence.toFixed(2)}${item.conflict ? '；存在冲突说法' : ''}`,
      ].filter(Boolean).join('\n'),
      importance: clamp(0.35 + item.confidence * 0.5, 0, 1),
      tags: Array.from(new Set([...(item.tags || []), ...(item.entities || [])])).slice(0, 16),
      emotion: 'neutral',
      source: { kind: 'video', videoId: videoId || item.evidence?.[0]?.videoId, knowledgeId: item.id },
      evidence,
      strength: 0.7 + item.confidence * 0.3,
    });
    const record = {
      knowledgeId: item.id,
      memoryId: memoryEntry.id,
      videoId: videoId || item.evidence?.[0]?.videoId,
      start: item.start ?? evidence[0]?.start ?? 0,
      end: item.end ?? evidence[0]?.end ?? 0,
      type: item.type,
      title: textSummary(item.content, 60),
      confidence: item.confidence,
      createdAt: nowIso(),
    };
    this.index.items.push(record);
    await this.#saveIndex();
    return record;
  }

  // ───────────────────────── 知识图谱 ─────────────────────────

  async updateGraph(item) {
    this.graph.stats.updates = (this.graph.stats.updates || 0) + 1;
    const nodeId = `k:${item.id}`;
    upsertNode(this.graph, { id: nodeId, type: 'knowledge', label: textSummary(item.content, 80), weight: 1 });
    const entities = [...(item.entities || [])];
    for (const triple of item.triples || []) {
      entities.push(triple.subject, triple.object);
      const s = `e:${normEntity(triple.subject)}`;
      const o = `e:${normEntity(triple.object)}`;
      upsertNode(this.graph, { id: s, type: 'entity', label: triple.subject, weight: 0.5 });
      upsertNode(this.graph, { id: o, type: 'entity', label: triple.object, weight: 0.5 });
      upsertEdge(this.graph, { from: s, to: o, type: triple.predicate, weight: 0.5, evidence: item.evidence });
      upsertEdge(this.graph, { from: nodeId, to: s, type: 'about', weight: 0.7, evidence: item.evidence });
    }
    for (const entity of entities) {
      const e = `e:${normEntity(entity)}`;
      upsertNode(this.graph, { id: e, type: 'entity', label: entity, weight: 0.5 });
      upsertEdge(this.graph, { from: nodeId, to: e, type: 'mentions', weight: 0.6, evidence: item.evidence });
    }
    if (this.graph.stats.updates % 5 === 0) this.recomputeCentrality();
    await this.#saveGraph();
  }

  recomputeCentrality() {
    for (const n of this.graph.nodes) n.centrality = 0;
    const degree = new Map();
    for (const e of this.graph.edges) {
      degree.set(e.from, (degree.get(e.from) || 0) + e.weight);
      degree.set(e.to, (degree.get(e.to) || 0) + e.weight);
    }
    const maxDeg = Math.max(1, ...degree.values());
    for (const n of this.graph.nodes) n.centrality = Number(((degree.get(n.id) || 0) / maxDeg).toFixed(4));
    // 简化 PageRank：3 轮迭代，阻尼 0.85
    const N = this.graph.nodes.length || 1;
    let rank = new Map(this.graph.nodes.map((n) => [n.id, 1 / N]));
    for (let iter = 0; iter < 3; iter += 1) {
      const next = new Map(this.graph.nodes.map((n) => [n.id, 0.15 / N]));
      for (const e of this.graph.edges) {
        const out = degree.get(e.from) || 1;
        next.set(e.to, next.get(e.to) + 0.85 * (rank.get(e.from) || 0) * (e.weight / out));
      }
      rank = next;
    }
    for (const n of this.graph.nodes) n.pagerank = Number((rank.get(n.id) || 0).toFixed(4));
    return this.graph;
  }

  getGraph({ limit = 50 } = {}) {
    const nodes = [...this.graph.nodes]
      .sort((a, b) => (b.centrality || 0) - (a.centrality || 0))
      .slice(0, limit);
    return { ...this.graph, nodes };
  }

  async #allIndexItems() {
    const files = (await fs.readdir(this.dir).catch(() => [])).filter((n) => n.endsWith('.ioshb'));
    const items = [];
    for (const f of files) {
      const data = await readIoshb(path.join(this.dir, f)).catch(() => null);
      for (const it of data?.items || []) items.push({ ...it, videoId: data.videoId, evidence: it.evidence || [{ videoId: data.videoId }] });
    }
    return items;
  }

  async #rebuildIndexFromFiles() {
    const items = [];
    for (const f of (await fs.readdir(this.dir).catch(() => [])).filter((n) => n.endsWith('.ioshb'))) {
      const data = await readIoshb(path.join(this.dir, f)).catch(() => null);
      if (!data) continue;
      for (const it of data.items || []) {
        const existing = this.index.items.find((x) => x.knowledgeId === it.id);
        if (existing) items.push(existing);
      }
    }
    // 保留 writeKnowledge 产生的 memoryId 映射，补齐无映射项
    for (const it of await this.#allIndexItems()) {
      if (!items.some((x) => x.knowledgeId === it.id)) {
        items.push({
          knowledgeId: it.id, videoId: it.videoId,
          start: it.evidence?.[0]?.start || 0, end: it.evidence?.[0]?.end || 0,
          type: it.type, title: textSummary(it.content, 60), confidence: it.confidence, createdAt: nowIso(),
        });
      }
    }
    this.index.items = items;
    await this.#saveIndex();
  }

  async searchKnowledge(query, topK = 8) {
    const memories = await this.memory.searchMemory(query, topK * 2, { filter: (e) => e.type === 'knowledge' });
    const out = [];
    for (const m of memories) {
      const rec = this.index.items.find((i) => i.memoryId === m.id);
      out.push({ ...rec, memory: m, score: m._score });
      if (out.length >= topK) break;
    }
    return out;
  }

  async getKnowledge(knowledgeId) {
    const rec = this.index.items.find((i) => i.knowledgeId === knowledgeId);
    if (!rec) return null;
    const file = path.join(this.dir, `${rec.videoId}.ioshb`);
    if (!(await exists(file))) return rec;
    const data = await readIoshb(file);
    return { ...rec, item: (data.items || []).find((i) => i.id === knowledgeId) || null };
  }

  getStats() {
    return {
      items: this.index?.items?.length || 0,
      nodes: this.graph?.nodes?.length || 0,
      edges: this.graph?.edges?.length || 0,
    };
  }
}

function extractEntities(text) {
  const out = [];
  const quoted = String(text).match(/[“"『「]([^”"』」]{2,20})[”"』」]/g) || [];
  for (const q of quoted) out.push(q.replace(/[“”"『』「」]/g, ''));
  const english = String(text).match(/\b[A-Z][A-Za-z0-9+.#-]{1,24}\b/g) || [];
  out.push(...english.slice(0, 6));
  return Array.from(new Set(out)).slice(0, 10);
}

function normEntity(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, '_').slice(0, 80);
}

function mergeEvidence(a, b) {
  const map = new Map();
  for (const e of [...(a || []), ...(b || [])]) {
    const key = `${e.videoId}|${Number(e.start || 0).toFixed(2)}|${Number(e.end || 0).toFixed(2)}`;
    if (!map.has(key)) map.set(key, e);
  }
  return Array.from(map.values()).slice(0, 20);
}

function upsertNode(graph, node) {
  const existing = graph.nodes.find((n) => n.id === node.id);
  if (existing) {
    existing.weight = Number((existing.weight + node.weight).toFixed(3));
    existing.lastSeen = nowIso();
  } else {
    graph.nodes.push({ ...node, firstSeen: nowIso(), lastSeen: nowIso(), centrality: 0, pagerank: 0 });
  }
}

function upsertEdge(graph, edge) {
  const key = `${edge.from}|${edge.to}|${edge.type}`;
  const existing = graph.edges.find((e) => `${e.from}|${e.to}|${e.type}` === key);
  if (existing) {
    existing.weight = Number((existing.weight + edge.weight).toFixed(3));
    existing.evidence = mergeEvidence(existing.evidence, edge.evidence);
  } else {
    graph.edges.push({ ...edge, evidence: edge.evidence || [], createdAt: nowIso() });
  }
}

export function createKnowledge(ctx) {
  return new KnowledgeEngine(ctx);
}

export { KNOWLEDGE_TYPES };

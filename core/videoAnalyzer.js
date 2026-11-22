/**
 * core/videoAnalyzer.js — “完整看完视频”流水线。
 *
 * 状态机：pending → decoding → analyzing → done / failed（最多重试 3 次）
 * 产物：
 *   data/video_registry.ioshb                 登记表
 *   data/frames/<videoId>/000001.jpg…         抽帧
 *   data/video/<videoId>/frame_index.ioshb     帧索引（t/ms/reason）
 *   data/video/<videoId>/frame_analysis.ioshb  逐帧理解
 *   data/video/<videoId>/transcript.ioshb      字幕/ASR
 *   data/video/<videoId>/segments.ioshb        1 秒时间轴
 *   data/video/<videoId>/scenes.ioshb         场景切分
 *   data/video/<videoId>/events.ioshb         事件/对象/动作
 *   data/video/<videoId>/completeness.ioshb   完整性报告
 *   data/video/<videoId>/video_summary.ioshb  视频级摘要
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Mutex, id as makeId, nowIso, shortHash, clamp, sleep, chunkArray, safeJsonParse, textSummary,
} from '../lib/util.js';
import { readFile as readIoshb, writeFileAtomic, exists } from '../lib/ioshb.js';

const STATES = ['pending', 'decoding', 'analyzing', 'done', 'failed'];
const STAGE_ORDER = ['decode', 'analyze', 'transcribe', 'align', 'scenes', 'events', 'verify', 'summarize', 'done'];

export class VideoAnalyzer {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.video;
    this.registryFile = ctx.paths.registry;
    this.videoDir = ctx.paths.video;
    this.framesRoot = ctx.paths.frames;
    this.host = ctx.host;
    this.logger = ctx.logger;
    this.mutex = new Mutex();
    this.registry = null;
    this.canceled = new Set();
    this.ffmpeg = ctx.config.media?.ffmpeg || 'ffmpeg';
    this.ffprobe = ctx.config.media?.ffprobe || 'ffprobe';
  }

  async init() {
    await fs.mkdir(this.videoDir, { recursive: true });
    await fs.mkdir(this.framesRoot, { recursive: true });
    this.registry = (await readIoshb(this.registryFile).catch(() => null)) || {
      format: 'IOSHB1', version: 1, updatedAt: nowIso(), videos: [],
    };
    return this;
  }

  async #saveRegistry() {
    this.registry.updatedAt = nowIso();
    this.registry.videos = this.registry.videos.map((v) => ({ ...v, source: v.source }));
    await writeFileAtomic(this.registryFile, this.registry);
  }

  #entry(videoId) {
    return this.registry.videos.find((v) => v.videoId === videoId) || null;
  }

  async #setEntry(videoId, patch) {
    const entry = this.#entry(videoId);
    if (!entry) throw new Error(`视频未登记：${videoId}`);
    Object.assign(entry, patch, { updatedAt: nowIso() });
    if (patch.status && !STATES.includes(patch.status)) throw new Error(`非法状态：${patch.status}`);
    await this.#saveRegistry();
    return entry;
  }

  async #artifactPath(videoId, name) {
    const dir = path.join(this.videoDir, videoId);
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, `${name}.ioshb`);
  }

  /** 重新解码时清除旧的下游产物，避免旧 frameNo 与新帧错位。 */
  async #clearDownstream(videoId) {
    const dir = path.join(this.videoDir, videoId);
    for (const name of ['frame_analysis', 'transcript', 'segments', 'scenes', 'events', 'completeness', 'video_summary']) {
      await fs.rm(path.join(dir, `${name}.ioshb`), { force: true }).catch(() => {});
    }
  }

  async #writeArtifact(videoId, name, value) {
    const file = await this.#artifactPath(videoId, name);
    await writeFileAtomic(file, { format: 'IOSHB1', version: 1, videoId, updatedAt: nowIso(), ...value });
    return file;
  }

  async #readArtifact(videoId, name) {
    try {
      return await readIoshb(await this.#artifactPath(videoId, name));
    } catch {
      return null;
    }
  }

  async readArtifacts(videoId) {
    const [index, analysis, transcript, segments, scenes, events, summary, completeness] = await Promise.all([
      this.#readArtifact(videoId, 'frame_index'),
      this.#readArtifact(videoId, 'frame_analysis'),
      this.#readArtifact(videoId, 'transcript'),
      this.#readArtifact(videoId, 'segments'),
      this.#readArtifact(videoId, 'scenes'),
      this.#readArtifact(videoId, 'events'),
      this.#readArtifact(videoId, 'video_summary'),
      this.#readArtifact(videoId, 'completeness'),
    ]);
    if (!index && !transcript && !segments) return null;
    return {
      index, analysis, transcript, segments, scenes, events, summary, completeness,
      frames: index?.frames || [],
      analysisFrames: analysis?.frames || [],
    };
  }

  // ───────────────────────── 登记 / 探测 ─────────────────────────

  /**
   * @param {string|{kind:string,value:string,headers?:object,id?:string}} source
   * @param {{mode?:string, title?:string}} [options]
   */
  async registerVideo(source, options = {}) {
    if (!this.registry) await this.init();
    const normalized = normalizeSource(source);
    let input = normalized.value;
    let headers = normalized.headers || null;
    if (this.ctx.host.raw?.media?.resolveSource) {
      const resolved = await this.ctx.host.raw.media.resolveSource(normalized.value, normalized);
      if (resolved?.path) input = resolved.path;
      else if (resolved?.url) input = resolved.url;
      headers = resolved?.headers || headers;
    }
    if (normalized.kind === 'file') {
      const abs = path.resolve(normalized.value);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) throw new Error(`本地视频不存在：${abs}`);
      input = abs;
    }

    const probe = await this.#probe(input, headers);
    const videoId = options.id || normalized.id || shortHash(`${normalized.kind}|${normalized.value}|${probe.duration}|${probe.width}x${probe.height}`);
    const existing = this.#entry(videoId);
    if (existing) {
      if (existing.status !== 'failed' || existing.attempts < 3) return existing;
    }
    const entry = {
      videoId,
      source: normalized,
      input,
      headers,
      title: options.title || normalized.title || path.basename(normalized.value) || '未命名视频',
      duration: probe.duration,
      fps: probe.fps,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      status: 'pending',
      stage: 'decode',
      mode: options.mode || this.config.defaultMode || 'hybrid',
      cursor: 0,
      coverage: 0,
      attempts: 0,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const old = this.registry.videos.findIndex((v) => v.videoId === videoId);
    if (old >= 0) this.registry.videos[old] = entry;
    else this.registry.videos.push(entry);
    await this.#saveRegistry();
    this.logger?.info('视频已登记', { videoId, duration: entry.duration, fps: entry.fps, mode: entry.mode });
    return entry;
  }

  async #probe(input, headers) {
    const args = ['-show_streams', '-show_format'];
    if (headers) {
      const headerLine = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      args.unshift('-headers', `${headerLine}\r\n`);
    }
    let json;
    try {
      json = await this.host.media.ffprobeJson(input, args);
    } catch (err) {
      throw new Error(`无法读取视频元信息：${err.message}`);
    }
    const stream = (json.streams || []).find((s) => s.codec_type === 'video');
    if (!stream) throw new Error('文件中没有视频流');
    const duration = Number(json.format?.duration || stream.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确定视频时长');
    const fps = parseRate(stream.avg_frame_rate || stream.r_frame_rate) || 25;
    const hasAudio = (json.streams || []).some((s) => s.codec_type === 'audio');
    return {
      duration: Number(duration.toFixed(3)),
      fps: Number(fps.toFixed(3)),
      width: Number(stream.width || 0),
      height: Number(stream.height || 0),
      hasAudio,
    };
  }

  // ───────────────────────── 抽帧 ─────────────────────────

  async decodeAndExtract(videoId, mode) {
    const entry = this.#entry(videoId);
    if (!entry) throw new Error(`视频未登记：${videoId}`);
    if (this.canceled.has(videoId)) throw new Error('任务已取消');
    const useMode = mode || entry.mode || this.config.defaultMode || 'hybrid';
    await this.#setEntry(videoId, { status: 'decoding', stage: 'decode', mode: useMode, error: null });
    await this.#clearDownstream(videoId);
    const dir = path.join(this.framesRoot, videoId);
    const tmp = path.join(this.framesRoot, `.extract-${videoId}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(tmp, { recursive: true });

    const collected = [];
    try {
      if (useMode === 'frame') {
        const fps = Math.min(Number(this.config.fpsCap || 60), entry.fps || 25);
        const expected = Math.round(entry.duration * fps);
        if (expected > (this.config.maxFrames || 120000)) {
          throw new Error(`逐帧抽帧将产生 ${expected} 帧，超过 maxFrames=${this.config.maxFrames}；请改用 hybrid 或提高上限`);
        }
        const out = await this.#extractFps(entry, tmp, 'fps', fps, 0, entry.duration);
        this.#collectSequential(collected, out, 1 / fps, 'fps');
        this.#record(entry, { fpsUsed: fps, expectedFrames: expected, extractionMode: useMode });
      } else if (useMode === 'keyframe') {
        const out = await this.#extractSelect(entry, tmp, 'key', "select=eq(pict_type\\,I)");
        this.#collectTimes(collected, out, 'keyframe');
      } else {
        // hybrid：每秒采样 + 关键帧 + 场景变化
        const outA = await this.#extractFps(entry, path.join(tmp, 'per-sec'), 'sec', 1, 0, entry.duration);
        this.#collectSequential(collected, outA, 1, 'fps');
        const outB = await this.#extractSelect(entry, path.join(tmp, 'scene'), 'scene',
          `select=eq(pict_type\\,I)+gt(scene\\,${Number(this.config.keyframeSceneThreshold || 0.35)})`);
        this.#collectTimes(collected, outB, 'scene');
      }
      const merged = this.#mergeFrames(collected);
      const frameIndex = await this.#materialize(videoId, tmp, dir, merged);
      const expectedFrames = useMode === 'frame'
        ? Math.round(entry.duration * (frameIndex.fpsUsed || Math.min(Number(this.config.fpsCap || 60), entry.fps || 25)))
        : null;
      await this.#writeArtifact(videoId, 'frame_index', {
        frames: frameIndex.frames,
        sceneChanges: frameIndex.sceneChanges,
        fpsUsed: frameIndex.fpsUsed,
        expectedFrames,
        mode: useMode,
        duration: entry.duration,
        extractedAt: nowIso(),
      });
      let coverage = this.computeCoverage(frameIndex.frames, entry.duration);
      entry.cursor = 0;
      entry.coverage = round4(coverage.ratio);
      await this.#saveRegistry();

      if (this.config.holeFill !== false && coverage.ratio < this.config.coverageThreshold) {
        this.logger?.warn('抽帧存在空洞，开始补抽', { videoId, coverage: coverage.ratio, gaps: coverage.gaps.length });
        await this.fillHoles(videoId);
        const idx = await this.#readArtifact(videoId, 'frame_index');
        coverage = this.computeCoverage(idx.frames, entry.duration);
      }

      if (useMode === 'frame' && frameIndex.frames.length < expectedFrames * 0.999) {
        this.logger?.warn('逐帧数量低于预期', { videoId, expected: expectedFrames, actual: frameIndex.frames.length });
        if (frameIndex.frames.length < expectedFrames * 0.99) {
          throw new Error(`抽帧不完整：${frameIndex.frames.length}/${expectedFrames}`);
        }
      }

      await this.#setEntry(videoId, { status: 'analyzing', stage: 'analyze', coverage: round4(coverage.ratio), cursor: 0 });
      this.logger?.info('抽帧完成', { videoId, frames: frameIndex.frames.length, coverage: coverage.ratio });
      return { videoId, frames: frameIndex.frames.length, coverage: coverage.ratio, gaps: coverage.gaps };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  #record(entry, patch) {
    Object.assign(entry, patch);
  }

  async #extractFps(entry, outDir, prefix, fps, start, duration) {
    await fs.mkdir(outDir, { recursive: true });
    const width = Number(this.config.analysisWidth || 1280);
    const vf = `fps=${fps}${width > 0 ? `,scale='min(${width},iw)':-2` : ''}`;
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...(start > 0 ? ['-ss', String(start)] : []),
      '-i', entry.input,
      ...(duration ? ['-t', String(duration)] : []),
      '-vf', vf, '-vsync', '0', '-q:v', String(this.config.frameQuality || 3),
      '-start_number', '1',
      path.join(outDir, `${prefix}-%06d.jpg`),
    ];
    if (entry.headers) args.unshift('-headers', headerBlock(entry.headers));
    await this.host.media.run(this.ffmpeg, args, { timeoutMs: this.#timeout(entry.duration) });
    const names = (await fs.readdir(outDir).catch(() => [])).filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.jpg'));
    return names.sort().map((n) => path.join(outDir, n));
  }

  async #extractSelect(entry, outDir, prefix, selector) {
    await fs.mkdir(outDir, { recursive: true });
    const width = Number(this.config.analysisWidth || 1280);
    const vf = `${selector},showinfo${width > 0 ? `,scale='min(${width},iw)':-2` : ''}`;
    const args = [
      '-y', '-hide_banner', '-loglevel', 'info',
      '-i', entry.input,
      '-vf', vf, '-vsync', 'vfr', '-q:v', String(this.config.frameQuality || 3),
      '-start_number', '1',
      path.join(outDir, `${prefix}-%06d.jpg`),
    ];
    if (entry.headers) args.unshift('-headers', headerBlock(entry.headers));
    const res = await this.host.media.run(this.ffmpeg, args, { timeoutMs: this.#timeout(entry.duration) });
    const names = (await fs.readdir(outDir).catch(() => [])).filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.jpg'));
    const times = [];
    const re = /pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g;
    let m;
    while ((m = re.exec(res.stderr || '')) !== null) times.push(Number(m[1]));
    const sortedNames = names.sort();
    if (times.length < sortedNames.length) {
      // 某些构建的 showinfo 日志被截断：退回按帧序等分（仍保证可用）
      const fallbackStep = entry.duration / Math.max(1, sortedNames.length);
      for (let i = times.length; i < sortedNames.length; i += 1) times.push(i * fallbackStep);
    }
    return sortedNames.map((name, i) => ({
      file: path.join(outDir, name),
      t: clamp(Number(times[i] ?? 0), 0, entry.duration),
      reason: prefix,
    }));
  }

  #collectSequential(list, files, step, reason) {
    files.forEach((file, i) => list.push({ file, t: i * step, reason }));
  }

  #collectTimes(list, files, reason) {
    for (const item of files) list.push(item);
  }

  #mergeFrames(list) {
    const sorted = list
      .filter((f) => Number.isFinite(f.t))
      .sort((a, b) => a.t - b.t);
    const out = [];
    for (const f of sorted) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(f.t - prev.t) < 0.02) {
        if (prev.reason === 'fps' && f.reason !== 'fps') prev.reason = f.reason;
        continue;
      }
      out.push({ ...f });
    }
    return out;
  }

  async #materialize(videoId, tmpRoot, finalDir, merged) {
    const frames = [];
    const sceneChanges = [];
    const staging = path.join(this.framesRoot, `.mat-${videoId}-${Date.now()}`);
    await fs.mkdir(staging, { recursive: true });
    let frameNo = 0;
    for (const item of merged) {
      frameNo += 1;
      const name = `${String(frameNo).padStart(6, '0')}.jpg`;
      const staged = path.join(staging, name);
      await moveFrame(item.file, staged);
      const stat = await fs.stat(staged).catch(() => null);
      const t = Number(item.t.toFixed(3));
      frames.push({
        frameNo,
        t,
        ms: Math.round(t * 1000),
        file: path.relative(this.ctx.paths.data, path.join(finalDir, name)),
        path: path.join(finalDir, name),
        bytes: stat?.size || 0,
        reason: item.reason || 'fps',
      });
      if (item.reason === 'scene' || item.reason === 'keyframe') sceneChanges.push(t);
    }
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.rename(staging, finalDir);
    return { frames, sceneChanges, fpsUsed: frames.length > 1 ? Number((1 / Math.max(0.001, frames[1].t - frames[0].t)).toFixed(3)) : 0 };
  }

  /**
   * 覆盖率为“被至少一帧代表的时间区间并集 / 总时长”。
   * 每帧最多代表 1 秒（maxGapMs），避免关键帧稀疏时覆盖率虚高。
   */
  computeCoverage(frames, duration) {
    if (!frames?.length || !duration) return { ratio: 0, gaps: [{ start: 0, end: duration }], covered: 0 };
    const sorted = [...frames].sort((a, b) => a.t - b.t);
    const gaps = [];
    const tol = (this.config.maxGapMs || 1000) / 1000;
    const maxWindow = Math.max(tol, 1);
    let covered = 0;
    if (sorted[0].t > tol) gaps.push({ start: 0, end: Number(sorted[0].t.toFixed(3)) });
    for (let i = 0; i < sorted.length; i += 1) {
      const start = Math.max(0, sorted[i].t);
      const nominalEnd = i + 1 < sorted.length ? sorted[i + 1].t : duration;
      const end = Math.min(duration, start + Math.min(maxWindow, Math.max(0, nominalEnd - start)));
      if (end > start) covered += end - start;
      if (i + 1 < sorted.length) {
        const gap = sorted[i + 1].t - sorted[i].t;
        if (gap > tol) gaps.push({ start: Number(sorted[i].t.toFixed(3)), end: Number(sorted[i + 1].t.toFixed(3)) });
      }
    }
    if (duration - sorted[sorted.length - 1].t > tol) {
      gaps.push({ start: Number(sorted[sorted.length - 1].t.toFixed(3)), end: duration });
    }
    return { ratio: clamp(covered / duration, 0, 1), gaps, covered };
  }

  async fillHoles(videoId) {
    const entry = this.#entry(videoId);
    const index = await this.#readArtifact(videoId, 'frame_index');
    if (!index) throw new Error('缺少帧索引，无法补抽');
    const coverage = this.computeCoverage(index.frames, entry.duration);
    if (coverage.gaps.length === 0) return { filled: 0, coverage: coverage.ratio };

    const gapTotal = coverage.gaps.reduce((s, g) => s + (g.end - g.start), 0);
    const tmp = path.join(this.framesRoot, `.fill-${videoId}-${Date.now()}`);
    await fs.mkdir(tmp, { recursive: true });
    const additions = [];
    try {
      const wholeVideo = coverage.gaps.length > 20 || gapTotal > entry.duration * 0.15;
      if (wholeVideo) {
        const dir = path.join(tmp, 'all');
        const files = await this.#extractFps(entry, dir, 'fill', 1, 0, entry.duration);
        this.#collectSequential(additions, files, 1, 'hole');
      } else {
        for (let i = 0; i < coverage.gaps.length; i += 1) {
          const gap = coverage.gaps[i];
          const dir = path.join(tmp, `gap-${i}`);
          const len = Math.max(0.2, gap.end - gap.start);
          const files = await this.#extractFps(entry, dir, `g${i}`, 1, gap.start, len);
          files.forEach((file, j) => additions.push({ file, t: gap.start + j, reason: 'hole' }));
        }
      }
      const merged = this.#mergeFrames([...index.frames.map((f) => ({ file: f.path, t: f.t, reason: f.reason })), ...additions]);
      const rebuilt = await this.#materialize(videoId, tmp, path.join(this.framesRoot, videoId), merged);
      await this.#writeArtifact(videoId, 'frame_index', {
        frames: rebuilt.frames,
        sceneChanges: index.sceneChanges || [],
        fpsUsed: index.fpsUsed,
        mode: index.mode,
        duration: entry.duration,
        filledAt: nowIso(),
      });
      const next = this.computeCoverage(rebuilt.frames, entry.duration);
      await this.#setEntry(videoId, { coverage: round4(next.ratio) });
      this.logger?.info('补抽完成', { videoId, added: additions.length, coverage: next.ratio });
      return { filled: additions.length, coverage: next.ratio, gaps: next.gaps };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ───────────────────────── 逐帧理解 ─────────────────────────

  async analyzeFrames(videoId) {
    const entry = this.#entry(videoId);
    const index = await this.#readArtifact(videoId, 'frame_index');
    if (!index?.frames?.length) throw new Error('没有可分析的帧，请先 decodeAndExtract');
    const existing = await this.#readArtifact(videoId, 'frame_analysis');
    const frames = index.frames;
    const done = new Map((existing?.frames || []).map((f) => [f.frameNo, f]));
    const result = new Map(done);
    const analyzed = [];
    const chunkSec = Number(this.config.chunkSec || 30);
    const overlap = Number(this.config.chunkOverlapSec || 1);
    const chunks = buildChunks(entry.duration, chunkSec, overlap);
    this.logger?.info('开始逐帧理解', { videoId, frames: frames.length, chunks: chunks.length, resumed: done.size });

    for (const chunk of chunks) {
      if (this.canceled.has(videoId)) throw new Error('任务已取消');
      const inChunk = frames.filter((f) => f.t >= chunk.start - overlap && f.t < chunk.end + overlap && !done.has(f.frameNo));
      for (const group of chunkArray(inChunk, Math.max(1, this.config.analysisBatch || 8))) {
        const analyzedGroup = await Promise.all(group.map((f) => this.#analyzeOne(videoId, f, index)));
        for (const a of analyzedGroup) {
          result.set(a.frameNo, a);
          analyzed.push(a);
        }
        const maxT = Math.max(...analyzedGroup.map((a) => a.t));
        const analysis = this.#analysisPayload(videoId, result, entry, index);
        await this.#writeArtifact(videoId, 'frame_analysis', analysis);
        await this.#setEntry(videoId, { cursor: round4(maxT), coverage: round4(this.computeCoverage(index.frames, entry.duration).ratio) });
      }
    }

    await this.#writeArtifact(videoId, 'frame_analysis', this.#analysisPayload(videoId, result, entry, index));
    await this.#setEntry(videoId, { stage: 'transcribe', cursor: entry.duration, status: 'analyzing' });
    this.logger?.info('逐帧理解完成', { videoId, analyzed: analyzed.length, total: result.size });
    return { videoId, analyzed: analyzed.length, total: result.size };
  }

  #analysisPayload(videoId, map, entry, index) {
    return {
      frames: Array.from(map.values()).sort((a, b) => a.frameNo - b.frameNo),
      count: map.size,
      totalFrames: index.frames.length,
      duration: entry.duration,
      updatedAt: nowIso(),
    };
  }

  async #analyzeOne(videoId, frame, index) {
    const prompt = [
      '你在逐帧理解一段视频画面。只描述看到的内容，不推测未出现的信息。',
      '输出 JSON：{"scene":"场景","objects":["物体"],"actions":["动作"],"ocr":[{"text":"画面文字","bbox":[x,y,w,h]}],"people":["人物描述"],"emotion":"neutral|joy|sad|angry|surprise|fear","confidence":0到1}',
      `时间点：${frame.t.toFixed(2)}s，画面尺寸未知，bbox 用 0..1 归一化。`,
    ].join('\n');
    let parsed = null;
    try {
      const described = await this.host.vision.describe(frame.path, prompt, { frameNo: frame.frameNo, t: frame.t });
      if (described?.text) parsed = safeJsonParse(described.text);
      if (!parsed && described?.raw) parsed = safeJsonParse(described.raw);
      if (!parsed && described?.text) {
        parsed = { scene: described.text.slice(0, 80), objects: [], actions: [], ocr: [], people: [], emotion: 'neutral', confidence: 0.35 };
      }
    } catch (err) {
      this.logger?.warn('单帧视觉理解失败，降级处理', { videoId, frameNo: frame.frameNo, error: err.message });
    }
    if (!parsed && this.ctx.config.video?.ocrFrames !== false && this.host.capabilities.ocr) {
      try {
        const ocr = await this.host.screen.ocr(frame.path, { lang: this.ctx.config.eye?.ocr?.lang });
        parsed = { scene: '画面', objects: [], actions: [], ocr: ocr?.text ? [{ text: ocr.text, bbox: [0, 0, 1, 1] }] : [], people: [], emotion: 'neutral', confidence: 0.3, degraded: true };
      } catch {
        // ignore
      }
    }
    if (!parsed) {
      parsed = { scene: '未识别', objects: [], actions: [], ocr: [], people: [], emotion: 'neutral', confidence: 0.2, degraded: true };
    }
    const ocr = Array.isArray(parsed.ocr)
      ? parsed.ocr.map((o) => (typeof o === 'string' ? { text: o, bbox: [0, 0, 1, 1] } : { text: String(o.text || ''), bbox: Array.isArray(o.bbox) ? o.bbox.slice(0, 4) : [0, 0, 1, 1] }))
        .filter((o) => o.text).slice(0, 20)
      : parsed.ocr ? [{ text: String(parsed.ocr), bbox: [0, 0, 1, 1] }] : [];
    return {
      frameNo: frame.frameNo,
      t: frame.t,
      scene: String(parsed.scene || '未识别').slice(0, 80),
      objects: toStringArray(parsed.objects, 20),
      actions: toStringArray(parsed.actions, 20),
      ocr,
      people: toStringArray(parsed.people, 10),
      emotion: String(parsed.emotion || 'neutral'),
      confidence: clamp(Number(parsed.confidence ?? 0.3), 0, 1),
      degraded: Boolean(parsed.degraded),
    };
  }

  // ───────────────────────── 音频 / 字幕 ─────────────────────────

  async transcribeAudio(videoId) {
    const entry = this.#entry(videoId);
    if (!entry) throw new Error(`视频未登记：${videoId}`);
    let subtitle = null;
    if (this.config.asr?.preferSubtitles !== false) subtitle = await this.#findSubtitle(entry);
    if (subtitle) {
      const segments = this.#parseSubtitles(subtitle.text, entry.duration);
      const payload = { audio: false, source: 'subtitle', engine: 'sidecar', segments, subtitleFile: subtitle.file, updatedAt: nowIso() };
      await this.#writeArtifact(videoId, 'transcript', payload);
      await this.#setEntry(videoId, { stage: 'align' });
      this.logger?.info('使用字幕文件', { videoId, file: subtitle.file, segments: segments.length });
      return payload;
    }
    if (!entry.hasAudio) {
      const payload = { audio: false, source: 'none', engine: 'none', segments: [], note: '视频无音轨' };
      await this.#writeArtifact(videoId, 'transcript', payload);
      await this.#setEntry(videoId, { stage: 'align' });
      return payload;
    }
    const audioPath = path.join(this.videoDir, videoId, 'audio.wav');
    if (!(await exists(audioPath))) {
      await this.host.media.run(this.ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', entry.input,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath,
      ], { timeoutMs: this.#timeout(entry.duration) });
    }
    let asr = null;
    try {
      asr = await this.host.media.asr(audioPath, { language: this.config.asr?.language || 'zh', timeoutMs: (this.config.asrTimeoutSec || 600) * 1000 });
    } catch (err) {
      this.logger?.warn('ASR 失败，保留空转写', { videoId, error: err.message });
    }
    const segments = normalizeTranscript(asr?.segments || asr?.result?.segments || [], entry.duration);
    const payload = {
      audio: true,
      source: 'asr',
      engine: asr?.engine || 'host-asr',
      segments,
      note: segments.length ? undefined : 'ASR 未返回结果（可在设置中配置 asr.command）',
      updatedAt: nowIso(),
    };
    await this.#writeArtifact(videoId, 'transcript', payload);
    await this.#setEntry(videoId, { stage: 'align' });
    return payload;
  }

  async #findSubtitle(entry) {
    const candidates = new Set();
    if (entry.source?.kind === 'file' || entry.input?.startsWith('/')) {
      const base = entry.input.replace(/\.[^.]+$/, '');
      for (const ext of ['.srt', '.vtt', '.ass']) candidates.add(base + ext);
    }
    if (entry.subtitlePath) candidates.add(entry.subtitlePath);
    for (const file of candidates) {
      try {
        const text = await fs.readFile(file, 'utf8');
        return { file, text };
      } catch {
        // next
      }
    }
    return null;
  }

  #parseSubtitles(text, duration) {
    const cleaned = text.replace(/\r/g, '');
    const segments = [];
    if (/^WEBVTT/im.test(cleaned)) {
      for (const block of cleaned.split(/\n\n+/)) {
        const lines = block.split('\n');
        const timeLine = lines.find((l) => l.includes('-->'));
        if (!timeLine) continue;
        const [a, b] = timeLine.split('-->');
        const start = parseTimestamp(a);
        const end = parseTimestamp(b);
        const body = lines.slice(lines.indexOf(timeLine) + 1).join(' ').replace(/<[^>]+>/g, '').trim();
        if (body && start != null && end != null) segments.push({ start, end, text: body, confidence: 0.95 });
      }
    } else {
      for (const block of cleaned.split(/\n\n+/)) {
        const lines = block.split('\n');
        const timeLine = lines.find((l) => l.includes('-->'));
        if (!timeLine) continue;
        const [a, b] = timeLine.split('-->');
        const start = parseTimestamp(a);
        const end = parseTimestamp(b);
        const body = lines.slice(lines.indexOf(timeLine) + 1).join(' ').replace(/<[^>]+>/g, '').trim();
        if (body && start != null && end != null) segments.push({ start, end, text: body, confidence: 0.95 });
      }
    }
    return normalizeTranscript(segments, duration, this.config.timelineToleranceMs || 200);
  }

  // ───────────────────────── 时间轴 / 场景 / 事件 ─────────────────────────

  async alignTimeline(videoId) {
    const entry = this.#entry(videoId);
    const index = await this.#readArtifact(videoId, 'frame_index');
    const analysis = await this.#readArtifact(videoId, 'frame_analysis');
    const transcript = await this.#readArtifact(videoId, 'transcript');
    if (!index?.frames?.length) throw new Error('缺少帧索引，无法对齐时间轴');
    const analysisFrames = (analysis?.frames || []).slice().sort((a, b) => a.t - b.t);
    const subs = (transcript?.segments || []).slice().sort((a, b) => a.start - b.start);
    const tol = (this.config.timelineToleranceMs || 200) / 1000;
    const seconds = Math.ceil(entry.duration);
    const segments = [];
    let fp = 0;
    let sp = 0;
    for (let sec = 0; sec < seconds; sec += 1) {
      const end = Math.min(entry.duration, sec + 1);
      while (fp < analysisFrames.length && analysisFrames[fp].t < sec - 0.01) fp += 1;
      const frame = [];
      let q = fp;
      while (q < analysisFrames.length && analysisFrames[q].t < end + 0.01) {
        frame.push(analysisFrames[q]);
        q += 1;
      }
      while (sp < subs.length && subs[sp].end < sec - tol) sp += 1;
      const overlapSubs = [];
      for (let k = sp; k < subs.length && subs[k].start <= end + tol; k += 1) {
        if (subs[k].end >= sec - tol) overlapSubs.push(subs[k]);
      }
      const speechText = overlapSubs.map((s) => s.text).join(' ').trim();
      const objects = uniqueTop(frame.flatMap((f) => f.objects || []), 8);
      const actions = uniqueTop(frame.flatMap((f) => f.actions || []), 8);
      const ocr = uniqueTop(frame.flatMap((f) => (f.ocr || []).map((o) => o.text)), 8);
      const scenes = uniqueTop(frame.map((f) => f.scene).filter((s) => s && s !== '未识别'), 3);
      const visualSummary = [
        scenes[0] || '',
        objects.length ? `物体：${objects.join('、')}` : '',
        actions.length ? `动作：${actions.join('、')}` : '',
        ocr.length ? `文字：${ocr.slice(0, 3).join(' / ')}` : '',
      ].filter(Boolean).join('；');
      segments.push({
        start: sec,
        end: Number(end.toFixed(3)),
        visualSummary: visualSummary || '画面无明显可识别内容',
        speechText,
        objects,
        actions,
        ocr,
        scene: scenes[0] || null,
        emotion: frame[0]?.emotion || null,
        frameNos: frame.map((f) => f.frameNo).slice(0, 20),
        coverage: frame.length > 0,
        confidence: frame.length ? average(frame.map((f) => f.confidence ?? 0.2)) : 0.1,
      });
    }
    const payload = {
      segments,
      toleranceMs: this.config.timelineToleranceMs || 200,
      duration: entry.duration,
      coveredSeconds: segments.filter((s) => s.coverage).length,
      updatedAt: nowIso(),
    };
    await this.#writeArtifact(videoId, 'segments', payload);
    await this.#setEntry(videoId, { stage: 'scenes', cursor: entry.duration });
    this.logger?.info('时间轴对齐完成', { videoId, segments: segments.length });
    return payload;
  }

  async segmentScenes(videoId) {
    const entry = this.#entry(videoId);
    const analysis = await this.#readArtifact(videoId, 'frame_analysis');
    const index = await this.#readArtifact(videoId, 'frame_index');
    const frames = (analysis?.frames || []).slice().sort((a, b) => a.t - b.t);
    if (!frames.length) throw new Error('缺少逐帧理解结果');
    const sceneTimes = new Set((index?.sceneChanges || []).map((t) => Number(t.toFixed(2))));
    const groups = [];
    let current = null;
    for (const f of frames) {
      const label = f.scene || '未识别';
      const isCut = sceneTimes.has(Number(f.t.toFixed(2)));
      if (!current || current.label !== label || isCut) {
        if (current) groups.push(current);
        current = { label, start: f.t, end: f.t, frames: [f] };
      } else {
        current.end = f.t;
        current.frames.push(f);
      }
    }
    if (current) groups.push(current);
    const scenes = groups.map((g, i) => {
      const start = Math.max(0, g.start);
      const end = Math.min(entry.duration, Math.max(start + 0.5, g.end));
      const keyframes = new Set([g.frames[0].frameNo]);
      // 长场景每 2 秒补关键帧
      const every2s = g.frames.filter((f) => f.t - start >= 2 && Math.abs((f.t - start) % 2) < 0.6);
      every2s.forEach((f) => keyframes.add(f.frameNo));
      if (g.frames.length > 1) keyframes.add(g.frames[Math.floor(g.frames.length / 2)].frameNo);
      return {
        sceneId: `sc_${videoId}_${i + 1}`,
        index: i + 1,
        label: g.label,
        start: round3(start),
        end: round3(end),
        duration: round3(Math.max(0, end - start)),
        frameNos: g.frames.map((f) => f.frameNo),
        keyframes: Array.from(keyframes).sort((a, b) => a - b),
      };
    }).filter((s) => s.duration >= 0.4);
    const payload = { scenes, count: scenes.length, updatedAt: nowIso() };
    await this.#writeArtifact(videoId, 'scenes', payload);
    await this.#setEntry(videoId, { stage: 'events' });
    return payload;
  }

  async extractEvents(videoId) {
    const entry = this.#entry(videoId);
    const analysis = await this.#readArtifact(videoId, 'frame_analysis');
    const frames = (analysis?.frames || []).slice().sort((a, b) => a.t - b.t);
    if (!frames.length) throw new Error('缺少逐帧理解结果');
    const raw = [];
    for (const f of frames) {
      for (const a of f.actions || []) raw.push({ type: 'action', label: a, t: f.t, frameNo: f.frameNo, confidence: f.confidence });
      for (const o of f.objects || []) raw.push({ type: 'object', label: o, t: f.t, frameNo: f.frameNo, confidence: f.confidence });
      for (const o of f.ocr || []) if (o.text) raw.push({ type: 'text', label: o.text, t: f.t, frameNo: f.frameNo, confidence: f.confidence });
    }
    const byLabel = new Map();
    for (const item of raw) {
      const key = `${item.type}|${item.label}`;
      if (!byLabel.has(key)) byLabel.set(key, []);
      byLabel.get(key).push(item);
    }
    const events = [];
    for (const [key, list] of byLabel) {
      const sorted = list.sort((a, b) => a.t - b.t);
      let cur = null;
      for (const item of sorted) {
        if (!cur || item.t - cur.end > 2) {
          if (cur) events.push(cur);
          cur = { type: item.type, label: item.label, start: item.t, end: item.t, frameNos: [item.frameNo], confidences: [item.confidence] };
        } else {
          cur.end = item.t;
          cur.frameNos.push(item.frameNo);
          cur.confidences.push(item.confidence);
        }
      }
      if (cur) events.push(cur);
    }
    const normalized = events
      .filter((e) => e.end - e.start >= 0.5 || e.frameNos.length >= 2)
      .map((e, i) => ({
        eventId: `ev_${videoId}_${i + 1}`,
        type: e.type,
        label: e.label,
        start: round3(Math.max(0, e.start)),
        end: round3(Math.min(entry.duration, Math.max(e.end, e.start + 0.5))),
        duration: round3(Math.max(0.5, Math.min(entry.duration, e.end) - Math.max(0, e.start))),
        frameNos: e.frameNos.slice(0, 60),
        confidence: round3(average(e.confidences)),
      }))
      .sort((a, b) => a.start - b.start)
      .slice(0, 400);
    const payload = { events: normalized, count: normalized.length, updatedAt: nowIso() };
    await this.#writeArtifact(videoId, 'events', payload);
    await this.#setEntry(videoId, { stage: 'verify' });
    return payload;
  }

  // ───────────────────────── 完整性 ─────────────────────────

  async verifyCompleteness(videoId, { repair = false } = {}) {
    const entry = this.#entry(videoId);
    const index = await this.#readArtifact(videoId, 'frame_index');
    const analysis = await this.#readArtifact(videoId, 'frame_analysis');
    const transcript = await this.#readArtifact(videoId, 'transcript');
    const segments = await this.#readArtifact(videoId, 'segments');
    const scenes = await this.#readArtifact(videoId, 'scenes');
    const checks = [];
    const missingRanges = [];

    const coverage = this.computeCoverage(index?.frames || [], entry.duration);
    checks.push({
      id: 'coverage',
      ok: coverage.ratio >= (this.config.coverageThreshold || 0.999),
      detail: `覆盖率 ${(coverage.ratio * 100).toFixed(3)}%，阈值 ${((this.config.coverageThreshold || 0.999) * 100).toFixed(2)}%`,
      gaps: coverage.gaps.slice(0, 50),
    });
    if (coverage.ratio < (this.config.coverageThreshold || 0.999)) missingRanges.push(...coverage.gaps);

    const maxGap = Math.max(0, ...coverage.gaps.map((g) => g.end - g.start));
    checks.push({ id: 'max-gap', ok: maxGap <= (this.config.maxGapMs || 1000) / 1000 + 1e-6, detail: `最大空洞 ${maxGap.toFixed(3)}s` });

    const expected = index?.mode === 'frame' ? Math.round(entry.duration * (index.fpsUsed || entry.fps)) : null;
    checks.push({
      id: 'frame-count',
      ok: expected ? (index?.frames?.length || 0) >= expected * 0.999 : Boolean(index?.frames?.length),
      detail: expected ? `${index?.frames?.length || 0}/${expected} 帧（逐帧模式）` : `${index?.frames?.length || 0} 帧`,
    });

    const analyzedRatio = index?.frames?.length ? (analysis?.frames?.length || 0) / index.frames.length : 0;
    checks.push({ id: 'analysis', ok: analyzedRatio >= 0.99, detail: `已理解 ${(analyzedRatio * 100).toFixed(2)}% 的帧` });
    if (analyzedRatio < 0.99) {
      const analyzedSet = new Set((analysis?.frames || []).map((a) => a.frameNo));
      for (const f of index?.frames || []) {
        if (!analyzedSet.has(f.frameNo)) missingRanges.push({ start: f.t, end: Math.min(entry.duration, f.t + 1) });
      }
    }

    const segmentSeconds = new Set((segments?.segments || []).map((s) => Math.floor(s.start)));
    const missingSeconds = [];
    for (let s = 0; s < Math.ceil(entry.duration); s += 1) if (!segmentSeconds.has(s)) missingSeconds.push(s);
    checks.push({ id: 'segment-per-second', ok: missingSeconds.length === 0, detail: missingSeconds.length ? `缺少 ${missingSeconds.length} 个秒段` : '每秒均有 segment' });

    const scenesWithKeyframe = (scenes?.scenes || []).filter((s) => (s.keyframes || []).length > 0).length;
    const sceneOk = (scenes?.scenes?.length || 0) > 0 && scenesWithKeyframe === scenes.scenes.length;
    checks.push({ id: 'scene-keyframes', ok: sceneOk, detail: `${scenesWithKeyframe}/${scenes?.scenes?.length || 0} 个场景有关键帧` });

    const timelineOk = (transcript?.segments || []).every((s) => s.start >= -0.2 && s.end <= entry.duration + 0.2 && s.end >= s.start);
    checks.push({ id: 'timeline-bounds', ok: timelineOk, detail: `字幕容差 ±${this.config.timelineToleranceMs || 200}ms` });

    let repaired = false;
    if (repair && (!checks.every((c) => c.ok) || missingSeconds.length)) {
      repaired = true;
      await this.fillHoles(videoId).catch((err) => this.logger?.warn('补抽失败', { videoId, error: err.message }));
      await this.analyzeFrames(videoId).catch((err) => this.logger?.warn('补分析失败', { videoId, error: err.message }));
      await this.alignTimeline(videoId).catch(() => {});
      await this.segmentScenes(videoId).catch(() => {});
      await this.extractEvents(videoId).catch(() => {});
    }

    if (repaired) {
      const recheck = await this.verifyCompleteness(videoId, { repair: false });
      recheck.repaired = true;
      recheck.previous = { checks, coverage: round4(coverage.ratio), missingRanges: dedupeRanges(missingRanges).slice(0, 100) };
      return recheck;
    }

    const report = {
      videoId,
      ok: checks.every((c) => c.ok),
      coverage: round4(coverage.ratio),
      threshold: this.config.coverageThreshold || 0.999,
      checks,
      missingRanges: dedupeRanges(missingRanges).slice(0, 100),
      repaired,
      verifiedAt: nowIso(),
    };
    await this.#writeArtifact(videoId, 'completeness', report);
    return report;
  }

  // ───────────────────────── 摘要 ─────────────────────────

  async summarizeVideo(videoId) {
    const entry = this.#entry(videoId);
    const segments = await this.#readArtifact(videoId, 'segments');
    const transcript = await this.#readArtifact(videoId, 'transcript');
    const scenes = await this.#readArtifact(videoId, 'scenes');
    const events = await this.#readArtifact(videoId, 'events');
    const segs = segments?.segments || [];
    const speech = (transcript?.segments || []).map((s) => s.text).join(' ').slice(0, 6000);
    const visual = segs.filter((s) => s.visualSummary && s.visualSummary !== '画面无明显可识别内容').map((s) => `${s.start}s：${s.visualSummary}`).slice(0, 60);
    let summary = null;
    try {
      const json = await this.host.llm.json(
        [
          { role: 'system', content: '你是视频摘要器。只依据材料总结，不编造。输出 JSON：{"summary":"不超过300字","keyPoints":["要点"],"topics":["主题"],"entities":["实体"],"highlights":[{"start":秒,"end":秒,"why":"看点"}]}' },
          { role: 'user', content: `时长 ${entry.duration}s；场景：${(scenes?.scenes || []).map((s) => s.label).join('、')}\n转写：${speech}\n画面：${visual.join('\n').slice(0, 4000)}\n事件：${(events?.events || []).map((e) => e.label).join('、').slice(0, 800)}` },
        ],
        { temperature: 0.3, maxTokens: 900 },
      );
      summary = json;
    } catch (err) {
      this.logger?.warn('LLM 摘要失败，使用抽取式摘要', { videoId, error: err.message });
    }
    if (!summary?.summary) {
      const fromSpeech = (transcript?.segments || []).map((s) => s.text).join('').slice(0, 260);
      const fromVisual = visual.slice(0, 3).join('；');
      summary = {
        summary: textSummary(`${fromSpeech}${fromSpeech && fromVisual ? '。' : ''}${fromVisual}`, 300) || '视频内容较少，未能生成摘要。',
        keyPoints: segs.filter((s) => s.speechText).slice(0, 5).map((s) => s.speechText.slice(0, 60)),
        topics: topWords(speech, 6),
        entities: [],
        highlights: segs.filter((s) => s.coverage).slice(0, 3).map((s) => ({ start: s.start, end: s.end, why: s.visualSummary.slice(0, 40) })),
      };
    }
    const payload = {
      videoId,
      title: entry.title,
      duration: entry.duration,
      summary: String(summary.summary).slice(0, 600),
      keyPoints: toStringArray(summary.keyPoints, 10),
      topics: toStringArray(summary.topics, 10),
      entities: toStringArray(summary.entities, 10),
      highlights: Array.isArray(summary.highlights) ? summary.highlights.slice(0, 8) : [],
      scenes: (scenes?.scenes || []).length,
      updatedAt: nowIso(),
    };
    await this.#writeArtifact(videoId, 'video_summary', payload);
    await this.#setEntry(videoId, { stage: 'done', status: 'done', cursor: entry.duration, coverage: round4(this.computeCoverage((await this.#readArtifact(videoId, 'frame_index'))?.frames || [], entry.duration).ratio), completedAt: nowIso() });
    return payload;
  }

  // ───────────────────────── 编排 / 断点续看 ─────────────────────────

  async resumeFromCursor(videoId) {
    const entry = this.#entry(videoId);
    if (!entry) throw new Error(`视频未登记：${videoId}`);
    const index = await this.#readArtifact(videoId, 'frame_index');
    const analysis = await this.#readArtifact(videoId, 'frame_analysis');
    const stage = entry.stage || 'decode';
    let cursor = Number(entry.cursor || 0);
    if (stage === 'analyze' && analysis?.frames?.length) {
      cursor = Math.max(cursor, ...analysis.frames.map((f) => f.t));
    }
    if (entry.status === 'failed' && entry.attempts >= 3) {
      return { videoId, stage, cursor, frames: index?.frames?.length || 0, canResume: false, reason: '重试次数已用尽' };
    }
    return { videoId, stage, cursor, frames: index?.frames?.length || 0, analyzed: analysis?.frames?.length || 0, canResume: true };
  }

  /**
   * 完整跑完一条视频，自动断点续看与失败重试（最多 video.retries 次）。
   */
  async run(videoId, { force = false, mode } = {}) {
    let entry = this.#entry(videoId);
    if (!entry) throw new Error(`视频未登记：${videoId}`);
    if (entry.status === 'done' && !force) return { ...entry, skipped: true };
    if (entry.status === 'failed' && entry.attempts >= (this.config.retries || 3) && !force) {
      throw new Error(`视频 ${videoId} 已失败 ${entry.attempts} 次，需人工重试`);
    }
    if (force) {
      entry.attempts = 0;
      entry.stage = 'decode';
      await this.#saveRegistry();
    }
    const retries = Number(this.config.retries || 3);
    for (let attempt = entry.attempts || 0; attempt < retries; attempt += 1) {
      try {
        entry = this.#entry(videoId);
        let stage = entry.stage || 'decode';
        if (force && attempt === 0) stage = 'decode';
        const resume = await this.resumeFromCursor(videoId);

        if (stage === 'decode') {
          await this.decodeAndExtract(videoId, mode || entry.mode);
          stage = 'analyze';
        }
        if (stage === 'analyze') {
          await this.analyzeFrames(videoId);
          stage = 'transcribe';
        }
        if (stage === 'transcribe') {
          await this.transcribeAudio(videoId);
          stage = 'align';
        }
        if (stage === 'align') {
          await this.alignTimeline(videoId);
          stage = 'scenes';
        }
        if (stage === 'scenes') {
          await this.segmentScenes(videoId);
          stage = 'events';
        }
        if (stage === 'events') {
          await this.extractEvents(videoId);
          stage = 'verify';
        }
        if (stage === 'verify') {
          let report = await this.verifyCompleteness(videoId, { repair: false });
          if (!report.ok && this.config.autoRepair !== false) {
            report = await this.verifyCompleteness(videoId, { repair: true });
          }
          if (!report.ok) throw new Error(`完整性校验未通过：覆盖率 ${(report.coverage * 100).toFixed(3)}%，缺失区间 ${report.missingRanges.length} 个`);
          stage = 'summarize';
        }
        if (stage === 'summarize') {
          await this.summarizeVideo(videoId);
          stage = 'done';
        }
        const final = this.#entry(videoId);
        await this.#setEntry(videoId, { status: 'done', stage: 'done', attempts: 0, error: null });
        const report = await this.#readArtifact(videoId, 'completeness');
        this.logger?.info('视频分析完成', { videoId, coverage: report?.coverage, stage: final.stage });
        return { ...this.#entry(videoId), resume, completeness: report };
      } catch (err) {
        const e = this.#entry(videoId);
        e.attempts = (e.attempts || 0) + 1;
        e.error = err.message;
        e.status = e.attempts >= retries ? 'failed' : 'pending';
        if (/完整性|覆盖率|抽帧不完整/.test(err.message)) e.stage = 'decode';
        await this.#saveRegistry();
        this.logger?.error('视频分析失败', { videoId, attempt: e.attempts, error: err.message });
        if (e.attempts >= retries) throw err;
        await sleep(1500 * e.attempts);
      }
    }
    return this.#entry(videoId);
  }

  async getStatus(videoId) {
    const entry = this.#entry(videoId);
    if (!entry) return null;
    const completeness = await this.#readArtifact(videoId, 'completeness');
    const summary = await this.#readArtifact(videoId, 'video_summary');
    return { ...entry, completeness, summary: summary?.summary || null };
  }

  listVideos({ limit = 50 } = {}) {
    return this.registry.videos.slice(-limit).reverse();
  }

  async cancel(videoId) {
    this.canceled.add(videoId);
    const entry = this.#entry(videoId);
    if (entry) await this.#setEntry(videoId, { status: 'failed', error: '用户取消', stage: entry.stage });
    return { ok: true };
  }

  #timeout(duration) {
    return Math.max(60000, Math.min(30 * 60 * 1000, duration * 2000 + 60000));
  }
}

function normalizeSource(source) {
  if (typeof source === 'string') {
    if (/^https?:\/\//i.test(source)) return { kind: 'url', value: source };
    return { kind: 'file', value: source };
  }
  if (source && typeof source === 'object' && source.value) {
    return {
      kind: source.kind || (/^https?:\/\//i.test(source.value) ? 'url' : 'file'),
      value: source.value,
      headers: source.headers,
      id: source.id,
      title: source.title,
      subtitlePath: source.subtitlePath,
    };
  }
  throw new Error('视频 source 必须是路径、URL 或 {kind,value} 对象');
}

function parseRate(rate) {
  if (!rate) return 0;
  if (typeof rate === 'number') return rate;
  const parts = String(rate).split('/').map(Number);
  if (parts.length === 2 && parts[1]) return parts[0] / parts[1];
  return Number(rate) || 0;
}

async function moveFrame(src, dst) {
  try {
    await fs.link(src, dst);
    await fs.unlink(src).catch(() => {});
  } catch {
    await fs.copyFile(src, dst);
    await fs.unlink(src).catch(() => {});
  }
}

function headerBlock(headers) {
  return `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n`;
}

function toStringArray(value, max = 10) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).slice(0, max);
  if (typeof value === 'string' && value.trim()) return value.split(/[,，、；;]/).map((v) => v.trim()).filter(Boolean).slice(0, max);
  return [];
}

function uniqueTop(list, max) {
  const counts = new Map();
  for (const item of list) {
    const key = String(item).trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
}

function average(list) {
  if (!list.length) return 0;
  return list.reduce((s, x) => s + (Number(x) || 0), 0) / list.length;
}

function round3(n) {
  return Number((Number(n) || 0).toFixed(3));
}
function round4(n) {
  return Number((Number(n) || 0).toFixed(4));
}

function parseTimestamp(text) {
  const m = String(text).match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const m2 = String(text).match(/(\d+):(\d+(?:\.\d+)?)/);
  if (m2) return Number(m2[1]) * 60 + Number(m2[2]);
  return null;
}

function normalizeTranscript(segments, duration, toleranceMs = 200) {
  const tol = toleranceMs / 1000;
  return segments
    .map((s) => ({
      start: clamp(Number(s.start ?? 0), 0, duration),
      end: clamp(Number(s.end ?? s.start ?? 0), 0, duration),
      text: String(s.text || '').trim(),
      confidence: clamp(Number(s.confidence ?? 0.7), 0, 1),
    }))
    .filter((s) => s.text && s.end > s.start - tol)
    .map((s) => ({ ...s, start: round3(s.start), end: round3(Math.max(s.start + 0.01, s.end)) }))
    .sort((a, b) => a.start - b.start);
}

function buildChunks(duration, chunkSec, overlap) {
  const chunks = [];
  for (let start = 0; start < duration; start += chunkSec - overlap) {
    const end = Math.min(duration, start + chunkSec);
    chunks.push({ start: round3(start), end: round3(end), overlap });
    if (end >= duration) break;
  }
  return chunks;
}

function dedupeRanges(ranges) {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.2) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out.map((r) => ({ start: round3(r.start), end: round3(r.end) }));
}

function topWords(text, max) {
  const tokens = String(text).match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/g) || [];
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
}

export function createVideoAnalyzer(ctx) {
  return new VideoAnalyzer(ctx);
}

export { STAGE_ORDER, STATES };

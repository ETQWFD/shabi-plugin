/**
 * core/imageApi.js — 图片生成 API 自拍。
 *
 * 支持：OpenAI 兼容（images/generations + images/edits）、通用 JSON、SD WebUI。
 * 约束：失败降级为文字；所有产出标注“AI 生成”；参考图最多 4 张。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso, clamp, textSummary, withTimeout } from '../lib/util.js';

export class ImageApi {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.imageApi;
    this.host = ctx.host;
    this.logger = ctx.logger;
    this.dir = ctx.paths.selfies;
    this.lastTest = null;
    this.lastError = null;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    return this;
  }

  buildPrompt(personality, scene, options = {}) {
    const p = personality || {};
    const style = options.style || this.config.style || 'anime';
    const base = this.config.basePrompt || '一个有个性的桌面 AI 助手角色，自拍视角，看向镜头，自然光，细节清晰';
    const persona = [
      p.name ? `人格：${p.name}` : '',
      p.tone?.length ? `气质：${p.tone.slice(0, 3).join('、')}` : '',
      p.catchphrases?.length ? `表情气质参考：${p.catchphrases[0]}` : '',
    ].filter(Boolean).join('；');
    const sceneText = typeof scene === 'string' ? scene : scene?.scene || scene?.window || '';
    const mood = options.mood || '';
    const pose = options.pose || '自拍姿势，一只手拿相机/手机，肩部以上';
    const parts = [
      base,
      persona,
      sceneText ? `场景：${String(sceneText).slice(0, 160)}` : '',
      mood ? `情绪：${mood}` : '',
      `姿势：${pose}`,
      `风格：${style}`,
      '画面中只出现角色本人，不出现文字、水印、logo；不冒充真人，不生成真实公众人物。',
    ].filter(Boolean);
    return parts.join('。').slice(0, 1200);
  }

  buildNegativePrompt() {
    return [
      this.config.negativePrompt || '',
      '低清晰度, 变形手, 多余手指, 文字, 水印, 签名, 多人, 真实公众人物, 未成年人性感化, 裸露',
    ].filter(Boolean).join(', ').slice(0, 600);
  }

  async testConnection(config = this.config) {
    const started = Date.now();
    const provider = config.provider || 'openai';
    const base = normalizeEndpoint(config.endpoint);
    if (!base) return { ok: false, provider, message: '缺少 endpoint', latencyMs: 0 };
    let url;
    let headers = {};
    if (provider === 'openai') {
      url = joinUrl(base, 'models');
      headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
    } else if (provider === 'sdwebui') {
      url = joinUrl(base, 'sdapi/v1/sd-models');
    } else {
      url = base;
      headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
    }
    try {
      const res = await withTimeout(
        this.host.http.request(url, { method: 'GET', headers, timeoutMs: Math.min(30000, (config.timeoutSec || 90) * 1000) }),
        35000,
        '图片 API 测试',
      );
      const latencyMs = Date.now() - started;
      const ok = res.ok || res.status === 401 || res.status === 403 || res.status === 405;
      const message = res.ok
        ? '连接成功'
        : res.status === 401 || res.status === 403
          ? '服务可达，但鉴权失败（检查 apiKey）'
          : res.status === 405
            ? '服务可达（该端点不支持 GET，可继续生成测试）'
            : `服务返回 HTTP ${res.status}`;
      this.lastTest = { ok, provider, status: res.status, latencyMs, message, at: nowIso() };
      return this.lastTest;
    } catch (err) {
      this.lastTest = { ok: false, provider, status: 0, latencyMs: Date.now() - started, message: `连接失败：${err.message}`, at: nowIso() };
      return this.lastTest;
    }
  }

  /**
   * @param {object} [config] 可覆盖 this.config
   * @param {object} [personality]
   * @param {object|string} [scene]
   */
  async generateSelfie(config = this.config, personality = null, scene = null) {
    // 兼容 generateSelfie({ personality, scene, mood }) 调用
    if (config && (config.personality || config.scene) && !config.endpoint && !config.provider) {
      scene = config.scene ?? scene;
      personality = config.personality ?? personality;
      config = this.config;
    }
    const cfg = { ...this.config, ...(config || {}) };
    const prompt = this.buildPrompt(personality, scene, { mood: typeof scene === 'object' ? scene?.mood : '' });
    const negative = this.buildNegativePrompt();
    const provider = cfg.provider || 'openai';
    this.logger?.info('生成自拍', { provider, promptLength: prompt.length, refs: (cfg.referenceImages || []).length });
    try {
      let images = [];
      if (provider === 'openai') images = await this.#openai(cfg, prompt);
      else if (provider === 'sdwebui') images = await this.#sdwebui(cfg, prompt, negative);
      else images = await this.#generic(cfg, prompt, negative);
      if (!images.length) throw new Error('API 未返回图片');
      const saved = [];
      for (const img of images.slice(0, 2)) saved.push(await this.#persist(img, cfg));
      const caption = `${selfieCaption(personality)}（AI 生成）`;
      return {
        ok: true,
        images: saved,
        caption,
        aiGenerated: true,
        provider,
        prompt,
        negativePrompt: negative,
        createdAt: nowIso(),
      };
    } catch (err) {
      this.lastError = err.message;
      this.logger?.error('自拍生成失败', { provider, error: err.message });
      return {
        ok: false,
        images: [],
        message: '拍糊了，等会儿再拍。',
        aiGenerated: true,
        provider,
        error: err.message,
      };
    }
  }

  async #openai(cfg, prompt) {
    const refs = await this.#refsAsBlobs(cfg.referenceImages || []);
    const base = normalizeEndpoint(cfg.endpoint);
    const apiKey = cfg.apiKey;
    if (refs.length > 0) {
      try {
        return await this.#openaiEdits(base, apiKey, cfg, prompt, refs);
      } catch (err) {
        this.logger?.warn('参考图编辑失败，降级为纯文生图', { error: err.message });
      }
    }
    const json = await this.#postJson(joinUrl(base, 'images/generations'), {
      model: cfg.model || 'gpt-image-1',
      prompt,
      n: 1,
      size: cfg.size || '1024x1024',
      response_format: 'b64_json',
    }, apiKey, cfg.timeoutSec);
    return parseOpenAiImages(json);
  }

  async #openaiEdits(base, apiKey, cfg, prompt, refs) {
    const form = new FormData();
    form.append('model', cfg.model || 'gpt-image-1');
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', cfg.size || '1024x1024');
    form.append('response_format', 'b64_json');
    for (const ref of refs) form.append('image[]', ref.blob, ref.name);
    const res = await withTimeout(
      fetch(joinUrl(base, 'images/edits'), {
        method: 'POST',
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: form,
      }),
      (cfg.timeoutSec || 90) * 1000,
      '图片 API edits',
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    return parseOpenAiImages(json);
  }

  async #generic(cfg, prompt, negative) {
    const base = normalizeEndpoint(cfg.endpoint);
    const refs = await this.#refsAsDataUrls(cfg.referenceImages || []);
    const payload = {
      prompt,
      negative_prompt: negative,
      model: cfg.model || undefined,
      workflow: cfg.workflow || undefined,
      size: cfg.size || '1024x1024',
      style: cfg.style || undefined,
      n: 1,
      reference_images: refs,
    };
    const json = await this.#postJson(base, payload, cfg.apiKey, cfg.timeoutSec);
    return parseGenericImages(json);
  }

  async #sdwebui(cfg, prompt, negative) {
    const size = parseSize(cfg.size, 1024, 1024);
    const base = normalizeEndpoint(cfg.endpoint);
    const payload = {
      prompt: `${prompt}, ${cfg.style || 'anime'} style`,
      negative_prompt: negative,
      width: size.width,
      height: size.height,
      steps: Number(cfg.steps || 28),
      cfg_scale: Number(cfg.cfgScale || 7),
      sampler_name: cfg.sampler || 'DPM++ 2M Karras',
      batch_size: 1,
      n_iter: 1,
    };
    const json = await this.#postJson(joinUrl(base, 'sdapi/v1/txt2img'), payload, cfg.apiKey, cfg.timeoutSec);
    return (json?.images || []).filter(Boolean).slice(0, 2);
  }

  async #postJson(url, body, apiKey, timeoutSec) {
    const attempts = Math.max(0, Number(this.config.retries || 1)) + 1;
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const res = await withTimeout(
          this.host.http.request(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            timeoutMs: (timeoutSec || 90) * 1000,
          }),
          (timeoutSec || 90) * 1000 + 5000,
          '图片生成',
        );
        if (!res.ok) throw new Error(res.json?.error?.message || res.text?.slice(0, 200) || `HTTP ${res.status}`);
        return res.json || {};
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async #refsAsBlobs(refs) {
    const out = [];
    for (const ref of refs.slice(0, 4)) {
      if (!ref) continue;
      try {
        if (/^https?:\/\//i.test(ref)) {
          const res = await fetch(ref);
          const buf = Buffer.from(await res.arrayBuffer());
          out.push({ blob: new Blob([buf], { type: res.headers.get('content-type') || 'image/png' }), name: `ref-${out.length + 1}.png` });
        } else {
          const buf = await fs.readFile(ref);
          out.push({ blob: new Blob([buf], { type: mimeOf(ref) }), name: path.basename(ref) });
        }
      } catch (err) {
        this.logger?.warn('参考图读取失败，已跳过', { ref, error: err.message });
      }
    }
    return out;
  }

  async #refsAsDataUrls(refs) {
    const out = [];
    for (const ref of refs.slice(0, 4)) {
      if (!ref) continue;
      try {
        if (/^https?:\/\//i.test(ref)) out.push(ref);
        else {
          const buf = await fs.readFile(ref);
          out.push(`data:${mimeOf(ref)};base64,${buf.toString('base64')}`);
        }
      } catch (err) {
        this.logger?.warn('参考图读取失败，已跳过', { ref, error: err.message });
      }
    }
    return out;
  }

  async #persist(image, cfg) {
    if (!image) throw new Error('空图片');
    await fs.mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (typeof image === 'string' && /^data:image\//i.test(image)) {
      const m = image.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
      if (!m) throw new Error('data URL 格式错误');
      const file = path.join(this.dir, `selfie-${stamp}.${m[1].includes('png') ? 'png' : 'jpg'}`);
      await fs.writeFile(file, Buffer.from(m[2], 'base64'), { mode: 0o600 });
      return file;
    }
    if (typeof image === 'string' && /^https?:\/\//i.test(image)) {
      try {
        const res = await fetch(image);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const file = path.join(this.dir, `selfie-${stamp}.png`);
        await fs.writeFile(file, buf, { mode: 0o600 });
        return file;
      } catch (err) {
        this.logger?.warn('远程图片下载失败，保留 URL', { error: err.message });
        return image;
      }
    }
    if (typeof image === 'string' && image.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(image)) {
      const file = path.join(this.dir, `selfie-${stamp}.png`);
      await fs.writeFile(file, Buffer.from(image.replace(/\s+/g, ''), 'base64'), { mode: 0o600 });
      return file;
    }
    throw new Error('无法识别的图片格式');
  }

  getStatus() {
    return {
      provider: this.config.provider,
      endpoint: this.config.endpoint,
      model: this.config.model,
      style: this.config.style,
      size: this.config.size,
      references: (this.config.referenceImages || []).length,
      hasApiKey: Boolean(this.config.apiKey),
      lastTest: this.lastTest,
      lastError: this.lastError,
    };
  }
}

function normalizeEndpoint(endpoint) {
  if (!endpoint) return '';
  let base = String(endpoint).trim().replace(/\/$/, '');
  return base;
}

function joinUrl(base, suffix) {
  if (!base) return suffix;
  if (base.toLowerCase().endsWith(`/${suffix.toLowerCase()}`)) return base;
  return `${base}/${suffix}`;
}

function parseOpenAiImages(json) {
  const data = json?.data || [];
  return data.map((d) => d.b64_json ? `data:image/png;base64,${d.b64_json}` : d.url).filter(Boolean);
}

function parseGenericImages(json) {
  const candidates = json?.images || json?.data || json?.output || [];
  const out = [];
  for (const item of candidates) {
    if (typeof item === 'string') out.push(item);
    else if (item?.url) out.push(item.url);
    else if (item?.b64_json) out.push(`data:image/png;base64,${item.b64_json}`);
    else if (item?.base64) out.push(`data:image/png;base64,${item.base64}`);
  }
  return out.filter(Boolean);
}

function parseSize(size, dw, dh) {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size || ''));
  if (!m) return { width: dw, height: dh };
  return { width: clamp(Number(m[1]), 256, 2048), height: clamp(Number(m[2]), 256, 2048) };
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

function selfieCaption(personality) {
  const id = personality?.id;
  if (id === 'tsundere') return '哼，就、就拍一张。别盯着看太久啊。';
  if (id === 'gentle') return '刚拍好的，今天的光线还不错。';
  if (id === 'sharp') return '拍是拍了，不好看也别怪我。';
  if (id === 'calm') return '自拍已生成。';
  if (id === 'genki') return '看！今天状态超好！';
  return textSummary('给你，刚拍的。', 40) || '给你，刚拍的。';
}

export function createImageApi(ctx) {
  return new ImageApi(ctx);
}

export { parseSize };

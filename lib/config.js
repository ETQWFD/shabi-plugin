/**
 * lib/config.js — 配置加载、校验、密钥分离持久化、路径规划。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deepMerge, getByPath, setByPath, clamp } from './util.js';
import { readFile as readIoshb, writeFileAtomic } from './ioshb.js';

export const SECRET_PATHS = ['llm.apiKey', 'imageApi.apiKey', 'qqBot.appSecret', 'qqBot.token', 'content.bilibili.cookie', 'content.novel.cookie'];

export class ConfigError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function buildPaths(root, config) {
  const rawData = config?.dataDir && config.dataDir !== '.' ? expandHome(config.dataDir) : root;
  const data = path.isAbsolute(rawData) ? rawData : path.resolve(root, rawData);
  return {
    root,
    data,
    memory: path.join(data, 'memory'),
    archive: path.join(data, 'memory', 'archive'),
    logs: path.join(data, 'logs'),
    frames: path.join(data, 'frames'),
    video: path.join(data, 'video'),
    backups: path.join(data, 'backups'),
    selfies: path.join(data, 'selfies'),
    settings: path.join(data, 'settings.json'),
    secrets: path.join(data, 'secrets.ioshb'),
    masterKey: path.join(data, 'master.key'),
    personalities: path.join(data, 'personalities.custom.json'),
    autonomyState: path.join(data, 'autonomy_state.ioshb'),
    interest: path.join(data, 'interest.ioshb'),
    registry: path.join(data, 'video_registry.ioshb'),
    knowledgeGraph: path.join(data, 'knowledge_graph.ioshb'),
    knowledgeIndex: path.join(data, 'knowledge_index.ioshb'),
    actions: path.join(data, 'logs', 'actions.jsonl'),
  };
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export const ENV_MAP = {
  'llm.endpoint': 'SHABI_LLM_ENDPOINT',
  'llm.apiKey': 'SHABI_LLM_API_KEY',
  'llm.model': 'SHABI_LLM_MODEL',
  'llm.visionModel': 'SHABI_LLM_VISION_MODEL',
  'llm.embedModel': 'SHABI_LLM_EMBED_MODEL',
  'imageApi.endpoint': 'SHABI_IMAGE_ENDPOINT',
  'imageApi.apiKey': 'SHABI_IMAGE_API_KEY',
  'imageApi.model': 'SHABI_IMAGE_MODEL',
  'qqBot.appId': 'SHABI_QQ_APPID',
  'qqBot.appSecret': 'SHABI_QQ_APPSECRET',
  'qqBot.token': 'SHABI_QQ_TOKEN',
  'video.asr.command': 'SHABI_ASR_COMMAND',
  'eye.capture.command': 'SHABI_CAPTURE_COMMAND',
};

/** 环境变量覆盖（最后应用，优先级最高）。 */
export function applyEnvOverrides(config, env = process.env) {
  let merged = config;
  for (const [cfgPath, envKey] of Object.entries(ENV_MAP)) {
    if (env[envKey]) merged = setByPath(merged, cfgPath, env[envKey]);
  }
  return merged;
}

/** 读取 config/default.json + data/settings.json + 环境变量（不含密钥）。 */
export async function loadBaseConfig({ root, dataDir, env = process.env } = {}) {
  const defaults = await readJson(path.join(root, 'config', 'default.json'));
  if (!defaults) throw new ConfigError('缺少 config/default.json');
  const paths = buildPaths(root, { ...defaults, ...(dataDir ? { dataDir } : {}) });
  const settings = await readJson(paths.settings, {});
  let merged = deepMerge(defaults, settings || {});
  merged = applyEnvOverrides(merged, env);
  return { config: merged, paths };
}

export async function loadSecrets(config, crypto) {
  try {
    const stored = await readIoshb(config.__paths?.secrets || '');
    if (stored && typeof stored === 'object') {
      for (const p of SECRET_PATHS) {
        const v = getByPath(stored, p);
        if (v) {
          const plain = crypto.decrypt(v);
          setByPath(config, p, plain);
        }
      }
    }
  } catch {
    // 无密钥文件或损坏：保持空值
  }
  return config;
}

/** 持久化非密钥配置；密钥加密后写入 secrets.ioshb，settings.json 中留空。 */
export async function saveConfig(config, { crypto, logger } = {}) {
  const paths = config.__paths;
  if (!paths) throw new ConfigError('配置缺少 __paths');
  const plain = JSON.parse(JSON.stringify(config));
  delete plain.__paths;
  const secrets = {};
  for (const p of SECRET_PATHS) {
    const v = getByPath(config, p);
    if (v) setByPath(secrets, p, crypto ? crypto.encrypt(v) : v);
    setByPath(plain, p, '');
  }
  await fs.mkdir(paths.data, { recursive: true });
  const tmp = `${paths.settings}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(plain, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, paths.settings);
  if (Object.keys(secrets).length > 0) await writeFileAtomic(paths.secrets, secrets);
  if (logger) logger.info('设置已保存', { file: paths.settings });
  return plain;
}

export function validateConfig(config) {
  const warnings = [];
  const errors = [];

  const num = (p, min, max, { repair = true } = {}) => {
    const v = Number(getByPath(config, p));
    if (!Number.isFinite(v)) {
      errors.push(`${p} 必须是数字`);
      return;
    }
    if (v < min || v > max) {
      warnings.push(`${p}=${v} 超出范围 [${min}, ${max}]`);
      if (repair) setByPath(config, p, clamp(v, min, max));
    }
  };

  num('eye.intervalSec', 5, 3600);
  num('video.coverageThreshold', 0.9, 1);
  num('video.chunkSec', 5, 300);
  num('video.chunkOverlapSec', 0, 10);
  num('video.maxFrames', 1000, 1000000);
  num('video.fpsCap', 1, 120);
  num('video.retries', 1, 10);
  num('memory.maxEntriesPerFile', 50, 5000);
  num('memory.forgetThreshold', 0, 1);
  num('memory.strengthThreshold', 0, 1);
  num('knowledge.dedupeThreshold', 0.5, 1);
  num('autonomy.intervalSec', 10, 86400);
  num('autonomy.dailyLimit', 0, 1000);
  num('autonomy.hourlyLimit', 0, 500);
  num('qqBot.rateLimit.perUserPerMin', 1, 120);

  if (getByPath(config, 'video.chunkOverlapSec', 0) >= getByPath(config, 'video.chunkSec', 30)) {
    errors.push('video.chunkOverlapSec 必须小于 video.chunkSec');
  }
  if (getByPath(config, 'autonomy.enabled') && getByPath(config, 'autonomy.dailyLimit') === 0) {
    warnings.push('自主循环已开启但每日上限为 0，将不会执行任何主动动作');
  }
  const dirs = getByPath(config, 'safety.allowedDirs', []);
  for (const d of dirs) {
    if (!path.isAbsolute(expandHome(d))) warnings.push(`白名单目录不是绝对路径：${d}`);
    if (path.resolve(expandHome(d)) === '/') errors.push('安全白名单不允许使用根目录 /');
  }
  if (getByPath(config, 'qqBot.enabled') && !getByPath(config, 'qqBot.appId')) {
    errors.push('QQ 机器人已启用但缺少 appId');
  }
  if (getByPath(config, 'imageApi.provider') === 'openai' && !getByPath(config, 'imageApi.endpoint')) {
    errors.push('图片 API 缺少 endpoint');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 给 UI 返回安全视图：密钥只暴露尾部 4 位。 */
export function redactConfigForUi(config) {
  const copy = JSON.parse(JSON.stringify({ ...config, __paths: undefined }));
  for (const p of SECRET_PATHS) {
    const v = getByPath(copy, p);
    if (v) setByPath(copy, p, `••••${String(v).slice(-4)}`);
  }
  return copy;
}

export function isMaskedSecret(value) {
  return typeof value === 'string' && /^•+/.test(value);
}

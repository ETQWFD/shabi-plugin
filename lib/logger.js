/**
 * lib/logger.js — 结构化 JSONL 日志，带体积轮转与敏感信息脱敏。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|appSecret|clientSecret)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|[a-f0-9]{32,})/g;

function redactValue(value, depth = 0) {
  if (depth > 3) return '[depth]';
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE, (m) => `${m.slice(0, 4)}***`).slice(0, 800);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '***' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  constructor({ dir, level = 'info', maxFileBytes = 5 * 1024 * 1024, keepFiles = 5, mirror = true, scope = '' } = {}) {
    this.dir = dir;
    this.level = LEVELS[level] ?? LEVELS.info;
    this.maxFileBytes = maxFileBytes;
    this.keepFiles = keepFiles;
    this.mirror = mirror;
    this.scope = scope;
    this.file = path.join(dir, 'shabi.log');
    this.queue = Promise.resolve();
    this.bytes = 0;
    if (dir) fs.mkdirSync(dir, { recursive: true });
    try {
      this.bytes = fs.statSync(this.file).size;
    } catch {
      this.bytes = 0;
    }
  }

  child(scope) {
    return new Logger({
      dir: this.dir,
      level: Object.keys(LEVELS).find((k) => LEVELS[k] === this.level) || 'info',
      maxFileBytes: this.maxFileBytes,
      keepFiles: this.keepFiles,
      mirror: this.mirror,
      scope: this.scope ? `${this.scope}:${scope}` : scope,
    });
  }

  setLevel(level) {
    this.level = LEVELS[level] ?? this.level;
  }

  #write(level, message, meta) {
    if (LEVELS[level] < this.level) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      scope: this.scope || 'shabi',
      msg: String(message).slice(0, 2000),
      ...(meta ? { meta: redactValue(meta) } : {}),
    });
    if (this.mirror) {
      const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      consoleFn(`[shabi${this.scope ? `:${this.scope}` : ''}] ${message}`);
    }
    if (!this.dir) return;
    const buf = `${line}\n`;
    this.queue = this.queue
      .then(async () => {
        await fsp.mkdir(this.dir, { recursive: true });
        await fsp.appendFile(this.file, buf, { mode: 0o600 });
        this.bytes += Buffer.byteLength(buf);
        if (this.bytes > this.maxFileBytes) await this.#rotate();
      })
      .catch(() => {});
  }

  async #rotate() {
    try {
      for (let i = this.keepFiles; i >= 1; i -= 1) {
        const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
        const to = `${this.file}.${i}`;
        await fsp.rename(from, to).catch(() => {});
      }
      this.bytes = 0;
    } catch {
      this.bytes = 0;
    }
  }

  debug(msg, meta) {
    this.#write('debug', msg, meta);
  }

  info(msg, meta) {
    this.#write('info', msg, meta);
  }

  warn(msg, meta) {
    this.#write('warn', msg, meta);
  }

  error(msg, meta) {
    this.#write('error', msg, meta);
  }

  async flush() {
    await this.queue;
  }

  async tail(limit = 200) {
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      return text.trim().split('\n').filter(Boolean).slice(-limit);
    } catch {
      return [];
    }
  }
}

export function createLogger(config = {}) {
  return new Logger({
    dir: config.dir,
    level: config.level || 'info',
    maxFileBytes: config.maxFileBytes,
    keepFiles: config.keepFiles,
    mirror: config.mirror !== false,
  });
}

/** 动作审计日志（独立文件，便于回滚检索）。 */
export class ActionLog {
  constructor(dir) {
    this.file = path.join(dir, 'actions.jsonl');
    this.queue = Promise.resolve();
  }

  append(entry) {
    const line = `${JSON.stringify(redactValue(entry))}\n`;
    this.queue = this.queue
      .then(async () => {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.appendFile(this.file, line, { mode: 0o600 });
      })
      .catch(() => {});
    return this.queue;
  }

  async find(logId) {
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      for (const line of text.trim().split('\n').reverse()) {
        try {
          const item = JSON.parse(line);
          if (item.logId === logId) return item;
        } catch {
          // 跳过损坏行
        }
      }
    } catch {
      // 文件不存在
    }
    return null;
  }

  async list(limit = 100) {
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    } catch {
      return [];
    }
  }
}

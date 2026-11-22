/**
 * lib/cryptoBox.js — 本地隐私数据加密（AES-256-GCM）。
 * 主密钥优先级：环境变量 SHABI_MASTER_KEY > 宿主 secrets > data/master.key（0600）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;

function parseKey(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === KEY_BYTES) return b64;
  } catch {
    // ignore
  }
  if (trimmed.length === KEY_BYTES) return Buffer.from(trimmed);
  return null;
}

export class CryptoBox {
  constructor({ dataDir, secrets, logger } = {}) {
    this.dataDir = dataDir;
    this.secrets = secrets;
    this.logger = logger;
    this.key = null;
  }

  async init() {
    const fromEnv = parseKey(process.env.SHABI_MASTER_KEY);
    if (fromEnv) {
      this.key = fromEnv;
      return this;
    }
    if (this.secrets) {
      const fromHost = parseKey(await this.secrets.get('shabi.masterKey').catch(() => null));
      if (fromHost) {
        this.key = fromHost;
        return this;
      }
    }
    const file = path.join(this.dataDir, 'master.key');
    try {
      const existing = parseKey(await fs.readFile(file, 'utf8'));
      if (existing) {
        this.key = existing;
        return this;
      }
    } catch {
      // 首次生成
    }
    const key = crypto.randomBytes(KEY_BYTES);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, key.toString('hex'), { mode: 0o600 });
    this.key = key;
    if (this.logger) this.logger.info('已生成本地加密主密钥（master.key）');
    return this;
  }

  #requireKey() {
    if (!this.key) throw new Error('CryptoBox 未初始化');
    return this.key;
  }

  encrypt(plain) {
    if (plain == null) return plain;
    const key = this.#requireKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${Buffer.concat([iv, tag, ct]).toString('base64')}`;
  }

  decrypt(value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
    const key = this.#requireKey();
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  encryptFields(obj, fields = ['content', 'summary']) {
    const out = { ...obj };
    for (const f of fields) {
      if (typeof out[f] === 'string' && !out[f].startsWith(PREFIX)) out[f] = this.encrypt(out[f]);
    }
    return out;
  }

  decryptFields(obj, fields = ['content', 'summary']) {
    const out = { ...obj };
    for (const f of fields) {
      if (typeof out[f] === 'string') out[f] = this.decrypt(out[f]);
    }
    return out;
  }
}

export const ENCRYPTED_PREFIX = PREFIX;

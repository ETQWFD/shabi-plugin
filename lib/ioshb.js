/**
 * lib/ioshb.js — 沙币私有数据容器 IOSHB1。
 *
 * 布局（小端序除外，长度均为大端）：
 *   0  6B  magic       "IOSHB1"
 *   6  1B  version     当前 1
 *   7  1B  flags       bit0=deflate, 其余保留
 *   8  4B  rawLength   未压缩 JSON 字节数（uint32BE）
 *  12  4B  payloadLength 压缩后字节数（uint32BE）
 *  16  4B  crc32      未压缩 JSON 的 CRC32（uint32BE）
 *  20  ... payload     deflate(JSON)
 * 总头长 20 字节。
 *
 * 写入：临时文件 -> fsync -> 备份旧文件(.bak) -> rename 原子替换。
 * 读取：头校验 + 长度校验 + CRC 校验；失败可回退 .bak。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export const MAGIC = 'IOSHB1';
export const VERSION = 1;
export const HEADER_SIZE = 20;
export const FLAG_DEFLATE = 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class IoshbError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'IoshbError';
    this.code = code;
    this.meta = meta;
  }
}

export function encode(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new IoshbError('IOSHB_SERIALIZE', `无法序列化对象：${err.message}`);
  }
  const raw = Buffer.from(json, 'utf8');
  const payload = zlib.deflateRawSync(raw, { level: 6 });
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt8(VERSION, 6);
  header.writeUInt8(FLAG_DEFLATE, 7);
  header.writeUInt32BE(raw.length, 8);
  header.writeUInt32BE(payload.length, 12);
  header.writeUInt32BE(crc32(raw), 16);
  return Buffer.concat([header, payload]);
}

export function decode(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < HEADER_SIZE) throw new IoshbError('IOSHB_TRUNCATED', '文件长度小于头部');
  if (buf.toString('ascii', 0, 6) !== MAGIC) throw new IoshbError('IOSHB_BAD_MAGIC', '不是 IOSHB1 文件');
  const version = buf.readUInt8(6);
  if (version !== VERSION) throw new IoshbError('IOSHB_VERSION', `不支持的版本 ${version}`);
  const flags = buf.readUInt8(7);
  const rawLength = buf.readUInt32BE(8);
  const payloadLength = buf.readUInt32BE(12);
  const expectedCrc = buf.readUInt32BE(16);
  if (buf.length !== HEADER_SIZE + payloadLength) {
    throw new IoshbError('IOSHB_LENGTH', `负载长度不符：声明 ${payloadLength}，实际 ${buf.length - HEADER_SIZE}`);
  }
  const payload = buf.subarray(HEADER_SIZE);
  let raw;
  try {
    raw = (flags & FLAG_DEFLATE) ? zlib.inflateRawSync(payload) : payload;
  } catch (err) {
    throw new IoshbError('IOSHB_INFLATE', `解压失败：${err.message}`);
  }
  if (raw.length !== rawLength) throw new IoshbError('IOSHB_LENGTH', `解压长度不符：声明 ${rawLength}，实际 ${raw.length}`);
  const actualCrc = crc32(raw);
  if (actualCrc !== expectedCrc) {
    throw new IoshbError('IOSHB_CRC', `CRC32 校验失败：期望 ${expectedCrc}，实际 ${actualCrc}`);
  }
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new IoshbError('IOSHB_PARSE', `JSON 解析失败：${err.message}`);
  }
  return { value, version, flags, rawLength, payloadLength, crc: actualCrc };
}

async function fsyncFile(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    await handle.sync();
  } catch {
    // 某些文件系统不支持 fsync，忽略
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * 原子写 IOSHB。
 * @param {string} file 目标文件
 * @param {unknown} value 可 JSON 序列化对象
 * @param {{backup?: boolean}} [opts]
 */
export async function writeFileAtomic(file, value, opts = {}) {
  const { backup = true } = opts;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const buffer = encode(value);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, buffer, { mode: 0o600 });
  await fsyncFile(tmp);
  if (backup) {
    try {
      await fs.copyFile(file, `${file}.bak`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  await fs.rename(tmp, file);
  return { bytes: buffer.length, crc: crc32(Buffer.from(JSON.stringify(value), 'utf8')) };
}

export async function readFile(file, { allowBackup = true } = {}) {
  try {
    const buffer = await fs.readFile(file);
    return decode(buffer).value;
  } catch (err) {
    if (allowBackup && (err.code === 'IOSHB_CRC' || err.code === 'IOSHB_TRUNCATED' || err.code === 'IOSHB_INFLATE')) {
      const bak = `${file}.bak`;
      try {
        const buffer = await fs.readFile(bak);
        const decoded = decode(buffer).value;
        return { ...decoded, __recoveredFromBackup: true };
      } catch {
        // 备份也不可用，抛原始错误
      }
    }
    throw err;
  }
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

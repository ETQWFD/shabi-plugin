import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic, readFile, writeJsonAtomic, exists } from '../lib/ioshb.js';

const DIR = '/tmp/shabi-ioshb-test';

test.before(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
});

test('IOSHB1 写入/读取：中文、嵌套、数组', async () => {
  const file = path.join(DIR, 'roundtrip.ioshb');
  const payload = {
    format: 'IOSHB1',
    version: 1,
    text: '沙币记忆：长期记忆与遗忘曲线',
    list: [1, 2, 3, { nested: true }],
    date: '2026-11-22T00:00:00.000Z',
  };
  await writeFileAtomic(file, payload);
  const back = await readFile(file);
  assert.deepEqual(back, payload);
  const raw = await fs.readFile(file);
  assert.equal(raw.subarray(0, 6).toString(), 'IOSHB1');
  assert.ok(raw.length < Buffer.byteLength(JSON.stringify(payload)) + 64, '应压缩');
});

test('写入自动生成 .bak，CRC 损坏时回退备份', async () => {
  const file = path.join(DIR, 'backup.ioshb');
  await writeFileAtomic(file, { version: 1, text: '第一版' });
  await writeFileAtomic(file, { version: 2, text: '第二版' });
  assert.ok(await exists(`${file}.bak`), '应生成 .bak');

  const buf = await fs.readFile(file);
  // 篡改 payload 的一个字节，触发 CRC 失败
  buf[buf.length - 3] ^= 0xff;
  await fs.writeFile(file, buf);
  const recovered = await readFile(file);
  assert.equal(recovered.version, 1);
  assert.equal(recovered.text, '第一版');
});

test('writeJsonAtomic 与损坏文件处理', async () => {
  const file = path.join(DIR, 'data.json');
  await writeJsonAtomic(file, { a: 1, b: ['x'] });
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(data, { a: 1, b: ['x'] });

  await fs.writeFile(file, '{broken');
  await assert.rejects(() => readFile(file));
});

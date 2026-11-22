import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeApp } from './helpers.js';

test('记忆写入/检索/加密落盘', async () => {
  const { app, dir, cleanup } = await makeApp({ prefix: 'memory' });
  try {
    const secret = '这是不应出现在磁盘明文里的秘密内容：蓝鲸计划';
    const entry = await app.memory.writeMemory({
      type: 'knowledge',
      summary: '蓝鲸计划的关键结论',
      content: secret,
      importance: 0.9,
      tags: ['项目A', '蓝鲸'],
      source: { kind: 'test' },
    });
    assert.ok(entry.id.startsWith('mem_'));
    assert.equal(app.memory.getMemory(entry.id).summary, '蓝鲸计划的关键结论');

    const found = await app.memory.searchMemory('蓝鲸', 5, { touch: false });
    assert.ok(found.some((x) => x.id === entry.id), '关键词检索应命中');

    const scene = await app.memory.recallByScene({ app: 'Editor', window: '蓝鲸计划.md', text: '项目A 的结论' }, 5);
    assert.ok(scene.length >= 1, '场景召回应命中');

    const raw = await fs.readFile(path.join(dir, 'memory', 'memory_1.ioshb'));
    assert.equal(raw.includes(Buffer.from('蓝鲸计划')), false, 'IOSHB 中不应出现明文');

    const listed = app.memory.listMemories({ limit: 10 });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].checksum.length, 64);
  } finally {
    await cleanup();
  }
});

test('遗忘结算：低重要度旧记忆进入归档，可“突然记起来”', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'forget' });
  try {
    const old = new Date(Date.now() - 240 * 86400000).toISOString();
    const low = await app.memory.writeMemory({
      type: 'observation', summary: '很久以前的一件小事', content: '旧记忆：阳台上的风铃',
      importance: 0.05, lastAccess: old, time: old, tags: ['旧事'],
    });
    const keep = await app.memory.writeMemory({
      type: 'knowledge', summary: '重要结论', content: '重要的长期结论', importance: 0.95,
    });

    const result = await app.memory.forgetTick(new Date());
    assert.ok(result.archived >= 1, '应归档低强度旧记忆');
    assert.equal(app.memory.getMemory(low.id), null);
    assert.ok(app.memory.getMemory(keep.id), '高重要度记忆应保留');

    const archived = await app.memory.readArchiveEntries();
    assert.ok(archived.some((x) => x.id === low.id));

    const woken = await app.memory.resurfaceMemory('风铃');
    assert.ok(woken, '应能从归档召回');
    assert.equal(woken.id, low.id);
    assert.ok(app.memory.getMemory(low.id), '唤醒后应回到主库');
    assert.ok(woken.tags.includes('resurfaced'));

    const un = await app.memory.unarchiveMemory(keep.id).catch((err) => ({ error: err.message }));
    assert.ok(un.error, '未归档的条目不应能 unarchive');
  } finally {
    await cleanup();
  }
});

test('导出 INI：章节从 [memory 1] 开始', async () => {
  const { app, dir, cleanup } = await makeApp({ prefix: 'export' });
  try {
    await app.memory.writeMemory({ type: 'chat', summary: '第一句', content: '第一句对话', importance: 0.5 });
    await app.memory.writeMemory({ type: 'chat', summary: '第二句', content: '第二句对话', importance: 0.6 });
    const out = path.join(dir, 'export');
    const result = await app.memory.exportMemory(out, { format: 'ini' });
    const text = await fs.readFile(result.path, 'utf8');
    assert.match(text, /\[memory 1\]/);
    assert.match(text, /\[memory 2\]/);
    assert.equal(text.includes('[memory 0]'), false);
    assert.equal(result.count, 2);
  } finally {
    await cleanup();
  }
});

test('删除最后一条后重启不会“复活”', async () => {
  const { app, dir, cleanup } = await makeApp({ prefix: 'delete' });
  try {
    const entry = await app.memory.writeMemory({ type: 'observation', summary: '临时', content: '删除测试' });
    await app.memory.deleteMemory(entry.id);
    await app.memory.close();
    const { createShabiPlugin } = await import('../main.js');
    const { ROOT } = await import('./helpers.js');
    const app2 = await createShabiPlugin({ root: ROOT, env: {}, config: { dataDir: dir, eye: { enabled: false }, qqBot: { enabled: false } } });
    try {
      assert.equal(app2.memory.getStats().entries, 0);
      assert.equal(app2.memory.getMemory(entry.id), null);
    } finally {
      await app2.dispose();
    }
  } finally {
    await cleanup();
  }
});

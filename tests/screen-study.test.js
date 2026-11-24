import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeApp } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('看屏幕视频学习：截屏帧 → OCR 文本 → 笔记 → 学习文件 → 长期记忆', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'watch', rawHost: {}, config: { eye: { enabled: true, mode: 'manual' } } });
  try {
    let n = 0;
    app.eye.getScreenContext = async () => {
      n += 1;
      return {
        app: 'chrome', window: '哔哩哔哩 - Chromium',
        text: n === 1
          ? '第一段：梯度下降是一种通过迭代更新参数来最小化损失函数的方法。'
          : '第二段：学习率太大会震荡，太小会收敛很慢，需要配合验证集调整。',
        scene: '视频课程画面，讲师在讲解公式', elements: [], source: 'ocr',
        timestamp: new Date().toISOString(), width: 1920, height: 1080,
      };
    };
    app.screenStudy.config.notesEveryFrames = 2;
    app.screenStudy.config.maxNotesPerSession = 5;
    app.screenStudy.config.autoWriteMemory = true;

    const started = app.screenStudy.start({ title: 'B站：梯度下降', intervalSec: 1, maxMinutes: 1 });
    assert.equal(started.ok, true);
    assert.equal(started.title, 'B站：梯度下降');
    await sleep(1200);
    await sleep(1200);
    const stopped = await app.screenStudy.stop();
    assert.equal(stopped.ok, true);
    assert.ok(stopped.frames >= 2, `帧数不足：${stopped.frames}`);
    assert.ok(stopped.notes >= 1, `没有生成笔记：${stopped.notes}`);
    const session = app.screenStudy.session;
    assert.ok(session.transcriptFile);
    const stat = await fs.stat(session.transcriptFile);
    assert.ok(stat.size > 100);
    const text = await fs.readFile(session.transcriptFile, 'utf8');
    assert.match(text, /梯度下降/);
    assert.match(text, /学习率/);
    assert.ok((await app.memory.getStats()).entries >= 1);
    assert.equal(app.screenStudy.getStatus().running, false);
  } finally {
    await cleanup();
  }
});

test('看屏幕视频学习：停止后可以再次开始，且重复画面不堆帧', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'watch2', rawHost: {}, config: { eye: { enabled: true, mode: 'manual' } } });
  try {
    let same = true;
    app.eye.getScreenContext = async () => ({
      app: 'chrome', window: 'B站', text: same ? '同一段字幕' : '新字幕', scene: '', elements: [], source: 'ocr',
      timestamp: new Date().toISOString(), width: 1920, height: 1080,
    });
    app.screenStudy.start({ title: '重复帧', intervalSec: 1, maxMinutes: 1 });
    await sleep(1200);
    assert.equal(app.screenStudy.session.frames.length, 1, '相同画面被重复堆帧');
    await app.screenStudy.stop();
    same = false;
    const again = app.screenStudy.start({ title: '第二轮', intervalSec: 1, maxMinutes: 1 });
    assert.equal(again.ok, true);
    await sleep(200);
    await app.screenStudy.stop();
    assert.ok(app.screenStudy.session.frames.length >= 1);
  } finally {
    await cleanup();
  }
});

test('设置 schema 包含看视频学习分组', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'config', 'settings.schema.json'), 'utf8'));
  const group = schema.groups.find((g) => g.id === 'screenStudy');
  assert.ok(group, '缺少 screenStudy 设置组');
  const keys = group.fields.map((f) => f.key);
  for (const key of ['screenStudy.intervalSec', 'screenStudy.maxMinutes', 'screenStudy.autoWriteMemory', 'screenStudy.defaultTitle']) {
    assert.ok(keys.includes(key), `缺少设置项 ${key}`);
  }
});

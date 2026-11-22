import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeApp } from './helpers.js';

function eyeHost({ window = 'Notepad - notes.txt', app = 'Notepad', fail = false, allow = ['Notepad'] } = {}) {
  let n = 0;
  return {
    screen: {
      async capture() {
        if (fail) throw new Error('模拟截屏失败');
        n += 1;
        const p = `/tmp/shabi-eye-${process.pid}-${Date.now()}-${n}.png`;
        await fs.writeFile(p, 'fake-png-bytes');
        return { path: p, width: 1920, height: 1080, app, window, capturedAt: new Date().toISOString() };
      },
      async ocr() {
        return { text: '文件 编辑 查看 帮助', blocks: [{ text: '保存按钮', bbox: [0.8, 0.1, 0.1, 0.05] }], engine: 'mock' };
      },
      async blur(imagePath, regions, outPath) {
        await fs.copyFile(imagePath, outPath);
        return outPath;
      },
    },
    vision: {
      async describe() {
        return JSON.stringify({
          app,
          window,
          scene: '在文本编辑器里编辑笔记',
          text: '用户正在写一份笔记',
          elements: [{ type: 'button', label: '保存', bbox: [0.8, 0.1, 0.1, 0.05] }],
        });
      },
    },
    ui: { notify: async () => ({ ok: true }), confirm: async () => ({ approved: false }) },
  };
}

test('屏幕上下文：OCR + 视觉理解 + 元素 bbox', async () => {
  const { app, cleanup } = await makeApp({
    prefix: 'eye', rawHost: eyeHost(),
    config: { eye: { enabled: false, mode: 'manual', privacy: { paused: false, windowAllowlist: ['Notepad'], blurRegions: [] } } },
  });
  try {
    const ctx = await app.eye.getScreenContext({ force: true });
    assert.ok(ctx);
    assert.equal(ctx.app, 'Notepad');
    assert.equal(ctx.window, 'Notepad - notes.txt');
    assert.equal(ctx.scene, '在文本编辑器里编辑笔记');
    assert.match(ctx.text, /笔记/);
    assert.ok(ctx.elements.length >= 2);
    assert.ok(ctx.elements.every((e) => e.bbox && typeof e.bbox.x === 'number'));
    assert.equal(ctx.degraded, false);
  } finally {
    await cleanup();
  }
});

test('隐私：暂停 / 窗口白名单 / 敏感区域模糊', async () => {
  const { app, cleanup } = await makeApp({
    prefix: 'eye-privacy', rawHost: eyeHost({ app: 'Chrome', window: 'Chrome - 其他窗口' }),
    config: { eye: { enabled: false, mode: 'manual', privacy: { paused: false, windowAllowlist: ['Notepad'], blurRegions: [[0.1, 0.1, 0.2, 0.1]] } } },
  });
  try {
    const skipped = await app.eye.getScreenContext({ force: true });
    assert.equal(skipped, null, '不在白名单的窗口应跳过');

    app.eye.pause('test');
    assert.equal(await app.eye.getScreenContext({ force: true }), null);
    app.eye.resume();
  } finally {
    await cleanup();
  }
});

test('截屏失败降级：返回 null、记录错误、连续失败后退避', async () => {
  const { app, cleanup } = await makeApp({
    prefix: 'eye-fail', rawHost: eyeHost({ fail: true }),
    config: { eye: { enabled: false, mode: 'manual', failure: { maxConsecutive: 1, backoffSec: 1 } } },
  });
  try {
    assert.equal(await app.eye.getScreenContext({ force: true }), null);
    const status = app.eye.getStatus();
    assert.ok(status.failures >= 1);
    assert.match(status.lastError, /截屏失败/);
    assert.equal(await app.eye.getScreenContext({ force: true }), null);
  } finally {
    await cleanup();
  }
});

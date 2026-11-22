import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeApp } from './helpers.js';

test('设置页：通过 webServer.register 挂载 /shabi/settings 与 /shabi/ui 前缀', async () => {
  const routes = [];
  const { app, cleanup } = await makeApp({
    prefix: 'routes',
    rawHost: {
      http: {
        registerRoute(routePath, handler, kind) {
          routes.push({ routePath, handler, kind });
          return () => {};
        },
      },
    },
    config: { eye: { enabled: false, mode: 'manual' } },
  });
  try {
    assert.ok(routes.length >= 15, `路由数量异常：${routes.length}`);
    const settings = routes.find((r) => r.routePath === '/shabi/settings');
    assert.ok(settings, '缺少 /shabi/settings');
    assert.equal(settings.kind, 'exact');
    const ui = routes.find((r) => r.routePath === '/shabi/ui');
    assert.ok(ui, '缺少 /shabi/ui');
    assert.equal(ui.kind, 'prefix');

    const settingsResult = await settings.handler({ method: 'GET', url: '/shabi/settings', headers: {} });
    assert.equal(settingsResult.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(String(settingsResult.body), /<base href="\/shabi\/ui\/" \/>/);
    assert.match(String(settingsResult.body), /沙币设置/);

    const cssResult = await ui.handler({ method: 'GET', url: '/shabi/ui/settings.css', headers: {} });
    assert.equal(cssResult.headers['content-type'], 'text/css; charset=utf-8');
    assert.match(String(cssResult.body), /:root|body|\.shell/);

    const api = routes.find((r) => r.routePath === '/shabi/api/content');
    assert.ok(api, '缺少内容 API');
  } finally {
    await cleanup();
  }
});

test('B 站：无 Cookie 时退回公开排行榜并标准化字段', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/x/web-interface/ranking/v2')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          code: 0,
          data: {
            list: [
              { bvid: 'BV1xx411c7mD', title: '测试视频', owner: { name: 'UP主' }, stat: { view: 123 }, duration: 60, pic: 'https://i0.hdslb.com/a.jpg', desc: '简介' },
            ],
          },
        }),
      };
    }
    throw new Error(`unexpected URL: ${u}`);
  };
  const { app, cleanup } = await makeApp({ prefix: 'bili-feed', rawHost: {}, config: { eye: { enabled: false, mode: 'manual' } } });
  try {
    const feed = await app.content.bilibiliFeed({ limit: 3 });
    assert.equal(feed.ok, true);
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].bvid, 'BV1xx411c7mD');
    assert.equal(feed.items[0].title, '测试视频');
    assert.equal(feed.items[0].author, 'UP主');
    assert.match(feed.items[0].url, /bilibili\.com\/video/);
  } finally {
    globalThis.fetch = original;
    await cleanup();
  }
});

test('B 站学习：无字幕时用标题/简介兜底，不直接判定不可用', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/x/web-interface/view')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { title: '无字幕的知识视频', cid: 42, desc: '这是视频简介，讲的是如何在设置页配置 B 站 Cookie。', owner: { name: '测试UP' }, tname: '知识' } }) };
    }
    if (u.includes('/x/player/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { subtitle: { subtitles: [] } } }) };
    }
    throw new Error(`unexpected URL: ${u}`);
  };
  const { app, cleanup } = await makeApp({ prefix: 'bili-learn', rawHost: {}, config: { eye: { enabled: false, mode: 'manual' } } });
  try {
    const learned = await app.content.bilibiliLearn('BV1xx411c7mD');
    assert.equal(learned.ok, true);
    assert.equal(learned.mode, 'description');
    assert.ok(learned.notes.length >= 1);
    assert.ok(learned.memoryIds.length >= 1);
    assert.match(learned.message, /没有可用字幕/);
  } finally {
    globalThis.fetch = original;
    await cleanup();
  }
});

test('小说：抓取标题/正文/章节链接并缓存，支持翻页', async () => {
  const original = globalThis.fetch;
  const base = 'https://example.com/book/1.html';
  const next = 'https://example.com/book/2.html';
  globalThis.fetch = async (url) => {
    const u = String(url);
    const isNext = u.includes('/2.html');
    return {
      ok: true, status: 200,
      text: async () => `<!doctype html><html><head><title>${isNext ? '第二章' : '第一章'}</title></head><body>
        <article><h1>${isNext ? '第二章' : '第一章'}</h1>
        <p>这是第一章的正文段落，长度足够被阅读器提取，不会因为太短被过滤掉。</p>
        <p>第二段继续讲述故事，人物在雨夜走进了旧书店，发现了一封没有署名的信。</p>
        <p>第三段留下悬念，读者会想知道下一章发生了什么，因此需要继续阅读。</p>
        <a href="/book/2.html">下一章</a><a href="/book/0.html">上一章</a></article></body></html>`,
    };
  };
  const { app, cleanup } = await makeApp({ prefix: 'novel', rawHost: {}, config: { eye: { enabled: false, mode: 'manual' } } });
  try {
    const opened = await app.content.novelOpen(base);
    assert.equal(opened.ok, true);
    assert.match(opened.title, /第一章/);
    assert.ok(opened.paragraphs.length >= 2);
    assert.ok(opened.paragraphs.join('').includes('旧书店'));
    assert.ok(opened.chapterLinks.some((x) => x.url === next));
    assert.equal(app.content.getStatus().novel.current.title, '第一章');

    const moved = await app.content.novelNext();
    assert.equal(moved.ok, true);
    assert.match(moved.title, /第二章/);
    assert.match(moved.note || '', /已翻到/);
  } finally {
    globalThis.fetch = original;
    await cleanup();
  }
});

test('学习文本：无 LLM 时用规则抽取，并写入长期记忆与笔记文件', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'learn', rawHost: {}, config: { eye: { enabled: false, mode: 'manual' } } });
  try {
    const learned = await app.content.learnText({
      title: '测试学习',
      text: '第一，先打开设置页。第二，把 B 站 Cookie 填进去。第三，点击刷一条，插件会读取推荐列表。遇到风控必须立即停止。',
      source: 'test',
      tags: ['回归'],
    });
    assert.equal(learned.ok, true);
    assert.ok(learned.notes.length >= 2);
    assert.ok(learned.memoryIds.length >= 1);
    const stat = await fs.stat(learned.noteFile);
    assert.ok(stat.size > 0);
    const memory = await app.memory.searchMemory('B 站 Cookie', 5, { touch: false });
    assert.ok(memory.length >= 1, '学习结果没有进入记忆');
  } finally {
    await cleanup();
  }
});

test('设置 schema 包含用户要求的 B 站/小说/学习选项', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'config', 'settings.schema.json'), 'utf8'));
  const content = schema.groups.find((g) => g.id === 'content');
  assert.ok(content, '缺少 content 设置组');
  const keys = content.fields.map((f) => f.key);
  for (const key of [
    'content.bilibili.enabled', 'content.bilibili.cookie', 'content.bilibili.feedLimit',
    'content.bilibili.downloadVideo', 'content.bilibili.maxDownloadMB',
    'content.novel.defaultUrl', 'content.novel.cookie',
    'content.learning.autoWriteMemory', 'content.learning.maxNotesPerItem',
  ]) assert.ok(keys.includes(key), `缺少设置项 ${key}`);
});

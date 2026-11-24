import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

test('平台自主学习：搜索候选 → 观看 → 写记忆/收藏 → 计数', async () => {
  const { app, cleanup } = await makeApp({
    prefix: 'media',
    config: {
      companion: { enabled: false },
      video: { analysisWidth: 320, frameQuality: 5, maxFrames: 5000, maxVideoSeconds: 120 },
      media: { enabled: true, platforms: ['bilibili'], topics: ['测试主题'], maxVideosPerDay: 8, restAfterVideos: 3, novelWhenTired: false },
    },
  });
  try {
    app.content.platformSearch = async () => ({
      ok: true,
      items: [{ platform: 'bilibili', id: 'BVtest123', bvid: 'BVtest123', title: '测试视频', url: 'https://www.bilibili.com/video/BVtest123', duration: 60, tags: ['测试'] }],
    });
    app.content.bilibiliWatch = async () => ({
      ok: true, title: '测试视频', platform: 'bilibili', summary: '这是一条测试知识点', videoId: 'vid-test',
      favorite: { id: 'fav-test', title: '测试视频' }, noteFile: '/tmp/note.md', memoryIds: ['mem-1'],
    });
    const tick = await app.media.tick({ manual: true });
    assert.equal(tick.started, true);
    assert.equal(tick.candidate.bvid, 'BVtest123');
    await app.media.currentPromise;
    const status = app.media.getStatus();
    assert.equal(status.lastResult.ok, true);
    assert.equal(status.lastResult.favorite.id, 'fav-test');
    assert.equal(status.videosSinceRest, 1);
    assert.equal(status.videosToday, 1);
  } finally {
    await cleanup();
  }
});

test('看累后进入休息并读小说，休息时间写入状态', async () => {
  const { app, cleanup } = await makeApp({
    prefix: 'mediarest',
    config: {
      companion: { enabled: false },
      media: { enabled: true, restAfterVideos: 3, restMinutes: 20, novelWhenTired: true, novelUrl: 'https://example.com/book', novelChaptersPerRest: 1 },
    },
  });
  try {
    app.media.state.videosSinceRest = 3;
    app.content.novelOpen = async () => ({ ok: true, title: '测试小说', url: 'https://example.com/book', paragraphs: ['第一章内容'] });
    app.content.novelNext = async () => ({ ok: true, title: '测试小说' });
    app.content.novelLearn = async () => ({ ok: true, summary: '测试小说知识点' });
    const tick = await app.media.tick({ manual: true });
    assert.equal(tick.action, 'rest');
    assert.ok(tick.restUntil);
    assert.equal(tick.novel.ok, true);
    assert.equal(app.media.state.mode, 'rest');
    assert.equal(app.media.state.novelsRead, 1);
    assert.equal(app.media.state.videosSinceRest, 3);
  } finally {
    await cleanup();
  }
});

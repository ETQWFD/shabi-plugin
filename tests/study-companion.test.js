import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeApp } from './helpers.js';

async function makeSampleVideo(file) {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4',
    '-c:v', 'mpeg4', '-q:v', '5', file,
  ], { timeout: 60000 });
  return file;
}

test('自主学习队列：扫描本地视频 → 逐帧学习 → 笔记/记忆 → 掌握状态', async () => {
  const { app, cleanup } = await makeApp({
    prefix: 'study',
    config: {
      companion: { enabled: false },
      video: { analysisWidth: 320, frameQuality: 5, maxFrames: 5000, maxVideoSeconds: 30 },
      study: { maxPasses: 1, minCoverage: 0.9, minConfidence: 0.2 },
    },
  });
  try {
    const video = await makeSampleVideo(path.join(app.study.inbox, 'lesson.mp4'));
    await app.study.scanInbox();
    assert.equal(app.study.getStatus().stats.queued, 1);
    const result = await app.study.next();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.id.startsWith('study-'));
    assert.ok(result.coverage >= 0.9);
    assert.ok(result.noteFile);
    const note = await fs.readFile(result.noteFile, 'utf8');
    assert.match(note, /lesson/);
    assert.ok(app.study.queue.find((x) => x.status === 'mastered'));
    assert.ok((await app.memory.getStats()).entries >= 1);
    assert.equal(app.study.getStatus().running, false);
    assert.ok(video.endsWith('lesson.mp4'));
  } finally {
    await cleanup();
  }
});

test('空闲陪伴：队列为空且没有主动消息授权时只返回 nothing-to-do', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'companion', config: { companion: { enabled: false, intervalSec: 60 }, media: { enabled: false } } });
  try {
    app.companion.config = { enabled: true, intervalSec: 60, autoStudy: true, proactiveQQ: false, quietHours: [] };
    app.companion.start();
    const result = await app.companion.tick();
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'nothing-to-do');
    assert.equal(app.companion.getStatus().running, true);
    app.companion.stop();
  } finally {
    await cleanup();
  }
});

test('QQ 主动消息：显式开启后每日次数与最小间隔生效', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'qqpro', config: { qqBot: { enabled: false } } });
  try {
    await app.qq.init();
    app.qq.running = true;
    app.qq.lastC2C = { type: 'c2c', channelId: 'c2c:u1', target: 'u1', userId: 'u1', id: 'm1', at: new Date().toISOString() };
    app.qq.proactiveState.proactive = { day: null, count: 0, lastAt: null, suppressedUntil: null };
    app.qq.config = { ...app.qq.config, proactive: { enabled: true, maxPerDay: 2, minGapMin: 120, maxAgeHours: 72, maxChars: 160, quietHours: [] } };
    let sent = 0;
    app.qq.sendMessage = async () => { sent += 1; return { ok: true }; };
    const first = await app.qq.sendProactive('在忙吗？我刚整理完一条学习笔记。');
    assert.equal(first.ok, true);
    assert.equal(sent, 1);
    const second = await app.qq.sendProactive('第二条不应该发。');
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'gap-limit');
    assert.equal(app.qq.getProactiveStatus().count, 1);
  } finally {
    await cleanup();
  }
});

test('设置 schema 含自主学习与空闲陪伴组', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../config/settings.schema.json', import.meta.url), 'utf8'));
  const ids = schema.groups.map((g) => g.id);
  assert.ok(ids.includes('study'));
  assert.ok(ids.includes('companion'));
  const qq = schema.groups.find((g) => g.id === 'qqBot');
  assert.ok(qq.fields.some((f) => f.key === 'qqBot.proactive.enabled'));
});

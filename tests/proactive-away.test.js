import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('QQ 主动消息：连续六条未回后发最后一条并进入 away 模式', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'qqaway', config: { qqBot: { enabled: false }, media: { enabled: false } } });
  try {
    await app.qq.init();
    app.qq.running = true;
    app.qq.lastC2C = { type: 'c2c', channelId: 'c2c:u1', target: 'u1', userId: 'u1', id: 'm1', at: new Date(Date.now() - 3600000).toISOString() };
    app.qq.proactiveState.proactive = {
      day: `${new Date().getFullYear()}-${new Date().getMonth() + 1}-${new Date().getDate()}`, count: 6, lastAt: new Date(Date.now() - 31 * 60000).toISOString(), suppressedUntil: null,
      unanswered: 6, finalSentAt: null, awayMode: false,
    };
    app.qq.config = { ...app.qq.config, proactive: { enabled: true, maxPerDay: 7, minGapMin: 30, maxAgeHours: 72, unansweredBeforeFinal: 6, awayAfterFinal: true, maxChars: 160, quietHours: [] } };
    let sent = 0;
    app.qq.sendMessage = async () => { sent += 1; return { ok: true }; };
    const final = await app.qq.sendProactive('你一直没回我，我先自己去看视频了。');
    assert.equal(final.ok, true);
    assert.equal(final.final, true);
    assert.equal(sent, 1);
    assert.equal(app.qq.getProactiveStatus().count, 7);
    assert.equal(app.qq.getProactiveStatus().awayMode, true);
    const blocked = await app.qq.sendProactive('不应该再发');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'away-mode');
  } finally {
    await cleanup();
  }
});

test('设置页/属性含媒体组、收藏夹与梁圣彩蛋', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT, 'config/settings.schema.json'), 'utf8'));
  assert.ok(schema.groups.some((g) => g.id === 'media' && g.fields.some((f) => f.type === 'favoriteList')));
  const html = await fs.readFile(path.join(ROOT, 'ui/settings.html'), 'utf8');
  assert.ok(html.includes('梁圣:"我的deepseek的记忆只有七秒,我要给他完整的一生"'));
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.properties.easterEgg.value, '梁圣:"我的deepseek的记忆只有七秒,我要给他完整的一生"');
});

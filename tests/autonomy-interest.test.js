import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, mockUi } from './helpers.js';

function hostForAutonomy({ approve = false } = {}) {
  const calls = { chat: [], notify: [], input: [] };
  return {
    calls,
    screen: {
      async capture() { throw new Error('无 GUI，按无屏幕降级'); },
      async ocr() { return { text: '', blocks: [] }; },
    },
    vision: { async describe() { return null; } },
    ui: {
      async notify(text, opts) { calls.notify.push({ text, opts }); return { ok: true }; },
      async confirm(action) { calls.confirm = action; return approve ? { approved: true, token: 'mock-token', approvedBy: 'test' } : { approved: false, reason: 'test-denied' }; },
      emit() {},
    },
    chat: { async send(text, opts) { calls.chat.push({ text, opts }); return { ok: true }; } },
    input: { async run(action) { calls.input.push(action); return { ok: true }; } },
    llm: { async chat() { return { text: 'fallback' }; } },
  };
}

test('自主循环：白名单动作执行、限额/冷却、危险动作二次确认拒绝', async () => {
  const rawHost = hostForAutonomy();
  const { app, cleanup } = await makeApp({
    prefix: 'autonomy',
    rawHost,
    config: { autonomy: { enabled: false, intervalSec: 10, dailyLimit: 20, hourlyLimit: 10, cooldownSec: 0, quietHours: [] } },
  });
  try {
    const goal = await app.autonomy.setGoal({ title: '整理今天的笔记', priority: 8, due: Date.now() + 3600000 });
    assert.ok(goal.id);
    assert.equal(app.autonomy.listGoals().length, 1);

    app.autonomy.config.enabled = true;
    app.autonomy.running = true;
    app.decision.decide = async () => ({
      action: 'speak', args: { text: '这是一次测试主动话' }, reason: 'test', confidence: 0.8, source: 'test', risk: 'low',
    });
    const spoken = await app.autonomy.tick({ manual: true });
    assert.equal(spoken.ok, true);
    assert.equal(spoken.decision.action, 'speak');
    assert.equal(rawHost.calls.chat.length, 1);
    assert.equal(rawHost.calls.chat[0].text, '这是一次测试主动话');

    app.decision.decide = async () => ({
      action: 'open_app', args: { app: 'Notepad' }, reason: 'test-confirm', confidence: 0.8, source: 'test', risk: 'medium',
    });
    const denied = await app.autonomy.tick({ manual: true });
    assert.equal(denied.skipped, true);
    assert.equal(denied.reason, 'user-denied');
    assert.equal(rawHost.calls.input.length, 0, '未确认不得执行鼠标键盘/打开应用');
    assert.ok(app.autonomy.getStatus().stats.denied >= 1);

    const blocked = app.autonomy.handlePlatformSignal({ type: 'captcha', detail: '请完成验证' });
    assert.equal(blocked.stopped, true);
    assert.ok(app.autonomy.getStatus().blockedUntil);
    assert.match(rawHost.calls.notify.at(-1).text, /验证码|风控|访问限制/);
    await app.autonomy.resumeAfterBlock();
    assert.equal(app.autonomy.getStatus().blockedUntil, null);

    const lowRiskWithLimit = await app.autonomy.tick();
    assert.equal(lowRiskWithLimit.skipped, true);
  } finally {
    await cleanup();
  }
});

test('自主循环：确认通过后执行中风险动作并写审计', async () => {
  const rawHost = hostForAutonomy({ approve: true });
  const { app, cleanup } = await makeApp({
    prefix: 'autonomy-approve', rawHost,
    config: { autonomy: { enabled: false, intervalSec: 10, dailyLimit: 20, hourlyLimit: 10, cooldownSec: 0 }, safety: { appAllowlist: ['Notepad'] } },
  });
  try {
    app.autonomy.config.enabled = true;
    app.autonomy.running = true;
    app.decision.decide = async () => ({
      action: 'open_app', args: { app: 'Notepad' }, reason: 'test', confidence: 0.8, source: 'test', risk: 'medium',
    });
    // 确认通过后执行中风险动作并写入审计。
    const result = await app.autonomy.tick({ manual: true });
    assert.equal(result.ok, true);
    assert.equal(rawHost.calls.input.length, 1, '确认后应执行一次白名单打开应用');
    assert.equal(rawHost.calls.input[0].app, 'Notepad');
    const actions = await app.safety.listActions(20);
    assert.ok(actions.some((a) => a.action === 'open_app' && a.approved === true), '应写入动作审计');
  } finally {
    await cleanup();
  }
});

test('兴趣画像：偏好排序、反馈闭环、平台限制后停止', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'interest', rawHost: { ui: mockUi() } });
  try {
    await app.interest.ingest({
      history: [{ title: '人工智能 编程 教程', tags: ['人工智能', '编程'], reward: 0.9 }],
      favorites: [{ title: '机器学习 入门', tags: ['机器学习', '编程'] }],
      chats: [{ text: '我想学习人工智能和编程' }],
    });
    const profile = app.interest.getProfile();
    assert.ok(profile.tags.length >= 2);
    assert.ok(profile.tags.some((t) => ['人工智能', '编程', '机器学习'].includes(t.tag)));

    const candidates = [
      { id: 'ai-1', title: '人工智能入门教程', tags: ['人工智能', '编程'], publishedAt: new Date().toISOString(), quality: 0.9 },
      { id: 'cook-1', title: '家常菜谱', tags: ['烹饪'], publishedAt: new Date(Date.now() - 30 * 86400000).toISOString(), quality: 0.6 },
    ];
    const picked = await app.interest.selectNext(candidates, { epsilon: 0, limit: 1 });
    assert.equal(picked.ok, true);
    assert.equal(picked.items.length, 1);
    assert.equal(picked.items[0].id, 'ai-1', '应优先选择兴趣匹配内容');
    assert.ok(picked.items[0]._score > 0);

    const before = app.interest.getProfile().tags.find((t) => t.tag === '人工智能')?.weight || 0;
    const feedback = await app.interest.feedback('ai-1', 'complete', { tags: ['人工智能', '编程'] });
    assert.equal(feedback.ok, true);
    const after = app.interest.getProfile().tags.find((t) => t.tag === '人工智能')?.weight || 0;
    assert.ok(after > before, '看完反馈应提升兴趣权重');

    const blocked = app.interest.handlePlatformSignal({ type: 'captcha', detail: '验证码' });
    assert.equal(blocked.stopped, true);
    assert.equal(app.interest.canOperate(), false);
    const denied = await app.interest.selectNext(candidates);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'blocked-by-platform-signal');

    await app.interest.clearBlock();
    assert.equal(app.interest.canOperate(), true);
    const resumed = await app.interest.selectNext(candidates);
    assert.equal(resumed.ok, true);
  } finally {
    await cleanup();
  }
});

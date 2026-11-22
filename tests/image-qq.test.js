import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { makeApp, tinyPng, mockUi } from './helpers.js';

const SECRET = 's'.repeat(32);

function qqPrivateKey(secret = SECRET) {
  const seed = Buffer.from(secret, 'utf8').length === 32
    ? Buffer.from(secret, 'utf8')
    : crypto.createHash('sha256').update(secret).digest();
  return crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8',
  });
}

function signWebhook(body, timestamp, secret = SECRET) {
  return crypto.sign(null, Buffer.from(`${timestamp}${body}`, 'utf8'), qqPrivateKey(secret)).toString('hex');
}

function imageHost(state) {
  return {
    http: {
      async request(url, options = {}) {
        if (url.includes('/models')) return { ok: true, status: 200, json: { data: [{ id: 'mock-image-model' }] } };
        if (state.fail) return { ok: false, status: 500, json: { error: { message: 'upstream boom' } } };
        if (options.method === 'POST') return { ok: true, status: 200, json: { images: [tinyPng()] } };
        return { ok: true, status: 200, json: {} };
      },
    },
  };
}

test('图片 API：连接测试、生成落盘、AI 标注、失败固定降级文案', async () => {
  const state = { fail: false };
  const { app, cleanup } = await makeApp({ prefix: 'image', rawHost: imageHost(state) });
  try {
    const connection = await app.imageApi.testConnection({
      provider: 'openai', endpoint: 'https://img.test/v1', apiKey: 'test-key',
    });
    assert.equal(connection.ok, true);
    assert.equal(connection.message, '连接成功');

    const personality = app.personality.getActive();
    const generated = await app.imageApi.generateSelfie({
      provider: 'generic', endpoint: 'https://img.test/generate', apiKey: 'test-key', retries: 0,
    }, personality, '客厅，下午');
    assert.equal(generated.ok, true);
    assert.ok(generated.images.length >= 1);
    assert.match(generated.caption, /AI 生成/);
    assert.equal(generated.aiGenerated, true);
    const stat = await fs.stat(generated.images[0]);
    assert.ok(stat.size > 0, '自拍文件必须落盘');
    assert.match(generated.prompt, /人格：/);

    state.fail = true;
    const failed = await app.imageApi.generateSelfie({
      provider: 'generic', endpoint: 'https://img.test/generate', apiKey: 'test-key', retries: 0,
    }, personality, '客厅');
    assert.equal(failed.ok, false);
    assert.equal(failed.message, '拍糊了，等会儿再拍。');
    assert.equal(failed.images.length, 0);
    assert.equal(failed.aiGenerated, true);
    assert.match(app.imageApi.getStatus().lastError, /upstream boom/);
  } finally {
    await cleanup();
  }
});

function qqHost() {
  return {
    http: {
      async request(url) {
        if (url.includes('getAppAccessToken')) {
          return { ok: true, status: 200, json: { access_token: 'mock-token', expires_in: 7200 } };
        }
        return { ok: true, status: 200, json: { id: 'sent', timestamp: new Date().toISOString() } };
      },
    },
    ui: mockUi(),
    chat: { async send() { return { ok: true }; } },
    llm: { async chat() { return { text: '我在。' }; } },
  };
}

test('QQ 官方机器人：Ed25519 验签、回调应答、@ 去重与限频', async () => {
  const { app, cleanup } = await makeApp({
    prefix: 'qq',
    rawHost: qqHost(),
    config: {
      qqBot: {
        enabled: false, mode: 'webhook', appId: '10200001', appSecret: SECRET,
        rateLimit: { perUserPerMin: 2, perChannelPerMin: 20, dedupeWindow: 600 },
      },
    },
  });
  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ op: 0, t: 'UNKNOWN_EVENT', d: {} });
    const bad = await app.qq.handleWebhook({
      headers: { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': timestamp },
      rawBody: body,
    });
    assert.equal(bad.status, 401, '无效签名必须拒绝');

    const valid = await app.qq.handleWebhook({
      headers: { 'x-signature-ed25519': signWebhook(body, timestamp), 'x-signature-timestamp': timestamp },
      rawBody: body,
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body, { op: 12 });

    const plainToken = 'callback-token-123';
    const eventTs = timestamp;
    const callbackBody = JSON.stringify({ op: 13, d: { plain_token: plainToken, event_ts: eventTs } });
    const callback = await app.qq.handleWebhook({
      headers: { 'x-signature-ed25519': signWebhook(callbackBody, timestamp), 'x-signature-timestamp': timestamp },
      rawBody: callbackBody,
    });
    assert.equal(callback.status, 200);
    assert.equal(callback.body.plain_token, plainToken);
    const pub = crypto.createPublicKey(qqPrivateKey());
    assert.equal(crypto.verify(
      null,
      Buffer.from(`${plainToken}${eventTs}`, 'utf8'),
      pub,
      Buffer.from(callback.body.signature, 'hex'),
    ), true, 'op13 回调签名必须可验证');

    const sent = [];
    app.qq.running = true;
    app.qq.sendMessage = async (channelId, content, image) => {
      sent.push({ channelId, content, image });
      return { ok: true };
    };

    const base = { type: 'group', channelId: 'group:g1', target: 'g1', userId: 'u1', content: '<@!10001> 在吗' };
    const first = await app.qq.onMention({ ...base, id: 'm1' });
    assert.equal(first.ok, true);
    assert.equal(sent.length, 1);

    const duplicate = await app.qq.onMention({ ...base, id: 'm1' });
    assert.equal(duplicate.skipped, true);
    assert.equal(duplicate.reason, 'duplicate');
    assert.equal(sent.length, 1, '重复消息不得重复回复');

    const second = await app.qq.onMention({ ...base, id: 'm2' });
    assert.equal(second.ok, true);
    assert.equal(sent.length, 2);

    const limited = await app.qq.onMention({ ...base, id: 'm3' });
    assert.equal(limited.skipped, true);
    assert.equal(limited.reason, 'user-rate-limit');
    assert.equal(sent.length, 2, '触发限频后不得发送');
  } finally {
    await cleanup();
  }
});

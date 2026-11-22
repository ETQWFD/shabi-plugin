import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeApp, mockUi } from './helpers.js';

test('路径白名单：插件目录允许，外部/穿越/受保护文件拒绝', async () => {
  const { app, dir, cleanup } = await makeApp({ prefix: 'safety-path', rawHost: { ui: mockUi() } });
  try {
    const inside = await app.safety.isPathAllowed(path.join(app.paths.logs, 'ok.txt'), { write: true });
    assert.equal(inside.ok, true);

    const outside = await app.safety.isPathAllowed(path.join('/tmp', `shabi-outside-${process.pid}`, 'outside.txt'), { write: true });
    assert.equal(outside.ok, false);

    const traversal = await app.safety.isPathAllowed('../../etc/passwd', { write: false });
    assert.equal(traversal.ok, false);

    const protectedMemory = await app.safety.isPathAllowed(path.join(app.paths.memory, 'memory_index.ioshb'), { write: true });
    assert.equal(protectedMemory.ok, false);

    const readMemory = await app.safety.isPathAllowed(path.join(app.paths.memory, 'memory_index.ioshb'), { write: false });
    assert.equal(readMemory.ok, true);
  } finally {
    await cleanup();
  }
});

test('确认 token 一次性、绑定 action/detail', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'safety-token', rawHost: { ui: mockUi() } });
  try {
    const detail = { text: 'hello' };
    const low = await app.safety.confirmAction({ action: 'notify', detail });
    assert.equal(low.approved, true);
    assert.ok(low.token);
    assert.equal(app.safety.verifyToken(low.token, { action: 'notify', detail }), true);
    assert.equal(app.safety.verifyToken(low.token, { action: 'notify', detail }), false, 'token 只能使用一次');
    assert.equal(app.safety.verifyToken('not-a-token', { action: 'notify', detail }), false);

    const bad = await app.safety.confirmAction({ action: 'file_delete', detail: { path: '/tmp/x' } });
    assert.equal(bad.approved, false, '无确认界面时高风险默认拒绝');
  } finally {
    await cleanup();
  }
});

test('备份 + 回滚恢复文件', async () => {
  const { app, dir, cleanup } = await makeApp({ prefix: 'safety-rollback', rawHost: { ui: mockUi() } });
  try {
    const file = path.join(dir, 'document.txt');
    await fs.writeFile(file, '原始内容');
    const backup = await app.safety.backupFile(file);
    const logId = await app.safety.logAction({
      action: 'file_write', risk: 'medium', detail: { path: file }, approved: true,
      rollback: { type: 'file-restore', target: file, backup },
    });
    await fs.writeFile(file, '被修改的内容');
    const result = await app.safety.rollback(logId);
    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(file, 'utf8'), '原始内容');
  } finally {
    await cleanup();
  }
});

test('鼠标键盘只允许白名单应用', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'safety-input', rawHost: { ui: mockUi() } });
  try {
    assert.equal(app.safety.isAppAllowed('shabi-plugin'), true);
    assert.equal(app.safety.isAppAllowed('沙币设置'), true);
    assert.equal(app.safety.isAppAllowed('Unknown App'), false);
    assert.throws(() => app.safety.assertInputAllowed('Unknown App'), /不在白名单/);
  } finally {
    await cleanup();
  }
});

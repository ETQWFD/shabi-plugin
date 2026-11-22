/**
 * tests/helpers.js — 测试夹具：隔离 dataDir，禁用后台循环与 QQ。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShabiPlugin } from '../main.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

let seq = 0;

export async function makeApp({ config = {}, rawHost = {}, prefix = 'case' } = {}) {
  const dir = path.join('/tmp', `shabi-${prefix}-${process.pid}-${Date.now()}-${seq += 1}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const app = await createShabiPlugin({
    root: ROOT,
    rawHost,
    env: {},
    config: {
      dataDir: dir,
      eye: { enabled: false, mode: 'manual' },
      autonomy: { enabled: false },
      qqBot: { enabled: false },
      ...config,
    },
  });
  return {
    app,
    dir,
    async cleanup() {
      await app.dispose().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export function tinyPng() {
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
}

export function mockUi() {
  return {
    notify: async () => ({ ok: true }),
    confirm: async () => ({ approved: false, reason: 'test-default-deny' }),
    emit: () => true,
  };
}

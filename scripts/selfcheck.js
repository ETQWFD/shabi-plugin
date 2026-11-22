/**
 * scripts/selfcheck.js — 零宿主依赖自检。
 * 不写入真实记忆：只写一条带 selfcheck 标签的临时记忆，检查后删除。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as readIoshb, writeFileAtomic } from '../lib/ioshb.js';
import { nowIso } from '../lib/util.js';

const execFileAsync = promisify(execFile);

export async function runSelfcheck(app) {
  const checks = [];
  const add = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail: detail == null ? 'ok' : String(detail) });
    } catch (err) {
      checks.push({ name, ok: false, detail: err.message });
    }
  };

  await add('配置校验', async () => {
    const { validateConfig } = await import('../lib/config.js');
    const result = validateConfig(app.config);
    if (!result.ok) throw new Error(result.errors.join('；'));
    return result.warnings.length ? `通过，${result.warnings.length} 条警告` : '通过';
  });

  await add('数据目录可写', async () => {
    const probe = path.join(app.paths.logs, `.selfcheck-${process.pid}`);
    await fs.writeFile(probe, 'ok', { mode: 0o600 });
    await fs.rm(probe, { force: true });
    return app.paths.data;
  });

  await add('IOSHB 往返', async () => {
    const file = path.join(app.paths.logs, `.selfcheck-${process.pid}.ioshb`);
    const payload = { format: 'IOSHB1', at: nowIso(), nested: { a: [1, 2, 3], b: '中文' } };
    await writeFileAtomic(file, payload, { backup: false });
    const back = await readIoshb(file);
    await fs.rm(file, { force: true });
    if (back?.nested?.b !== '中文') throw new Error('往返内容不一致');
    return 'magic/CRC/压缩正常';
  });

  await add('记忆写入/读取/删除', async () => {
    const entry = await app.memory.writeMemory({
      type: 'observation',
      summary: 'selfcheck 临时记忆',
      content: `自检临时内容 ${process.pid}`,
      tags: ['selfcheck'],
      importance: 0.01,
    });
    const found = app.memory.getMemory(entry.id);
    if (!found) throw new Error('写入后读不到');
    await app.memory.deleteMemory(entry.id);
    return `写入 ${entry.id} 后删除`;
  });

  await add('人格装配', async () => {
    const list = app.personality.listPersonalities();
    if (list.length < 5) throw new Error(`内置人格不足：${list.length}`);
    const prompt = app.personality.buildSystemPrompt(app.personality.getActive(), [], {
      app: 'SelfCheck', window: 'test', text: '示例屏幕内容', scene: '测试',
    });
    for (const must of ['硬约束', '不透露', 'AI 生成']) {
      if (!prompt.includes(must)) throw new Error(`系统提示缺少约束：${must}`);
    }
    return `${list.length} 个人格，提示词 ${prompt.length} 字`;
  });

  await add('文件白名单', async () => {
    const inside = await app.safety.isPathAllowed(app.paths.logs, { write: true });
    if (!inside.ok) throw new Error(`插件目录被拒绝：${inside.reason}`);
    const outside = await app.safety.isPathAllowed('/tmp/outside-shabi-selfcheck', { write: true });
    if (outside.ok) throw new Error('外部目录未被拒绝');
    const protectedFile = await app.safety.isPathAllowed(path.join(app.paths.memory, 'memory_1.ioshb'), { write: true });
    if (protectedFile.ok) throw new Error('记忆文件未被保护');
    return '插件目录允许，外部与记忆文件拒绝';
  });

  await add('危险动作确认', async () => {
    const detail = { path: path.join(app.paths.logs, 'x.txt') };
    const low = await app.safety.confirmAction({ action: 'notify', detail });
    if (!low.approved || !low.token) throw new Error('低风险动作未自动签发 token');
    if (!app.safety.verifyToken(low.token, { action: 'notify', detail })) throw new Error('token 校验失败');
    const high = await app.safety.confirmAction({ action: 'file_delete', detail });
    if (high.approved && !high.token) throw new Error('高风险确认缺少 token');
    return high.approved ? '高风险 token 正常' : '高风险在无确认界面时默认拒绝（符合预期）';
  });

  await add('ffmpeg / ffprobe', async () => {
    const ffmpeg = app.config.media?.ffmpeg || 'ffmpeg';
    const ffprobe = app.config.media?.ffprobe || 'ffprobe';
    const a = await execFileAsync(ffmpeg, ['-version'], { timeout: 10000 });
    const b = await execFileAsync(ffprobe, ['-version'], { timeout: 10000 });
    return `${a.stdout.split('\n')[0]} / ${b.stdout.split('\n')[0]}`;
  });

  await add('图片 API 配置', async () => {
    const cfg = app.config.imageApi || {};
    if (!cfg.endpoint) throw new Error('未配置 endpoint');
    return `${cfg.provider || 'openai'} ${cfg.endpoint}，参考图 ${(cfg.referenceImages || []).length}/4`;
  });

  await add('QQ 机器人配置', async () => {
    const cfg = app.config.qqBot || {};
    if (!cfg.enabled) return '未启用（跳过）';
    if (!cfg.appId || !cfg.appSecret) throw new Error('已启用但缺少 appId/appSecret');
    return `${cfg.mode}，路径 ${cfg.webhookPath}`;
  });

  await add('HTTP 设置 API', async () => {
    if (!app.routes?.length) return '独立模式：未注册 HTTP 路由；在 DSH/dev-server 中由宿主提供';
    return `${app.routes.length} 条路由`;
  });

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    at: nowIso(),
    version: app.version,
    capabilities: app.host.capabilities,
    checks,
  };
}

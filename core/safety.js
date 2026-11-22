/**
 * core/safety.js — 白名单、风险分级、二次确认、动作审计与回滚。
 *
 * 原则：
 *  - 写/删文件必须在“插件目录 + 用户授权目录”内；
 *  - 记忆库、密钥、插件代码属于受保护文件，公开 API 不允许改写/删除；
 *  - 鼠标键盘只允许白名单应用与插件窗口；
 *  - 高风险动作必须拿到一次性确认 token；
 *  - 可回滚动作先备份，再执行，日志落 logs/actions.jsonl。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ActionLog } from '../lib/logger.js';
import { expandHome } from '../lib/config.js';
import { id as makeId, nowIso, sha256 } from '../lib/util.js';

export const RISK = {
  notify: 'low', speak: 'low', suggest: 'low', save_note: 'low', remind: 'low',
  analyze_screen: 'low', generate_selfie: 'low', watch_video: 'medium', qq_send: 'medium',
  send_message: 'medium', open_app: 'medium', file_write: 'medium', file_delete: 'high',
  file_overwrite: 'high', input_click: 'high', input_type: 'high', input_key: 'high',
  execute_command: 'high', delete_memory: 'medium', rollback: 'high', qq_broadcast: 'high',
};

const PROTECTED_PATTERNS = [
  /memory[_-]?index\.ioshb$/i,
  /memory_\d+\.ioshb$/i,
  /archive_\d+\.ioshb$/i,
  /master\.key$/i,
  /secrets\.ioshb$/i,
  /host-secrets\.json$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)manifest\.json$/i,
  /(^|\/)package\.json$/i,
  /(^|\/)main\.js$/i,
];

export class SafetyError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'SafetyError';
    this.code = code;
    this.meta = meta;
  }
}

export class Safety {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = ctx.config.safety;
    this.pluginDir = ctx.paths.root;
    this.dataDir = ctx.paths.data;
    // 插件自己的 dataDir 永远属于内部数据目录（可能被配置到插件根之外）。
    this.allowedDirs = [ctx.paths.data, ...(this.config.allowedDirs || [])].map((d) => path.resolve(expandHome(d)));
    this.appAllowlist = (this.config.appAllowlist || []).map(String);
    this.confirmTtl = Number(this.config.confirmTtlSec || 120) * 1000;
    this.backupsDir = ctx.paths.backups;
    this.actionLog = new ActionLog(ctx.paths.logs);
    this.tokens = new Map();
    this.logger = ctx.logger;
  }

  // ───────────────── 路径 ─────────────────

  resolvePath(input) {
    if (typeof input !== 'string' || !input) throw new SafetyError('PATH_INVALID', '路径不能为空');
    if (input.includes('\0')) throw new SafetyError('PATH_INVALID', '路径包含非法字符');
    const expanded = expandHome(input);
    if (path.isAbsolute(expanded)) return path.resolve(expanded);
    return path.resolve(this.pluginDir, expanded);
  }

  async #canonical(input) {
    const resolved = this.resolvePath(input);
    try {
      return await fs.realpath(resolved);
    } catch {
      // 目标尚不存在：对父目录做 realpath，防止通过符号链接逃逸
      try {
        const parent = await fs.realpath(path.dirname(resolved));
        return path.join(parent, path.basename(resolved));
      } catch {
        return resolved;
      }
    }
  }

  async isPathAllowed(target, { write = false, internal = false } = {}) {
    let resolved;
    try {
      resolved = await this.#canonical(target);
    } catch (err) {
      return { ok: false, reason: err.message, resolved: null };
    }
    if (internal) {
      const inData = isInside(resolved, this.dataDir);
      const inPlugin = isInside(resolved, this.pluginDir);
      return { ok: inData || inPlugin, reason: inData || inPlugin ? 'internal' : 'outside-plugin', resolved };
    }
    const roots = [this.pluginDir, ...this.allowedDirs];
    const matched = roots.find((r) => isInside(resolved, r));
    if (!matched) return { ok: false, reason: '不在白名单目录内', resolved };
    if (write && this.#isProtected(resolved)) {
      return { ok: false, reason: '受保护文件，禁止改写或删除', resolved };
    }
    return { ok: true, reason: 'whitelist', resolved, root: matched };
  }

  #isProtected(file) {
    const normalized = file.replace(/\\/g, '/');
    return PROTECTED_PATTERNS.some((re) => re.test(normalized)) || (this.config.denyPatterns || []).some((p) => globish(p, normalized));
  }

  async assertPathAllowed(target, opts = {}) {
    const result = await this.isPathAllowed(target, opts);
    if (!result.ok) throw new SafetyError('PATH_DENIED', `路径被安全策略拒绝：${target}（${result.reason}）`, result);
    return result;
  }

  isAppAllowed(app) {
    if (!app) return false;
    const hay = String(app).toLowerCase();
    if (hay.includes('shabi') || hay.includes('沙币')) return true;
    if (this.appAllowlist.length === 0) return false;
    return this.appAllowlist.some((a) => hay.includes(String(a).toLowerCase()));
  }

  assertInputAllowed(app) {
    if (!this.isAppAllowed(app)) {
      throw new SafetyError('INPUT_DENIED', `鼠标键盘目标不在白名单：${app}`, { app });
    }
    return true;
  }

  // ───────────────── 风险与确认 ─────────────────

  riskOf(action) {
    return RISK[action] || 'high';
  }

  templateFor(action, detail = {}) {
    const map = {
      file_write: ['写入文件', detail.path],
      file_delete: ['删除文件', detail.path],
      file_overwrite: ['覆盖文件', detail.path],
      input_click: ['模拟鼠标点击', detail.app],
      input_type: ['模拟键盘输入', detail.app],
      input_key: ['模拟按键', detail.app],
      send_message: ['发送消息', detail.target],
      qq_send: ['QQ 机器人回复', detail.target],
      watch_video: ['观看/分析视频', detail.title || detail.source],
      open_app: ['打开应用', detail.app],
      execute_command: ['执行命令', detail.command],
      rollback: ['回滚动作', detail.logId],
    };
    return map[action] || [action, detail.target || ''];
  }

  async confirmAction(action) {
    const risk = this.riskOf(action.action || action.name);
    const [title, target] = this.templateFor(action, action.detail || {});
    const payload = {
      action: action.action || action.name,
      detail: action.detail || {},
      risk,
    };
    if (risk === 'low') {
      const token = this.#issueToken({ action: payload.action, detail: payload.detail });
      await this.logAction({ ...payload, approved: true, approvedBy: 'low-risk-auto' });
      return { approved: true, token, risk };
    }
    if (!this.config.confirmHighRisk && risk !== 'high') {
      const token = this.#issueToken({ action: payload.action, detail: payload.detail });
      return { approved: true, token, risk, approvedBy: 'medium-auto' };
    }
    const result = await this.ctx.host.ui.confirm({
      title: `沙币请求：${title}`,
      detail: [target, JSON.stringify(payload.detail).slice(0, 500)].filter(Boolean).join('\n'),
      risk,
      action: payload.action,
      confirmText: '允许一次',
      cancelText: '拒绝',
    });
    if (!result?.approved) {
      await this.logAction({ ...payload, approved: false, approvedBy: 'user-denied' });
      return { approved: false, reason: result?.reason || '用户拒绝', risk };
    }
    const token = this.#issueToken({ action: payload.action, detail: payload.detail });
    await this.logAction({ ...payload, approved: true, approvedBy: result.by || 'user' });
    return { approved: true, token, risk, approvedBy: result.by || 'user' };
  }

  #issueToken(payload) {
    const token = crypto.randomBytes(16).toString('hex');
    this.tokens.set(token, { hash: sha256(JSON.stringify(payload)), expiresAt: Date.now() + this.confirmTtl, used: false });
    return token;
  }

  verifyToken(token, payload = {}) {
    const rec = this.tokens.get(token);
    if (!rec || rec.used || Date.now() > rec.expiresAt) return false;
    if (payload && rec.hash !== sha256(JSON.stringify(payload))) return false;
    rec.used = true;
    this.tokens.delete(token);
    return true;
  }

  // ───────────────── 动作日志 / 回滚 ─────────────────

  async logAction(action) {
    const logId = action.logId || makeId('act');
    const entry = {
      logId,
      ts: nowIso(),
      action: action.action || 'unknown',
      risk: action.risk || this.riskOf(action.action),
      detail: action.detail || {},
      approved: action.approved ?? null,
      approvedBy: action.approvedBy || null,
      result: action.result || null,
      rollback: action.rollback || null,
      error: action.error || null,
    };
    await this.actionLog.append(entry);
    return logId;
  }

  async listActions(limit = 100) {
    return this.actionLog.list(limit);
  }

  async backupFile(target) {
    await this.assertPathAllowed(target, { write: false, internal: false });
    try {
      await fs.access(target);
    } catch {
      return null;
    }
    const base = path.join(this.backupsDir, makeId('bak'));
    await fs.mkdir(base, { recursive: true });
    const backupPath = path.join(base, path.basename(target));
    await fs.copyFile(target, backupPath);
    return backupPath;
  }

  /**
   * 执行一个受控动作：校验白名单/确认 token/记录前后状态。
   * @param {{action:string, detail?:object, token?:string, requiresConfirm?:boolean}} spec
   * @param {(ctx:{token?:string, logId:string}) => Promise<any>} fn
   */
  async runGuarded(spec, fn) {
    const action = spec.action;
    const risk = this.riskOf(action);
    if (risk === 'high' || spec.requiresConfirm) {
      if (!spec.token || !this.verifyToken(spec.token, { action, detail: spec.detail || {} })) {
        throw new SafetyError('CONFIRM_REQUIRED', `高风险动作需要二次确认：${action}`);
      }
    }
    if (['input_click', 'input_type', 'input_key'].includes(action)) {
      this.assertInputAllowed(spec.detail?.app);
    }
    const logId = makeId('act');
    let rollback = null;
    if (spec.detail?.path && ['file_write', 'file_overwrite', 'file_delete'].includes(action)) {
      await this.assertPathAllowed(spec.detail.path, { write: true });
      rollback = { type: 'file-restore', target: spec.detail.path, backup: await this.backupFile(spec.detail.path) };
    }
    await this.logAction({ action, risk, detail: spec.detail, approved: true, approvedBy: spec.approvedBy || 'token', logId, result: 'running', rollback });
    try {
      const result = await fn({ token: spec.token, logId });
      await this.logAction({ action, risk, detail: spec.detail, approved: true, approvedBy: spec.approvedBy || 'token', logId, result: { ok: true, summary: result?.summary || 'done' }, rollback });
      return result;
    } catch (err) {
      await this.logAction({ action, risk, detail: spec.detail, approved: true, approvedBy: spec.approvedBy || 'token', logId, result: { ok: false }, error: err.message, rollback });
      throw err;
    }
  }

  async rollback(logId) {
    const entry = await this.actionLog.find(logId);
    if (!entry) throw new SafetyError('ROLLBACK_NOT_FOUND', `找不到动作日志：${logId}`);
    const rb = entry.rollback;
    if (!rb || rb.type !== 'file-restore') throw new SafetyError('ROLLBACK_UNSUPPORTED', '该动作没有可用的回滚信息');
    await this.assertPathAllowed(rb.target, { write: true, internal: false });
    if (rb.backup) {
      await fs.copyFile(rb.backup, rb.target);
      await this.logAction({ action: 'rollback', risk: 'high', detail: { logId, target: rb.target }, approved: true, approvedBy: 'manual', result: { ok: true, restored: rb.target } });
      return { ok: true, restored: rb.target, from: rb.backup };
    }
    await fs.rm(rb.target, { force: true });
    await this.logAction({ action: 'rollback', risk: 'high', detail: { logId, target: rb.target }, approved: true, approvedBy: 'manual', result: { ok: true, removed: rb.target } });
    return { ok: true, removed: rb.target };
  }

  getStatus() {
    return {
      pluginDir: this.pluginDir,
      allowedDirs: this.allowedDirs,
      appAllowlist: this.appAllowlist,
      confirmHighRisk: Boolean(this.config.confirmHighRisk),
      confirmTtlSec: this.confirmTtl / 1000,
      pendingConfirmations: this.tokens.size,
    };
  }
}

function isInside(child, parent) {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  if (a === b) return true;
  return a.startsWith(b + path.sep);
}

function globish(pattern, text) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`, 'i').test(text) || new RegExp(escaped, 'i').test(text);
}

export function createSafety(ctx) {
  return new Safety(ctx);
}

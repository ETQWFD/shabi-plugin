/**
 * ui/chatEnhance.js — 聊天增强钩子与命令处理。
 *
 * 提供 beforeSend（人格+记忆+屏幕注入）与 handleCommand（自拍/记忆/视频/人格）。
 * DSH 适配点：若宿主暴露 chat.onBeforeSend 或事件总线，则自动挂接；否则由工具层调用。
 */
import { textSummary } from '../lib/util.js';

export function createChatEnhance(app) {
  return {
    async beforeSend({ text = '', session = null } = {}) {
      const personality = app.personality.getActive();
      const screen = await app.eye.getScreenContext().catch(() => null);
      const memories = await app.memory.searchMemory(text, 6).catch(() => []);
      const systemPrompt = app.personality.buildSystemPrompt(personality, memories, screen);
      return {
        systemPrompt,
        personality: personality?.id,
        memories: memories.map((m) => ({ id: m.id, type: m.type, summary: m.summary, time: m.time, importance: m.importance, evidence: m.evidence })),
        screen,
        sessionId: session?.id || null,
      };
    },

    async handleCommand(text = '') {
      const input = String(text).trim();
      if (!input) return null;
      let m;

      if (/^(帮助|help|沙币帮助)$/i.test(input)) {
        return { text: helpText(), handled: true };
      }
      if (/^(看屏幕|屏幕|现在屏幕是什么|解释屏幕)$/i.test(input)) {
        const screen = await app.eye.getScreenContext({ force: true });
        if (!screen) return { text: '现在看不到屏幕（可能已暂停、无截屏能力或窗口不在白名单）。', handled: true };
        return { text: formatScreen(screen), handled: true, screen };
      }
      if (/^(发自拍|自拍|拍一张|拍照)/.test(input)) {
        const result = await app.imageApi.generateSelfie({ personality: app.personality.getActive(), scene: '桌面聊天，室内自然光', mood: '轻松' });
        if (!result.ok) return { text: '拍糊了，等会儿再拍。', handled: true, ok: false };
        return { text: result.caption, image: result.images?.[0], handled: true, aiGenerated: true };
      }
      m = input.match(/^记住[:：]?\s*([\s\S]+)$/);
      if (m) {
        const entry = await app.memory.writeMemory({
          type: 'chat', summary: textSummary(m[1], 200), content: m[1], importance: 0.7,
          tags: ['chat'], source: { kind: 'chat' },
        });
        return { text: `记住了。（${entry.id}）`, handled: true, memoryId: entry.id };
      }
      m = input.match(/^忘掉[:：]?\s*([\s\S]+)$/);
      if (m) {
        const found = await app.memory.searchMemory(m[1], 5, { touch: false });
        if (!found.length) return { text: '没有找到相关的记忆。', handled: true };
        for (const f of found) await app.memory.archiveMemory(f.id, 'user-chat-forget').catch(() => {});
        return { text: `已归档 ${found.length} 条相关记忆。`, handled: true, ids: found.map((f) => f.id) };
      }
      if (/^(你记得|还记得|记得什么|回忆一下)/.test(input)) {
        const query = input.replace(/^(你记得|还记得|记得什么|回忆一下)[:：]?/, '').trim() || '最近的事';
        const found = await app.memory.searchMemory(query, 5);
        if (!found.length) return { text: '我这儿暂时没有相关记忆。', handled: true };
        return { text: found.map((f, i) => `${i + 1}. ${f.summary}`).join('\n'), handled: true, memories: found };
      }
      if (/^(学习一个视频|开始自主学习|学一个视频)$/.test(input)) {
        const r = app.study.startNext();
        return { text: r.started ? `开始逐帧学习：${r.item.title}` : `没有开始：${r.reason === 'queue-empty' ? '学习队列是空的' : r.reason}`, handled: true, study: r };
      }
      if (/^(加入学习|学习视频)\s+/.test(input)) {
        const path = input.replace(/^(加入学习|学习视频)\s+/, '').replace(/^["']|["']$/g, '').trim();
        const item = await app.study.add(path);
        return { text: `已加入队列：${item.title}`, handled: true, study: item };
      }
      if (/^(学习队列|自主学习状态|学习状态)$/.test(input)) {
        const st = app.study.getStatus();
        return { text: `队列 ${st.stats.queued} 条，已完成 ${st.stats.done} 条，失败 ${st.stats.failed} 条。`, handled: true, study: st };
      }
      if (/^(看视频学习|开始看视频学习|看屏幕学习)/.test(input)) {
        const title = input.replace(/^(看视频学习|开始看视频学习|看屏幕学习)\s*/, '').trim();
        const result = app.screenStudy.start({ title: title || '屏幕视频学习' });
        return { text: result.ok ? `开始看屏幕了，${result.intervalSec} 秒截一帧。现在播放视频，我会认字幕、记笔记。` : `启动失败：${result.error}`, handled: true, watch: result };
      }
      if (/^(停止看视频学习|停止看屏幕学习)$/.test(input)) {
        const result = await app.screenStudy.stop();
        return { text: result.ok ? `已停止。看了 ${result.frames} 帧，记了 ${result.notes} 组笔记。` : `停止失败：${result.error}`, handled: true, watch: result };
      }
      if (/^(看视频学习状态|看屏幕学习状态|我看到了什么)$/.test(input)) {
        const s = app.screenStudy.getStatus();
        return { text: s.running ? `正在看：${s.title}，已 ${s.frames} 帧，${s.notes} 组笔记。` : '当前没有在看屏幕视频。', handled: true, watch: s };
      }
      if (/^(刷B站|刷b站|看B站|看b站|B站推荐|b站推荐)$/.test(input)) {
        const result = await app.content.bilibiliNext();
        if (!result.ok) return { text: `没能刷到内容：${result.error}`, handled: true };
        return { text: `B 站这条不错：${result.pick.title}\n${result.pick.url}`, handled: true, content: result };
      }
      if (/^(学B站|学b站|学习B站)\s+/.test(input)) {
        const target = input.replace(/^(学B站|学b站|学习B站)\s+/, '').trim();
        const result = await app.content.bilibiliLearn(target);
        return { text: result.ok ? `学完了：${result.title}，记了 ${result.notes?.length || 0} 条。` : `学习失败：${result.error}`, handled: true, content: result };
      }
      if (/^(看小说|读小说)\s+/.test(input)) {
        const url = input.replace(/^(看小说|读小说)\s+/, '').trim();
        const result = await app.content.novelOpen(url);
        if (!result.ok) return { text: `没能打开：${result.error}`, handled: true };
        return { text: `《${result.title}》已打开，${result.paragraphs.length} 段。\n${result.paragraphs.slice(0, 2).join('\n')}`, handled: true, content: result };
      }
      if (/^(下一章|翻页|继续读)$/.test(input)) {
        const result = await app.content.novelNext();
        return { text: result.ok ? `${result.title}\n${(result.paragraphs || []).slice(0, 2).join('\n')}` : `翻页失败：${result.error}`, handled: true, content: result };
      }
      m = input.match(/^分析视频[:：]?\s*(\S.+)$/);
      if (m) {
        const entry = await app.video.registerVideo(m[1].trim());
        app.video.run(entry.videoId, { mode: 'hybrid' }).catch(() => {});
        return { text: `开始分析：${entry.title}（${entry.videoId}）。完成后我会告诉你。`, handled: true, videoId: entry.videoId };
      }
      m = input.match(/^(切换人格|人格)[:：]?\s*([\s\S]+)$/);
      if (m) {
        const p = await app.personality.setActive(m[2].trim());
        return { text: `已切换到「${p.name}」人格。`, handled: true, personality: p.id };
      }
      if (/^(停止自主|关闭自主)/.test(input)) {
        app.autonomy.stopLoop();
        return { text: '自主循环已停止。', handled: true };
      }
      if (/^(开始自主|开启自主)/.test(input)) {
        const r = await app.autonomy.startLoop({ enabled: true });
        return { text: r.running ? '自主循环已启动。' : `没有启动：${r.reason}`, handled: true };
      }
      return null;
    },
  };
}

export function registerChatEnhance(app, ctx) {
  const disposers = [];
  const hooks = app.chatEnhance;
  let chat = null;
  try {
    chat = typeof ctx.get === 'function' ? ctx.get('chat', false) : ctx.chat;
  } catch {
    chat = null;
  }
  try {
    if (typeof chat?.onBeforeSend === 'function') {
      disposers.push(chat.onBeforeSend(async (payload) => hooks.beforeSend(payload)));
    } else if (typeof chat?.beforeSend === 'function') {
      disposers.push(chat.beforeSend(async (payload) => hooks.beforeSend(payload)));
    } else if (typeof ctx.on === 'function') {
      const handler = async (payload) => hooks.beforeSend(payload);
      ctx.on('chat:before-send', handler);
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          try { ctx.off?.('chat:before-send', handler); } catch { /* ignore */ }
        });
      }
    }
  } catch {
    // 宿主聊天钩子形状不匹配时静默降级，工具层仍可使用
  }
  // 命令入口暴露给宿主/工具/HTTP
  app.commands = {
    handle: (text) => hooks.handleCommand(text),
    beforeSend: (payload) => hooks.beforeSend(payload),
  };
  return disposers;
}

function formatScreen(screen) {
  const elements = (screen.elements || []).slice(0, 10).map((e) => `- ${e.type}：${e.label}`).join('\n');
  return [
    `应用：${screen.app}`,
    `窗口：${screen.window}`,
    screen.scene ? `场景：${screen.scene}` : '',
    screen.text ? `文字摘要：${textSummary(screen.text, 600)}` : '',
    elements ? `可见元素：\n${elements}` : '',
    screen.degraded ? '（视觉理解降级）' : '',
  ].filter(Boolean).join('\n');
}

function helpText() {
  return [
    '沙币可用命令：',
    '· 看屏幕 —— 解释当前屏幕（桌面端）',
    '· 发自拍 —— 生成一张 AI 自拍',
    '· 记住：<内容> —— 写入长期记忆',
    '· 你记得什么 / 还记得… —— 检索记忆',
    '· 忘掉：<关键词> —— 归档相关记忆',
    '· 分析视频 <路径或URL> —— 完整分析视频',
    '· 学习一个视频 —— 从学习队列里挑一条逐帧学',
    '· 加入学习 <文件路径> —— 放进自主学习队列',
    '· 看视频学习 [主题] —— 眼睛看你正在播放的视频，自己记笔记',
    '· 停止看视频学习 —— 结束并生成学习记录',
    '· 刷B站 —— 从推荐里挑一条',
    '· 学B站 <BV号或链接> —— 字幕学习并写记忆',
    '· 看小说 <链接> —— 打开小说并阅读',
    '· 下一章 —— 继续读当前小说',
    '· 切换人格 <名称> —— 切换人格',
    '· 开始自主 / 停止自主 —— 控制自主循环',
  ].join('\n');
}

export { formatScreen, helpText };

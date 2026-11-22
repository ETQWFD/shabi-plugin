import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeApp } from './helpers.js';
import { writeFileAtomic } from '../lib/ioshb.js';

async function writeVideoArtifacts(app, videoId) {
  const dir = path.join(app.paths.video, videoId);
  await fs.mkdir(dir, { recursive: true });
  const base = { format: 'IOSHB1', version: 1, videoId };
  await writeFileAtomic(path.join(dir, 'frame_index.ioshb'), {
    ...base,
    frames: [
      { frameNo: 1, file: 'frames/1.jpg', t: 0, pts: 0 },
      { frameNo: 2, file: 'frames/2.jpg', t: 1, pts: 1 },
    ],
  });
  await writeFileAtomic(path.join(dir, 'frame_analysis.ioshb'), {
    ...base,
    frames: [
      { frameNo: 1, t: 0, scene: '设置界面', objects: ['设置面板'], actions: ['点击'], ocr: ['打开设置'], confidence: 0.8 },
      { frameNo: 2, t: 1, scene: '亮度滑块', objects: ['滑块'], actions: ['拖动'], ocr: ['亮度 50%'], confidence: 0.85 },
    ],
  });
  const spoken = [
    '首先打开设置。',
    '然后把亮度调到百分之五十。',
    '这个设置很重要。',
    '例如夜间模式可以减少眩光。',
  ];
  await writeFileAtomic(path.join(dir, 'transcript.ioshb'), {
    ...base,
    segments: spoken.map((text, i) => ({ start: i, end: i + 1, text, confidence: 0.9 })),
  });
  await writeFileAtomic(path.join(dir, 'segments.ioshb'), {
    ...base,
    segments: spoken.map((text, i) => ({
      start: i, end: i + 1, speechText: text,
      visualSummary: i === 0 ? '用户打开设置界面' : '设置项被调整',
      objects: ['设置面板'], actions: ['点击'],
    })),
  });
  await writeFileAtomic(path.join(dir, 'scenes.ioshb'), {
    ...base, scenes: [{ id: 's1', start: 0, end: 4, keyFrame: 0 }],
  });
  await writeFileAtomic(path.join(dir, 'events.ioshb'), {
    ...base, events: [{ id: 'e1', start: 0, end: 1, type: 'action', label: '打开设置' }],
  });
  await writeFileAtomic(path.join(dir, 'video_summary.ioshb'), {
    ...base, summary: '演示如何打开设置并调整亮度。',
  });
}

test('知识抽取：证据完整、置信度评分、写记忆、图谱与索引', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'knowledge' });
  try {
    await writeVideoArtifacts(app, 'vid-k1');
    const result = await app.knowledge.extractKnowledge('vid-k1');
    assert.ok(result.items.length >= 2, '至少抽取两条知识');
    for (const item of result.items) {
      assert.ok(item.evidence.length >= 1, '每条知识必须有证据');
      assert.equal(item.evidence[0].videoId, 'vid-k1');
      assert.equal(typeof item.evidence[0].start, 'number');
      assert.equal(typeof item.evidence[0].end, 'number');
      assert.ok(item.confidence > 0 && item.confidence <= 1, '置信度必须在 (0,1]');
      const formula = 0.3 * Math.min(1, new Set(item.evidence.map((e) => e.videoId)).size / 2)
        + 0.3 * item.visualSupport + 0.2 * item.transcriptConfidence + 0.2 * (1 - (item.conflict ? 0.5 : 0));
      assert.ok(Math.abs(item.confidence - formula) < 0.051, '置信度应符合公式');
    }
    assert.ok(result.written.length >= 2, '应写入知识记忆');
    assert.ok(result.written.every((x) => x.memoryId), '索引必须保留 memoryId');

    const memories = await app.memory.searchMemory('设置', 10, { filter: (e) => e.type === 'knowledge' });
    assert.ok(memories.length >= 2, '知识应写入长期记忆');
    assert.ok(memories.every((m) => Array.isArray(m.evidence) && m.evidence.length > 0), '记忆保留证据');

    const graph = app.knowledge.getGraph();
    assert.ok(graph.nodes.length >= 1, '应生成知识图谱节点');
    assert.ok(app.knowledge.getStats().items >= 2);

    const record = result.written[0];
    const detail = await app.knowledge.getKnowledge(record.knowledgeId);
    assert.ok(detail?.item, '应可按 knowledgeId 回看知识原文与证据');
    assert.equal(detail.videoId, 'vid-k1');
    assert.ok(Array.isArray(detail.item.evidence) && detail.item.evidence.length > 0);
  } finally {
    await cleanup();
  }
});

test('知识去重：cosine>0.9 合并并保留多来源证据，冲突标记', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'knowledge-dedupe' });
  try {
    const items = app.knowledge.structureKnowledge([
      { type: 'fact', content: '把屏幕亮度调到百分之五十，然后保存设置。', start: 0, end: 1, visualSupport: 0.7, transcriptConfidence: 0.9, evidence: [{ videoId: 'a', start: 0, end: 1 }] },
      { type: 'opinion', content: '把屏幕亮度调到百分之五十，然后保存设置。', start: 2, end: 3, visualSupport: 0.8, transcriptConfidence: 0.9, evidence: [{ videoId: 'b', start: 2, end: 3 }] },
      { type: 'fact', content: '夜间模式可以减少眩光。', start: 4, end: 5, visualSupport: 0.6, transcriptConfidence: 0.8, evidence: [{ videoId: 'c', start: 4, end: 5 }] },
    ]);
    const merged = await app.knowledge.dedupeMerge(items);
    assert.equal(merged.length, 2, '余弦相同的内容合并，不同内容保留');
    const same = merged.find((x) => x.content.includes('百分之五十'));
    assert.ok(same);
    assert.equal(new Set(same.evidence.map((e) => e.videoId)).size, 2, '合并后保留两个来源证据');
    assert.ok(same.conflict && same.content.includes('另有说法'), '类型/语义冲突应被标记');
    assert.ok(app.knowledge.scoreConfidence(same) > app.knowledge.scoreConfidence(items[0]));
  } finally {
    await cleanup();
  }
});

test('writeKnowledge 未评分时不崩溃，并补齐 memoryId', async () => {
  const { app, cleanup } = await makeApp({ prefix: 'knowledge-write' });
  try {
    const item = app.knowledge.structureKnowledge([
      { type: 'concept', content: 'IOSHB 是一种本地存储格式。', start: 0, end: 2, entities: ['IOSHB'] },
    ])[0];
    const record = await app.knowledge.writeKnowledge(item, { videoId: 'vid-w' });
    assert.ok(record.memoryId);
    assert.equal(record.confidence, 0);
  } finally {
    await cleanup();
  }
});

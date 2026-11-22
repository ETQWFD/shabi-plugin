import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeApp } from './helpers.js';

async function makeSampleVideo(dir) {
  const video = path.join(dir, 'sample.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-shortest', video,
  ], { timeout: 60000 });
  await fs.writeFile(`${video.slice(0, -4)}.srt`, '1\n00:00:00,000 --> 00:00:04,000\n这是一个四秒测试视频。\n', 'utf8');
  return video;
}

test('视频完整看：真实 FFmpeg 解码、每秒时间轴、场景/事件/摘要与断点状态', async () => {
  const { app, dir, cleanup } = await makeApp({
    prefix: 'video',
    config: { video: { analysisWidth: 320, frameQuality: 5, maxFrames: 5000, maxVideoSeconds: 30 } },
  });
  try {
    const video = await makeSampleVideo(dir);
    const entry = await app.video.registerVideo(video);
    assert.ok(entry.videoId);
    assert.ok(Math.abs(entry.duration - 4) < 0.2, `时长约 4s，实际 ${entry.duration}`);
    assert.equal(entry.hasAudio, true);
    assert.ok(entry.fps >= 24 && entry.fps <= 26);

    const done = await app.video.run(entry.videoId);
    assert.equal(done.status, 'done');
    assert.ok(done.coverage >= 0.999, `覆盖率应 >=99.9%，实际 ${done.coverage}`);
    assert.ok(done.completeness?.ok, '完整性报告应通过');

    const artifacts = await app.video.readArtifacts(entry.videoId);
    assert.ok(artifacts?.frames.length > 0, '应抽到帧');
    assert.ok(artifacts.analysisFrames.length > 0, '应有逐帧理解');
    assert.ok(artifacts.transcript?.segments.length >= 1, '字幕应被解析');
    assert.equal(artifacts.segments?.segments.length, 4, '4 秒视频应有 4 个每秒 segment');
    for (let i = 0; i < 4; i += 1) {
      const seg = artifacts.segments.segments[i];
      assert.ok(seg, `缺少第 ${i} 秒 segment`);
      assert.ok(seg.start <= i + 0.01 && seg.end >= i + 0.99, 'segment 必须覆盖整秒');
      assert.ok(seg.frameNos.length >= 1, '每秒 segment 至少关联一帧');
    }
    assert.ok(artifacts.scenes?.scenes.length >= 1, '应切分场景');
    assert.ok(artifacts.scenes.scenes.every((s) => s.keyframes.length >= 1), '每个场景至少一个关键帧');
    assert.ok(artifacts.summary?.summary, '应生成视频摘要');

    const report = artifacts.completeness;
    const coverageCheck = report.checks.find((c) => c.id === 'coverage');
    const maxGap = report.checks.find((c) => c.id === 'max-gap');
    const segmentCheck = report.checks.find((c) => c.id === 'segment-per-second');
    assert.equal(coverageCheck.ok, true, '覆盖率检查通过');
    assert.equal(maxGap.ok, true, '最大空洞 <=1s');
    assert.equal(segmentCheck.ok, true, '每秒 segment 检查通过');

    const resume = await app.video.resumeFromCursor(entry.videoId);
    assert.equal(resume.canResume, true);
    assert.equal(resume.stage, 'done');
    assert.equal(resume.frames, artifacts.frames.length);

    const status = await app.video.getStatus(entry.videoId);
    assert.equal(status.status, 'done');
    assert.equal(status.videoId, entry.videoId);
  } finally {
    await cleanup();
  }
});

# 架构

```
DSH / Cordis
   └── main.js  apply(ctx, config)
         ├── lib/config.js    默认配置 + settings.json + env + 加密 secrets
         ├── lib/host.js      宿主能力总线（screen/vision/llm/media/ui/chat/http/secrets/accounts/content/input）
         ├── lib/ioshb.js     IOSHB1 编解码 + 原子写 + .bak 恢复
         ├── lib/cryptoBox.js AES-256-GCM
         ├── lib/logger.js    JSONL + 轮转 + 脱敏 + ActionLog
         ├── core/*           业务模块，只依赖 app（config/paths/host/logger/...）
         └── ui/*             设置页 + 聊天增强
```

## 设计原则

1. **业务与宿主解耦**：core 模块不直接假设 DSH 服务名，统一走 `host`。能力缺失时返回 `null`/降级并写日志。
2. **安全默认拒绝**：文件路径先 `realpath` 归一化；受保护文件禁止写；无确认界面时高风险默认拒绝。
3. **可恢复**：IOSHB 原子写 + `.bak`；动作审计带备份指针；记忆删除重写空分卷，避免重启复活。
4. **隐私优先**：截图默认不落盘；记忆内容加密；日志脱敏；QQ 端默认不读屏幕。
5. **可验证**：`verifyCompleteness` 对覆盖率、最大空洞、逐帧理解比例、每秒 segment、场景关键帧、字幕边界逐项检查；失败自动补抽/补分析再校验。

## 一次自主 tick

```
eye.getScreenContext()
  → memory.recallByScene(screen)
  → 周期性 memory.resurfaceMemory()
  → decision.decide(screen, memories, goals, personality)
  → decision.validateDecision()
  → safety.confirmAction()（非 low 风险）
  → safety.verifyToken()
  → execute 白名单动作
  → safety.logAction()
  → 冷却 / 计数持久化
```

## 视频流水线

```
registerVideo → ffprobe → pending
decodeAndExtract → decoding → frame_index + frames/
analyzeFrames → analyzing → frame_analysis
transcribeAudio → transcript（字幕优先，ASR 兜底）
alignTimeline → segments（每秒至少一个，容差 ±200ms）
segmentScenes → scenes（场景关键帧）
extractEvents → events
verifyCompleteness → 覆盖率/空洞/逐帧/每秒/关键帧/字幕
summarizeVideo → video_summary
done
```

断点：`stage` + `cursor` 持久化到 `video_registry.ioshb`；重新 `run` 从当前 stage 继续，解码阶段会清理下游产物。

## 知识置信度

```
sourceScore = min(1, 独立来源数 / 2)
visualScore = 画面证据
transcriptScore = 转写置信
consistency = 1 - 冲突惩罚
confidence = 0.3*sourceScore + 0.3*visualScore + 0.2*transcriptScore + 0.2*consistency
```

跨视频验证：相似内容出现在 ≥2 个独立视频，`+0.05` 并标 `crossValidated`。

## 记忆衰减

```
forgetScore = importance*0.5 + exp(-Δdays/halfLife)*0.3 + accessNorm*0.2
τ = clamp(tauBase*(0.5+importance*1.5), tauBase, tauMax)
strength *= exp(-Δdays/τ)
```

低于 `strengthThreshold` 或 `forgetThreshold` → `archive/archive_N.ioshb`；`resurfaceMemory` 命中后提升 importance/strength、加 `resurfaced` 标签并移回主库。

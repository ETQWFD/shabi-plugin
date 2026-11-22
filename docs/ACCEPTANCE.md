# 验收清单

## 眼睛
- [x] 定时/手动截屏，5s/30s/60s 可配
- [x] OCR + 视觉理解，结构化 `{app, window, text, scene, elements, timestamp}`
- [x] 暂停、窗口白名单、敏感区域模糊、截图默认不落盘
- [x] 截屏失败返回 null、写日志、连续失败退避，不崩溃

## 视频
- [x] 本地文件/URL/用户会话来源登记
- [x] `pending → decoding → analyzing → done/failed`，失败最多 3 次
- [x] frame/keyframe/hybrid 三种抽帧
- [x] 逐帧视觉理解、ASR/字幕、1 秒级 segment、场景/事件
- [x] 覆盖率 ≥99.9%、最大空洞 ≤1s、逐帧理解 ≥99%、场景关键帧
- [x] 断点续看、空洞补抽、完整性报告与自动重跑
- [x] 测试视频实测：6s/25fps，18 帧，覆盖率 100%，6 个 segment，7 项检查全通过

## 知识
- [x] 概念/步骤/事实/观点/数据/示例
- [x] evidence 指向 videoId/start/end
- [x] cosine>0.9 去重合并、冲突标记
- [x] 置信度公式、跨视频验证
- [x] 写入 `type=knowledge` 记忆，可回看证据
- [x] 知识图谱节点/边/中心度

## 记忆
- [x] IOSHB1 分卷/索引/archive，原子写 + CRC + `.bak`
- [x] 字段完整（id/time/type/summary/content/importance/lastAccess/accessCount/tags/emotion/source/evidence/strength/version/checksum）
- [x] 遗忘分/衰减/归档/巩固/压缩/唤醒
- [x] INI 导出从 `[memory 1]` 开始
- [x] 删除最后一条后重启不复活
- [x] 内容加密，磁盘无明文

## 人格
- [x] 5 个内置人格
- [x] 自定义新增/编辑/删除/切换
- [x] 人格影响提示词与主动程度
- [x] 硬约束不可被自定义人格覆盖

## 图片/QQ/自主
- [x] 图片 API 测试、成功发图、失败固定文案、AI 标注
- [x] QQ Webhook 验签 / WebSocket / 去重 / 限频 / @ 回复
- [x] 自主循环开关、限额、冷却、安静时段、二次确认
- [x] 兴趣画像、epsilon-greedy/UCB、反馈闭环、风控停止

## 工程
- [x] `node --check` 全量通过
- [x] `node main.js selfcheck` 通过（独立模式 HTTP 路由为提示）
- [x] 设置页 12 组字段保存/读取
- [x] `dsh.bundle.patch`、`engines.dsh >=0.2.0`、纯 ESM、无 `prepare`
- [x] GitHub 仓库创建与推送：<https://github.com/ETQWFD/shabi-plugin>（`main`）
- [x] 真实 DSH 0.2.2-rc.5 profile：本地路径 `add` 成功，`--dump-config` 出现 `id: shabi` 组合包层
- [x] 真实 DSH headless 启动：插件挂载与卸载正常；dummy API key 仅导致模型 401
- [x] 全量测试 25/25 通过（含真实 FFmpeg 视频与 QQ 验签）

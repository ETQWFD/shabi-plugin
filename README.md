# 沙币（shabi-plugin）

> 带眼睛、长期记忆、人格、自主循环、AI 自拍与 QQ 官方机器人的 DSH 桌面插件。

沙币运行在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/dsh) 的 Cordis 插件体系中。所有业务能力都通过统一的 `host` 能力总线访问宿主；缺少截屏、视觉或媒体能力时会降级，不会让宿主崩溃。

## 功能

| 模块 | 说明 |
| --- | --- |
| 眼睛 | 定时截屏、OCR、视觉理解，输出 `{app, window, text, scene, elements, timestamp}`；支持暂停、窗口白名单、敏感区域模糊、失败退避。 |
| 视频完整看 | 0–2 分钟视频逐帧/关键帧/混合抽帧，FFmpeg 解码，逐帧视觉理解，ASR/字幕，1 秒级时间轴，场景/事件，覆盖率 ≥99.9%，断点续看。 |
| 知识 | 从时间轴、画面文字抽取概念/步骤/事实/观点/数据/示例；向量去重、冲突标记、置信度评分、跨视频验证、知识图谱。 |
| 长期记忆 | IOSHB1 分卷、AES-256-GCM、遗忘曲线、归档/压缩/“突然记起来”、INI 导出。 |
| 人格 | 内置傲娇/温柔/毒舌/冷静/元气，支持自定义；人格不能覆盖安全硬约束。 |
| 自主循环 | 感知 → 记忆 → 决策 → 白名单动作 → 审计 → 冷却；每日/每小时上限、安静时段、二次确认。 |
| 兴趣选片 | 观看/收藏/聊天/知识构建偏好，兴趣 + 新鲜度 + 多样性 + epsilon-greedy/UCB。 |
| 桌面协助 | 解释当前屏幕、提醒待办、引用记忆、知识回馈。 |
| AI 自拍 | OpenAI 兼容 / 通用 JSON / SD WebUI，4 张人物参考图，失败固定“拍糊了，等会儿再拍。”，成功标注“（AI 生成）”。 |
| QQ 官方机器人 | Webhook（Ed25519 验签）/ WebSocket，@ 消息去重、限频、复用记忆与人格；不实现个人号自动化。 |
| 安全 | 文件/应用白名单、危险动作二次确认、动作审计、备份回滚、日志脱敏、记忆加密。 |

## 安装

### 从 GitHub 安装（仓库发布后）

```bash
# 先安装官方 DSH CLI
npm install -g @deepseek-ai/dsh

# 添加插件（把 <profile> 换成你的 profile 名称，如 tui）
dsh plugin --profile <profile> add github:ETQWFD/shabi-plugin

# 验证组合包层
dsh --profile <profile> --dump-config
```

安装后应能在 `--dump-config` 中看到类似：

```yaml
# == shabi-plugin
- id: shabi
  name: shabi-plugin
```

> 如果宿主提示“这个包没有声明组合包”，请确认 `package.json` 中有 `dsh.bundle.patch`，且 `engines.dsh` 为 `>=0.2.0`。本仓库已经声明；git 安装不会执行 `prepare`，项目保持纯 JS/ESM。

### 从本地目录安装（开发/未发布时）

```bash
dsh plugin --profile <profile> add /绝对路径/shabi-plugin
dsh --profile <profile> --dump-config
```

### 独立设置页（无 DSH 时）

```bash
cd shabi-plugin
npm start
# 打开 http://127.0.0.1:3579/shabi/settings
```

独立模式只用于查看/保存配置、测试 API；截屏、LLM、知识抽取等完整能力需要 DSH 宿主提供对应服务。

## 依赖与权限

- Node.js **>=22**（使用全局 `fetch`、`WebSocket`）。
- `ffmpeg` / `ffprobe` 在 `PATH` 中，或在设置里填写绝对路径。
- 可选：Tesseract（OCR）、Whisper/faster-whisper（ASR）。没有时自动降级。
- 插件**没有 npm 运行时依赖**，不需要 `npm install`。

权限边界：

1. **截屏**：默认不落盘，只处理内存中的临时图；可暂停、限定窗口、模糊敏感区域。
2. **文件**：只允许插件目录、插件 `dataDir` 和设置中的 `safety.allowedDirs`；记忆库、索引、主密钥、secrets、`.git`、`package.json`、`main.js` 等受保护文件禁止写入/删除。
3. **鼠标键盘**：只允许 `safety.appAllowlist` 中的应用或沙币窗口；高风险输入必须二次确认。
4. **网络**：只访问用户配置的 LLM/图片 API/QQ 官方 API；不内置遥测。
5. **账号**：由用户本人登录并授权；插件不代登录、不保存密码、不读取未授权会话。

## 账号授权

在设置页“账号授权”中，逐平台点击“检查会话”：

- 检查是**只读**的，只调用宿主 `accounts.check`，不会打开网页、不会发消息。
- `authorized=false` 时，视频观看/兴趣选片不会操作该平台。
- 遇到验证码、风控提示、平台限制或规则不允许时，立即停止并提示用户；插件不实现反检测、不绕过限制。
- 不批量私信、不评论骚扰、不刷量；自主行为有频率上限和安静时段。

## 配置

- `config/default.json`：默认配置（会被 `settings.json` 覆盖）。
- `settings.json`：设置页保存的非密钥配置（首次保存后生成）。
- `secrets.ioshb`：`llm.apiKey`、`imageApi.apiKey`、`qqBot.appSecret`、`qqBot.token` 的加密存储。
- `master.key`：AES-256-GCM 主密钥（0600）。优先级：`SHABI_MASTER_KEY` → 本地 `master.key`。
- 环境变量（可选）：
  - `SHABI_LLM_ENDPOINT` / `SHABI_LLM_API_KEY` / `SHABI_LLM_MODEL`
  - `SHABI_IMAGE_ENDPOINT` / `SHABI_IMAGE_API_KEY`
  - `SHABI_CAPTURE_COMMAND` / `SHABI_ASR_COMMAND`
  - `SHABI_MASTER_KEY`（32 字节 base64/hex）

设置页覆盖：截屏频率/范围、隐私、视频抽帧/覆盖率/分块、自主开关/频率/上限/冷却、人格、图片 API + 测试、记忆管理、安全白名单、QQ 机器人、账号状态、模型、日志。

## 数据格式 IOSHB1

```
偏移  长度  内容
0     6     "IOSHB1"
6     1     version (1)
7     1     flags (1=deflateRaw)
8     4     rawLength (uint32 BE)
12    4     payloadLength (uint32 BE)
16    4     crc32 (uint32 BE, 未压缩 JSON)
20    ...   deflateRaw(JSON)
```

写入：临时文件 → `fsync` → 旧文件 `.bak` → `rename` 原子替换。读取校验 magic/长度/CRC；损坏时回退 `.bak`。记忆内容字段在写入前用 AES-256-GCM 加密，密文前缀 `enc:v1:`。

## 命令

桌面聊天中可用：

- `帮助`
- `看屏幕`
- `发自拍`
- `记住 <内容>` / `忘掉 <关键词>` / `你记得什么`
- `分析视频 <路径或URL>`
- `切换人格 <名称>`
- `开始自主` / `停止自主`
- `状态`

DSH Agent 工具：`shabi_screen`、`shabi_memory_search`、`shabi_memory_write`、`shabi_selfie`、`shabi_video_analyze`、`shabi_video_status`、`shabi_personality`、`shabi_goal`、`shabi_status`。

## 测试与自检

```bash
npm test                 # node:test，单元/集成测试
node main.js selfcheck   # 不需要宿主：配置、IOSHB、记忆、人格、安全、ffmpeg
node main.js video /path/to/video.mp4 hybrid
```

测试覆盖：IOSHB 往返/CRC/备份恢复、记忆写读/遗忘/归档/唤醒/压缩/INI/删除不复活、人格与硬约束、安全路径/确认 token/回滚、知识抽取/证据/去重、真实 FFmpeg 视频覆盖率/每秒 segment/断点、图片 API 成功/失败/AI 标注、QQ 验签/去重/限频、自主循环冷却/限额、兴趣反馈/风控停止、眼睛隐私/降级。

## 目录

```
shabi-plugin/
├── manifest.json
├── main.js
├── package.json
├── cordis.patch.yml
├── config/
│   ├── default.json
│   ├── personality.json
│   └── settings.schema.json
├── core/
│   ├── eye.js              # 眼睛
│   ├── videoAnalyzer.js    # 视频完整看
│   ├── knowledge.js        # 知识抽取/图谱
│   ├── memory.js           # 长期记忆
│   ├── personality.js      # 人格
│   ├── autonomy.js         # 自主循环
│   ├── decision.js         # 规则+LLM 决策
│   ├── imageApi.js         # AI 自拍
│   ├── qqBot.js            # QQ 官方机器人
│   ├── safety.js           # 安全护栏
│   └── interest.js         # 兴趣选片
├── lib/                    # 宿主适配/配置/IOSHB/日志/加密/工具
├── ui/                     # 设置页与聊天增强
├── scripts/                # selfcheck / dev-server
├── tests/                  # node:test
├── docs/                   # 架构、安全、验收
├── memory/                 # 运行时生成（.gitkeep 占位）
├── logs/                   # 运行时生成（.gitkeep 占位）
└── README.md
```

运行时还会生成 `frames/`、`video/`、`selfies/`、`backups/`、`knowledge/`、`settings.json`、`secrets.ioshb`、`master.key`、各类 `*.ioshb`。这些都在 `.gitignore` 中，不会提交。

## 合规说明

- 仅使用 **QQ 官方机器人平台**（Webhook/WebSocket）；不接入个人号，不实现个人号自动化。
- 账号由用户本人登录并授权；插件不代登录、不保存密码。
- 不骚扰其他用户，不批量私信、评论、刷量；自主行为频率接近正常用户，有每日/每小时上限、随机抖动、安静时段。
- 遇到验证码、风控提示、平台限制或规则不允许时立即停止并提示用户；**不实现反检测、不绕过平台限制**。
- AI 自拍一律标注“AI 生成”，不冒充真人；参考图必须由用户提供且有权使用。
- 屏幕、记忆、聊天默认本地处理；日志脱敏；记忆内容加密。

## 已知限制

- 设置页需要宿主提供 HTTP 路由（`ctx.http`/`ctx.webServer`/`ctx.server` 等）。若宿主没有，使用 `npm start` 的独立设置页。
- QQ 图片回复需要 `qqBot.publicBaseUrl` 提供公网可访问 URL；没有公网时只回文字。
- DSH 各版本的宿主服务名可能不同；`lib/host.js` 做了多形态适配，但完整截屏/视觉/输入能力仍取决于宿主实际提供的服务。
- 视频分析使用本机 FFmpeg；长视频受 `video.maxVideoSeconds`（默认 120 秒）限制，这是规格要求。

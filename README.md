# 沙币（shabi-plugin）

> 带眼睛、长期记忆、人格、平台自主学习（B站/抖音/快手视频、公版小说）、逐帧视频学习与 QQ 官方机器人的 DSH 插件。

沙币运行在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/dsh) 的 Cordis 插件体系中。所有业务能力都通过统一的 `host` 能力总线访问宿主；缺少截屏、视觉或媒体能力时会降级，不会让宿主崩溃。

## 功能

| 模块 | 说明 |
| --- | --- |
| 眼睛 | 定时截屏、OCR、视觉理解，输出 `{app, window, text, scene, elements, timestamp}`；宿主没有 `screen.capture` 时自动探测 Linux/macOS/Windows 本机截屏，OCR 自动探测 Tesseract；支持暂停、窗口白名单、敏感区域模糊、失败退避。 |
| 视频完整看 | 最长 30 分钟视频逐帧/关键帧/混合抽帧，FFmpeg 解码，逐帧视觉理解，ASR/字幕，1 秒级时间轴，场景/事件，覆盖率 ≥99.9%，断点续看。 |
| 知识 | 从时间轴、画面文字抽取概念/步骤/事实/观点/数据/示例；向量去重、冲突标记、置信度评分、跨视频验证、知识图谱。 |
| 长期记忆 | IOSHB1 分卷、AES-256-GCM、遗忘曲线、归档/压缩/“突然记起来”、INI 导出。 |
| 人格 | 内置傲娇/温柔/毒舌/冷静/元气，支持自定义；人格不能覆盖安全硬约束。 |
| 自主循环 | 感知 → 记忆 → 决策 → 白名单动作 → 审计 → 冷却；每日/每小时上限、安静时段、二次确认。 |
| 兴趣选片 | 观看/收藏/聊天/知识构建偏好，兴趣 + 新鲜度 + 多样性 + epsilon-greedy/UCB。 |
| 看视频学习 | 你播放 B 站/课程视频，眼睛逐帧截取画面、视觉理解、写知识笔记；视觉模型不可用时才 OCR 兜底。 |
| 自主学习队列 | 本地视频放学习目录，空闲时自动逐帧学习；覆盖率/置信度不达标会在上限内重学；写笔记与长期记忆。 |
| 空闲陪伴 | 空闲时自己搜索并看平台视频；QQ 主动消息仅 C2C、每日/间隔/安静时段限额；连续 6 条未回后只再发 1 条，然后进入 away 模式继续自己看视频/读小说。 |
| 内容源 | B 站公开搜索/详情/字幕/下载；抖音、快手支持直接链接（抖音需登录 Cookie 才能搜索，快手有 Cookie 时可尝试）；公版中文小说目录检索与阅读。 |
| 桌面协助 | 解释当前屏幕、提醒待办、引用记忆、知识回馈。 |
| AI 自拍 | OpenAI 兼容 / 通用 JSON / SD WebUI，4 张人物参考图，失败固定“拍糊了，等会儿再拍。”，成功标注“（AI 生成）”。 |
| QQ 官方机器人 | Webhook（Ed25519 验签）/ WebSocket，@ 消息去重、限频、复用记忆与人格；不实现个人号自动化。 |
| 平台自主学习 | 按兴趣画像选主题 → 平台搜索 → 下载/逐帧观看 → 总结知识点写长期记忆并收藏；连续看 3 条休息 20 分钟，休息时读小说。 |
| 安全 | 文件/应用白名单、危险动作二次确认、动作审计、备份回滚、日志脱敏、记忆加密。 |

> 当前版本：`1.4.0`。新增平台自主学习、公版小说检索、六条未回后的最后一条与 away 模式、收藏夹与插件属性彩蛋；视频默认不调用模型摘要，加载后按规则直接执行。历史版本：v1.3.3 主动 QQ 默认开启；v1.3.2 修正版本号读取；v1.3.1 修正学习目录路径显示；v1.3.0 新增空闲陪伴与本地学习队列。

## 安装

### 从 GitHub 安装（仓库发布后）

```bash
# 先安装官方 DSH CLI
npm install -g @deepseek-ai/dsh

# 添加插件（把 <profile> 换成你的 profile 名称，如 web / tui）
dsh plugin --profile web add github:ETQWFD/shabi-plugin#v1.4.0

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

### 在 DSH Web 中打开设置

安装并启动 `web` profile 后，有两种入口：

1. **DSH 设置页**：左下角账号菜单 → **Settings** → 左侧 **沙币**。
2. **页面右下角悬浮按钮**：**沙币设置**；或直接访问 `http://127.0.0.1:<端口>/shabi/settings`。

设置页会加载完整 schema（眼睛、视频、B 站/小说/学习、自主、人格、自拍、记忆、安全、隐私、QQ、账号、模型、高级）。POST 保存走 `/shabi/api/settings`，立即生效；`dataDir` 修改需重启。

### 让 AI 自己看视频 / 读小说

默认 **平台自主学习** 已开启。插件空闲时会：

1. 从长期记忆、兴趣画像或你填写的“想看的主题”生成搜索词；
2. 先 B 站公开搜索，找不到再尝试抖音/快手（这两个平台通常需要你在设置页填 Cookie，或直接给视频链接）；
3. 下载视频并用 FFmpeg 逐帧观看，提取字幕/简介/画面要点；
4. 每看完一条就写知识笔记、长期记忆，并保存到本地收藏夹 `~/.dsh/shabi/content/favorites.json`；
5. 连续看 3 条后自动休息 20 分钟，休息时从公版中文小说目录（三国演义/西游记/水浒传/红楼梦/聊斋志异）挑一本、翻一章并写读书笔记；休息结束自动继续。

聊天命令：

- `自己去看视频` / `开始自主观看`：立即按兴趣搜索并看一条；
- `平台学习状态`：今天看了多少、什么时候休息；
- `收藏夹`：看看保存了哪些内容；
- `找小说 西游记` / `看小说`：搜索并打开公版小说；
- `学B站 BV号或链接`：下载完整看完、总结并写记忆。

设置页 **沙币 → 平台自主学习** 可调平台顺序、主题、每天上限、看几条休息、休息时长、单条视频上限、是否自动收藏、是否休息时读小说。B 站账号收藏夹需要 Cookie 含 `bili_jct`；失败只影响账号收藏，本地收藏不受影响。

> 边界：不代登录、不绕过验证码/平台限制、不批量骚扰他人；抖音/快手搜索接口需要登录态，没有 Cookie 时直接给视频链接最稳。插件不会安装 `yt-dlp` 或修改系统软件。

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

独立模式只用于查看/保存配置、测试 API；截屏、LLM、知识抽取等完整能力在 DSH Web profile 中启用。`web` profile 的真实路由和设置 section 已在 DSH `0.2.2-rc.5` 验证。

## 依赖与权限

- Node.js **>=22**（使用全局 `fetch`、`WebSocket`）。
- `ffmpeg` / `ffprobe` 在 `PATH` 中，或在设置里填写绝对路径。
- 可选：Tesseract（OCR）、Whisper/faster-whisper（ASR）。没有时自动降级；Linux 眼睛还需要 grim/scrot/ImageMagick 或 X11（任一即可），macOS 需屏幕录制权限。
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
- 默认数据目录：`~/.dsh/shabi`（不再写进插件安装目录，升级不会丢）。
- `settings.json`：设置页保存的非密钥配置（首次保存后生成）。
- `secrets.ioshb`：`llm.apiKey`、`imageApi.apiKey`、`qqBot.appSecret`、`qqBot.token` 的加密存储。
- `master.key`：AES-256-GCM 主密钥（0600）。优先级：`SHABI_MASTER_KEY` → 本地 `master.key`。
- 环境变量（可选）：
  - `SHABI_LLM_ENDPOINT` / `SHABI_LLM_API_KEY` / `SHABI_LLM_MODEL`
  - `SHABI_IMAGE_ENDPOINT` / `SHABI_IMAGE_API_KEY`
  - `SHABI_CAPTURE_COMMAND` / `SHABI_ASR_COMMAND`
  - `SHABI_MASTER_KEY`（32 字节 base64/hex）

设置页覆盖：眼睛测试/截屏频率/范围、隐私、视频抽帧/覆盖率/分块、B 站 Cookie/推荐条数/无字幕下载、小说默认地址/Cookie、学习笔记上限、自主开关/频率/上限/冷却、人格、图片 API + 测试、记忆管理、安全白名单、QQ 机器人、账号状态、模型、日志。

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

当前验证记录（2026-11-22）：

- `npm test`：**25/25 通过**（含真实 FFmpeg 4 秒视频流水线、知识证据/去重、图片成功与失败降级、QQ Ed25519 验签/去重/限频、自主确认/拒绝、兴趣风控停止、眼睛视觉归一化）。
- 真实 DSH `0.2.2-rc.5`：`dsh plugin --profile headless add <本插件>` 成功，`--dump-config` 出现 `# == shabi-plugin / id: shabi` 层。
- 真实 DSH headless 启动：日志出现“沙币插件已启动”，退出时“沙币插件已卸载”；仅因使用 dummy `DEEPSEEK_API_KEY` 触发模型 401，不是插件错误。
- GitHub：<https://github.com/ETQWFD/shabi-plugin>，默认分支 `main`。
- GitHub 直装：全新 profile 执行 `dsh plugin --profile githubtest add github:ETQWFD/shabi-plugin` 成功，`--dump-config` 出现 shabi 层；headless 从 GitHub 源启动正常，9 个 Agent 工具注册无错误。


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
│   ├── content.js          # B 站推荐/字幕学习 + 小说阅读
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
│   └── client.js           # DSH Web settings.section 客户端入口
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

- DSH Web 设置 section 依赖 `dsh-client-ui-settings`；TUI/headless 使用独立设置页或 `npm start`。
- B 站个性化推荐和字幕需要用户自己的 Cookie；没有 Cookie 时退回公开排行榜，仍可刷到视频，但字幕/高清下载可能不可用。
- 小说抓取只处理静态 HTML 页面；动态渲染、登录墙或强风控站点会返回明确错误，插件不会绕过。
- QQ 图片回复需要 `qqBot.publicBaseUrl` 提供公网可访问 URL；没有公网时只回文字。
- 视频分析使用本机 FFmpeg；长视频受 `video.maxVideoSeconds`（默认 120 秒）限制，这是规格要求。

## 验证记录（1.1.0）

- `npm test`：**31/31 通过**，新增设置路由、B 站推荐、无字幕兜底学习、小说抓取/翻页、学习写记忆测试。
- 真实 DSH `0.2.2-rc.5` Web profile：`dsh plugin --profile web add <本地路径>` 成功；`--dump-config` 出现 `# == shabi-plugin / id: shabi`。
- 真实 Web 启动：`工具注册完成 registered:10 total:10 failures:[]`；不再出现 `cannot create effect on inactive context`。
- 真实 `GET /shabi/settings` 返回 200；设置页渲染 15 个分组，含“B站 / 小说 / 学习”全部字段；`GET /shabi/ui/settings.js` 返回正确 JS（非 Buffer JSON）。
- 真实 `POST /shabi/api/settings` 保存成功；`POST /shabi/api/content {"action":"next"}` 返回真实 B 站视频。
- 真实眼睛：Linux 无宿主 `screen.capture` 时自动用本机截屏，捕获到 `about:blank - Chromium` 窗口，`failures:0`；Tesseract 自动探测可用。


## v1.4.0 真实运行验证

- `npm test`：42/42 通过（含平台自主学习选片/观看、休息读小说、QQ 六条未回最后一条与 away、彩蛋/收藏夹 schema）。
- 真实 B 站自主搜索：`一分钟` 搜索到 `BV11e411P7y7`；下载 62 秒视频，逐帧观看完成，摘要“1分钟倒计时，翻页时钟画面来自【番茄Todo】软件...”，写入笔记 `content/notes/b82e6d062e5a03af.md`，本地收藏 `fav-6545b4f2d39c`。
- 真实 B 站完整观看：`BV1bFPFemEMc`《地球上的一分钟会发生什么！》，下载后逐帧完成，摘要回退为标题/UP 主，写 2 条长期记忆、1 条本地收藏。
- 真实休息读小说：看累 3 条后进入 20 分钟休息，从公版目录打开《三国演义》第一回，写 1 章读书笔记；第二次休息自动翻到第二回。
- 设置页新增“平台自主学习”分组、最近收藏列表和彩蛋；`manifest.json` 的 `properties.easterEgg` 同步。
- 默认 `video.useLlm=false`、`content.learning.useLlm=false`：不依赖模型深度思考即可完成观看/总结/写记忆。

## v1.3.0 历史行为（v1.4.0 已升级为平台自主学习）

- 空闲陪伴优先消费“自主学习队列”，不会安装软件、执行系统命令、改系统设置或删除文件。
- 学习只接收本地视频文件：可放进 `~/.dsh/shabi/study/inbox`，或从已授权目录选择路径；不登录 B 站/抖音/快手，不抓视频流，不自动收藏账号内容。
- QQ 主动消息默认开启：只发给最近私聊你的 C2C，每日最多 2 条、间隔 120 分钟、夜间安静；你说“别发了”会停止 7 天。
- “自我意识”不是事实描述：这里是目标队列 + 记忆 + 自主调度形成的持续行为，不是意识。

## v1.3.0–v1.3.3 真实运行验证（历史版本）

- `npm test`：42/42 通过；`node main.js selfcheck` 全部 ok。
- 真实 DSH `0.2.2-rc.5` Web：`registered:14 total:14 failures:[]`，设置页出现“平台自主学习”“收藏夹”和 QQ 主动消息字段。
- 真实学习队列：4 秒本地测试视频，扫描 → 入队 → 抽帧/逐帧理解 → 覆盖率 `1`、置信度 `1`、1 轮完成；生成学习记录、知识笔记和长期记忆。
- 真实屏幕逐帧模式：3 帧均来自 `vision-frame`，停止后生成时间轴 Markdown 和 1 组笔记；未使用 OCR 路径。
- 设置页导航可跳到对应分组并保持 active 高亮；长页面滚动容器自适应。

## v1.2.0 真实运行验证

- 全新 profile 安装本地包，DSH `0.2.2-rc.5` Web 启动成功，日志 `registered:11 total:11 failures:[]`。
- 设置页原生左侧出现“沙币 → 看视频学习（眼睛）”，含截屏间隔、最长学习、笔记频率、开始看/停止看。
- 真实屏幕测试：播放带中文字幕的视频窗口，截屏 OCR 得到
  `第二段: 学习率太大会震荡，太小会收敛很慢`、
  `第三段; 训练集用于学习，验证集用于选择超参数`。
- 停止后写入 `~/.dsh/shabi/screen-study/watch-*.md`（时间轴 + 学习笔记）和 `~/.dsh/shabi/content/notes/*.md`，并写入长期记忆。
- 设置页“开始看/停止看”按钮真实调用 `/shabi/api/watch`，返回帧数、笔记数、时长。

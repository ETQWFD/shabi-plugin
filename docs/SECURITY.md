# 安全与隐私

## 边界

- 账号由用户本人登录并授权；插件不代登录、不保存密码。
- 不骚扰其他用户，不批量私信、评论、刷量；自主行为有每日/每小时上限、随机抖动、安静时段。
- 遇到验证码、风控提示、平台限制或规则不允许时立即停止并提示用户。
- **不实现反检测、不绕过平台限制、不伪造人类行为指纹。**
- 仅使用 QQ 官方机器人平台，不接入个人号。
- AI 自拍标注“AI 生成”，不冒充真人。

## 文件

- 白名单：插件根目录、插件 `dataDir`、`safety.allowedDirs`。
- 受保护：`memory_*.ioshb`、`memory_index.ioshb`、`archive_*.ioshb`、`master.key`、`secrets.ioshb`、`.git`、`manifest.json`、`package.json`、`main.js`。写/删一律拒绝。
- 路径做 `realpath`；目标不存在时对父目录做 `realpath`，阻止符号链接逃逸。
- 高风险动作：一次性 token（默认 120 秒），绑定 action + detail，使用即失效。
- 可回滚动作先备份到 `backups/`，`logs/actions.jsonl` 记录回滚指针。

## 鼠标键盘

- 只允许 `safety.appAllowlist` 命中的应用或包含“沙币/shbi”的窗口。
- `input_click` / `input_type` / `input_key` 默认高风险，必须二次确认。

## 数据

- 记忆内容 AES-256-GCM；主密钥 `master.key` 0600，优先 `SHABI_MASTER_KEY`。
- 日志 JSONL，轮转 + 脱敏：密码字段、`sk-*`、`Bearer`、32+ hex。
- 截图默认不落盘；`storeScreenshots=false`。
- QQ 端默认不读屏幕；需要同时开启 `qqBot.includeScreen` 与 `privacy.qqReadScreen`。

## 威胁模型外的内容

插件不防御已经拿到本机账户权限的攻击者，也不保证用户配置的第三方 LLM/图片 API 不记录请求。请只使用你信任的端点，并阅读其隐私政策。

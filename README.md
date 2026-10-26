# YanyuMail

私有联系信箱机器人：陌生人在 Telegram 私聊里完成验证后留言，管理员在 Bot 私聊窗口**引用消息**回复。

- Bot：[@YanyuMail_bot](https://t.me/YanyuMail_bot)
- Worker：`yanyumail`（Cloudflare Workers + KV）
- 正式入口：`https://your-worker.your-subdomain.workers.dev`，Webhook 路径 `/webhook`
- 不占用 VPS 资源；不使用 Cloudflare 付费套餐。
- 工作原理：访客消息 `copyMessage` 到管理员私聊，KV 保存“转发消息 ID → 联系人”，管理员引用回复后 `copyMessage` 回访客。

## 快速开始（本地）

```sh
node --version        # 建议 Node 18+
node tests/worker.test.mjs
npx wrangler login
npx wrangler deploy
```

部署前必须在 Cloudflare 为 Worker 配置以下变量，**不要把真实值写进仓库**：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `BOT_TOKEN` | Secret | BotFather 取得的机器人 Token |
| `WEBHOOK_SECRET` | Secret | 随机长串，注册 Webhook 时同步提交给 Telegram |
| `ADMIN_ID` | 变量 | 管理员的 Telegram 数字用户 ID |
| `MAIL` | KV 命名空间 | 仓库已在 `wrangler.jsonc` 绑定现有命名空间 |

## 文档

| 内容 | 文件 |
| --- | --- |
| 安装与首次部署 | [docs/INSTALL.md](docs/INSTALL.md) |
| 使用说明与命令 | [docs/USAGE.md](docs/USAGE.md) |
| 维护、排查、备份 | [docs/MAINTENANCE.md](docs/MAINTENANCE.md) |
| 偏好与约定 | [docs/PREFERENCES.md](docs/PREFERENCES.md) |
| Codex 接手 | [docs/HANDOFF.md](docs/HANDOFF.md) |

## 当前线上配置（2026-10-26）

| 项目 | 值 |
| --- | --- |
| Bot 显示名称 | YanyuMail |
| 公开介绍 | 请联系 Yanyu 前完成验证 |
| 命令 | `/start` 开始联系并完成验证；`/help` 使用帮助 |
| 身份卡 | 首次留言时推送，含拉黑／解封／信任／信息按钮 |
| Webhook | 已注册，`max_connections=1`，`allowed_updates=[message, callback_query]` |
| 待处理更新 | 0 |
| KV 命名空间 | 绑定名 `MAIL`（ID 不记录在此，见 Cloudflare 控制台） |

## 边界

- KV 最终一致，且有每日读写配额；限频与去重是**尽力而为**，不能承诺严格幂等。
- 只转发 Telegram 允许复制的内容；受保护内容、部分媒体类型可能失败，失败会提示管理员。
- Bot 私聊不是 Telegram 端到端加密的“秘密聊天”，不要发送敏感凭据。
- 人机验证只减少自动化垃圾消息，无法阻止真人广告。

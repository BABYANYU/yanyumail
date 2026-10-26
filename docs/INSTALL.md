# 安装与首次部署

## 0. 前置

| 需要 | 说明 |
| --- | --- |
| Telegram Bot | 通过 [@BotFather](https://t.me/BotFather) 创建，取得 Token |
| 管理员 ID | 你的 Telegram 数字用户 ID（不是用户名） |
| Cloudflare 账号 | 使用免费套餐即可 |
| 本地环境 | Node.js 18+；不使用 VPS |

## 1. 创建 Bot

1. 向 @BotFather 发送 `/newbot`，设置显示名称与用户名（用户名必须以 `bot` 结尾）。
2. 记录 Token。**Token 等同于机器人密码，不要提交到仓库或截图外传。**
3. 用 `/setdescription` 设置公开介绍，用 `/setcommands` 设置命令菜单：

| 命令 | 说明 |
| --- | --- |
| `start` | 开始联系并完成验证 |
| `help` | 使用帮助 |

4. 保持 Bot 的 Group Privacy 默认开启即可，本方案不使用群组。

## 2. 创建 KV 命名空间

```sh
npx wrangler kv namespace create MAIL
```

把返回的 `id` 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`。

## 3. 配置变量

在 Cloudflare 控制台 Worker → Settings → Variables and Secrets 添加：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `BOT_TOKEN` | Secret | Bot Token |
| `WEBHOOK_SECRET` | Secret | 随机串，建议 32 字节 hex，例如 `openssl rand -hex 32` |
| `ADMIN_ID` | 变量 | 管理员数字用户 ID |

也可以用 Wrangler：

```sh
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

`ADMIN_ID` 属于非敏感配置，写在 `wrangler.jsonc` 的 `vars` 中或控制台普通变量均可。

## 4. 部署

```sh
npm install
npm test
npx wrangler deploy
```

首次部署后得到形如 `https://yanyumail.<你的子域>.workers.dev` 的地址。

## 5. 注册 Webhook

必须带 secret，且 `max_connections=1` 以降低并发写 KV 的冲突概率：

```sh
BOT_TOKEN=...        # 不要写进 shell 历史可回显的地方
WEBHOOK_SECRET=...
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://<你的地址>/webhook\",\"secret_token\":\"${WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"callback_query\"],\"max_connections\":1}"
```

注册成功返回 `{"ok":true,...,"description":"Webhook was set"}`。

## 6. 验收

| 检查 | 预期 |
| --- | --- |
| `GET /health` | 返回 `YanyuMail ok` |
| 未带 secret 的 `POST /webhook` | 返回 403 |
| 管理员先打开 Bot 点“开始” | 能与 Bot 建立会话 |
| 另一账号私聊 Bot | 收到算术验证题 |
| 答题正确后发消息 | 管理员私聊收到带身份卡的消息 |
| 管理员引用该消息回复 | 对方收到回复 |
| `getWebhookInfo` | `pending_update_count` 为 0，`last_error_message` 为空 |

## 注意事项

- **Telegram 无法向从未打开过 Bot 的用户主动发消息**，所以自测前管理员必须自己先点“开始”。
- Webhook 未注册或 secret 不一致时，机器人完全不响应。
- 首次部署后不要立刻更换 Token；若更换，需重新 `secret put` 并重新部署，Webhook 无需重设。

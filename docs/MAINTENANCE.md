# 维护与排查

## 日常检查

```sh
curl -s https://<你的地址>/health
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

关注 `pending_update_count` 是否持续增长、`last_error_message` 是否出现 5xx/超时。

Cloudflare 控制台 Worker 的 Observability（仓库已开启）可查看请求量、错误率与日志。

## 可靠性设计（勿回退）

| 机制 | 原因 |
| --- | --- |
| 收到 Webhook 立即返回 200，处理放 `ctx.waitUntil` | 处理耗时超过 Telegram 60 秒等待会触发重投，造成重复转发 |
| 处理前先 `claim(update_id)` 占位去重 | 重投时同一条消息只会被转发一次；同一实例内另有 `inflight` 集合防并发 |
| 所有向 Telegram 的发送都包 try/catch | 任一目标不可达（如管理员未启动 Bot）不得让整个请求失败 |
| 回调先算结果，`finally` 里必答 `answerCallbackQuery` | 否则按钮会一直转圈 |
| `/health` 返回配置缺失项 | 部署错误可立刻发现，而不是表现为静默失败 |
| 失败提示每用户每小时一次 | 避免同一条失败反复刷屏 |

## 常见故障

| 现象 | 排查顺序 |
| --- | --- |
| Bot 完全没反应 | Webhook URL 是否正确、`WEBHOOK_SECRET` 是否与注册时一致、Worker 是否部署成功 |
| 每次都有 403 | secret 不匹配；重新 `setWebhook` 时使用同一值 |
| 访客收不到回复 | 检查 `copyMessage` 报错提示：对方是否拉黑 Bot、内容是否受保护 |
| 管理员收不到消息 | `ADMIN_ID` 是否为数字 ID；管理员是否曾打开 Bot |
| 提示找不到联系人 | 引用的消息超过 30 天，或引用的是身份卡以外的旧消息 |
| 验证题不出现 | 该用户已被 `trust`、仍在 24 小时有效期内，或已被拉黑 |
| 频繁重复同一提示 | 多为 Webhook 返回 500 触发 Telegram 重试；检查日志中的 handler error，并确认 ADMIN_ID 可达 |
| 高频 500 | KV 写入配额或并发冲突；查看是否被刷 |

## 参数调整

主要位于 `src/worker.mjs` 顶部与各函数内：

| 参数 | 当前值 | 位置 |
| --- | --- | --- |
| 验证有效期 | 24 小时 | `VERIFY` |
| 路由保留 | 30 天 | `ROUTE` |
| 验证尝试次数 | 3 次 / 5 分钟窗口 | `challenge` 中的 `rate(...)` 与 `tries` |
| 访客发信限频 | 20 条 / 60 秒 | `visitor` 中的 `rate(...)` |
| 去重窗口 | 24 小时 | `update:` 键 TTL |

改完执行 `npm test` 再 `npx wrangler deploy`。

## 备份

| 数据 | 位置 | 是否重要 |
| --- | --- | --- |
| KV 数据（路由、验证、黑名单） | Cloudflare KV | 低：全部带 TTL，丢失仅影响历史引用与验证状态 |
| 源码 | 本仓库 | 重要 |
| Bot Token / Webhook Secret | Cloudflare Secret | 重要，无法回读，需自行保管 |

KV 无长期业务数据，**不需要例行备份**。若确实要留档，可使用 `npx wrangler kv key list/get` 导出，注意其中含用户 ID。

## 管理员会话可达性

Bot 只能向**主动给 Bot 发过消息**的用户发送内容。`ADMIN_ID` 填错或管理员从未启动 Bot 时，`sendMessage` 会返回 `chat not found`，导致转交失败。排障时先确认这一点，再检查代码。

任何用户发送 `/id` 可获知自己的数字 ID。

## 安全

- 不把 Token、Secret 写进代码、文档、截图或提交历史。
- 泄露 Token 后立即在 BotFather 执行 `/revoke` 换新，再 `wrangler secret put BOT_TOKEN` 并重新部署。
- 定期查看 Cloudflare 的请求量，异常增长可能是被扫描或被刷。
- 本方案不使用群组，无需 Group Privacy 调整。

## 卸载

| 步骤 | 操作 |
| --- | --- |
| 1 | `curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"` |
| 2 | Cloudflare 删除 Worker `yanyumail` |
| 3 | 删除 KV 命名空间 `MAIL` |
| 4 | BotFather `/deletebot`（如不再使用该 Bot） |

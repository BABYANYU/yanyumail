# Codex 交接

## 现状

YanyuMail 已上线并正常运行。这是**原创精简实现**，不是从其他开源项目套壳；无第三方代码需要遵循额外许可。

| 项目 | 值 |
| --- | --- |
| Bot | @YanyuMail_bot（显示名称 YanyuMail） |
| Worker | `yanyumail`，Cloudflare Workers 免费套餐 |
| 运行地址 | `https://your-worker.your-subdomain.workers.dev` |
| 数据 | KV，绑定名 `MAIL` |
| 资源 | 不涉及 VPS、不涉及 Docker、未购买任何付费服务 |

线上具体值（管理员 ID、KV 命名空间 ID、Token）**不在本仓库**。需由用户单独提供，或从 Cloudflare / BotFather 侧取得。

## 代码结构

| 文件 | 作用 |
| --- | --- |
| `src/worker.mjs` | 全部逻辑，单文件 |
| `tests/worker.test.mjs` | 无网络依赖的行为测试，模拟 KV 与 Telegram API |
| `wrangler.jsonc` | Worker 名、入口、KV 绑定（ID 为占位符） |
| `docs/` | 安装、使用、维护、偏好 |

## 关键实现点

| 机制 | 说明 |
| --- | --- |
| 身份卡 | 首次联系时向管理员发一条联系人信息，其 message_id 记入 `route:` |
| 路由 | 每条转发消息的 message_id → `{id, name, username}`，TTL 30 天 |
| 回复 | 管理员引用某条消息，Worker 用 `copyMessage` 发回原发言人 |
| 权限 | 只有 `ADMIN_ID` 的消息进入管理分支；未引用一律不发送 |
| 验证 | 算术题内联按钮，nonce 防伪造回调，24 小时有效，3 次尝试上限 |
| 去重 | `update:<id>` 键，24 小时；KV 最终一致，属尽力而为 |
| 限频 | 固定窗口计数，KV 存储 |
| 并发 | 同一用户消息用内存 Promise 串行化（仅单实例有效） |

## 修改时注意

1. **不要**引入“自动回复最后联系人”等功能，用户明确拒绝，存在误发风险。
2. 改动后必须跑 `node tests/worker.test.mjs`；该测试覆盖认证、隔离、验证、双向路由、拉黑、信任、去重。
3. 部署后必须用**另一个 Telegram 账号**实测：验证 → 留言 → 管理员引用回复 → 对方收到。
4. 不要打印或提交 `BOT_TOKEN`、`WEBHOOK_SECRET`、真实 `ADMIN_ID`、KV ID。
5. 调整 `max_connections=1` 前需评估 KV 并发写冲突；不适合高并发场景。
6. 文案改动遵循 `docs/PREFERENCES.md`：简约、专业、正式，不使用“烟雨”作为对外标识。

## 待办（非阻塞）

| 项目 | 说明 |
| --- | --- |
| 真人端到端验收 | 已通过模拟测试与健康检查，尚需另一个账号完成一次完整往返 |
| Token 轮换 | 用户曾在对话中明文发送过 Token，建议在 BotFather `/revoke` 后重新部署 |
| 联系方式 | 当前只有 workers.dev 默认地址，如需自定义域可后续绑定 |

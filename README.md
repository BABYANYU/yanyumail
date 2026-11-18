# YanyuMail

私有联系信箱机器人：访客验证后留言，管理员在 Bot 私聊中引用消息回复。

**使用入口：[@YanyuMail_bot](https://t.me/YanyuMail_bot)**

## 访客功能

- 首次留言前完成算术验证；验证前的消息不会转交，也不会在验证后补发。
- 验证通过后，24 小时内可直接留言。
- 支持文字、图片、语音、视频、文件等 Telegram 允许复制的内容。
- 每分钟最多约 20 条消息；被拉黑的联系人消息不转交。
- `/start` 开始验证或查看当前验证状态；`/id` 查看自己的用户 ID。

## 管理员功能

- 在与 Bot 的私聊窗口接收访客消息，不需要群组或后台。
- 引用对应访客消息或身份卡，发送文字、媒体即可回复；未引用时不会发送。
- 身份卡提供拉黑、解封、信任、取消信任和信息按钮；24 小时内不重复发送。
- 信任后永久免验证，仍保留基本限频；取消信任会同时清除验证状态。
- 引用消息的联系路由保留 30 天。管理员命令只对管理员本人有效。

| 命令              | 功能                     |
| ----------------- | ------------------------ |
| `/help`、`/start` | 管理帮助                 |
| `/id`             | 查看管理员自己的用户 ID  |
| `/block`、`/b`    | 拉黑引用消息对应的联系人 |
| `/unblock`、`/ub` | 解封联系人               |
| `/trust`、`/t`    | 永久信任联系人           |
| `/untrust`、`/ut` | 取消信任并清除验证       |
| `/info`、`/i`     | 查看联系人身份与状态     |

未知管理命令会被拦截，不会作为回复发送给访客。

## 消息处理与隐私

- 更新先进入持久队列，再按顺序处理；临时限流时自动延期重试。
- 不保存普通留言正文或媒体文件；转交使用 Telegram 消息 ID。
- 已确认成功的转交会记录结果，避免重试时重复发送。
- 网络中断导致转交状态无法确认时，会提示核对，不盲目重复发送。
- 访客不会看到管理员账号或其他联系人的消息。Bot 私聊属于普通 Telegram 云端聊天，不是端到端加密的秘密聊天。

## 部署与生产配置

- **生产必须关闭 workers.dev**：仓库中的 `wrangler.jsonc` 是模板，当前写的是 `"workers_dev": true`。正式发布时该 Worker 只应通过自定义域名/路由对外，生产配置必须改为 `"workers_dev": false`（同时不要开启预览 URL），否则 `*.workers.dev` 会额外暴露一个可公开访问的入口，绕过预期的域名与访问控制。`npm run deploy`（`scripts/deploy.mjs`）会把模板里的 `workers_dev`、`keep_vars` 等字段原样带入实际部署配置，**不会**替你纠正该项，因此发布前必须自行核对所用配置。本次维护只改文档与 CI，没有改动模板里的该字段，也没有部署。
- **KV namespace**：`kv_namespaces[].id` 必须替换为真实的 32 位十六进制 namespace id（`MAIL` 绑定名保持不变）；真实 id 与 Secret 不要写入公开仓库。
- **Secret**：`BOT_TOKEN`、`WEBHOOK_SECRET`、`ADMIN_ID` 属于生产配置，发布时依靠 `keep_vars: true` 保留，不要通过仓库配置文件下发。

### `npm run deploy:check` 与占位 KV id

- `deploy:check` 的定义是 `wrangler deploy --dry-run`，**只验证打包，不验证绑定是否可用**。实测（wrangler 4.153.0，`wrangler.jsonc` 保留占位 id `REPLACE_WITH_KV_NAMESPACE_ID`）它只是打印 `env.MAIL (REPLACE_WITH_KV_NAMESPACE_ID)  KV Namespace`，然后以退出码 0 结束。也就是说：占位 KV id 不会让 `deploy:check` 失败，**不要把它的绿色当作“配置可部署”的证据**。
- 占位 id 的拦截点在发布路径上：`npm run deploy`（`scripts/deploy.mjs`）会先读取当前生产版本的真实绑定，`prepareConfig()` 校验 `MAIL` 绑定的 `namespace_id` 是否匹配 `^[a-f0-9]{32}$`，不匹配就抛出 `Existing MAIL binding is missing or invalid` 并中止（同时校验 `ADMIN_ID` 为合法数字、`BOT_TOKEN` 与 `WEBHOOK_SECRET` 以 secret 形式存在）；错误路径不会打印原始 SDK 报错内容，避免泄漏配置值。
- 想在任何部署动作之前就明确失败，用下面的前置自检（占位时退出码非 0）：

```sh
# 占位 KV id 存在即失败
rg -q 'REPLACE_WITH_KV_NAMESPACE_ID' wrangler.jsonc \
  && { echo 'wrangler.jsonc still uses the placeholder KV namespace id' >&2; exit 1; }
```

## 测试环境

- `npm test` 等于 `node --test tests/*.test.mjs`，混合了两类用例：
  - 纯 `node:test`：`worker.test.mjs`、`card.test.mjs`、`hardening.test.mjs`、`review.test.mjs`、`deploy.test.mjs`，不需要 workerd。
  - **需要真实 workerd**：`tests/runtime.test.mjs`。它从 `node_modules/wrangler` 里 `require("miniflare")`，用 `convertV4MiniflareOptions` 启动 workerd，加载 `src/worker.mjs`、`src/mailbox.mjs`、`src/bot.mjs`，带 SQLite Durable Object（`useSQLite: true`）和 mock `outboundService`，单个用例自带 45 秒超时。
- 因此 `runtime.test.mjs` 的前提是：已完整执行 `npm ci`（Miniflare/workerd 由 wrangler 4.153.0 携带，不能跨平台或跨架构复用）、宿主能启动 workerd 子进程、有可写临时目录。离线、精简容器、模拟 CPU 或慢机器上，它会超时或以启动错误结束——这属于环境问题，不等于用例失败。
- **CI 需要稳定环境**：`.github/workflows/check.yml` 使用 `ubuntu-latest`、固定 Node 22（与 `engines: ">=22.0.0 <25"` 及 `.nvmrc` 一致）、`npm ci` 走锁文件、`WRANGLER_SEND_METRICS=false`、作业级 `timeout-minutes: 10`，顺序为 `npm run check` → `npm test` → `npm run deploy:check`。不要在共享、无缓存或网络抖动的临时环境里跑 `npm test`，否则 workerd 下载超时和用例超时会混在一起，无法判断原因。
- `engines` 限定 `<25`，Node 25 及以上不在验证范围内。

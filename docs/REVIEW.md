# 2026-10-27 复查修复

已修复 /i 未映射导致被当回复转给访客；管理员 /id 不可用；访客 /id 绕过限频；/START 或 start带参数解析不一致；管理员按钮未校验私聊来源及联系人ID；管理员转交失败通知未节流。新增 activeUpdates 集合覆盖完整处理周期（同实例）。

验证有效期仍为24小时，信任仍永久，未改变公开菜单。访客 /help 仍忽略，本次没有增加访客帮助功能。

所有四组测试需运行：`node tests/worker.test.mjs`、`node tests/card.test.mjs`、`node tests/hardening.test.mjs`、`node tests/review.test.mjs`。

## 不能夸大保证

- KV没有原子CAS，跨实例去重、限频仍为尽力而为。
- Worker立即确认之后的后台处理可能失败或中断，不能保证必达，也没有持久队列。
- answerCallbackQuery在finally中尝试，不代表总能及时应答：前面的网络请求耗时或回调过期仍可能造成按钮延迟。
- ban/trust未设置TTL，永久存在直到明确删除；不是所有KV键都有TTL，维护备份需特别留意这些状态。
- 身份卡intro键TTL为24小时，因此并非一生只发一次；过期后的下一次留言会再发送。
- 不承诺没有任何bug；上线健康与模拟测试不能替代真人双向验收。

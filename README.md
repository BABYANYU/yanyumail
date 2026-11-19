# YanyuMail

Telegram 联系信箱。访客通过验证后留言，管理员在 Bot 私聊中引用原消息回复。

**在线入口：** [@YanyuMail_bot](https://t.me/YanyuMail_bot)

## 使用

1. 向 Bot 发送 `/start`，按提示完成验证。
2. 发送文字、图片或文件。管理员的回复由 Bot 转交。
3. 管理员可引用留言直接回复，或通过身份卡管理联系人。

消息通过 Telegram 转交。应用队列保存处理所需的消息标识和路由信息，普通留言正文与媒体由 Telegram 承载。Bot 聊天属于 Telegram 云端聊天。

许可证：[MIT](LICENSE)。

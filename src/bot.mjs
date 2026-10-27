// YanyuMail — Copyright 2026 烟雨. Original implementation.
const VERIFY = 86400,
  ROUTE = 2592000;

async function tg(e, method, data) {
  return e.TELEGRAM(method, data);
}
async function say(e, id, text, extra = {}) {
  return tg(e, "sendMessage", { chat_id: id, text, ...extra });
}
async function get(e, k) {
  return e.STATE.get(k);
}
async function put(e, k, v, ttl) {
  await e.STATE.put(k, v, ttl);
}
async function rate(e, id, key, max, seconds) {
  return e.RATE(id, key, max, seconds);
}
async function challenge(e, id) {
  const allowed = await rate(e, id, "challenge", 3, 300);
  if (!allowed) {
    if (await rate(e, id, "challenge_wait", 1, 300))
      await say(e, id, "请稍后重试。");
    return;
  }
  const a = 2 + Math.floor(Math.random() * 8),
    b = 1 + Math.floor(Math.random() * 8),
    answer = a + b;
  const nonce = crypto.randomUUID().slice(0, 12);
  const options = [answer, answer + 1, answer - 1].sort(
    () => Math.random() - 0.5,
  );
  await put(e, "quiz:" + id, { answer, nonce, tries: 0 }, 300);
  await say(e, id, `请完成验证后留言：${a}＋${b}＝？\n验证前的消息不会转交。`, {
    reply_markup: {
      inline_keyboard: [
        options.map((x) => ({
          text: String(x),
          callback_data: `q:${nonce}:${x}`,
        })),
      ],
    },
  });
}

async function adminAct(e, act, id) {
  if (act === "b") {
    await put(e, "ban:" + id, true);
    return `已拉黑 ${id}`;
  }
  if (act === "u") {
    const had = await get(e, "ban:" + id);
    if (!had) return `${id} 未处于拉黑状态`;
    await e.STATE.delete("ban:" + id);
    await e.STATE.delete("failnotice:" + id);
    return `已解封 ${id}`;
  }
  if (act === "t") {
    await put(e, "trust:" + id, true);
    return `已信任 ${id}，永久免验证`;
  }
  if (act === "x") {
    await e.STATE.delete("trust:" + id);
    await e.STATE.delete("verified:" + id);
    return `已取消信任 ${id}，需重新验证`;
  }
  return "未知操作";
}

async function callback(e, q) {
  const from = String(q.from.id);
  let note = "已处理";
  try {
    if (
      q.message?.chat?.type !== "private" ||
      String(q.message.chat.id) !== from
    ) {
      note = "无效操作";
      return;
    }
    if (!(await rate(e, from, "callback", 15, 60))) {
      note = "请稍后重试。";
      return;
    }
    if (from === String(e.ADMIN_ID) && (q.data || "").startsWith("a:")) {
      if (!/^a:[butxi]:[1-9]\d{0,15}$/.test(q.data)) {
        note = "无效操作";
        return;
      }
      const p = (q.data || "").split(":"),
        act = p[1],
        id = p.slice(2).join(":");
      if (act === "i") {
        const route = await get(e, `uid:${id}`);
        const banned = await get(e, "ban:" + id),
          trusted = await get(e, "trust:" + id),
          verified = await get(e, "verified:" + id);
        note = "信息";
        await say(
          e,
          e.ADMIN_ID,
          `联系人：${route?.name || "未知"}\n用户名：${route?.username ? "@" + route.username : "未设置"}\n用户ID：${id}\n状态：${banned ? "已拉黑" : trusted ? "已信任" : verified ? "已验证（24小时）" : "未验证"}`,
        );
      } else {
        note = await adminAct(e, act, id);
        await say(e, e.ADMIN_ID, note);
      }
      return;
    }
    const id = from;
    if (
      q.message?.chat.type !== "private" ||
      String(q.message.chat.id) !== id
    ) {
      note = "无效操作";
      return;
    }
    const quiz = await get(e, "quiz:" + id);
    const parts = (q.data || "").split(":");
    note = "验证已过期，请重新发送消息。";
    if (await get(e, "ban:" + id)) {
      note = "当前无法使用。";
      return;
    }
    if (!quiz || parts[0] !== "q" || parts[1] !== quiz.nonce) return;
    if (quiz.tries >= 3) {
      note = "验证次数过多，请稍后重试。";
      return;
    }
    if (Number(parts[2]) === quiz.answer) {
      await say(e, id, "验证通过，请简述来意。");
      await put(e, "verified:" + id, true, VERIFY);
      await e.STATE.delete("quiz:" + id);
      note = "验证通过";
    } else {
      quiz.tries++;
      await put(e, "quiz:" + id, quiz, 300);
      note =
        quiz.tries >= 3 ? "验证次数过多，请稍后重试。" : "答案不正确，请重试。";
    }
  } catch (err) {
    if (err.retryable) throw err;
    console.error("callback failed");
    note = "处理失败，请重试";
  } finally {
    try {
      await tg(e, "answerCallbackQuery", {
        callback_query_id: q.id,
        text: note,
        show_alert: false,
      });
    } catch {}
  }
}

async function owner(e, m) {
  const text = (m.text || "").trim();
  let cmd = text.split(/\s/)[0].toLowerCase().split("@")[0];
  const alias = {
    "/b": "/block",
    "/ub": "/unblock",
    "/t": "/trust",
    "/ut": "/untrust",
    "/i": "/info",
  };
  cmd = alias[cmd] || cmd;
  // 防止管理员侧被自动回复程序来回触发（理论上限，正常人工操作远低于此值）
  if (!(await rate(e, e.ADMIN_ID, "owner", 30, 60))) return;
  if (cmd === "/id") {
    await say(e, e.ADMIN_ID, `ID：${e.ADMIN_ID}`);
    return;
  }
  if (cmd === "/start" || cmd === "/help") {
    await say(
      e,
      e.ADMIN_ID,
      "YanyuMail 管理帮助\n\n【身份卡按钮】首次联系会发一张身份卡，直接点：\n拉黑 / 解封 / 信任 / 取消信任 / 信息\n\n【命令】引用联系人消息后发送：\n/block 或 /b 拉黑\n/unblock 或 /ub 解封\n/trust 或 /t 永久免验证\n/untrust 或 /ut 取消信任\n/info 或 /i 查看联系人\n\n【回复】引用消息后直接发文字或媒体即可\n未引用不会发送给任何人；路由保留 30 天；Bot 非端到端加密。",
    );
    return;
  }
  if (
    text.startsWith("/") &&
    !["/block", "/unblock", "/trust", "/untrust", "/info"].includes(cmd)
  ) {
    await say(e, e.ADMIN_ID, "未知命令。发送 /help 查看可用操作。");
    return;
  }
  if (!m.reply_to_message) {
    if (await rate(e, e.ADMIN_ID, "hint", 1, 300))
      await say(
        e,
        e.ADMIN_ID,
        "请引用对应联系人的消息后回复，避免误发。发送 /help 查看操作。",
      );
    return;
  }
  const route = await get(e, `route:${m.reply_to_message.message_id}`);
  if (!route) {
    await say(
      e,
      e.ADMIN_ID,
      "未找到对应联系人（路由可能已超过30天）。请引用近期收到的联系人消息。",
    );
    return;
  }
  const id = route.id;
  if (cmd === "/block") {
    await put(e, "ban:" + id, true);
    await say(e, e.ADMIN_ID, `已拉黑 ${id}`);
    return;
  }
  if (cmd === "/unblock") {
    await e.STATE.delete("ban:" + id);
    await e.STATE.delete("failnotice:" + id);
    await say(e, e.ADMIN_ID, `已解封 ${id}`);
    return;
  }
  if (cmd === "/trust") {
    await put(e, "trust:" + id, true);
    await say(e, e.ADMIN_ID, `已永久信任 ${id}，仍受基本限频保护。`);
    return;
  }
  if (cmd === "/untrust") {
    await e.STATE.delete("trust:" + id);
    await e.STATE.delete("verified:" + id);
    await say(e, e.ADMIN_ID, `已取消信任及验证 ${id}`);
    return;
  }
  if (cmd === "/info") {
    const banned = await get(e, "ban:" + id),
      trusted = await get(e, "trust:" + id),
      verified = await get(e, "verified:" + id);
    await say(
      e,
      e.ADMIN_ID,
      `联系人：${route.name || "未知"}\n用户名：${route.username ? "@" + route.username : "未设置"}\n用户ID：${id}\n状态：${banned ? "已拉黑" : trusted ? "已信任" : verified ? "已验证（24小时）" : "未验证"}`,
    );
    return;
  }
  if (await get(e, "ban:" + id)) {
    await say(e, e.ADMIN_ID, "该联系人已拉黑，请先引用消息发送 /unblock。");
    return;
  }
  try {
    await tg(e, "copyMessage", {
      chat_id: id,
      from_chat_id: e.ADMIN_ID,
      message_id: m.message_id,
    });
  } catch (err) {
    if (err.retryable) throw err;
    await say(
      e,
      e.ADMIN_ID,
      `回复${err.uncertain ? "状态未确认" : "未送达"}（用户 ${id}）。请核对会话后处理。`,
    );
  }
}

async function visitor(e, m) {
  const id = String(m.from.id);
  if (await get(e, "ban:" + id)) return;
  if (!(await rate(e, id, "inbound", 20, 60))) return;
  const raw = (m.text || "").trim();
  const command = raw.split(/\s+/)[0].toLowerCase().split("@")[0];
  if (command === "/id") {
    await say(e, id, `ID：${id}`);
    return;
  }
  if (raw.startsWith("/") && command !== "/start") return;
  const ok = (await get(e, "trust:" + id)) || (await get(e, "verified:" + id));
  if (!ok) {
    await challenge(e, id);
    return;
  }
  if (command === "/start") {
    await say(e, id, "验证有效，可直接发送消息。");
    return;
  }
  const name =
    [m.from.first_name, m.from.last_name]
      .filter(Boolean)
      .join(" ")
      .replace(/[\r\n]/g, " ")
      .slice(0, 100) || `用户${id}`;
  const route = { id, name, username: m.from.username || "" };
  try {
    if (!(await get(e, "intro:" + id))) {
      const card = await say(
        e,
        e.ADMIN_ID,
        `联系人：${name}\n用户名：${route.username ? "@" + route.username : "未设置"}\n用户ID：${id}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "拉黑", callback_data: `a:b:${id}` },
                { text: "解封", callback_data: `a:u:${id}` },
                { text: "信任", callback_data: `a:t:${id}` },
                { text: "信息", callback_data: `a:i:${id}` },
              ],
              [{ text: "取消信任", callback_data: `a:x:${id}` }],
            ],
          },
        },
      );
      await put(e, "uid:" + id, route, ROUTE);
      await put(e, `route:${card.message_id}`, route, ROUTE);
      await put(e, "intro:" + id, true, 86400);
    }
    const sent = await tg(e, "copyMessage", {
      chat_id: e.ADMIN_ID,
      from_chat_id: id,
      message_id: m.message_id,
    });
    await put(e, `route:${sent.message_id}`, route, ROUTE);
  } catch (err) {
    if (err.retryable) throw err;
    if (!(await get(e, "failnotice:" + id))) {
      const notices = [
        [
          id,
          err.uncertain
            ? "消息转交状态未确认，请稍后联系。"
            : "消息未能送达，请稍后重试。",
        ],
        [
          e.ADMIN_ID,
          `联系人 ${id} 消息${err.uncertain ? "转交状态未确认" : "转交失败"}，请核对会话后处理。`,
        ],
      ];
      for (const [target, text] of notices) {
        try {
          await say(e, target, text);
        } catch (noticeError) {
          if (noticeError.retryable) throw noticeError;
        }
      }
      await put(e, "failnotice:" + id, true, 3600);
    }
  }
}

export async function handleUpdate(e, u) {
  const m = u.message,
    q = u.callback_query;
  const uid = String(q?.from?.id || m?.from?.id || "");
  if (q) await callback(e, q);
  else if (uid === String(e.ADMIN_ID)) await owner(e, m);
  else await visitor(e, m);
}

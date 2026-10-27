export { Mailbox } from "./mailbox.mjs";

const validId = (value) =>
  /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value));

export function configurationErrors(env) {
  const missing = ["BOT_TOKEN", "WEBHOOK_SECRET", "MAIL", "INBOX"].filter(
    (key) => !env[key],
  );
  if (!validId(env.ADMIN_ID)) missing.push("ADMIN_ID");
  if (
    typeof env.WEBHOOK_SECRET !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(env.WEBHOOK_SECRET)
  ) {
    if (!missing.includes("WEBHOOK_SECRET")) missing.push("WEBHOOK_SECRET");
  }
  return missing;
}

export function normalizeUpdate(body) {
  if (!body || !Number.isSafeInteger(body.update_id) || body.update_id < 0)
    return null;
  const raw = body.callback_query ?? body.message;
  const from = raw?.from;
  const chat = body.callback_query ? raw?.message?.chat : raw?.chat;
  if (
    !validId(from?.id) ||
    from.is_bot ||
    chat?.type !== "private" ||
    String(chat.id) !== String(from.id)
  )
    return null;
  const sender = {
    id: String(from.id),
    first_name: String(from.first_name ?? "").slice(0, 64),
    last_name: String(from.last_name ?? "").slice(0, 64),
    username: String(from.username ?? "").slice(0, 64),
  };
  if (body.callback_query) {
    if (
      typeof raw.id !== "string" ||
      typeof raw.data !== "string" ||
      raw.data.length > 64
    )
      return null;
    return {
      update_id: body.update_id,
      callback_query: {
        id: raw.id,
        from: sender,
        message: { chat: { id: String(chat.id), type: "private" } },
        data: raw.data,
      },
    };
  }
  if (!Number.isSafeInteger(raw.message_id) || raw.message_id <= 0) return null;
  // copyMessage needs IDs, not a stored copy of the private message or its media.
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const command = text.startsWith("/")
    ? text.split(/\s+/)[0].slice(0, 128)
    : "";
  const message = {
    message_id: raw.message_id,
    from: sender,
    chat: { id: String(chat.id), type: "private" },
    text: command,
  };
  if (
    Number.isSafeInteger(raw.reply_to_message?.message_id) &&
    raw.reply_to_message.message_id > 0
  ) {
    message.reply_to_message = { message_id: raw.reply_to_message.message_id };
  }
  return { update_id: body.update_id, message };
}

async function readBody(request) {
  const limit = 1024 * 1024;
  if (Number(request.headers.get("Content-Length")) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const errors = configurationErrors(env);
    if (path === "/health" && request.method === "GET") {
      return new Response(
        errors.length ? "配置缺失或无效：" + errors.join(",") : "YanyuMail ok",
        {
          status: errors.length ? 503 : 200,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    if (path !== "/webhook" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (errors.length)
      return new Response("Service unavailable", { status: 503 });
    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.WEBHOOK_SECRET
    )
      return new Response("Forbidden", { status: 403 });
    let raw;
    try {
      raw = await readBody(request);
    } catch {
      return new Response("Invalid body", { status: 400 });
    }
    if (raw === null) return new Response("Too large", { status: 413 });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const update = normalizeUpdate(body);
    if (!update) return new Response("ok");
    try {
      return await env.INBOX.getByName("mailbox-v1").fetch(
        new Request("https://mailbox/enqueue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        }),
      );
    } catch {
      // Telegram retries non-2xx responses; never ACK an update that wasn't saved.
      console.error("mailbox enqueue failed");
      return new Response("Please retry", { status: 503 });
    }
  },
};

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Use the exact Miniflare/workerd runtime bundled with the pinned deployment tool.
const require = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
);
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

test(
  "real workerd: SQLite alarms deliver rapid messages and preserve quoted-reply isolation",
  { timeout: 45000 },
  async (t) => {
    const calls = [];
    let mid = 100;
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: ["worker.mjs", "mailbox.mjs", "bot.mjs"].map((name) => ({
          type: "ESModule",
          path: fileURLToPath(new URL("../src/" + name, import.meta.url)),
        })),
        compatibilityDate: "2026-10-01",
        cf: false,
        kvNamespaces: ["MAIL"],
        durableObjects: { INBOX: { className: "Mailbox", useSQLite: true } },
        bindings: {
          ADMIN_ID: "1",
          BOT_TOKEN: "mock-token",
          WEBHOOK_SECRET: "test-secret",
        },
        outboundService: async (request) => {
          assert.equal(new URL(request.url).hostname, "api.telegram.org");
          const method = new URL(request.url).pathname.split("/").at(-1),
            data = await request.json();
          const result =
            method === "answerCallbackQuery" ? true : { message_id: ++mid };
          calls.push({ method, ...data, result });
          return Response.json({ ok: true, result });
        },
      }),
    );
    t.after(() => mf.dispose());
    await mf.ready;
    const legacy = await mf.getKVNamespace("MAIL");
    await legacy.put("trust:2", "true");
    await legacy.put("intro:2", "true", { expirationTtl: 86400 });
    assert.equal((await mf.dispatchFetch("https://test/health")).status, 200);
    const post = (body) =>
      mf.dispatchFetch("https://test/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
        body: JSON.stringify(body),
      });
    const message = (n, id, text, reply) => ({
      update_id: n,
      message: {
        message_id: n,
        chat: { id, type: "private" },
        from: { id, first_name: "Example" },
        text,
        ...(reply ? { reply_to_message: { message_id: reply } } : {}),
      },
    });
    for (let n = 1; n <= 3; n++)
      assert.equal((await post(message(n, 2, "hello"))).status, 200);
    const waitFor = async (predicate) => {
      const limit = Date.now() + 20000;
      while (!predicate()) {
        if (Date.now() > limit) throw new Error("Workerd alarm did not finish");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    await waitFor(
      () =>
        calls.filter((c) => c.method === "copyMessage" && c.chat_id === "1")
          .length === 3,
    );
    const inbound = calls.find(
      (c) => c.method === "copyMessage" && c.chat_id === "1",
    );
    await post(message(4, 1, "reply", inbound.result.message_id));
    await waitFor(() =>
      calls.some((c) => c.method === "copyMessage" && c.chat_id === "2"),
    );
    await post(message(5, 1, "/unknown", inbound.result.message_id));
    await waitFor(() => calls.some((c) => c.text?.includes("未知命令")));
    assert.equal(
      calls.filter((c) => c.method === "copyMessage" && c.chat_id === "2")
        .length,
      1,
    );
  },
);

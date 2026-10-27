import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.mjs";
import { fixture } from "./helpers.mjs";

test("webhook authenticates and refuses invalid configuration before touching the queue", async (t) => {
  const f = fixture();
  t.after(f.close);
  assert.equal((await f.post(f.msg("2", "hi"), "wrong")).status, 403);
  f.env.WEBHOOK_SECRET = "";
  assert.equal((await f.post(f.msg("2", "hi"), "")).status, 503);
  f.env.WEBHOOK_SECRET = "test-secret";
  f.env.ADMIN_ID = "not-an-id";
  assert.equal((await f.post(f.msg("2", "hi"))).status, 503);
  assert.equal(f.pending(), 0);
});

test("receipt means durably queued, not processed in waitUntil", async (t) => {
  const f = fixture();
  t.after(f.close);
  const response = await f.post(f.msg("2", "hello"));
  assert.equal(response.status, 200);
  assert.equal(f.pending(), 1);
  assert.equal(f.calls.length, 0);
  f.restart();
  await f.drain();
  assert.ok(
    f.calls.some((c) => c.method === "sendMessage" && c.chat_id === "2"),
  );
});

test("queue storage failures return 503 so Telegram can retry", async (t) => {
  const f = fixture();
  t.after(f.close);
  f.env.INBOX = {
    getByName: () => ({
      fetch: async () => {
        throw Error("storage unavailable");
      },
    }),
  };
  assert.equal((await f.post(f.msg("2", "hello"))).status, 503);
});

test("unsupported updates are ignored before persistence and ordinary message text is not archived", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.post(
    f.msg("2", "group", {}, { chat: { id: "-100", type: "group" } }),
  );
  await f.post(f.msg("2", "bot", null, { from: { id: "2", is_bot: true } }));
  assert.equal(f.pending(), 0);
  await f.post(f.msg("2", "private-message-content"));
  const queued = f.sql.exec("SELECT payload FROM jobs").toArray()[0].payload;
  assert.ok(!queued.includes("private-message-content"));
  assert.ok(queued.includes("message_id"));
});

test("body limit is measured in bytes even without Content-Length", async (t) => {
  const f = fixture();
  t.after(f.close);
  const response = await worker.fetch(
    new Request("https://test/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
      body: "中".repeat(400000),
    }),
    f.env,
  );
  assert.equal(response.status, 413);
  assert.equal(f.pending(), 0);
});

test("health distinguishes valid configuration from missing bindings", async (t) => {
  const f = fixture();
  t.after(f.close);
  assert.equal(
    (await worker.fetch(new Request("https://test/health"), f.env)).status,
    200,
  );
  delete f.env.INBOX;
  assert.equal(
    (await worker.fetch(new Request("https://test/health"), f.env)).status,
    503,
  );
});

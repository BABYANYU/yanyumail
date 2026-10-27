import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("unknown admin commands never become visitor replies; aliases still work", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.seed("route:42", { id: "2", name: "Example" });
  await f.post(f.msg("1", "/unknown_private_command", 42));
  await f.drain();
  assert.ok(!f.calls.some((c) => c.method === "copyMessage"));
  assert.ok(f.calls.some((c) => c.text?.includes("未知命令")));
  for (const command of ["/i", "/info", "/help", "/id"]) {
    await f.post(f.msg("1", command, 42));
    await f.drain();
  }
  assert.ok(!f.calls.some((c) => c.method === "copyMessage"));
  assert.ok(f.calls.some((c) => c.text === "ID：1"));
  await f.post(f.msg("1", "/t", 42));
  await f.drain();
  assert.equal(await f.get("trust:2"), true);
  await f.post(f.msg("1", "/ut", 42));
  await f.drain();
  assert.equal(await f.get("trust:2"), null);
});

test("visitor ID is rate limited, START parameters normalized, other commands ignored", async (t) => {
  const f = fixture();
  t.after(f.close);
  for (let i = 0; i < 25; i++) await f.post(f.msg("2", "/id"));
  await f.drain();
  assert.equal(
    f.calls.filter((c) => c.method === "sendMessage" && c.chat_id === "2")
      .length,
    20,
  );
  await f.seed("verified:3", true, 86400);
  await f.post(f.msg("3", "/START payload"));
  await f.post(f.msg("3", "/help"));
  await f.drain();
  assert.ok(
    f.calls.some((c) => c.chat_id === "3" && c.text?.includes("验证有效")),
  );
  assert.ok(!f.calls.some((c) => c.method === "copyMessage"));
});

test("legacy trust and route expiry migrate without writes; deletions cannot resurrect old trust", async (t) => {
  const f = fixture();
  t.after(f.close);
  f.legacy.set("trust:2", { value: true });
  f.legacy.set("verified:3", {
    value: true,
    expiration: Math.floor(f.clock.value / 1000) + 30,
  });
  assert.equal(await f.get("trust:2"), true);
  assert.equal(await f.get("verified:3"), true);
  await f.box.state.delete("trust:2");
  f.restart();
  assert.equal(await f.get("trust:2"), null);
  f.clock.value += 31000;
  assert.equal(await f.get("verified:3"), null);
  assert.equal(f.legacyWrites.length, 0);
});

test("source callback validation ignores groups and mismatched chat IDs before enqueue", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.post(
    f.callback("1", "a:b:2", {
      message: { chat: { id: "-100", type: "supergroup" } },
    }),
  );
  await f.post(
    f.callback("1", "a:b:2", {
      message: { chat: { id: "3", type: "private" } },
    }),
  );
  assert.equal(f.pending(), 0);
  assert.equal(await f.get("ban:2"), null);
});

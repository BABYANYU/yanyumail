import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("verification gates forwarding and admin replies route only by quoted message", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.post(f.msg("2", "before verification"));
  await f.drain();
  assert.equal(f.calls.filter((c) => c.method === "copyMessage").length, 0);
  const quiz = await f.get("quiz:2");
  await f.post(f.callback("2", `q:${quiz.nonce}:${quiz.answer}`));
  await f.drain();
  assert.equal(await f.get("verified:2"), true);
  await f.post(f.msg("2", "actual message"));
  await f.drain();
  const card = f.calls.find((c) => c.chat_id === "1" && c.reply_markup);
  assert.deepEqual(
    card.reply_markup.inline_keyboard[0].map((b) => b.text),
    ["拉黑", "解封", "信任", "信息"],
  );
  const inbound = f.calls.find(
    (c) => c.method === "copyMessage" && c.chat_id === "1",
  );
  assert.ok(inbound);
  assert.equal((await f.get("route:" + inbound.result.message_id)).id, "2");
  await f.post(f.msg("1", "answer", inbound.result.message_id));
  await f.drain();
  assert.ok(
    f.calls.some((c) => c.method === "copyMessage" && c.chat_id === "2"),
  );
  const before = f.calls.filter((c) => c.method === "copyMessage").length;
  await f.post(f.msg("1", "not quoted"));
  await f.drain();
  assert.equal(
    f.calls.filter((c) => c.method === "copyMessage").length,
    before,
  );
});

test("identity card actions preserve block, unblock, trust, untrust and info", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.seed("uid:2", { id: "2", name: "Example" });
  await f.seed("verified:2", true, 86400);
  for (const [action, key, value] of [
    ["b", "ban:2", true],
    ["u", "ban:2", null],
    ["t", "trust:2", true],
    ["x", "trust:2", null],
  ]) {
    await f.post(f.callback("1", "a:" + action + ":2"));
    await f.drain();
    assert.equal(await f.get(key), value);
  }
  assert.equal(await f.get("verified:2"), null);
  await f.post(f.callback("1", "a:i:2"));
  await f.drain();
  assert.ok(f.calls.some((c) => c.text?.includes("用户ID：2")));
  await f.post(f.callback("3", "a:b:2"));
  await f.drain();
  assert.equal(await f.get("ban:2"), null);
  await f.post(f.callback("1", "a:b:garbage"));
  await f.drain();
  assert.equal(await f.get("ban:garbage"), null);
});

test("banned visitors are silent and wrong answers have a three-try limit", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.seed("ban:2", true);
  await f.post(f.msg("2", "blocked"));
  await f.drain();
  assert.equal(f.calls.length, 0);
  await f.post(f.msg("3", "hi"));
  await f.drain();
  const quiz = await f.get("quiz:3");
  for (let i = 0; i < 4; i++) {
    await f.post(f.callback("3", `q:${quiz.nonce}:${quiz.answer + 4}`));
    await f.drain();
  }
  assert.equal(await f.get("verified:3"), null);
  assert.equal((await f.get("quiz:3")).tries, 3);
});

import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("retries do not consume the visitor rate budget again", async (t) => {
  let copies = 0;
  const f = fixture({
    telegram: (method) =>
      method === "copyMessage" && ++copies <= 21
        ? { ok: false, error_code: 429, parameters: { retry_after: 1 } }
        : null,
  });
  t.after(f.close);
  await f.seed("verified:2", true, 86400);
  await f.seed("intro:2", true, 86400);
  await f.post(f.msg("2", "retry the same update"));
  await f.drain(30);
  assert.equal(copies, 22);
  assert.equal(f.pending(), 0);
  const counters = f.sql
    .exec("SELECT value FROM state WHERE key LIKE 'rate:inbound:2:%'")
    .toArray();
  assert.equal(counters.length, 1);
  assert.equal(JSON.parse(counters[0].value), 1);
});

test("uncertain verification replies do not block unrelated contacts or repeatedly resend", async (t) => {
  const f = fixture({
    telegram: (method, data) =>
      method === "sendMessage" && data.chat_id === "2"
        ? Error("connection lost")
        : null,
  });
  t.after(f.close);
  await f.post(f.msg("2", "first contact"));
  await f.post(f.msg("3", "second contact"));
  await f.drain();
  assert.equal(f.calls.filter((c) => c.chat_id === "2").length, 1);
  assert.ok(f.calls.some((c) => c.chat_id === "3" && c.reply_markup));
  assert.equal(f.pending(), 0);
});

test("rapid successive messages all forward with zero writes to the legacy KV", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.seed("verified:2", true, 86400);
  await f.seed("intro:2", true, 86400);
  await Promise.all([
    f.post(f.msg("2", "first")),
    f.post(f.msg("2", "second")),
    f.post(f.msg("2", "third")),
  ]);
  await f.drain();
  assert.equal(f.calls.filter((c) => c.method === "copyMessage").length, 3);
  assert.equal(f.legacyWrites.length, 0);
});

test("concurrent and later duplicate updates are processed once", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.seed("verified:2", true, 86400);
  await f.seed("intro:2", true, 86400);
  const update = f.msg("2", "once");
  await Promise.all([f.post(update), f.post(update)]);
  await f.drain();
  await f.post(update);
  await f.drain();
  assert.equal(f.calls.filter((c) => c.method === "copyMessage").length, 1);
});

test("updates already acknowledged by the old deployment are not copied again during cutover", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.seed("verified:2", true, 86400);
  await f.seed("intro:2", true, 86400);
  const update = f.msg("2", "old update");
  f.legacy.set("update:" + update.update_id, {
    value: 1,
    expiration: Math.floor(f.clock.value / 1000) + 86400,
  });
  await f.post(update);
  await f.drain();
  assert.equal(f.calls.length, 0);
});

test("429 is durably deferred and succeeds after a restart", async (t) => {
  let copies = 0;
  const f = fixture({
    telegram: (method) =>
      method === "copyMessage" && ++copies === 1
        ? { ok: false, error_code: 429, parameters: { retry_after: 2 } }
        : null,
  });
  t.after(f.close);
  await f.seed("verified:2", true, 86400);
  await f.seed("intro:2", true, 86400);
  await f.post(f.msg("2", "retry"));
  await f.box.alarm();
  assert.equal(f.pending(), 1);
  f.restart();
  await f.drain();
  assert.equal(copies, 2);
  assert.equal(f.pending(), 0);
});

test("confirmed copies are not repeated when route persistence transiently fails", async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.seed("verified:2", true, 86400);
  await f.seed("intro:2", true, 86400);
  const put = f.box.state.put;
  let failed = false;
  f.box.state.put = async (key, ...args) => {
    if (key.startsWith("route:") && !failed) {
      failed = true;
      throw Object.assign(Error("temporary storage failure"), {
        retryable: true,
        after: 1,
      });
    }
    return put(key, ...args);
  };
  await f.post(f.msg("2", "hello"));
  await f.box.alarm();
  assert.equal(f.pending(), 1);
  await f.drain();
  assert.equal(f.calls.filter((c) => c.method === "copyMessage").length, 1);
  const copy = f.calls.find((c) => c.method === "copyMessage");
  assert.equal((await f.get("route:" + copy.result.message_id)).id, "2");
});

test("unknown network outcome is reported rather than blindly resending a copy", async (t) => {
  const f = fixture({
    telegram: (method) =>
      method === "copyMessage" ? Error("socket disconnected") : null,
  });
  t.after(f.close);
  await f.seed("verified:2", true, 86400);
  await f.seed("intro:2", true, 86400);
  const update = f.msg("2", "hello");
  await f.post(update);
  await f.drain();
  await f.post(update);
  await f.drain();
  assert.equal(f.calls.filter((c) => c.method === "copyMessage").length, 1);
  assert.ok(
    f.calls.some((c) => c.chat_id === "1" && c.text?.includes("状态未确认")),
  );
});

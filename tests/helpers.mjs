import { DatabaseSync } from "node:sqlite";
import worker, { Mailbox } from "../src/worker.mjs";

export function fixture(options = {}) {
  const db = new DatabaseSync(":memory:");
  const clock = { value: 1800000010000 };
  let alarmAt = null,
    sequence = 100000,
    update = 1,
    message = 1,
    transaction = Promise.resolve();
  const calls = [],
    legacy = new Map(),
    legacyWrites = [];
  const sql = {
    exec(query, ...params) {
      const statement = db.prepare(query);
      const rows = statement.columns().length
        ? statement.all(...params)
        : (statement.run(...params), []);
      return {
        toArray: () => rows,
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };
  const storage = {
    sql,
    sync: async () => {},
    getAlarm: async () => alarmAt,
    setAlarm: async (at) => {
      alarmAt = at;
    },
    deleteAlarm: async () => {
      alarmAt = null;
    },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    transaction(fn) {
      const next = transaction
        .catch(() => {})
        .then(async () => {
          db.exec("BEGIN");
          try {
            const value = await fn();
            db.exec("COMMIT");
            return value;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        });
      transaction = next;
      return next;
    },
  };
  const env = {
    ADMIN_ID: "1",
    BOT_TOKEN: "mock-token",
    WEBHOOK_SECRET: "test-secret",
    MAIL: {
      get: async (key) => {
        const item = legacy.get(key);
        return !item ||
          (item.expiration && item.expiration * 1000 <= clock.value)
          ? null
          : item.value;
      },
      list: async ({ prefix, limit }) => ({
        keys: [...legacy.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .sort()
          .slice(0, limit)
          .map(([name, item]) => ({
            name,
            ...(item.expiration ? { expiration: item.expiration } : {}),
          })),
      }),
      put: async () => {
        legacyWrites.push("unexpected");
        throw new Error(
          "legacy KV is read-only; never high-frequency write it",
        );
      },
    },
  };
  const ports = {
    now: () => clock.value,
    sleep: async (ms) => {
      clock.value += ms;
    },
    fetch: async (url, init) => {
      const method = url.split("/").at(-1),
        data = JSON.parse(init.body);
      const call = { method, ...data };
      calls.push(call);
      const override = await options.telegram?.(method, data, calls);
      if (override instanceof Error) throw override;
      if (override) return Response.json(override);
      const result =
        method === "answerCallbackQuery" ? true : { message_id: ++sequence };
      call.result = result;
      return Response.json({ ok: true, result });
    },
  };
  let box = new Mailbox({ storage }, env, ports);
  env.INBOX = { getByName: () => ({ fetch: (request) => box.fetch(request) }) };
  const post = (body, secret = env.WEBHOOK_SECRET) =>
    worker.fetch(
      new Request("https://test/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify(body),
      }),
      env,
    );
  const msg = (id, text = "", reply, extra = {}) => ({
    update_id: update++,
    message: {
      message_id: message++,
      chat: { id: String(id), type: "private" },
      from: { id: String(id), first_name: "Example", username: "example" },
      text,
      ...(reply ? { reply_to_message: { message_id: reply } } : {}),
      ...extra,
    },
  });
  const callback = (id, data, extra = {}) => ({
    update_id: update++,
    callback_query: {
      id: `callback-${message++}`,
      from: { id: String(id) },
      message: { chat: { id: String(id), type: "private" } },
      data,
      ...extra,
    },
  });
  const pending = () =>
    sql.exec("SELECT COUNT(*) AS count FROM jobs").toArray()[0].count;
  const drain = async (maximum = 30) => {
    for (let i = 0; pending() && i < maximum; i++) {
      clock.value = Math.max(clock.value, alarmAt ?? clock.value);
      await box.alarm();
    }
    if (pending()) throw new Error("Queue did not finish");
  };
  return {
    env,
    sql,
    clock,
    calls,
    legacy,
    legacyWrites,
    post,
    msg,
    callback,
    drain,
    pending,
    get box() {
      return box;
    },
    restart() {
      box = new Mailbox({ storage }, env, ports);
    },
    seed: (key, value, ttl) => box.state.put(key, value, ttl),
    get: (key) => box.state.get(key),
    close: () => db.close(),
  };
}

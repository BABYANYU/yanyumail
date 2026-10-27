import { handleUpdate } from "./bot.mjs";

const DAY = 86400000;
const MAX_PENDING = 1000;
const LEGACY_KEYS = /^(ban|trust|verified|intro|quiz|uid|route):/;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RetryableError extends Error {
  constructor(seconds = 2) {
    super("temporary delivery failure");
    this.retryable = true;
    this.after = seconds;
  }
}
class DeliveryError extends Error {
  constructor(uncertain = false) {
    super(uncertain ? "delivery uncertain" : "delivery rejected");
    this.uncertain = uncertain;
  }
}

// A single SQLite-backed object owns the queue and all mutable bot state.
// MAIL is read-only legacy storage. Deleted migrated values remain tombstones.
export class Mailbox {
  constructor(ctx, env, ports = {}) {
    this.ctx = ctx;
    this.env = env;
    this.now = ports.now ?? (() => Date.now());
    this.sleep = ports.sleep ?? delay;
    this.network = ports.fetch ?? ((...args) => fetch(...args));
    this.lastSend = new Map();
    this.lastCleanup = 0;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER)",
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS state_expiry ON state(expires)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY, finished INTEGER NOT NULL)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS receipts_expiry ON receipts(finished)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS effects (job INTEGER NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, PRIMARY KEY(job,signature))",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS effects_expiry ON effects(created)",
    );
    this.sql.exec(
      "INSERT OR IGNORE INTO state(key,value,expires) VALUES('__cutover',?,NULL)",
      JSON.stringify(this.now()),
    );
    this.cutover = JSON.parse(
      this.sql
        .exec("SELECT value FROM state WHERE key='__cutover'")
        .toArray()[0].value,
    );
    this.state = {
      get: async (key) => {
        try {
          return await this.readState(key);
        } catch {
          throw new RetryableError();
        }
      },
      put: async (key, value, ttl) => {
        try {
          this.sql.exec(
            "INSERT INTO state(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires",
            key,
            JSON.stringify(value),
            ttl ? this.now() + ttl * 1000 : null,
          );
        } catch {
          throw new RetryableError();
        }
      },
      delete: async (key) => {
        try {
          this.sql.exec(
            "INSERT INTO state(key,value,expires) VALUES(?,'null',NULL) ON CONFLICT(key) DO UPDATE SET value='null',expires=NULL",
            key,
          );
        } catch {
          throw new RetryableError();
        }
      },
    };
  }

  async readState(key) {
    const row = this.sql
      .exec("SELECT value,expires FROM state WHERE key=?", key)
      .toArray()[0];
    if (row)
      return row.expires !== null && row.expires <= this.now()
        ? null
        : JSON.parse(row.value);
    if (!LEGACY_KEYS.test(key) || !this.env.MAIL) return null;
    const value = await this.env.MAIL.get(key, "json");
    if (value === null) {
      await this.state.put(key, null, 300);
      return null;
    }
    // Preserve original expiry, rather than silently giving old verification a new 24 hours.
    const listing = await this.env.MAIL.list({ prefix: key, limit: 10 });
    const entry = listing.keys.find((item) => item.name === key);
    if (!entry) throw new RetryableError();
    const remaining =
      entry.expiration === undefined
        ? undefined
        : Math.ceil(entry.expiration - this.now() / 1000);
    if (remaining !== undefined && remaining <= 0) {
      await this.state.put(key, null, 300);
      return null;
    }
    await this.state.put(key, value, remaining);
    return value;
  }

  cleanup() {
    if (this.now() - this.lastCleanup < 3600000) return;
    this.sql.exec(
      "DELETE FROM state WHERE expires IS NOT NULL AND expires<=?",
      this.now(),
    );
    this.sql.exec("DELETE FROM receipts WHERE finished<?", this.now() - DAY);
    this.sql.exec(
      "DELETE FROM effects WHERE created<? AND job NOT IN (SELECT id FROM jobs)",
      this.now() - DAY,
    );
    this.lastCleanup = this.now();
  }

  async wake(at) {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > at) await this.ctx.storage.setAlarm(at);
  }

  async fetch(request) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/enqueue"
    )
      return new Response("Not found", { status: 404 });
    const update = await request.json();
    this.cleanup();
    const known = this.sql
      .exec(
        "SELECT id FROM receipts WHERE id=? UNION ALL SELECT id FROM jobs WHERE id=?",
        update.update_id,
        update.update_id,
      )
      .toArray().length;
    const legacyDone =
      !known &&
      this.now() - this.cutover < DAY &&
      (await this.env.MAIL.get("update:" + update.update_id, "json"));
    await this.ctx.storage.transaction(async () => {
      if (
        this.sql
          .exec("SELECT id FROM receipts WHERE id=?", update.update_id)
          .toArray().length
      )
        return;
      if (legacyDone) {
        this.sql.exec(
          "INSERT INTO receipts(id,finished) VALUES(?,?)",
          update.update_id,
          this.now(),
        );
        return;
      }
      if (
        !this.sql
          .exec("SELECT id FROM jobs WHERE id=?", update.update_id)
          .toArray().length
      ) {
        const count = this.sql
          .exec("SELECT COUNT(*) AS count FROM jobs")
          .toArray()[0].count;
        if (count >= MAX_PENDING) throw new RetryableError();
        this.sql.exec(
          "INSERT INTO jobs(id,payload,created) VALUES(?,?,?)",
          update.update_id,
          JSON.stringify(update),
          this.now(),
        );
      }
      await this.wake(this.now() + 1);
    });
    // This response is released only after the job and its wakeup are durable.
    return new Response("ok");
  }

  async signature(method, data) {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([method, data])),
    );
    return [...new Uint8Array(bytes)]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  }

  rate(job, id, key, maximum, seconds) {
    try {
      return this.ctx.storage.transactionSync(() => {
        const decisionKey = `budget:${job.id}:${key}:${id}`;
        const decision = this.sql
          .exec("SELECT value FROM state WHERE key=?", decisionKey)
          .toArray()[0];
        if (decision) return JSON.parse(decision.value);
        const counterKey = `rate:${key}:${id}:${Math.floor(this.now() / 1000 / seconds)}`;
        const row = this.sql
          .exec("SELECT value FROM state WHERE key=?", counterKey)
          .toArray()[0];
        const count = (row ? JSON.parse(row.value) : 0) + 1;
        const allowed = count <= maximum;
        this.sql.exec(
          "INSERT INTO state(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires",
          counterKey,
          JSON.stringify(count),
          this.now() + Math.max(60, seconds * 2) * 1000,
        );
        this.sql.exec(
          "INSERT INTO state(key,value,expires) VALUES(?,?,?)",
          decisionKey,
          JSON.stringify(allowed),
          this.now() + DAY,
        );
        return allowed;
      });
    } catch {
      throw new RetryableError();
    }
  }

  async telegram(job, method, data) {
    try {
      return await this.sendTelegram(job, method, data);
    } catch (error) {
      if (error instanceof RetryableError || error instanceof DeliveryError)
        throw error;
      throw new RetryableError();
    }
  }

  async sendTelegram(job, method, data) {
    const callbackAck = method === "answerCallbackQuery";
    const signature = callbackAck ? null : await this.signature(method, data);
    if (signature) {
      const record = this.sql
        .exec(
          "SELECT status,result FROM effects WHERE job=? AND signature=?",
          job.id,
          signature,
        )
        .toArray()[0];
      if (record?.status === "done") return JSON.parse(record.result);
      if (record?.status === "sending" || record?.status === "uncertain")
        throw new DeliveryError(true);
      if (record?.status === "rejected") throw new DeliveryError();
    }
    if (!callbackAck) {
      const chat = String(data.chat_id);
      const gap = (this.lastSend.get(chat) ?? 0) + 1050 - this.now();
      if (gap > 0) await this.sleep(gap);
      this.lastSend.set(chat, this.now());
      this.sql.exec(
        "INSERT INTO effects(job,signature,status,created) VALUES(?,?,'sending',?) ON CONFLICT(job,signature) DO UPDATE SET status='sending'",
        job.id,
        signature,
        this.now(),
      );
      await this.ctx.storage.sync();
    }
    let response, body;
    try {
      response = await this.network(
        `https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(callbackAck ? 3000 : 12000),
        },
      );
      body = await response.json();
    } catch {
      if (signature)
        this.sql.exec(
          "UPDATE effects SET status='uncertain' WHERE job=? AND signature=?",
          job.id,
          signature,
        );
      throw new DeliveryError(true);
    }
    if (body.ok !== true) {
      const retryable = body.error_code === 429 || body.error_code >= 500;
      if (signature)
        this.sql.exec(
          "UPDATE effects SET status=? WHERE job=? AND signature=?",
          retryable ? "retry" : "rejected",
          job.id,
          signature,
        );
      if (retryable)
        throw new RetryableError(
          Math.max(
            1,
            Math.min(3600, Number(body.parameters?.retry_after) || 3),
          ),
        );
      throw new DeliveryError();
    }
    const result = body.result?.message_id
      ? { message_id: body.result.message_id }
      : true;
    if (signature)
      this.sql.exec(
        "UPDATE effects SET status='done',result=? WHERE job=? AND signature=?",
        JSON.stringify(result),
        job.id,
        signature,
      );
    return result;
  }

  async alarm() {
    // One alarm handler runs at a time, so rate counters and admin deliveries are serialized.
    // Process a small batch, then yield to another durable alarm.
    for (let i = 0; i < 4; i++) {
      const job = this.sql
        .exec("SELECT * FROM jobs ORDER BY id LIMIT 1")
        .toArray()[0];
      if (!job) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      if (job.not_before > this.now()) {
        await this.ctx.storage.setAlarm(job.not_before);
        return;
      }
      const runtime = {
        ...this.env,
        STATE: this.state,
        CLOCK: this.now,
        RATE: (id, key, maximum, seconds) =>
          this.rate(job, id, key, maximum, seconds),
        TELEGRAM: (method, data) => this.telegram(job, method, data),
      };
      try {
        await handleUpdate(runtime, JSON.parse(job.payload));
        await this.ctx.storage.transaction(async () => {
          this.sql.exec(
            "INSERT OR REPLACE INTO receipts(id,finished) VALUES(?,?)",
            job.id,
            this.now(),
          );
          this.sql.exec("DELETE FROM jobs WHERE id=?", job.id);
        });
      } catch (error) {
        if (error instanceof DeliveryError) {
          // Verification/control replies may be rejected or have an ambiguous outcome.
          // Do not replay an unknown send indefinitely or block unrelated contacts.
          await this.ctx.storage.transaction(async () => {
            this.sql.exec(
              "INSERT OR REPLACE INTO receipts(id,finished) VALUES(?,?)",
              job.id,
              this.now(),
            );
            this.sql.exec("DELETE FROM jobs WHERE id=?", job.id);
          });
          console.error("mailbox reply not confirmed", {
            uncertain: error.uncertain,
          });
          continue;
        }
        // Keep the payload and retry time until processing succeeds; never ACK and forget it.
        const attempts = job.attempts + 1;
        const seconds = error.retryable
          ? error.after
          : Math.min(300, 2 ** Math.min(attempts, 8));
        this.sql.exec(
          "UPDATE jobs SET attempts=?,not_before=? WHERE id=?",
          attempts,
          this.now() + seconds * 1000,
          job.id,
        );
        await this.ctx.storage.setAlarm(this.now() + seconds * 1000);
        console.error("mailbox job deferred", {
          attempts,
          type: error.retryable ? "upstream" : "storage",
        });
        return;
      }
    }
    await this.ctx.storage.setAlarm(this.now() + 50);
  }
}

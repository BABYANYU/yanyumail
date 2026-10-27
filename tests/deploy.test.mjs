import test from "node:test";
import assert from "node:assert/strict";
import { prepareConfig, readTemplate } from "../scripts/deploy.mjs";

test('deployment accepts valid JSONC comments and trailing commas but rejects malformed configuration',()=>{
 assert.equal(readTemplate('{/* config */ "name":"yanyumail",}').name,'yanyumail');
 assert.throws(()=>readTemplate('{"name":'));
});

const template = {
  name: "yanyumail",
  main: "src/worker.mjs",
  kv_namespaces: [{ binding: "MAIL", id: "placeholder" }],
};
const bindings = [
  { name: "MAIL", type: "kv_namespace", namespace_id: "a".repeat(32) },
  { name: "ADMIN_ID", type: "plain_text", text: "12345678" },
  { name: "BOT_TOKEN", type: "secret_text" },
  { name: "WEBHOOK_SECRET", type: "secret_text" },
];
test("deployment uses the existing namespace and preserves dashboard variables without copying their values", () => {
  const result = prepareConfig(template, { resources: { bindings } });
  assert.equal(result.keep_vars, true);
  assert.equal(result.kv_namespaces[0].id, "a".repeat(32));
  assert.ok(!JSON.stringify(result).includes("12345678"));
  assert.equal(result.vars, undefined);
});
test("deployment refuses a missing namespace, administrator or secret", () => {
  for (const name of ["MAIL", "ADMIN_ID", "BOT_TOKEN", "WEBHOOK_SECRET"]) {
    assert.throws(() =>
      prepareConfig(template, {
        resources: { bindings: bindings.filter((item) => item.name !== name) },
      }),
    );
  }
  assert.throws(() =>
    prepareConfig(
      { ...template, name: "other-worker" },
      { resources: { bindings } },
    ),
  );
});

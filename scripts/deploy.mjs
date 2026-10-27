import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "node_modules/wrangler/bin/wrangler.js");

export function prepareConfig(template, metadata) {
  if (template.name !== "yanyumail") throw new Error("Unexpected Worker name");
  const bindings = metadata.resources?.bindings ?? [];
  const mail = bindings.find(
    (item) => item.name === "MAIL" && item.type === "kv_namespace",
  );
  const admin = bindings.find(
    (item) => item.name === "ADMIN_ID" && item.type === "plain_text",
  );
  if (!mail || !/^[a-f0-9]{32}$/i.test(mail.namespace_id))
    throw new Error("Existing MAIL binding is missing or invalid");
  if (!admin || !/^[1-9]\d{0,15}$/.test(String(admin.text)))
    throw new Error(
      "Existing administrator configuration is missing or invalid",
    );
  for (const name of ["BOT_TOKEN", "WEBHOOK_SECRET"]) {
    if (
      !bindings.some(
        (item) => item.name === name && item.type === "secret_text",
      )
    )
      throw new Error(`Required secret ${name} is missing`);
  }
  return {
    ...template,
    keep_vars: true,
    kv_namespaces: [{ binding: "MAIL", id: mail.namespace_id }],
  };
}

export async function main(checkOnly = false) {
  const hidden = [];
  const redact = (value) =>
    hidden.reduce(
      (text, item) => text.split(item).join("[redacted]"),
      String(value),
    );
  const command = (args) => {
    try {
      return execFileSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      // Never print a raw SDK error object, which can contain configuration values.
      throw new Error(
        "Cloudflare command failed; verify login, Worker access and deployment status.",
      );
    }
  };
  const template = JSON.parse(
    await readFile(path.join(root, "wrangler.jsonc"), "utf8"),
  );
  const deployments = JSON.parse(
    command(["deployments", "list", "--name", template.name, "--json"]),
  );
  const active = deployments.sort((a, b) =>
    b.created_on.localeCompare(a.created_on),
  )[0];
  if (active?.versions?.length !== 1 || active.versions[0].percentage !== 100)
    throw new Error("Expected one active production version");
  const version = active.versions[0].version_id;
  if (
    process.env.EXPECTED_WORKER_VERSION &&
    process.env.EXPECTED_WORKER_VERSION !== version
  )
    throw new Error(
      "Production changed since review; inspect before deploying",
    );
  const metadata = JSON.parse(
    command(["versions", "view", version, "--name", template.name, "--json"]),
  );
  for (const binding of metadata.resources?.bindings ?? []) {
    for (const value of [binding.text, binding.namespace_id])
      if (typeof value === "string" && value.length >= 6) hidden.push(value);
  }
  const config = prepareConfig(template, metadata);
  const destination = path.join(root, ".wrangler/runtime.jsonc");
  config.main = "../" + template.main;
  delete config.$schema;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(config, null, 2) + "\n");
  console.log(
    "Preflight passed: existing MAIL and dashboard variables will be preserved; secrets remain encrypted.",
  );
  const args = ["deploy", "--config", destination];
  if (checkOnly) args.push("--dry-run");
  console.log(redact(command(args)));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.includes("--check")).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

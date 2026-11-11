import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyModelCredentials,
  credentialsPath,
  listCredentials,
  maskSecret,
  readCredentials,
  redactText,
  registerSecrets,
  removeCredential,
  setCredential
} from "../lib/credentials.js";

const MF = fileURLToPath(new URL("../mf.js", import.meta.url));

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "mf-cred-"));
  process.env.MF_CONFIG_DIR = dir;
  return dir;
}

function runCli(args, { env = {}, input = "" } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [MF, ...args], {
      env: { ...process.env, MF_NO_USAGE: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

test("setCredential stores a key with owner-only permissions and masks it in listings", async () => {
  const dir = await tempDir();
  try {
    const result = await setCredential("DEEPSEEK_API_KEY", "sk-test-1234567890");
    assert.equal(result.name, "DEEPSEEK_API_KEY");
    assert.equal(credentialsPath(), join(dir, "credentials.json"));

    const stored = await readCredentials();
    assert.equal(stored.DEEPSEEK_API_KEY, "sk-test-1234567890");

    const listed = await listCredentials();
    assert.deepEqual(listed, [{ name: "DEEPSEEK_API_KEY", masked: "sk-…7890" }]);
    assert.ok(!JSON.stringify(listed).includes("sk-test-1234567890"));

    if (process.platform !== "win32") {
      const info = await stat(credentialsPath());
      assert.equal(info.mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stored keys fill only missing model env vars and never override the environment", async () => {
  const dir = await tempDir();
  const savedDeepseek = process.env.DEEPSEEK_API_KEY;
  const savedOpenai = process.env.OPENAI_API_KEY;
  try {
    await setCredential("DEEPSEEK_API_KEY", "stored-deepseek-key");
    await setCredential("UNRELATED_TOKEN", "should-not-be-applied");
    process.env.OPENAI_API_KEY = "from-env";
    delete process.env.DEEPSEEK_API_KEY;

    const filled = await applyModelCredentials({
      deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY" },
      openai: { apiKeyEnv: "OPENAI_API_KEY" }
    });

    assert.deepEqual(filled, ["DEEPSEEK_API_KEY"]);
    assert.equal(process.env.DEEPSEEK_API_KEY, "stored-deepseek-key");
    assert.equal(process.env.OPENAI_API_KEY, "from-env");
    assert.equal(process.env.UNRELATED_TOKEN, undefined);
  } finally {
    if (savedDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedDeepseek;
    if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenai;
    delete process.env.UNRELATED_TOKEN;
    await rm(dir, { recursive: true, force: true });
  }
});

test("MODEL_API_KEY is loaded as a provider-neutral fallback", async () => {
  const dir = await tempDir();
  const saved = process.env.MODEL_API_KEY;
  try {
    await setCredential("MODEL_API_KEY", "sk-neutral-fallback");
    delete process.env.MODEL_API_KEY;

    const filled = await applyModelCredentials({
      any: { apiKeyEnv: "ANY_PROVIDER_KEY" }
    });
    assert.ok(filled.includes("MODEL_API_KEY"));
    assert.equal(process.env.MODEL_API_KEY, "sk-neutral-fallback");
  } finally {
    if (saved === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeCredential deletes one key and leaves the rest", async () => {
  const dir = await tempDir();
  try {
    await setCredential("DEEPSEEK_API_KEY", "sk-keep-this-one");
    await setCredential("OPENAI_API_KEY", "sk-remove-this-one");

    const removed = await removeCredential("OPENAI_API_KEY");
    assert.equal(removed.removed, true);
    assert.deepEqual(await readCredentials(), { DEEPSEEK_API_KEY: "sk-keep-this-one" });

    const again = await removeCredential("OPENAI_API_KEY");
    assert.equal(again.removed, false);

    await assert.rejects(() => removeCredential("lowercase"), /invalid environment variable name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a malformed credentials file never echoes its secrets", async () => {
  const dir = await tempDir();
  try {
    await writeFile(credentialsPath(), '{"DEEPSEEK_API_KEY": "sk-secret-value"\n', "utf8");
    await assert.rejects(
      () => readCredentials(),
      (error) => {
        assert.match(error.message, /not valid JSON/);
        assert.ok(!error.message.includes("sk-secret-value"));
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redactText masks registered values and common key shapes", () => {
  registerSecrets(["my-very-secret-key"]);
  assert.equal(redactText("key=my-very-secret-key"), "key=***");
  assert.equal(redactText("Authorization: Bearer abc.def-123456"), "Authorization: Bearer ***");
  assert.equal(redactText("token sk-abcdefgh1234"), "token ***");
  assert.equal(maskSecret("short"), "********");
});

test("mf config set-key reads hidden input from a pipe and list never prints the value", async () => {
  const dir = await tempDir();
  try {
    const set = await runCli(["config", "set-key", "DEEPSEEK_API_KEY"], {
      env: { MF_CONFIG_DIR: dir },
      input: "sk-cli-secret-9999\n"
    });
    assert.equal(set.code, 0, set.stderr);

    const stored = JSON.parse(await readFile(join(dir, "credentials.json"), "utf8"));
    assert.equal(stored.DEEPSEEK_API_KEY, "sk-cli-secret-9999");

    const listed = await runCli(["config", "list"], { env: { MF_CONFIG_DIR: dir } });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /DEEPSEEK_API_KEY/);
    assert.match(listed.stdout, /sk-…9999/);
    assert.ok(!listed.stdout.includes("sk-cli-secret-9999"));

    const path = await runCli(["config", "path"], { env: { MF_CONFIG_DIR: dir } });
    assert.equal(path.stdout.trim(), join(dir, "credentials.json"));

    const removed = await runCli(["config", "remove-key", "DEEPSEEK_API_KEY"], { env: { MF_CONFIG_DIR: dir } });
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /removed DEEPSEEK_API_KEY/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "credentials.json"), "utf8")), {});

    const empty = await runCli(["config", "list"], { env: { MF_CONFIG_DIR: dir } });
    assert.match(empty.stdout, /no stored keys/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mf config rejects invalid names and unknown subcommands", async () => {
  const dir = await tempDir();
  try {
    const invalid = await runCli(["config", "set-key", "lowercase"], {
      env: { MF_CONFIG_DIR: dir },
      input: "value\n"
    });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /invalid environment variable name/);

    const unknown = await runCli(["config", "nope"], { env: { MF_CONFIG_DIR: dir } });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /usage: mf config/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

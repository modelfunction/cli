import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MAX_BYTES = 1_000_000;
const MAX_STDERR = 4_000;
const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const CLIENT_INFO = { name: "mf", version: PACKAGE.version };
const PROTOCOL_VERSION = "2025-06-18";

// Streamable HTTP is the current remote MCP transport. Headers come from the
// user's own config and are never copied into reports or logs.
export async function probeHttpServer(server, { timeoutMs = 5_000 } = {}) {
  if (!server?.url) return { ok: false, error: "missing url" };
  let url;
  try {
    url = new URL(server.url);
  } catch {
    return { ok: false, error: "invalid url" };
  }

  const client = new Client(CLIENT_INFO);
  const headers = server.headers && Object.keys(server.headers).length > 0 ? server.headers : null;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: headers ? { headers } : undefined
  });

  try {
    await withTimeout(client.connect(transport), timeoutMs, "connect");
    const result = await withTimeout(client.listTools(), timeoutMs, "tools/list");
    return { ok: true, tools: normalizeTools(result?.tools ?? []) };
  } catch (error) {
    return { ok: false, error: `http: ${scrubUrl(error?.message ?? error, url)}` };
  } finally {
    await client.close().catch(() => {});
  }
}

function withTimeout(promise, ms, label) {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

function scrubUrl(message, url) {
  let text = String(message ?? "");
  text = text.split(url.href).join(`${url.origin}${url.pathname}`);
  if (url.search) text = text.split(url.search).join("");
  return text;
}

function normalizeTools(tools) {
  return tools
    .filter((tool) => typeof tool?.name === "string" && tool.name.trim() !== "")
    .map((tool) => ({
      name: tool.name.trim(),
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} }
    }));
}

export async function probeStdioServer(server, { timeoutMs = 5_000, cwd } = {}) {
  if (!server?.command) {
    return { ok: false, error: "missing command" };
  }

  let child;
  try {
    child = spawn(server.command, server.args ?? [], {
      cwd,
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
  } catch (error) {
    return { ok: false, error: `spawn failed: ${error.message}` };
  }

  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let received = 0;
  let failure = null;
  let settled = false;

  const fail = (message) => {
    if (!failure) failure = message;
  };

  const rejectAll = () => {
    for (const [, waiter] of pending) waiter.reject(new Error(failure ?? "server closed"));
    pending.clear();
  };

  const stop = () => {
    if (!child || child.killed) return;
    try {
      child.kill();
    } catch {
      // ignore
    }
  };

  const send = (payload) => {
    if (!child.stdin.writable) throw new Error("stdin closed");
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });

  const onLine = (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message ?? "rpc error"));
    } else {
      waiter.resolve(message.result);
    }
  };

  child.stdout.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_BYTES) {
      fail("response exceeded 1MB");
      stop();
      return;
    }
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      onLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
  });

  child.on("error", (error) => {
    fail(`spawn failed: ${error.message}`);
    rejectAll();
  });

  child.on("exit", (code) => {
    if (settled) return;
    fail(`server exited (code ${code})`);
    rejectAll();
  });

  const timer = setTimeout(() => {
    fail(`timeout after ${timeoutMs}ms`);
    stop();
    rejectAll();
  }, timeoutMs);

  try {
    await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const result = await request("tools/list", {});
    return { ok: true, tools: normalizeTools(result?.tools ?? []) };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message ?? error),
      stderr: stderr.trim().slice(0, 500)
    };
  } finally {
    settled = true;
    clearTimeout(timer);
    rejectAll();
    stop();
  }
}

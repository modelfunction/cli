import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOpenAiAdapter } from "../lib/adapters/openai.js";

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function successBody() {
  return JSON.stringify({
    choices: [
      {
        message: {
          tool_calls: [{ function: { name: "search", arguments: "{\"q\":\"x\"}" } }]
        }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  });
}

test("retries a 429 and reports the retry count", async () => {
  process.env.MF_TEST_KEY = "test";
  let calls = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    calls += 1;
    req.resume();
    if (calls === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(successBody());
  });
  try {
    const adapter = createOpenAiAdapter({
      id: "t",
      baseUrl,
      model: "test-model",
      apiKeyEnv: "MF_TEST_KEY",
      retries: 1
    });
    const result = await adapter.call({ messages: [{ role: "user", content: "hi" }], tools: [] });
    assert.equal(result.ok, true);
    assert.equal(result.retries, 1);
    assert.equal(calls, 2);
    assert.equal(result.toolCalls[0].name, "search");
    assert.deepEqual(result.toolCalls[0].arguments, { q: "x" });
  } finally {
    await close(server);
  }
});

test("gives up after the configured retries and keeps the last error", async () => {
  process.env.MF_TEST_KEY = "test";
  let calls = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    calls += 1;
    req.resume();
    res.writeHead(504, { "content-type": "text/plain" });
    res.end("gateway timeout");
  });
  try {
    const adapter = createOpenAiAdapter({
      id: "t",
      baseUrl,
      model: "test-model",
      apiKeyEnv: "MF_TEST_KEY",
      retries: 0
    });
    const result = await adapter.call({ messages: [{ role: "user", content: "hi" }], tools: [] });
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 504/);
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test("min-interval spaces consecutive requests", async () => {
  process.env.MF_TEST_KEY = "test";
  const stamps = [];
  const { server, baseUrl } = await startServer((req, res) => {
    stamps.push(Date.now());
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(successBody());
  });
  try {
    const adapter = createOpenAiAdapter({
      id: "t",
      baseUrl,
      model: "test-model",
      apiKeyEnv: "MF_TEST_KEY",
      retries: 0,
      minIntervalMs: 150
    });
    await adapter.call({ messages: [{ role: "user", content: "one" }], tools: [] });
    await adapter.call({ messages: [{ role: "user", content: "two" }], tools: [] });
    assert.equal(stamps.length, 2);
    assert.ok(stamps[1] - stamps[0] >= 120, `expected >=120ms spacing, got ${stamps[1] - stamps[0]}ms`);
  } finally {
    await close(server);
  }
});

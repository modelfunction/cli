import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { probeHttpServer } from "../lib/mcp-probe.js";
import { redactReport } from "../lib/scan.js";

function buildMcpServer() {
  const mcp = new McpServer({ name: "test", version: "0" });
  mcp.registerTool(
    "echo_text",
    { description: "Echo the given text.", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] })
  );
  return mcp;
}

// Stateless MCP servers need a fresh server/transport pair per request.
async function startMcpServer() {
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const mcp = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    }
  });

  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { http, port: http.address().port };
}

test("probeHttpServer lists tools over streamable HTTP with headers", async () => {
  const { http, port } = await startMcpServer();
  try {
    const result = await probeHttpServer(
      {
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: "Bearer test-token" }
      },
      { timeoutMs: 5_000 }
    );
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      ["echo_text"]
    );
    assert.equal(result.tools[0].parameters.properties.text.type, "string");
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
});

test("probeHttpServer fails cleanly and does not leak URL or header secrets", async () => {
  const { http, port } = await startMcpServer();
  await new Promise((resolve) => http.close(resolve));

  const result = await probeHttpServer(
    {
      url: `http://127.0.0.1:${port}/mcp?token=secret-value`,
      headers: { Authorization: "Bearer secret-token" }
    },
    { timeoutMs: 2_000 }
  );
  assert.equal(result.ok, false);
  assert.ok(!String(result.error).includes("secret-value"));
  assert.ok(!String(result.error).includes("secret-token"));
});

test("probeHttpServer rejects invalid URLs", async () => {
  const result = await probeHttpServer({ url: "not a url" });
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid url/);
});

test("scan reports redact remote MCP headers and URL secrets", () => {
  const report = redactReport({
    mcpServers: [
      {
        name: "remote",
        transport: "http",
        command: null,
        args: [],
        url: "https://user:pass@example.com/mcp?token=secret&x=1",
        headers: { Authorization: "Bearer secret-token" },
        env: { API_KEY: "secret" }
      }
    ]
  });
  const text = JSON.stringify(report);
  assert.ok(!text.includes("secret-token"));
  assert.ok(!text.includes("token=secret"));
  assert.ok(!text.includes("user:pass"));
  assert.equal(report.mcpServers[0].url, "https://example.com/mcp");
  assert.deepEqual(report.mcpServers[0].headerKeys, ["Authorization"]);
  assert.deepEqual(report.mcpServers[0].envKeys, ["API_KEY"]);
});

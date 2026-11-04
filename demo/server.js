import http from "node:http";
import crypto from "node:crypto";
import { scoreResume } from "./scorer.js";

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.DEMO_API_KEY || "sk_demo_local";
const RATE_LIMIT = 60;
const WINDOW_MS = 60_000;
const MAX_BODY = 1_000_000;

const usage = { total_calls: 0, by_function: {}, calls: [] };
const buckets = new Map();

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With");
}

function send(res, status, body, extraHeaders = {}) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message) {
  send(res, status, { error: { code, message } });
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  return header === `Bearer ${API_KEY}`;
}

function rateLimit(key) {
  const now = Date.now();
  const bucket = buckets.get(key) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + WINDOW_MS;
  }
  bucket.count += 1;
  buckets.set(key, bucket);
  return {
    ok: bucket.count <= RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - bucket.count),
    resetAt: bucket.resetAt
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function recordCall({ requestId, functionName, startedAt, result, status }) {
  const entry = {
    id: requestId,
    function: functionName,
    at: new Date().toISOString(),
    latency_ms: Date.now() - startedAt,
    status,
    input_chars: result && result.usage ? result.usage.input_chars : 0,
    output_chars: result && result.usage ? result.usage.output_chars : 0
  };
  usage.total_calls += 1;
  usage.by_function[functionName] = (usage.by_function[functionName] || 0) + 1;
  usage.calls.unshift(entry);
  if (usage.calls.length > 100) usage.calls.pop();
  console.log(`[${entry.at}] ${entry.function} ${status} ${entry.latency_ms}ms ${requestId}`);
}

function docsPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>ModelFunction demo API</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;background:#0b0b12;color:#e8e8f0;line-height:1.7}code,pre{background:#151522;padding:2px 6px;border-radius:5px}pre{padding:14px;overflow:auto}a{color:#22d3ee}</style>
</head>
<body>
<h1>ModelFunction demo API</h1>
<p>本地演示：简历与 JD 匹配评分。默认 API Key 为 <code>sk_demo_local</code>。</p>
<h2>调用</h2>
<pre>curl -X POST http://127.0.0.1:${PORT}/v1/fn/resume_score \\
  -H "Authorization: Bearer sk_demo_local" \\
  -H "Content-Type: application/json" \\
  -d '{"resume":"5 年 Python 后端经验，熟悉 MySQL、Redis、Docker","jd":"招聘 Python 后端，要求 3 年以上，熟悉 MySQL、Redis、Docker"}'</pre>
<h2>其他端点</h2>
<ul>
  <li><code>GET /health</code></li>
  <li><code>GET /v1/usage</code>（需要 Key）</li>
  <li><code>POST /v1/fn/resume_score</code>（需要 Key）</li>
</ul>
<p>MCP：<code>npm run mcp</code>，或用 <code>npm test</code> 跑一遍 MCP 客户端测试。</p>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true, service: "modelfunction-demo", version: "0.1.0" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    cors(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(docsPage());
    return;
  }

  if (!url.pathname.startsWith("/v1/")) {
    fail(res, 404, "not_found", "Route not found");
    return;
  }

  if (!isAuthorized(req)) {
    fail(res, 401, "unauthorized", "Missing or invalid API key");
    return;
  }

  const key = req.headers.authorization || "anonymous";
  const limit = rateLimit(key);
  if (!limit.ok) {
    send(
      res,
      429,
      { error: { code: "rate_limited", message: "Too many requests" } },
      {
        "Retry-After": String(Math.ceil((limit.resetAt - Date.now()) / 1000)),
        "X-RateLimit-Remaining": "0"
      }
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/usage") {
    send(res, 200, usage);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/fn/resume_score") {
    const requestId = "req_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const startedAt = Date.now();
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      fail(res, 400, "invalid_body", err.message);
      return;
    }

    try {
      const result = scoreResume({ resume: body.resume, jd: body.jd });
      recordCall({
        requestId,
        functionName: "resume_score",
        startedAt,
        result,
        status: 200
      });
      send(res, 200, {
        request_id: requestId,
        function: "resume_score",
        model: "mock-keyword-v1",
        result: {
          score: result.score,
          reasons: result.reasons,
          matched: result.matched,
          missing: result.missing,
          years: result.years
        },
        usage: result.usage,
        latency_ms: Date.now() - startedAt
      }, {
        "X-RateLimit-Remaining": String(limit.remaining),
        "X-Request-Id": requestId
      });
    } catch (err) {
      fail(res, 422, "validation_error", err.message);
    }
    return;
  }

  fail(res, 404, "not_found", "Route not found");
});

server.listen(PORT, () => {
  console.log(`ModelFunction demo API listening on http://127.0.0.1:${PORT}`);
  console.log(`API key: ${API_KEY}`);
});

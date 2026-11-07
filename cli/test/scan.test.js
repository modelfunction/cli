import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject, buildSuiteDraft, scanPythonClassTools } from "../lib/scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MF = resolve(HERE, "../mf.js");

function runCli(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [MF, ...args], {
      env: { ...process.env, MF_NO_USAGE: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
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
  });
}

test("scan finds function specs and frameworks in this repo", async () => {
  const report = await scanProject(resolve(HERE, "../.."));
  const spec = report.sources.find((source) => source.type === "function-spec");
  assert.ok(spec, "expected a function-spec source");
  assert.ok(report.tools.some((tool) => tool.name === "resume_score"));
  assert.ok(report.frameworks.includes("mcp"), "expected mcp framework from demo/package.json");
  const draft = buildSuiteDraft(report);
  assert.ok(draft.tools.some((tool) => tool.name === "resume_score"));
  assert.equal(draft.cases.length, 0);
});

test("scan collects specs, OpenAPI, MCP configs, skills and code candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-scan-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, ".claude", "skills", "review"), { recursive: true });
    await mkdir(join(root, ".cursor"), { recursive: true });

    await writeFile(
      join(root, "function.json"),
      JSON.stringify({
        name: "summarize",
        description: "总结一段文本",
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
      }),
      "utf8"
    );

    await writeFile(
      join(root, "openapi.json"),
      JSON.stringify({
        openapi: "3.0.0",
        paths: {
          "/tickets/{id}": {
            get: {
              operationId: "get_ticket",
              summary: "按 ID 查询工单",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
            }
          },
          "/tickets": {
            post: {
              summary: "创建工单",
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/TicketInput" }
                  }
                }
              }
            }
          }
        },
        components: {
          schemas: {
            TicketInput: {
              type: "object",
              properties: { title: { type: "string" }, priority: { type: "string" } },
              required: ["title"]
            }
          }
        }
      }),
      "utf8"
    );

    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs.js"] } } }),
      "utf8"
    );
    await writeFile(
      join(root, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp" } } }),
      "utf8"
    );

    await writeFile(
      join(root, ".claude", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: 代码审查\n---\n\n正文",
      "utf8"
    );

    await writeFile(
      join(root, "src", "agent.ts"),
      [
        "const tools = [",
        '  { type: "function", function: { name: "search" } }',
        "];",
        "server.registerTool(",
        '  "lookup_doc",',
        '  { description: "查文档" },',
        ");"
      ].join("\n"),
      "utf8"
    );

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { openai: "^5.0.0", "@modelcontextprotocol/sdk": "^1.0.0" } }),
      "utf8"
    );

    const report = await scanProject(root);

    assert.deepEqual(
      report.tools.map((tool) => tool.name).sort(),
      ["get_ticket", "post_tickets", "summarize"].sort()
    );
    const post = report.tools.find((tool) => tool.name === "post_tickets");
    assert.deepEqual(Object.keys(post.parameters.properties).sort(), ["priority", "title"]);
    assert.deepEqual(post.parameters.required, ["title"]);
    assert.equal(report.mcpServers.length, 2);
    assert.equal(report.mcpServers.find((server) => server.name === "remote").transport, "http");
    assert.equal(report.skills.length, 1);
    assert.equal(report.skills[0].name, "review");
    assert.ok(report.sources.some((source) => source.type === "skill"));
    assert.ok(report.codeMatches.some((match) => match.name === "lookup_doc" && match.confidence === "medium"));
    assert.ok(report.frameworks.includes("openai"));
    assert.ok(report.frameworks.includes("mcp"));
    assert.deepEqual(report.dependencies.sort(), ["@modelcontextprotocol/sdk", "openai"]);

    const draft = buildSuiteDraft(report);
    assert.equal(draft.tools.length, 3);
    assert.equal(draft.cases.length, 0);
    assert.deepEqual(draft.skills, [{ name: "review", description: "代码审查" }]);
    assert.deepEqual(draft.profiles, {
      function: ["summarize"],
      openapi: ["get_ticket", "post_tickets"]
    });
    assert.ok(!JSON.stringify(draft).includes("undefined"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan reports a warning for unparseable JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-scan-"));
  try {
    await writeFile(join(root, "function.json"), "{ not json", "utf8");
    const report = await scanProject(root);
    assert.equal(report.tools.length, 0);
    assert.ok(report.warnings.some((warning) => warning.includes("JSON 解析失败")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan extracts LangChain @tool functions and skips test files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-scan-py-"));
  try {
    await mkdir(join(root, "agents", "utils"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(
      join(root, "agents", "utils", "stock_tools.py"),
      [
        "from typing import Annotated",
        "from langchain_core.tools import tool",
        "",
        "@tool",
        "def get_stock_data(",
        '    symbol: Annotated[str, "ticker symbol of the company"],',
        '    start_date: Annotated[str, "Start date in yyyy-mm-dd format"],',
        "    limit: int = 10,",
        ") -> str:",
        '    """Retrieve stock price data (OHLCV) for a ticker."""',
        '    return "ok"'
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(root, "agents", "utils", "news_tools.py"),
      [
        "from typing import Annotated",
        "from langchain_core.tools import tool",
        "",
        "@tool",
        "async def get_news(",
        '    ticker: Annotated[str, "ticker symbol"],',
        ") -> str:",
        '    """',
        "    Retrieve news articles.",
        '    """',
        '    return "ok"'
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(root, "agents", "utils", "notes.test.ts"),
      'server.registerTool("fake_tool", {});',
      "utf8"
    );
    await writeFile(
      join(root, "tests", "test_stock_tools.py"),
      ['@tool', "def helper(", "    x: str,", ") -> str:", '    """ignored"""', "    return x"].join("\n"),
      "utf8"
    );

    const report = await scanProject(root);
    assert.deepEqual(report.tools.map((tool) => tool.name).sort(), ["get_news", "get_stock_data"]);
    const stock = report.tools.find((tool) => tool.name === "get_stock_data");
    assert.deepEqual(Object.keys(stock.parameters.properties).sort(), ["limit", "start_date", "symbol"]);
    assert.deepEqual(stock.parameters.required.sort(), ["start_date", "symbol"]);
    assert.equal(stock.parameters.properties.symbol.description, "ticker symbol of the company");
    assert.equal(stock.parameters.properties.limit.type, "number");
    assert.match(stock.description, /Retrieve stock price data/);
    assert.match(report.tools.find((tool) => tool.name === "get_news").description, /Retrieve news articles/);
    assert.ok(!report.codeMatches.some((match) => match.name === "fake_tool"));

    const draft = buildSuiteDraft(report);
    assert.deepEqual(draft.profiles, {
      news_tools: ["get_news"],
      stock_tools: ["get_stock_data"]
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan extracts JS/TS tool declarations with zod schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-js-tools-"));
  try {
    await writeFile(
      join(root, "tools.ts"),
      [
        'import { z } from "zod";',
        "const scoreInput = z.object({",
        '  resume: z.string().describe("简历文本"),',
        "  jd: z.string()",
        "});",
        "export const ScoreTool = buildTool({",
        '  name: "score_resume",',
        '  description: "给简历与岗位描述打分",',
        "  inputSchema: scoreInput,",
        "  isReadOnly: () => true",
        "});"
      ].join("\n"),
      "utf8"
    );
    const report = await scanProject(root);
    const tool = report.tools.find((item) => item.name === "score_resume");
    assert.ok(tool, "expected the TS tool to be extracted");
    assert.equal(tool.origin, "code-literal");
    assert.deepEqual(tool.parameters.required, ["resume", "jd"]);
    assert.equal(tool.parameters.properties.resume.description, "简历文本");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan retries files whose tool name constant lives in a sibling module", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-js-const-"));
  try {
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(
      join(root, "tools", "ConfigTool.ts"),
      [
        "const inputSchema = lazySchema(() => z.object({ setting: z.string() }));",
        "export const ConfigTool = buildTool({",
        "  name: CONFIG_TOOL_NAME,",
        '  description: "读取或修改设置",',
        "  get inputSchema(): InputSchema { return inputSchema() }",
        "});"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(root, "tools", "constants.ts"),
      "export const CONFIG_TOOL_NAME = 'Config'\n",
      "utf8"
    );
    const report = await scanProject(root);
    const tool = report.tools.find((item) => item.name === "Config");
    assert.ok(tool, "name constant from the sibling module should resolve");
    assert.deepEqual(Object.keys(tool.parameters.properties), ["setting"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan exits 0 when a project only has skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-skills-only-"));
  try {
    await mkdir(join(root, "skills", "foo"), { recursive: true });
    await writeFile(
      join(root, "skills", "foo", "SKILL.md"),
      "---\nname: foo\ndescription: Use this when the user needs foo output.\n---\n",
      "utf8"
    );
    const result = await runCli(["scan", "--root", root, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.report.skills.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan extracts class-based Tool subclasses", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-class-tools-"));
  try {
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(
      join(root, "tools", "python_tool.py"),
      [
        "class PythonInterpreterTool(Tool):",
        '    name = "python_interpreter"',
        '    description = "Evaluates python code."',
        "    inputs = {",
        '        "code": {"type": "string", "description": "Code to run"},',
        '        "timeout": {"type": "integer", "description": "Seconds"},',
        "    }",
        "",
        "    def forward(self, code: str, timeout: int = 30):",
        "        return code"
      ].join("\n"),
      "utf8"
    );
    const report = await scanProject(root);
    const tool = report.tools.find((item) => item.name === "python_interpreter");
    assert.ok(tool, "class-based Tool should be extracted");
    assert.equal(tool.parameters.properties.code.type, "string");
    assert.equal(tool.parameters.properties.code.description, "Code to run");
    assert.equal(tool.parameters.properties.timeout.type, "number");
    assert.equal(scanPythonClassTools("class X(Tool):\n    name = \"x\"\n").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan extracts registry.action decorators", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-action-tools-"));
  try {
    await writeFile(
      join(root, "actions.py"),
      [
        "@self.registry.action('Go back', param_model=NoParamsAction)",
        "async def go_back(_: NoParamsAction, browser_session: BrowserSession):",
        "    return 'back'",
        "",
        "@self.registry.action('Wait for x seconds.')",
        "async def wait(seconds: int = 3):",
        "    return seconds"
      ].join("\n"),
      "utf8"
    );
    const report = await scanProject(root);
    const goBack = report.tools.find((item) => item.name === "go_back");
    const wait = report.tools.find((item) => item.name === "wait");
    assert.ok(goBack, "registry.action decorator should be extracted");
    assert.equal(goBack.description, "Go back");
    assert.ok(wait);
    assert.equal(wait.parameters.properties.seconds.type, "number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

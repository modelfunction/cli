import test from "node:test";
import assert from "node:assert/strict";
import { extractJsTools } from "../lib/js-tools.js";

const byName = (tools, name) => tools.find((tool) => tool.name === name);

test("extracts MCP server.tool with a shape object and a handler", () => {
  const src = `
    server.tool("search_docs", "用于在文档中搜索", {
      query: { type: "string", description: "关键词" },
      limit: { type: "integer" }
    }, async ({ query }) => ({ content: [] }));
  `;
  const tools = extractJsTools(src);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "search_docs");
  assert.equal(tools[0].description, "用于在文档中搜索");
  assert.deepEqual(tools[0].parameters.required, ["query", "limit"]);
  assert.equal(tools[0].parameters.properties.query.description, "关键词");
});

test("extracts registerTool with an inputSchema object", () => {
  const src = `
    server.registerTool("score_resume", {
      title: "简历评分",
      description: "给简历与岗位描述打分",
      inputSchema: {
        type: "object",
        properties: {
          resume: { type: "string", description: "简历文本" },
          jd: { type: "string", description: "岗位描述" }
        },
        required: ["resume", "jd"]
      }
    }, async (args) => ({ content: [] }));
  `;
  const tools = extractJsTools(src);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "score_resume");
  assert.equal(tools[0].description, "给简历与岗位描述打分");
  assert.deepEqual(tools[0].parameters.required, ["resume", "jd"]);
});

test("resolves a const zod schema and honours optional()", () => {
  const src = `
    import { z } from "zod";
    const sleepInputSchema = z.object({
      duration: z.number().int().describe("秒"),
      reason: z.string().optional().describe("原因")
    });
    export const SleepTool = buildTool({
      name: "Sleep",
      description: "Sleep for a specified duration",
      inputSchema: sleepInputSchema
    });
  `;
  const tool = byName(extractJsTools(src), "Sleep");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["duration"]);
  assert.equal(tool.parameters.properties.duration.type, "integer");
  assert.equal(tool.parameters.properties.duration.description, "秒");
  assert.equal(tool.parameters.properties.reason.description, "原因");
});

test("resolves TypeBox schemas referenced by an exported tool object", () => {
  const src = `
    import { Type } from "@sinclair/typebox";
    const ReadParams = Type.Object({
      path: Type.String({ description: "文件路径" }),
      offset: Type.Optional(Type.Number({ description: "起始行" }))
    });
    export const readTool = {
      name: "read_file",
      description: "读取工作区文件",
      inputSchema: ReadParams
    };
  `;
  const tool = byName(extractJsTools(src), "read_file");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["path"]);
  assert.equal(tool.parameters.properties.path.description, "文件路径");
  assert.equal(tool.parameters.properties.offset.type, "number");
});

test("extracts tools from a registry array and dedupes by name", () => {
  const src = `
    export const tools = [
      { name: "a_tool", description: "A 工具", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
      { name: "b_tool", description: "B 工具", inputSchema: { type: "object", properties: {} } },
      { name: "a_tool", description: "重复定义", parameters: { type: "object", properties: {} } }
    ];
  `;
  const tools = extractJsTools(src);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["a_tool", "b_tool"]);
});

test("skips definitions whose schema cannot be resolved statically", () => {
  const src = `
    const sharedSchemaFromSdk = buildSchema(process.env.SCHEMA);
    server.tool("unknown_tool", "描述", sharedSchemaFromSdk, handler);
  `;
  assert.deepEqual(extractJsTools(src), []);
});

test("resolves lazySchema factories, accessors and cross-module name constants", () => {
  const src = `
    const inputSchema = lazySchema(() =>
      z.strictObject({
        setting: z.string().describe("键"),
        value: z.union([z.string(), z.boolean()]).optional()
      })
    );
    export const ConfigTool = buildTool({
      name: CONFIG_TOOL_NAME,
      async description() { return "设置" },
      get inputSchema(): InputSchema { return inputSchema() },
      get outputSchema(): OutputSchema { return outputSchema() },
      async call({ setting }) { return 1 }
    } satisfies ToolDef<InputSchema, Output>);
  `;
  const tools = extractJsTools(src, { externals: new Map([["CONFIG_TOOL_NAME", "Config"]]) });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "Config");
  assert.deepEqual(tools[0].parameters.required, ["setting"]);
  assert.equal(tools[0].parameters.properties.setting.description, "键");
  assert.deepEqual(tools[0].parameters.properties.value.type, ["string", "boolean"]);
});

test("extracts plugin function registrations", () => {
  const src = `
    module.exports.X = {
      name: "filesystem-read-text-file",
      plugin: function () {
        return {
          name: "filesystem-read-text-file",
          setup(aibitat) {
            aibitat.function({
              name: this.name,
              description: "Read a file from the filesystem.",
              parameters: {
                type: "object",
                properties: { path: { type: "string", description: "File path" } },
                required: ["path"]
              }
            });
          }
        };
      }
    };
  `;
  const tools = extractJsTools(src);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "filesystem-read-text-file");
  assert.equal(tools[0].parameters.properties.path.description, "File path");
  assert.deepEqual(tools[0].parameters.required, ["path"]);
});

test("marks unresolved template descriptions as runtime-provided", () => {
  const src = `
    const PREFIX = "result";
    const DESCRIPTION = \`Do the thing. Follow-up starts with \${PREFIX}.\`;
    export const ToolX = buildTool({
      name: "tool_x",
      description: DESCRIPTION,
      inputSchema: z.object({ q: z.string() })
    });
  `;
  const [tool] = extractJsTools(src);
  assert.equal(tool.name, "tool_x");
  assert.equal(tool.descriptionSource, "runtime");
});

test("marks method-generated descriptions as runtime-provided", () => {
  const src = `
    export const ConfigTool = buildTool({
      name: "ConfigTool",
      async description() { return buildDescription() },
      inputSchema: z.object({ setting: z.string() })
    });
  `;
  const [tool] = extractJsTools(src);
  assert.equal(tool.name, "ConfigTool");
  assert.equal(tool.descriptionSource, "runtime");
  assert.deepEqual(Object.keys(tool.parameters.properties), ["setting"]);
});

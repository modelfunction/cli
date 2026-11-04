import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./mcp-server.js", import.meta.url))],
  stderr: "inherit"
});

const client = new Client({
  name: "modelfunction-test-client",
  version: "1.0.0"
});

await client.connect(transport);

const tools = await client.listTools();
const result = await client.callTool({
  name: "resume_score",
  arguments: {
    resume:
      "王小明，5 年 Python 后端开发经验，熟悉 MySQL、Redis、Docker，做过 LLM 应用和 RAG 检索。",
    jd: "招聘 Python 后端工程师，要求 3 年以上经验，熟悉 MySQL、Redis、Docker、Kubernetes，有 LLM/RAG 项目经验优先。"
  }
});

console.log(
  JSON.stringify(
    {
      tools: tools.tools.map((tool) => tool.name),
      result
    },
    null,
    2
  )
);

await client.close();

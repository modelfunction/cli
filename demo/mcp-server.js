import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scoreResume } from "./scorer.js";

const server = new McpServer({
  name: "modelfunction-demo",
  version: "0.1.0"
});

server.registerTool(
  "resume_score",
  {
    title: "Resume score",
    description: "根据简历和 JD 计算匹配分数，返回分数、理由和缺失关键词。",
    inputSchema: {
      resume: z.string().min(20).describe("候选人简历文本"),
      jd: z.string().min(20).describe("职位描述文本")
    }
  },
  async ({ resume, jd }) => {
    const result = scoreResume({ resume, jd });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("ModelFunction demo MCP server running on stdio");

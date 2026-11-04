import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSuite } from "./suite.js";
import { scanProject, addTools, buildSuiteDraft, redactReport } from "./scan.js";
import { writeFileAtomic } from "./fsutil.js";
import { probeStdioServer, probeHttpServer } from "./mcp-probe.js";
import { addCases, computeCoverage } from "./cases.js";
import { auditSuite } from "./audit.js";
import { check, checkMany } from "./check.js";
import { lintSuite } from "./lint.js";
import { clusterTools } from "./cluster.js";
import { compareScorecards } from "./compare.js";

const MF_PATH = fileURLToPath(new URL("../mf.js", import.meta.url));
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const MAX_CHILD_OUTPUT = 5_000_000;

function json(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function suitePath(input) {
  return resolve(input ?? "mf.suite.json");
}

export async function startMcpServer() {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  const server = new McpServer({ name: "modelfunction", version: pkg.version });

  server.registerTool(
    "scan_tools",
    {
      title: "Scan tools",
      description:
        "扫描仓库里的 function.json / OpenAPI / MCP 配置 / SKILL.md / 代码内定义。probe=true 时连接 stdio 或 streamable-HTTP MCP server 拉取 tools/list（HTTP headers 只用于连接，不写入报告）。不执行工具。默认只读；传 writeSuite 时在该路径写出套件草稿（cases 为空，需补用例并复核；来源 ≥2 时草稿带按来源分组的 profiles，并列出不参与评测的 skills）。",
      inputSchema: {
        root: z.string().optional().describe("仓库目录，默认进程当前目录"),
        probe: z.boolean().optional().describe("是否连接 MCP server 拉取工具清单"),
        timeoutMs: z.number().optional().describe("单个 MCP server 超时（毫秒，默认 5000）"),
        writeSuite: z.string().optional().describe("套件草稿输出路径，如 mf.suite.json")
      }
    },
    async ({ root, probe, timeoutMs, writeSuite }) => {
      const report = await scanProject(root ?? process.cwd());
      if (probe) {
        for (const mcpServer of [...report.mcpServers]) {
          const result =
            mcpServer.transport === "stdio"
              ? await probeStdioServer(mcpServer, { timeoutMs: timeoutMs ?? 5000 })
              : await probeHttpServer(mcpServer, { timeoutMs: timeoutMs ?? 5000 });
          if (!result.ok) {
            report.probes.push({ server: mcpServer.name, ok: false, error: result.error });
            continue;
          }
          const added = addTools(report, result.tools, {
            source: mcpServer.source,
            origin: "mcp-probe",
            confidence: "high",
            replaceExisting: true,
            note: `server ${mcpServer.name}`
          });
          report.probes.push({ server: mcpServer.name, ok: true, toolCount: added.length, tools: added });
        }
      }
      const payload = redactReport(report);
      if (!writeSuite) return json(payload);
      const target = resolve(writeSuite);
      await writeFileAtomic(target, JSON.stringify(buildSuiteDraft(report), null, 2));
      return json({ ...payload, suiteDraftPath: target });
    }
  );

  server.registerTool(
    "list_suite",
    {
      title: "List suite",
      description: "读取套件概览：工具、用例数、复核状态分布。",
      inputSchema: { suite: z.string().optional().describe("套件路径，默认 ./mf.suite.json") }
    },
    async ({ suite }) => {
      const loaded = await loadSuite(suitePath(suite));
      const sources = {};
      for (const testCase of loaded.cases) {
        sources[testCase.source] = (sources[testCase.source] ?? 0) + 1;
      }
      return json({
        name: loaded.name,
        path: loaded.path,
        tools: loaded.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: Object.keys(tool.parameters?.properties ?? {})
        })),
        cases: loaded.cases.length,
        reviewed: loaded.cases.filter((testCase) => testCase.reviewed !== false).length,
        sources
      });
    }
  );

  server.registerTool(
    "coverage",
    {
      title: "Case coverage",
      description: "报告每个工具的用例数、参数覆盖、负例比例、疑似混淆的工具对与缺口。",
      inputSchema: { suite: z.string().optional().describe("套件路径，默认 ./mf.suite.json") }
    },
    async ({ suite }) => json(computeCoverage(await loadSuite(suitePath(suite))))
  );

  server.registerTool(
    "audit",
    {
      title: "Audit tool set",
      description:
        "一次静态审计整个工具集：lint 发现、混淆族与边界建议、用例覆盖、挂载检查。不调用模型、不执行工具、无网络。返回 JSON。",
      inputSchema: { suite: z.string().optional().describe("套件路径，默认 ./mf.suite.json") }
    },
    async ({ suite }) =>
      json(
        auditSuite(
          await loadSuite(suitePath(suite), { allowEmptyCases: true, allowEmptyTools: true })
        )
      )
  );

  server.registerTool(
    "lint",
    {
      title: "Lint suite",
      description:
        "静态检查 tools 与 skills 的描述、参数与工具对边界（不调用模型）。返回 counts / findings / profilePairs。",
      inputSchema: { suite: z.string().optional().describe("套件路径，默认 ./mf.suite.json") }
    },
    async ({ suite }) =>
      json(
        lintSuite(
          await loadSuite(suitePath(suite), { allowEmptyCases: true, allowEmptyTools: true })
        )
      )
  );

  server.registerTool(
    "check",
    {
      title: "Install gate",
      description:
        "安装门禁：把新能力与已装能力做静态比较，返回 pass/warn、findings 与竞争族。传 manifest 检查单个；传 manifests 检查一包（新能力之间也会互比）。不阻断、不调用模型、无网络。",
      inputSchema: {
        manifest: z.any().optional().describe("新能力 {name, description, parameters?} 或 tool schema"),
        manifests: z.array(z.any()).optional().describe("一次安装一包能力时的数组"),
        installed: z.any().optional().describe("已装能力数组，或 {tools: [], skills: []}")
      }
    },
    async ({ manifest, manifests, installed }) => {
      if (manifests) return json(checkMany({ manifests, installed }));
      return json(check({ manifest, installed }));
    }
  );

  server.registerTool(
    "cluster",
    {
      title: "Cluster tools",
      description:
        "聚类工具，给出挂载分组、跨组高风险与族内边界清单（每族要补哪句选择条件）。不调用模型。",
      inputSchema: {
        suite: z.string().optional().describe("套件路径，默认 ./mf.suite.json"),
        threshold: z.number().min(0).max(1).optional().describe("聚类阈值，默认 0.5"),
        maxSize: z.number().int().positive().optional().describe("单组最大工具数，默认 10")
      }
    },
    async ({ suite, threshold, maxSize }) => {
      const loaded = await loadSuite(suitePath(suite), { allowEmptyCases: true });
      return json(clusterTools(loaded.tools, { threshold, maxSize }));
    }
  );

  server.registerTool(
    "compare",
    {
      title: "Compare scorecards",
      description:
        "比较两份评分卡 JSON：可比性、升降、干扰归因与混淆矩阵。只读文件，不调用模型。",
      inputSchema: {
        before: z.string().describe("旧评分卡 JSON 路径"),
        after: z.string().describe("新评分卡 JSON 路径")
      }
    },
    async ({ before, after }) => {
      const [oldText, newText] = await Promise.all([
        readFile(resolve(before), "utf8"),
        readFile(resolve(after), "utf8")
      ]);
      return json(compareScorecards(JSON.parse(oldText), JSON.parse(newText)));
    }
  );

  server.registerTool(
    "add_cases",
    {
      title: "Add cases",
      description:
        "把编码 Agent 撰写的用例写入套件。默认 source=agent、reviewed=false；未复核用例不计入正式分数。",
      inputSchema: {
        suite: z.string().optional().describe("套件路径，默认 ./mf.suite.json"),
        cases: z.array(z.any()).describe("用例数组，字段 id/input/expectedTool/expectedArgs/note/tags"),
        source: z.string().optional().describe("来源标记，默认 agent"),
        reviewed: z.boolean().optional().describe("是否已复核，默认 false"),
        dryRun: z.boolean().optional().describe("只校验不写入")
      }
    },
    async ({ suite, cases, source, reviewed, dryRun }) =>
      json(
        await addCases(suitePath(suite), cases, {
          source: source ?? "agent",
          reviewed: reviewed ?? false,
          dryRun: dryRun ?? false
        })
      )
  );

  server.registerTool(
    "run_eval",
    {
      title: "Run evaluation",
      description:
        "对套件跑评分卡（调用被测模型）。返回 JSON 评分卡；耗时约 用例数 × 模型数 × 单次延迟。",
      inputSchema: {
        suite: z.string().optional().describe("套件路径，默认 ./mf.suite.json"),
        models: z.string().optional().describe("逗号分隔的模型 id，如 mock,dsv4-flash"),
        cases: z.string().optional().describe("只跑这些用例 id（逗号分隔）"),
        profile: z
          .string()
          .optional()
          .describe("按挂载组评分：all 或组名（逗号分隔）；套件需含 profiles，结果里带 groups/lifted/jammed"),
        repeat: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("每条用例重复次数，取多数结果；建议正式基线用 3"),
        failUnder: z.number().optional().describe("选择准确率阈值，低于则退出码为 2"),
        maxCost: z.number().positive().optional().describe("累计估算成本上限（CNY），超限退出 2 且不返回部分评分卡"),
        progress: z.boolean().optional().describe("把逐用例进度写到 stderr（stdout 仍为纯 JSON）")
      }
    },
    async ({ suite, models, cases, profile, repeat, failUnder, maxCost, progress }) => {
      const args = ["eval", "--json", "--suite", suitePath(suite)];
      if (models) args.push("--models", models);
      if (cases) args.push("--case", cases);
      if (profile) args.push("--profile", profile);
      if (repeat !== undefined) args.push("--repeat", String(repeat));
      if (failUnder !== undefined) args.push("--fail-under", String(failUnder));
      if (maxCost !== undefined) args.push("--max-cost", String(maxCost));
      if (progress) args.push("--progress");

      const result = await runCli(args);
      let scorecard = null;
      try {
        scorecard = JSON.parse(result.stdout);
      } catch {
        scorecard = null;
      }
      return json({
        exitCode: result.code,
        scorecard,
        ...(result.error ? { error: result.error } : {}),
        ...(scorecard ? {} : { stdout: result.stdout.slice(-4000) }),
        stderr: result.stderr.slice(-4000)
      });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => process.exit(0);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.error("modelfunction mcp server running on stdio");
}

function runCli(args, timeoutMs = 300_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [MF_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let error = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolvePromise({ code, stdout, stderr, error });
    };

    const timer = setTimeout(() => {
      error = `timeout after ${timeoutMs}ms`;
      finish(-1);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_CHILD_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_CHILD_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      error = `spawn failed: ${err.message}`;
      finish(-1);
    });
    child.on("exit", (code) => finish(code ?? -1));
  });
}

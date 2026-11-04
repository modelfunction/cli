import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterTools, formatClusters } from "../lib/cluster.js";
import { runCluster } from "../mf.js";

function searchTool(name, description) {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索词" },
        max_results: { type: "number", description: "数量" }
      }
    }
  };
}

test("groups tools that share a name token and parameter shape", () => {
  const tools = [
    searchTool("tavily_search", "联网搜索实时信息"),
    searchTool("google_search", "使用谷歌检索网页内容"),
    searchTool("wiki_search", "查询维基百科条目"),
    {
      name: "file_read",
      description: "读取工作区文件并返回内容",
      parameters: { type: "object", properties: { path: { type: "string", description: "文件路径" } } }
    },
    {
      name: "file_write",
      description: "把内容写入工作区文件",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件路径" }, content: { type: "string", description: "内容" } }
      }
    },
    {
      name: "salary_band",
      description: "根据城市和岗位给出薪资区间",
      parameters: { type: "object", properties: { city: { type: "string", description: "城市" } } }
    }
  ];
  const result = clusterTools(tools);
  assert.ok(result.clusters.length >= 2);
  const searchGroup = result.clusters.find((cluster) => cluster.tools.includes("tavily_search"));
  assert.ok(searchGroup.tools.includes("google_search"));
  assert.ok(searchGroup.tools.includes("wiki_search"));
  assert.ok(!searchGroup.tools.includes("salary_band"));
  assert.match(formatClusters(result), /clusters/);
});

test("groups same-family tools that share a token and one parameter", () => {
  const tools = [
    {
      name: "alarm_query",
      description: "查询基站告警",
      parameters: {
        type: "object",
        properties: { cell_id: { type: "string", description: "小区 ID" }, start_time: { type: "string", description: "开始时间" } }
      }
    },
    {
      name: "alarm_ack",
      description: "确认基站告警",
      parameters: {
        type: "object",
        properties: { cell_id: { type: "string", description: "小区 ID" }, note: { type: "string", description: "备注" } }
      }
    }
  ];
  const result = clusterTools(tools);
  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0].tools, ["alarm_ack", "alarm_query"]);
});

test("clustering output is deterministic", () => {
  const tools = [searchTool("a_search", "搜索 A"), searchTool("b_search", "搜索 B")];
  assert.deepEqual(clusterTools(tools), clusterTools(tools));
});

test("maxSize caps cluster growth", () => {
  const tools = ["s1", "s2", "s3", "s4"].map((name) => searchTool(`${name}_search`, "搜索工具"));
  const result = clusterTools(tools, { maxSize: 2 });
  assert.ok(result.clusters.every((cluster) => cluster.tools.length <= 2));
});

test("cluster --out keeps the suite's other keys and refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-cluster-"));
  try {
    const suitePath = join(root, "suite.json");
    await writeFile(
      suitePath,
      JSON.stringify(
        {
          name: "t",
          tools: [searchTool("a_search", "联网搜索实时信息"), searchTool("b_search", "网页搜索资料")],
          cases: [{ id: "c1", input: "搜索一下", expectedTool: "a_search", expectedArgs: {} }],
          execution: { runtime: "node", entry: "run.js" }
        },
        null,
        2
      ),
      "utf8"
    );
    const lines = [];
    const code = await runCluster(
      { suite: suitePath, out: suitePath, json: false, threshold: 0.5, maxSize: 10 },
      { log: (line) => lines.push(String(line)), error: () => {} }
    );
    assert.equal(code, 0);
    const written = JSON.parse(await readFile(suitePath, "utf8"));
    assert.deepEqual(written.execution, { runtime: "node", entry: "run.js" });
    assert.equal(written.cases.length, 1);
    const names = Object.values(written.profiles).flat().sort();
    assert.deepEqual(names, ["a_search", "b_search"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two shared name tokens are enough even when parameters differ", () => {
  const tools = [
    {
      name: "fault_alarm_query",
      description: "查询基站的故障告警列表",
      parameters: {
        type: "object",
        properties: { site_id: { type: "string", description: "基站 ID" } }
      }
    },
    {
      name: "fault_alarm_ack",
      description: "确认基站的故障告警",
      parameters: {
        type: "object",
        properties: { alarm_id: { type: "string", description: "告警 ID" } }
      }
    },
    {
      name: "ops_restart_service",
      description: "重启服务器上的运维服务",
      parameters: {
        type: "object",
        properties: { service: { type: "string", description: "服务名" } }
      }
    }
  ];
  const result = clusterTools(tools);
  const alarm = result.clusters.find((cluster) => cluster.tools.includes("fault_alarm_query"));
  assert.ok(alarm.tools.includes("fault_alarm_ack"));
  assert.ok(!alarm.tools.includes("ops_restart_service"));
});

test("a shared generic verb is not a family signal", () => {
  const tools = [
    {
      name: "get_stock_data",
      description: "Retrieve stock price data",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string", description: "ticker" }, start_date: { type: "string", description: "start" } }
      }
    },
    {
      name: "get_fundamentals",
      description: "Retrieve fundamental data",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string", description: "ticker" }, curr_date: { type: "string", description: "date" } }
      }
    }
  ];
  const result = clusterTools(tools);
  assert.equal(result.clusters.length, 2);
});

test("boundary checklist names each tool's distinguishing words", () => {
  const tools = [
    {
      name: "alarm_query",
      description: "查询基站告警",
      parameters: {
        type: "object",
        properties: { cell_id: { type: "string", description: "小区 ID" }, start_time: { type: "string", description: "开始时间" } }
      }
    },
    {
      name: "alarm_ack",
      description: "确认基站告警",
      parameters: {
        type: "object",
        properties: { cell_id: { type: "string", description: "小区 ID" }, note: { type: "string", description: "备注" } }
      }
    },
    {
      name: "salary_band",
      description: "根据城市和岗位给出薪资区间",
      parameters: { type: "object", properties: { city: { type: "string", description: "城市" } } }
    }
  ];
  const result = clusterTools(tools);
  assert.equal(result.boundaries.length, 1);
  const family = result.boundaries[0];
  assert.deepEqual(family.tools, ["alarm_ack", "alarm_query"]);
  assert.deepEqual(family.sharedParams, ["cell_id"]);
  assert.deepEqual(family.axes.find((axis) => axis.tool === "alarm_query").distinct, ["query"]);
  assert.match(family.suggestion, /cell_id/);
  assert.match(formatClusters(result), /族内边界清单/);
});

test("boundary families and clusters get a readable label for PascalCase names", () => {
  const tool = (name) => ({
    name,
    description: "",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "任务 ID" } } }
  });
  const result = clusterTools([tool("TaskGet"), tool("TaskStop")]);
  assert.equal(result.clusters[0].label, "task");
  assert.equal(result.boundaries[0].label, "task");
});

test("boundary pairs linked only by family carry the family basis", () => {
  const tool = (name, properties) => ({
    name,
    description: "",
    parameters: {
      type: "object",
      properties: Object.fromEntries(properties.map((key) => [key, { type: "string", description: key }]))
    }
  });
  const result = clusterTools([
    tool("sessions_history", ["sessionKey", "limit"]),
    tool("sessions_send", ["sessionKey", "message"]),
    tool("read_file", ["path"])
  ]);
  const family = result.boundaries.find((item) => item.tools.includes("sessions_history"));
  assert.ok(family);
  const pair = family.pairs.find((item) => [item.a, item.b].includes("sessions_send"));
  assert.equal(pair.basis, "family");
});

test("unrelated tools produce no boundary checklist", () => {
  const tools = [
    { name: "get_stock_data", description: "Retrieve stock price data", parameters: { type: "object", properties: { ticker: { type: "string" } } } },
    { name: "get_fundamentals", description: "Retrieve fundamental data", parameters: { type: "object", properties: { ticker: { type: "string" } } } }
  ];
  const result = clusterTools(tools);
  assert.deepEqual(result.boundaries, []);
  assert.doesNotMatch(formatClusters(result), /族内边界清单/);
});

test("cluster hints at a family that parameter shapes split apart", () => {
  const tool = (name, properties) => ({
    name,
    description: "",
    parameters: {
      type: "object",
      properties: Object.fromEntries(properties.map((key) => [key, { type: "string", description: key }]))
    }
  });
  const tools = [
    tool("sessions_list", ["kinds", "limit"]),
    tool("sessions_history", ["sessionKey", "limit"]),
    tool("sessions_send", ["sessionKey", "message"]),
    tool("sessions_spawn", ["task"]),
    tool("sessions_yield", ["closing"]),
    tool("session_status", ["sessionKey", "model"]),
    tool("read_file", ["path"])
  ];
  const result = clusterTools(tools);
  const session = result.familyHints.find((hint) => hint.token === "session");
  assert.ok(session, "session family should be hinted");
  assert.equal(session.size, 6);
  assert.ok(session.loose.includes("sessions_spawn"));
  assert.ok(session.loose.includes("sessions_yield"));
  assert.match(formatClusters(result), /同族候选/);
});

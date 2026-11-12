import test from "node:test";
import assert from "node:assert/strict";
import { lintSuite, formatLint } from "../lib/lint.js";

test("pairScope reports only pairs that touch the new capabilities", () => {
  const suite = {
    tools: [
      { name: "search_docs", description: "Search documentation pages by keyword." },
      { name: "search_wiki", description: "Search wiki pages by keyword." },
      { name: "send_email", description: "Send an email message to one recipient." }
    ]
  };
  const pairFindings = (report) => report.findings.filter((finding) => finding.pair);
  assert.equal(pairFindings(lintSuite(suite)).length, 1);
  assert.equal(pairFindings(lintSuite(suite, { pairScope: new Set(["send_email"]) })).length, 0);
  assert.equal(pairFindings(lintSuite(suite, { pairScope: new Set(["search_docs"]) })).length, 1);
});

test("lint flags missing description, generic name and bad params", () => {
  const suite = {
    tools: [
      { name: "run", description: "", parameters: { type: "object", properties: {} } },
      {
        name: "BadName",
        description: "处理东西",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            payload: { type: "object" },
            ids: { type: "array" }
          },
          required: ["a", "b", "c", "d", "e", "f"]
        }
      }
    ]
  };
  const report = lintSuite(suite);
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes("desc-missing"));
  assert.ok(codes.includes("name-generic"));
  assert.ok(codes.includes("name-style"));
  assert.ok(codes.includes("desc-short"));
  assert.ok(codes.includes("desc-no-when"));
  assert.ok(codes.includes("param-desc-missing"));
  assert.ok(codes.includes("param-object-no-props"));
  assert.ok(codes.includes("param-array-no-items"));
  assert.ok(codes.includes("required-many"));
  assert.ok(report.counts.error >= 1);
  assert.match(formatLint(report), /desc-missing/);
});

test("lint accepts a clean tool definition", () => {
  const suite = {
    tools: [
      {
        name: "score_resume",
        description: "当用户需要评估简历与岗位描述匹配度时使用，返回 0-100 分和缺失关键词。",
        parameters: {
          type: "object",
          properties: {
            resume: { type: "string", description: "候选人简历文本" },
            jd: { type: "string", description: "职位描述文本" }
          },
          required: ["resume", "jd"]
        }
      }
    ]
  };
  const report = lintSuite(suite);
  assert.deepEqual(report.findings, []);
  assert.equal(formatLint(report), "tools: 1  findings: 0（error 0 / warn 0 / info 0）\n没有发现问题");
});

test("lint reports overlapping tool descriptions that lack boundaries", () => {
  const suite = {
    tools: [
      {
        name: "search_docs",
        description: "用于在技术文档库中搜索相关段落，返回匹配的文档片段与链接。",
        parameters: { type: "object", properties: { query: { type: "string", description: "搜索词" } } }
      },
      {
        name: "find_docs",
        description: "用于在技术文档库中搜索相关段落，返回匹配的文档片段与链接。",
        parameters: { type: "object", properties: { query: { type: "string", description: "搜索词" } } }
      }
    ]
  };
  const report = lintSuite(suite);
  const noBoundary = report.findings.filter((finding) => finding.code === "pair-no-boundary");
  assert.equal(noBoundary.length, 1);
  assert.match(noBoundary[0].message, /相似度/);
  assert.deepEqual(noBoundary[0].pair, ["search_docs", "find_docs"]);
  assert.equal(report.findings.filter((finding) => finding.code === "pair-overlap").length, 0);
});

test("lint reports confusable pairs split across profiles as merge hazards", () => {
  const tools = [
    {
      name: "search_docs",
      description: "用于在技术文档库中搜索相关段落，返回匹配的文档片段与链接。",
      parameters: { type: "object", properties: { query: { type: "string", description: "搜索词" } } }
    },
    {
      name: "find_docs",
      description: "用于在技术文档库中搜索相关段落，返回匹配的文档片段与链接。",
      parameters: { type: "object", properties: { query: { type: "string", description: "搜索词" } } }
    }
  ];
  const split = lintSuite({ tools, profiles: { web: ["search_docs"], jobs: ["find_docs"] } });
  assert.equal(split.profilePairs.length, 1);
  assert.deepEqual([split.profilePairs[0].a, split.profilePairs[0].b], ["jobs", "web"]);
  assert.equal(split.profilePairs[0].pairs.length, 1);
  assert.match(formatLint(split), /jobs × web/);

  const same = lintSuite({ tools, profiles: { web: ["search_docs", "find_docs"] } });
  assert.equal(same.profilePairs.length, 0);
  assert.equal(lintSuite({ tools }).profilePairs.length, 0);
});

test("lint downgrades overlap to info when a boundary is declared", () => {
  const suite = {
    tools: [
      {
        name: "search_docs",
        description: "用于在技术文档库中搜索相关段落，返回匹配的文档片段与链接。不适用于只查找单个文件路径的场景。",
        parameters: { type: "object", properties: { query: { type: "string", description: "搜索词" } } }
      },
      {
        name: "find_docs",
        description: "用于在技术文档库中搜索相关段落，返回匹配的文档片段与链接。",
        parameters: { type: "object", properties: { query: { type: "string", description: "搜索词" } } }
      }
    ]
  };
  const report = lintSuite(suite);
  const overlap = report.findings.filter((finding) => finding.code === "pair-overlap");
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].severity, "info");
  assert.equal(report.findings.filter((finding) => finding.code === "pair-no-boundary").length, 0);
});

test("lint flags required identifiers with no documented source", () => {
  const suite = {
    tools: [
      {
        name: "file_read",
        description: "当用户需要读取工作区中的文件时使用，返回文件内容。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            session_id: { type: "string", description: "会话 ID" }
          },
          required: ["path", "session_id"]
        }
      }
    ]
  };
  const report = lintSuite(suite);
  const finding = report.findings.find((item) => item.code === "required-unsourced");
  assert.ok(finding);
  assert.equal(finding.param, "session_id");
  assert.equal(finding.severity, "warn");
});

test("structural similarity catches different wording with the same shape", () => {
  const tool = (name, description, properties) => ({
    name,
    description,
    parameters: { type: "object", properties }
  });
  const tools = [
    tool("tavily_search", "联网搜索实时信息", { query: { type: "string" }, max_results: { type: "number" } }),
    tool("google_search", "使用谷歌检索网页内容", { query: { type: "string" }, max_results: { type: "number" } }),
    tool("get_user", "查询用户资料", { user_id: { type: "string" } }),
    tool("get_order", "查询订单详情", { order_id: { type: "string" } })
  ];
  const report = lintSuite({ tools, cases: [] });
  const pairs = report.findings.filter((item) => item.pair).map((item) => item.pair.join("×"));
  assert.ok(pairs.includes("tavily_search×google_search"), "same shape, different wording should pair");
  assert.ok(!pairs.some((item) => item.includes("get_user")), "same verb but disjoint params should not pair");
});

test("identifier detection matches whole tokens, not substrings", () => {
  const build = (name) => ({
    tools: [
      {
        name: "t",
        description: "当用户需要处理数据时使用，返回结果。",
        parameters: {
          type: "object",
          required: [name],
          properties: { [name]: { type: "string", description: "参数说明" } }
        }
      }
    ]
  });
  const code = (name) =>
    lintSuite(build(name)).findings.filter((item) => item.code === "required-unsourced");

  assert.equal(code("request_text").length, 0, "request_text is text, not an id");
  assert.equal(code("session_summary").length, 0, "session_summary is text, not an id");
  assert.equal(code("request_id")[0].severity, "warn");
  assert.equal(code("sessionId")[0].severity, "warn");
  assert.equal(code("candidate_id")[0].severity, "info", "business ids are only a nudge");
});

test("lint accepts required identifiers when the source is documented", () => {
  const suite = {
    tools: [
      {
        name: "file_read",
        description: "当用户需要读取工作区中的文件时使用，返回文件内容。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            session_id: { type: "string", description: "由平台在会话开始时注入的会话 ID，模型无需生成" }
          },
          required: ["path", "session_id"]
        }
      }
    ]
  };
  const report = lintSuite(suite);
  assert.equal(report.findings.filter((item) => item.code === "required-unsourced").length, 0);
});

test("lint compares skills by description and separates siblings from duplicates", () => {
  const suite = {
    tools: [],
    skills: [
      {
        name: "gitcrawl",
        description: "GitHub archive: issue/PR search, sync freshness, duplicate clusters, PR status, repo work."
      },
      {
        name: "tag-duplicate-prs-issues",
        description: "Search duplicate PRs/issues, group related work, sync duplicate state to GitHub."
      },
      {
        name: "feishu-doc",
        description: "Feishu document read/write operations. Activate when user mentions Feishu docs, cloud docs, or docx links."
      },
      {
        name: "feishu-wiki",
        description: "Feishu knowledge base navigation. Activate when user mentions knowledge base, wiki, or wiki links."
      },
      { name: "brief", description: "Short." }
    ]
  };
  const report = lintSuite(suite);
  const skillFindings = report.findings.filter((item) => item.kind === "skill");
  const codes = skillFindings.map((item) => item.code);
  assert.equal(report.skills, 5);
  assert.ok(codes.includes("skill-desc-short"));
  assert.ok(codes.includes("skill-pair-no-boundary"), "two skills with the same job should warn");
  assert.ok(codes.includes("skill-pair-sibling"), "same-vendor siblings are a hint, not a warning");
  const dup = skillFindings.find((item) => item.code === "skill-pair-no-boundary");
  assert.deepEqual(dup.pair.sort(), ["gitcrawl", "tag-duplicate-prs-issues"]);
});

test("formatLint folds a repeated rule into one block", () => {
  const tools = Array.from({ length: 5 }, (_, index) => ({
    name: `worker_${index}`,
    description: "短",
    parameters: { type: "object", properties: {} }
  }));
  tools.push({
    name: "ConfigTool",
    description: "当用户需要读取配置时使用，返回配置内容。",
    parameters: { type: "object", properties: { setting: { type: "string", description: "键" } } }
  });
  const text = formatLint(lintSuite({ tools }));
  assert.match(text, /重复问题/);
  assert.match(text, /desc-no-when × 5/);
  assert.match(text, /逐条:/);
});

test("runtime descriptions are informational and name style is info", () => {
  const suite = {
    tools: [
      {
        name: "ConfigTool",
        description: "",
        descriptionSource: "runtime",
        parameters: {
          type: "object",
          properties: { setting: { type: "string", description: "键" } }
        }
      }
    ]
  };
  const report = lintSuite(suite);
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes("desc-runtime"));
  assert.ok(!codes.includes("desc-missing"));
  assert.ok(!codes.includes("desc-no-when"));
  const nameStyle = report.findings.find((finding) => finding.code === "name-style");
  assert.equal(nameStyle.severity, "info");
  assert.deepEqual(report.counts, { error: 0, warn: 0, info: 2 });
});

test("lint flags imperative wording aimed at optional params", () => {
  const suite = {
    tools: [
      {
        name: "create_report",
        description: "当用户需要生成报告时使用。Pass a concise report title via the title parameter.",
        parameters: {
          type: "object",
          properties: {
            body: { type: "string", description: "报告正文" },
            title: { type: "string", description: "报告标题" }
          },
          required: ["body"]
        }
      }
    ]
  };
  const findings = lintSuite(suite).findings.filter((item) => item.code === "param-optional-imperative");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].param, "title");
  assert.equal(findings[0].severity, "info");
});

test("lint does not flag optional params with conditional wording", () => {
  const suite = {
    tools: [
      {
        name: "create_report",
        description: "当用户需要生成报告时使用。If a title is available, pass it for the report.",
        parameters: {
          type: "object",
          properties: {
            body: { type: "string", description: "报告正文" },
            title: { type: "string", description: "报告标题" }
          },
          required: ["body"]
        }
      }
    ]
  };
  assert.equal(
    lintSuite(suite).findings.filter((item) => item.code === "param-optional-imperative").length,
    0
  );
});

test("lint flags stale tool references left by a rename", () => {
  const suite = {
    tools: [
      {
        name: "read_goal_status",
        description: "当用户询问目标进度时使用，读取当前目标状态。不要调用 get_goal。",
        parameters: { type: "object", properties: {} }
      },
      {
        name: "create_goal",
        description: "当用户提出一个新目标时使用，创建目标记录。",
        parameters: { type: "object", properties: {} }
      }
    ]
  };
  const findings = lintSuite(suite).findings.filter((item) => item.code === "desc-dangling-tool");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ref, "get_goal");
  assert.equal(findings[0].similarTo, "read_goal_status");
});

test("lint does not flag references to tools that exist", () => {
  const suite = {
    tools: [
      {
        name: "create_report",
        description: "当用户需要生成报告时使用。读取文件请调用 file_read，不要先 file_saver。",
        parameters: { type: "object", properties: {} }
      },
      {
        name: "file_read",
        description: "当用户需要读取文件时使用，返回文件内容。",
        parameters: { type: "object", properties: {} }
      },
      {
        name: "file_saver",
        description: "当用户需要保存文件时使用，写入文件。",
        parameters: { type: "object", properties: {} }
      }
    ]
  };
  assert.equal(
    lintSuite(suite).findings.filter((item) => item.code === "desc-dangling-tool").length,
    0
  );
});

test("lint does not treat noun phrases or tool actions as optional-param imperatives", () => {
  const suite = {
    tools: [
      {
        name: "sessions_history",
        description: "当用户需要查看会话历史时使用。",
        parameters: {
          type: "object",
          properties: {
            includeTools: { type: "boolean", description: "Include tool messages" }
          }
        }
      },
      {
        name: "sessions_send",
        description: "Send message to a visible session by sessionKey/label.",
        parameters: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Session key" }
          }
        }
      }
    ]
  };
  assert.equal(
    lintSuite(suite).findings.filter((item) => item.code === "param-optional-imperative").length,
    0
  );
});

test("family tools with distinct actions are siblings, not boundary hazards", () => {
  const tool = (name, description) => ({
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path" },
        content: { type: "string", description: "file content" }
      }
    }
  });
  const report = lintSuite({
    tools: [
      tool("filesystem-copy-file", "Copy a file to a new location."),
      tool("filesystem-move-file", "Move a file to a new location.")
    ]
  });
  const sibling = report.findings.filter((item) => item.code === "pair-family-sibling");
  assert.equal(sibling.length, 1);
  assert.equal(sibling[0].severity, "info");
  assert.equal(report.findings.filter((item) => item.code === "pair-no-boundary").length, 0);
});

test("search tools across different domains still need a boundary", () => {
  const tool = (name) => ({
    name,
    description: "Search documentation pages by keyword.",
    parameters: { type: "object", properties: { query: { type: "string", description: "query" } } }
  });
  const report = lintSuite({ tools: [tool("search_docs"), tool("search_wiki")] });
  assert.equal(report.findings.filter((item) => item.code === "pair-family-sibling").length, 0);
  assert.equal(report.findings.filter((item) => item.code === "pair-no-boundary").length, 1);
});

test("lint flags a one-shot claim whose param accepts content or paths", () => {
  const suite = {
    tools: [
      {
        name: "create_html_report",
        description: "Call this tool directly to generate an HTML report for the user.",
        parameters: {
          type: "object",
          properties: {
            files: { type: "string", description: "file contents or file paths" }
          }
        }
      }
    ]
  };
  const findings = lintSuite(suite).findings.filter((item) => item.code === "desc-or-contradiction");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warn");
  assert.equal(findings[0].param, "files");
});

test("lint detects a Chinese content-or-path contradiction", () => {
  const suite = {
    tools: [
      {
        name: "create_html_report",
        description: "当用户需要生成 HTML 报告时直接调用本工具。",
        parameters: {
          type: "object",
          properties: {
            files: { type: "string", description: "文件内容或文件路径" }
          }
        }
      }
    ]
  };
  const findings = lintSuite(suite).findings.filter((item) => item.code === "desc-or-contradiction");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].param, "files");
});

test("lint does not flag alternatives between the same input mode", () => {
  const suite = {
    tools: [
      {
        name: "fetch_resource",
        description: "Call this tool directly to fetch a resource.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: "file path or URL" }
          }
        }
      }
    ]
  };
  const findings = lintSuite(suite).findings.filter((item) => item.code === "desc-or-contradiction");
  assert.equal(findings.length, 0);
});

test("lint does not flag content/path alternatives without a one-shot claim", () => {
  const suite = {
    tools: [
      {
        name: "create_html_report",
        description: "Generate an HTML report from the files the user provides.",
        parameters: {
          type: "object",
          properties: {
            files: { type: "string", description: "file contents or file paths" }
          }
        }
      }
    ]
  };
  const findings = lintSuite(suite).findings.filter((item) => item.code === "desc-or-contradiction");
  assert.equal(findings.length, 0);
});

function contradictionSuite(description) {
  return {
    tools: [
      {
        name: "create_html_report",
        description,
        parameters: {
          type: "object",
          properties: {
            files: { type: "string", description: "List of file contents or file paths" }
          }
        }
      }
    ]
  };
}

function contradictionFindings(description) {
  return lintSuite(contradictionSuite(description)).findings.filter(
    (item) => item.code === "desc-or-contradiction"
  );
}

test("lint flags an imperative-negative one-shot claim", () => {
  const findings = contradictionFindings(
    "Generate an HTML report. This tool does the reading and writing itself — do NOT call file_read or file_saver first, and do not paste file contents manually."
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].param, "files");
});

test("lint flags a self-contained one-shot claim without a direct-call phrase", () => {
  const findings = contradictionFindings(
    "Generate an HTML report from one or more files already stored in this session. It performs the reading and writing itself; no preliminary read step is needed."
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].param, "files");
});

test("lint flags Chinese imperative-negative and self-contained claims", () => {
  assert.equal(contradictionFindings("生成 HTML 报告，不要先调用 file_read，本工具会自行读取文件。").length, 1);
  assert.equal(contradictionFindings("生成 HTML 报告，本工具自行完成读取和写入。").length, 1);
});

test("a repaired description that accepts only paths stays silent even with a one-shot claim", () => {
  const suite = {
    tools: [
      {
        name: "create_html_report",
        description:
          "Generate an HTML report. This tool does the reading itself — do NOT call file_read first. Input must be file paths.",
        parameters: {
          type: "object",
          properties: { files: { type: "string", description: "List of file paths" } }
        }
      }
    ]
  };
  const findings = lintSuite(suite).findings.filter((item) => item.code === "desc-or-contradiction");
  assert.equal(findings.length, 0);
});

test("an imperative negative about an unrelated tool does not trigger the rule", () => {
  const findings = contradictionFindings(
    "Generate an HTML report. Do not call this tool before the user confirms the title. The files parameter accepts file contents or file paths."
  );
  assert.equal(findings.length, 0);
});

test("lint checks every occurrence of an optional parameter name", () => {
  const suite = {
    tools: [
      {
        name: "create_report",
        description:
          "Write an HTML report (a formatted webpage with title, sections, and optional charts). Pass a concise report title via the title parameter.",
        parameters: {
          type: "object",
          properties: {
            body: { type: "string", description: "报告正文" },
            title: { type: "string", description: "Optional report title" }
          },
          required: ["body"]
        }
      }
    ]
  };
  const findings = lintSuite(suite).findings.filter((item) => item.code === "param-optional-imperative");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].param, "title");
});

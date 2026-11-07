import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { extractJsTools } from "./js-tools.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".turbo",
  ".cache",
  // Not part of the agent's tool surface: generated API specs, examples and
  // test fixtures otherwise look like tools and dominate the report.
  "examples",
  "example",
  "tests",
  "test",
  "e2e",
  "fixtures",
  "swagger"
]);

// Monorepo tool registries often sit 7–8 levels deep
// (server/utils/agents/<framework>/plugins/<plugin>/file.js).
const MAX_DEPTH = 8;
// 5k was too small: a real agent monorepo (openclaw) has 16k files after the
// skip list, so the walk stopped a third of the way in and reported 26 of its
// 53 skills. Silent partial results are worse than a slow scan.
const MAX_FILES = 25000;
const MAX_FILE_BYTES = 200_000;

const FUNCTION_SPEC_NAMES = new Set([
  "function.json",
  "tool.json",
  "tools.json",
  "functions.json",
  "mcp-tools.json"
]);

const MCP_CONFIG_NAMES = new Set([
  "mcp.json",
  ".mcp.json",
  "mcp_config.json",
  "claude_desktop_config.json",
  "cline_mcp_settings.json",
  "mcp_settings.json"
]);

const OPENAPI_PATTERN = /^(openapi|swagger)[^/]*\.json$/i;
const SKILL_FILE = "skill.md";
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"]);

// Test fixtures and mocks use the same APIs as real tool definitions, so any
// match there is noise for a tool inventory.
const TEST_PATH = /(^|[\\/])(__tests__|tests?)([\\/])|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]+\.py$|_test\.py$/i;
// Dev harnesses shape objects like tools (`{ name: "ping", inputSchema }`) but
// are not part of the agent's tool surface.
const DEV_PATH = /(^|[\\/])(scripts?|bench|benchmarks?|dev|examples?|fixtures?|mocks?)([\\/])|[-_.](runner|scan|bench|fixture|mock)\.[cm]?[jt]sx?$/i;

const CODE_PATTERNS = [
  { label: "registerTool", confidence: "medium", re: /registerTool\s*\(\s*["'`]([\w.-]+)["'`]/ },
  { label: "server.tool", confidence: "medium", re: /\.tool\s*\(\s*["'`]([\w.-]+)["'`]/ },
  { label: "py-tool-decorator", confidence: "low", re: /^\s*@tool\b/ },
  { label: "py-action-decorator", confidence: "medium", re: /^\s*@(?:self\.)?registry\.action\s*\(/ },
  { label: "vercel-tool-call", confidence: "low", re: /\btool\s*\(\s*\{/ },
  { label: "openai-tools-array", confidence: "low", re: /\btools\s*:\s*\[\s*\{/ },
  { label: "anthropic-input-schema", confidence: "low", re: /\binput_?schema\s*:/ }
];

const PY_FRAMEWORKS = {
  openai: "openai",
  anthropic: "anthropic",
  langchain: "langchain",
  langgraph: "langgraph",
  crewai: "crewai",
  litellm: "litellm",
  mcp: "mcp",
  "openai-agents": "openai-agents"
};

const JS_FRAMEWORKS = {
  openai: "openai",
  "@anthropic-ai/sdk": "anthropic",
  ai: "vercel-ai-sdk",
  langchain: "langchain",
  "@langchain/core": "langchain",
  langgraph: "langgraph",
  "@modelcontextprotocol/sdk": "mcp",
  "@openai/agents": "openai-agents"
};

export async function scanProject(root = ".") {
  const absRoot = resolve(root);
  const files = [];
  const state = { truncated: false };
  await walk(absRoot, 0, files, state);

  const report = {
    root: absRoot,
    filesScanned: files.length,
    sources: [],
    tools: [],
    skills: [],
    mcpServers: [],
    probes: [],
    codeMatches: [],
    dependencies: [],
    frameworks: [],
    warnings: []
  };

  if (state.truncated) {
    report.warnings.push(`扫描在 ${MAX_FILES} 个文件处截断，结果可能不完整；可把 --root 指向子目录`);
  }

  const seenTools = new Set();
  // Tool names are frequently constants defined in a sibling module
  // (`name: CONFIG_TOOL_NAME`). Files are visited in path order, so the
  // constant may not be known yet; such files are retried after the walk.
  const constIndex = new Map();
  const retryFiles = new Set();
  const dependencies = new Set();
  const frameworks = new Set();

  for (const file of files.sort()) {
    const name = basename(file).toLowerCase();
    const rel = relative(absRoot, file);

    if (name === "package.json") {
      const pkg = await readJson(file, report);
      if (pkg) {
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        for (const dep of Object.keys(deps)) {
          dependencies.add(dep);
          if (JS_FRAMEWORKS[dep]) frameworks.add(JS_FRAMEWORKS[dep]);
        }
      }
      continue;
    }

    if (name === "requirements.txt" || name === "pyproject.toml") {
      const text = await readText(file, report);
      if (text) {
        for (const [pkg, framework] of Object.entries(PY_FRAMEWORKS)) {
          if (new RegExp(`(^|[^a-z0-9_-])${pkg}([^a-z0-9_-]|$)`, "i").test(text)) {
            dependencies.add(pkg);
            frameworks.add(framework);
          }
        }
      }
      continue;
    }

    if (FUNCTION_SPEC_NAMES.has(name)) {
      const spec = await readJson(file, report);
      if (!spec) continue;
      const tools = toolsFromSpec(spec);
      if (tools.length === 0) {
        report.warnings.push(`${rel}: 未识别出工具定义（需要 name + input/parameters，或 tools 数组）`);
        continue;
      }
      const added = [];
      for (const tool of tools) {
        if (seenTools.has(tool.name)) {
          report.warnings.push(`${rel}: 工具 "${tool.name}" 重复，已忽略`);
          continue;
        }
        seenTools.add(tool.name);
        report.tools.push({ ...tool, source: rel, origin: "function-spec" });
        added.push(tool.name);
      }
      report.sources.push({ type: "function-spec", path: rel, confidence: "high", tools: added });
      continue;
    }

    if (MCP_CONFIG_NAMES.has(name)) {
      const config = await readJson(file, report);
      if (!config) continue;
      const servers = mcpServersFrom(config);
      if (servers.length === 0) {
        report.warnings.push(`${rel}: 未找到 mcpServers/servers 配置`);
        continue;
      }
      report.mcpServers.push(...servers.map((server) => ({ ...server, source: rel })));
      report.sources.push({
        type: "mcp-config",
        path: rel,
        confidence: "high",
        servers: servers.map((server) => server.name),
        note: "工具清单需连接 MCP server 后获取（本轮 scan 不启动进程）"
      });
      continue;
    }

    if (OPENAPI_PATTERN.test(name)) {
      const spec = await readJson(file, report);
      if (!spec || !spec.paths) continue;
      const tools = toolsFromOpenApi(spec);
      const added = [];
      for (const tool of tools) {
        if (seenTools.has(tool.name)) {
          report.warnings.push(`${rel}: 工具 "${tool.name}" 重复，已忽略`);
          continue;
        }
        seenTools.add(tool.name);
        report.tools.push({ ...tool, source: rel, origin: "openapi" });
        added.push(tool.name);
      }
      report.sources.push({ type: "openapi", path: rel, confidence: "medium", tools: added });
      continue;
    }

    if (name === SKILL_FILE) {
      const text = await readText(file, report);
      if (!text) continue;
      const meta = parseFrontmatter(text);
      if (!meta.name) {
        report.warnings.push(`${rel}: SKILL.md 缺少 frontmatter name`);
        continue;
      }
      report.skills.push({ name: meta.name, description: meta.description ?? "", source: rel });
      report.sources.push({
        type: "skill",
        path: rel,
        confidence: "high",
        skills: [meta.name],
        note: "skill 没有参数 schema，不参与工具评测；可作为 skill 选择评测的候选"
      });
      continue;
    }

    if (CODE_EXTENSIONS.has(name.slice(name.lastIndexOf(".")))) {
      const info = await stat(file).catch(() => null);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      const text = await readText(file, report);
      if (!text) continue;
      if (name.endsWith(".py") && !TEST_PATH.test(rel)) {
        const pythonTools = [
          ...scanPythonTools(text),
          ...scanPythonClassTools(text),
          ...scanPythonActionDecorators(text)
        ];
        if (pythonTools.length > 0) {
          addTools(report, pythonTools, {
            source: rel,
            origin: "py-tool",
            confidence: "medium",
            note: "从 @tool 装饰器、类型注解或 class-based Tool 提取，需人工确认"
          });
        }
      }
      if (!name.endsWith(".py") && !TEST_PATH.test(rel) && !DEV_PATH.test(rel)) {
        for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=\s*(['"])([^'"\n]{1,200})\2/g)) {
          if (!constIndex.has(match[1])) constIndex.set(match[1], match[3]);
        }
        const jsTools = extractJsTools(text, {
          externals: constIndex,
          onUnresolvedName: () => retryFiles.add(file)
        });
        if (jsTools.length > 0) {
          addTools(report, jsTools, {
            source: rel,
            origin: "code-literal",
            confidence: "medium",
            note: "从 JS/TS 声明或 TypeBox/zod schema 静态提取（不执行代码），需人工确认"
          });
        }
      }
      if (TEST_PATH.test(rel)) continue;
      // Only matches that carry a tool name are actionable; a bare `input_schema:`
      // in API plumbing is not a tool and only inflates the report.
      const matches = scanCode(text).filter((match) => match.name);
      for (const match of matches) {
        report.codeMatches.push({
          source: rel,
          line: match.line,
          label: match.label,
          name: match.name,
          confidence: match.confidence
        });
      }
      if (matches.length > 0) {
        report.sources.push({
          type: "code",
          path: rel,
          confidence: "low",
          matches: matches.length,
          note: "代码内定义只能作为草稿，需人工确认"
        });
      }
    }
  }

  if (retryFiles.size > 0 && constIndex.size > 0) {
    for (const file of retryFiles) {
      const text = await readText(file, report);
      if (!text) continue;
      const tools = extractJsTools(text, { externals: constIndex });
      if (tools.length === 0) continue;
      addTools(report, tools, {
        source: relative(absRoot, file),
        origin: "code-literal",
        confidence: "medium",
        note: "名称常量在其他模块定义，扫描完整仓库后再解析"
      });
    }
  }

  report.dependencies = [...dependencies].sort();
  report.frameworks = [...frameworks].sort();
  return report;
}

export function addTools(
  report,
  tools,
  { source, origin, confidence = "high", note, meta, replaceExisting = false }
) {
  const index = new Map(report.tools.map((tool, position) => [tool.name, position]));
  const added = [];
  for (const tool of tools) {
    if (!tool?.name) continue;
    const existing = index.get(tool.name);
    if (existing === undefined) {
      index.set(tool.name, report.tools.length);
      report.tools.push({ ...tool, source, origin, ...(meta ?? {}) });
      added.push(tool.name);
    } else if (replaceExisting) {
      // A probed tool is the runtime truth; a static guess with the same name
      // should be replaced, not silently kept.
      report.tools[existing] = { ...tool, source, origin, ...(meta ?? {}) };
      added.push(tool.name);
    }
  }
  report.sources.push({
    type: origin,
    path: source,
    confidence,
    tools: added,
    ...(note ? { note } : {})
  });
  return added;
}

export function redactReport(report) {
  return {
    ...report,
    mcpServers: report.mcpServers.map(({ env, headers, ...rest }) => ({
      ...rest,
      url: rest.url ? sanitizeUrl(rest.url) : null,
      envKeys: env ? Object.keys(env) : [],
      headerKeys: headers ? Object.keys(headers).sort() : []
    }))
  };
}

export function buildSuiteDraft(report) {
  const draft = {
    name: `${basename(report.root)}-draft`,
    description: "由 mf scan 生成。请人工确认工具描述与参数，并补充 cases 后再运行 mf eval。",
    tools: report.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.descriptionSource ? { descriptionSource: tool.descriptionSource } : {})
    })),
    cases: []
  };
  if (report.skills.length > 0) {
    draft.skills = report.skills.map((skill) => ({ name: skill.name, description: skill.description }));
  }
  // Where a tool came from is the only mount hint the scan can observe without
  // guessing: one MCP server or one spec file is normally one thing agents mount.
  const profiles = groupBySource(report.tools);
  if (profiles) draft.profiles = profiles;
  return draft;
}

function groupBySource(tools) {
  const groups = new Map();
  const owner = new Map();
  for (const tool of tools) {
    const key = tool.provider ?? tool.source ?? "";
    if (!key) continue;
    let label = profileLabel(key);
    if (owner.has(label) && owner.get(label) !== key) label = String(key).replace(/[\\/]+/g, "-");
    owner.set(label, key);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(tool.name);
  }
  if (groups.size < 2) return null;
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function profileLabel(key) {
  const text = String(key);
  if (!/[\\/]|\.(json|ya?ml|toml|js|mjs|ts|py)$/i.test(text)) return text;
  return basename(text, extname(text)) || text;
}

export function formatScanSummary(report) {
  const lines = [`scan: ${report.root}（${report.filesScanned} 个文件）`];

  if (report.sources.length === 0) {
    lines.push("未发现可识别的工具来源");
  } else {
    lines.push("", "sources:");
    for (const source of report.sources) {
      const detail = source.tools?.length
        ? `${source.tools.length} tool(s): ${source.tools.join(", ")}`
        : source.servers?.length
          ? `${source.servers.length} server(s): ${source.servers.join(", ")}`
          : source.skills?.length
            ? `${source.skills.length} skill(s): ${source.skills.join(", ")}`
            : source.matches
              ? `${source.matches} code match(es)`
              : "";
      lines.push(`  ${source.type.padEnd(13)} ${source.path.padEnd(40)} ${detail} [${source.confidence}]`);
      if (source.note) lines.push(`  ${" ".repeat(14)}note: ${source.note}`);
    }
  }

  if (report.frameworks.length > 0) {
    lines.push("", `frameworks: ${report.frameworks.join(", ")}`);
  }

  const probed = (report.probes ?? []).length;
  lines.push(
    "",
    `tools:       ${report.tools.length}`,
    `skills:      ${report.skills.length}（仅静态检查）`,
    `mcp servers: ${report.mcpServers.length}${probed > 0 ? `（已 probe ${probed} 个）` : "（需 --probe 才能拿到工具清单）"}`,
    `code match:  ${report.codeMatches.length}（low confidence，需人工确认）`
  );

  if ((report.probes ?? []).length > 0) {
    lines.push("", "probes:");
    for (const probe of report.probes) {
      lines.push(
        `  ${probe.server.padEnd(20)} ${probe.ok ? `ok, ${probe.toolCount} tool(s)` : `failed: ${probe.error}`}`
      );
    }
  }

  if (report.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }

  const hints = [];
  if (report.tools.length === 0) hints.push("没有可直接使用的工具定义：请手写 tools 或先连接 MCP server（后续版本支持）");
  if (report.tools.length > 0) hints.push("cases 为空：补 1 个以上用例后才能运行 mf eval");
  if (report.codeMatches.length > 0) hints.push("代码内定义请对照源码逐个确认，不要直接采信");
  if (hints.length > 0) {
    lines.push("", "next:");
    for (const hint of hints) lines.push(`  - ${hint}`);
  }

  return lines.join("\n");
}

async function walk(dir, depth, files, state) {
  if (depth > MAX_DEPTH || files.length >= MAX_FILES) {
    if (files.length >= MAX_FILES) state.truncated = true;
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (files.length >= MAX_FILES) {
      state.truncated = true;
      return;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, depth + 1, files, state);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

async function readJson(file, report) {
  const text = await readText(file, report);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    report.warnings.push(`${relative(report.root, file)}: JSON 解析失败（${String(error.message).slice(0, 80)}）`);
    return null;
  }
}

async function readText(file, report) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    report.warnings.push(`${relative(report.root, file)}: 读取失败（${String(error.message).slice(0, 80)}）`);
    return null;
  }
}

function toolsFromSpec(spec) {
  const raw = Array.isArray(spec)
    ? spec
    : Array.isArray(spec.tools)
      ? spec.tools
      : typeof spec.name === "string"
        ? [spec]
        : [];
  return raw.map(normalizeTool).filter(Boolean);
}

export function normalizeTool(entry) {
  const source = entry.function ?? entry;
  if (!source || typeof source.name !== "string" || source.name.trim() === "") return null;
  return {
    name: source.name.trim(),
    description: source.description ?? "",
    parameters: source.input ?? source.parameters ?? source.inputSchema ?? { type: "object", properties: {} },
    sideEffects: typeof source.sideEffects === "string" ? source.sideEffects : null
  };
}

function mcpServersFrom(config) {
  const servers = config.mcpServers ?? config.servers ?? {};
  return Object.entries(servers).map(([name, value]) => ({
    name,
    transport: value.url ? "http" : "stdio",
    command: value.command ?? null,
    args: Array.isArray(value.args) ? value.args : [],
    env: value.env && typeof value.env === "object" ? value.env : null,
    headers: value.headers && typeof value.headers === "object" ? value.headers : null,
    url: value.url ?? null
  }));
}

// Remote MCP configs often carry tokens in the query string; keep the report
// safe to share while the live server object still probes the full URL.
function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function toolsFromOpenApi(spec) {
  const tools = [];
  const paths = spec.paths ?? {};
  for (const [path, operations] of Object.entries(paths)) {
    if (!operations || typeof operations !== "object") continue;
    const pathParams = Array.isArray(operations.parameters) ? operations.parameters : [];
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = operations[method];
      if (!op || typeof op !== "object") continue;
      const name = op.operationId ?? `${method}_${path}`.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
      const properties = {};
      const required = new Set();
      const params = [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      for (const rawParam of params) {
        const param = deref(spec, rawParam);
        if (!param?.name) continue;
        properties[param.name] = param.schema ?? { type: param.type ?? "string" };
        if (param.description) properties[param.name].description = param.description;
        if (param.required) required.add(param.name);
      }
      const bodySchema = deref(spec, op.requestBody?.content?.["application/json"]?.schema);
      if (bodySchema?.properties) {
        for (const [key, value] of Object.entries(bodySchema.properties)) {
          properties[key] = deref(spec, value);
        }
        for (const key of bodySchema.required ?? []) required.add(key);
      }
      tools.push({
        name,
        description: op.summary ?? op.description ?? "",
        parameters: {
          type: "object",
          properties,
          ...(required.size > 0 ? { required: [...required] } : {})
        }
      });
    }
  }
  return tools;
}

function deref(spec, node, depth = 0) {
  if (!node || depth > 5) return node;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    let target = spec;
    for (const part of node.$ref.slice(2).split("/")) {
      target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      if (!target) return node;
    }
    return deref(spec, target, depth + 1);
  }
  return node;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    meta[pair[1]] = pair[2].replace(/^["']|["']$/g, "").trim();
  }
  return meta;
}

// LangChain-style tool definitions: @tool above a typed function. The runtime
// builds the JSON schema from the same annotations, so this is the real schema,
// not a guess — only the description can drift (first docstring line vs args_schema).
export function scanPythonTools(text) {
  const lines = text.split(/\r?\n/);
  const tools = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*@tool\b/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && j - i <= 4 && !/^\s*(async\s+)?def\s+\w+\s*\(/.test(lines[j])) j += 1;
    const defMatch = lines[j]?.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
    if (!defMatch) continue;
    const signature = collectSignature(lines, j, defMatch[0].length);
    if (signature === null) continue;
    const properties = {};
    const required = [];
    for (const part of splitPyParams(signature.text)) {
      const param = parsePyParam(part);
      if (!param) continue;
      properties[param.name] = param.schema;
      if (param.required) required.push(param.name);
    }
    tools.push({
      name: defMatch[1],
      description: pythonDocstring(lines, signature.endLine),
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {})
      }
    });
    i = signature.endLine;
  }
  return tools;
}

// Class-based tools: smolagents-style `class X(Tool)` with `name`,
// `description` and an `inputs` dict. Static only; never executes the class.
export function scanPythonClassTools(text) {
  const lines = text.split(/\r?\n/);
  const tools = [];
  for (let i = 0; i < lines.length; i += 1) {
    const classMatch = lines[i].match(/^(\s*)class\s+\w+\s*\(\s*Tool\s*\)\s*:/);
    if (!classMatch) continue;
    const indent = classMatch[1].length;
    let end = i + 1;
    for (; end < lines.length; end += 1) {
      const line = lines[end];
      if (!line.trim()) continue;
      if (line.match(/^\s*/)[0].length <= indent) break;
    }
    const joined = lines.slice(i + 1, end).join("\n");
    const nameMatch = joined.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (!nameMatch) continue;
    tools.push({
      name: nameMatch[1],
      description: pythonAttrString(joined, "description") || pythonDocstring(lines, i),
      parameters: {
        type: "object",
        properties: pythonInputs(joined)
      }
    });
    i = end;
  }
  return tools;
}

// Registry actions: browser-use-style `@registry.action("desc", param_model=…)`
// above an async function. The model class is usually in another file, so the
// schema is limited to literal function parameters; name + description are
// still useful for inventory and description lint.
export function scanPythonActionDecorators(text) {
  const lines = text.split(/\r?\n/);
  const tools = [];
  for (let i = 0; i < lines.length; i += 1) {
    const decorator = lines[i].match(/^\s*@(?:self\.)?registry\.action\s*\(/);
    if (!decorator) continue;
    const signature = collectSignature(lines, i, decorator[0].length);
    if (signature === null) continue;
    const description = firstPythonString(signature.text);
    let j = signature.endLine + 1;
    while (j < lines.length && j - signature.endLine <= 6 && !/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(lines[j])) j += 1;
    const def = lines[j]?.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
    if (!def) continue;
    const args = collectSignature(lines, j, def[0].length);
    const properties = {};
    if (args !== null) {
      for (const part of splitPyParams(args.text)) {
        const param = parsePyParam(part);
        if (!param || param.name === "_" || param.name.startsWith("_")) continue;
        if (["params", "browser_session", "context", "self", "cls"].includes(param.name)) continue;
        properties[param.name] = param.schema;
      }
    }
    tools.push({
      name: def[1],
      description: description || pythonDocstring(lines, j),
      parameters: { type: "object", properties }
    });
    i = args?.endLine ?? signature.endLine;
  }
  return tools;
}

function firstPythonString(text) {
  const triple = text.match(/(?:[rRuU])?("""|''')([\s\S]*?)\1/);
  if (triple) {
    return triple[2].split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
  }
  const single = text.match(/(?:[rRuU])?["']([^"'\n]*)["']/);
  return single ? single[1] : "";
}

function pythonAttrString(text, attr) {
  const triple = text.match(new RegExp(`^\\s*${attr}\\s*=\\s*(?:[rRuU])?("""|''')([\\s\\S]*?)\\1`, "m"));
  if (triple) {
    return triple[2].split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
  }
  const single = text.match(new RegExp(`^\\s*${attr}\\s*=\\s*["']([^"']*)["']`, "m"));
  return single ? single[1] : "";
}

function pythonInputs(text) {
  const start = text.search(/^\s*inputs\s*=\s*\{/m);
  if (start === -1) return {};
  const open = text.indexOf("{", start);
  const block = balancedBraces(text, open);
  if (!block) return {};
  const properties = {};
  for (const match of block.matchAll(/["']([\w-]+)["']\s*:\s*\{([\s\S]*?)\}/g)) {
    const schema = {};
    const type = match[2].match(/["']type["']\s*:\s*["']([^"']+)["']/);
    const description = match[2].match(/["']description["']\s*:\s*["']([^"']*)["']/);
    const mapped = type ? mapPythonInputType(type[1]) : null;
    if (mapped) schema.type = mapped;
    if (description) schema.description = description[1];
    properties[match[1]] = schema;
  }
  return properties;
}

function balancedBraces(text, openIndex) {
  if (openIndex < 0) return null;
  let depth = 0;
  let quote = null;
  let triple = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    const rest = text.slice(i, i + 3);
    if (triple) {
      if (rest === triple) {
        i += 2;
        triple = null;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (rest === '"""' || rest === "'''") {
      i += 2;
      triple = rest;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      const newline = text.indexOf("\n", i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

function mapPythonInputType(type) {
  const value = String(type).toLowerCase();
  if (["string", "str", "text"].includes(value)) return "string";
  if (["integer", "int", "number", "float"].includes(value)) return "number";
  if (["boolean", "bool"].includes(value)) return "boolean";
  if (["array", "list"].includes(value)) return "array";
  if (["object", "dict"].includes(value)) return "object";
  return null;
}

function collectSignature(lines, startLine, offset) {
  let depth = 1;
  let out = "";
  for (let i = startLine; i < lines.length; i += 1) {
    const line = lines[i];
    for (let c = i === startLine ? offset : 0; c < line.length; c += 1) {
      const ch = line[c];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return { text: out, endLine: i };
      }
      out += ch;
    }
    out += "\n";
  }
  return null;
}

function splitPyParams(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const PY_TYPES = {
  str: "string",
  int: "number",
  float: "number",
  bool: "boolean",
  list: "array",
  List: "array",
  dict: "object",
  Dict: "object"
};

function parsePyParam(part) {
  const eq = part.indexOf("=");
  const head = eq === -1 ? part : part.slice(0, eq);
  const hasDefault = eq !== -1;
  const colon = head.indexOf(":");
  const name = (colon === -1 ? head : head.slice(0, colon)).trim().replace(/^\*+/, "");
  if (!name || name === "self" || name === "cls") return null;
  const typeText = colon === -1 ? "" : head.slice(colon + 1).trim();
  const description = (typeText.match(/Annotated\s*\[[^,]+,\s*["']([^"']+)["']/) ?? [])[1] ?? "";
  const schema = { type: pyType(typeText) };
  if (description) schema.description = description;
  return { name, schema, required: !hasDefault };
}

function pyType(typeText) {
  const core = typeText
    .replace(/^Annotated\s*\[\s*([^,\]]+).*/s, "$1")
    .replace(/^Optional\s*\[\s*(.*?)\s*\]$/s, "$1")
    .trim();
  return PY_TYPES[core] ?? (core.endsWith("List") || core.startsWith("list") ? "array" : "string");
}

function pythonDocstring(lines, fromLine) {
  for (let i = fromLine + 1; i < Math.min(lines.length, fromLine + 6); i += 1) {
    const match = lines[i].match(/^\s*(?:[rRuU])?("""|''')\s*(.*)$/);
    if (!match) continue;
    const quote = match[1];
    const rest = match[2];
    const sameLine = rest.includes(quote) ? rest.split(quote)[0] : rest;
    if (sameLine.trim()) return sameLine.trim();
    for (let k = i + 1; k < lines.length; k += 1) {
      const text = lines[k].trim();
      if (!text) continue;
      return text.startsWith(quote) ? "" : text;
    }
  }
  return "";
}

function scanCode(text) {
  const matches = [];
  for (const pattern of CODE_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes("g") ? pattern.re.flags : `${pattern.re.flags}g`);
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[0].length <= 500) {
        matches.push({
          line: lineAt(text, match.index),
          label: pattern.label,
          name: match[1] ?? null,
          confidence: pattern.confidence
        });
      }
      if (matches.length >= 50) return matches.sort((a, b) => a.line - b.line);
      if (re.lastIndex === match.index) re.lastIndex += 1;
    }
  }
  return matches.sort((a, b) => a.line - b.line);
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

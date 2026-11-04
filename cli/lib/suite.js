import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EMPTY_SCHEMA = { type: "object", properties: {} };

export async function loadSuite(suitePath, { allowEmptyCases = false, allowEmptyTools = false } = {}) {
  const abs = resolve(suitePath);
  const raw = JSON.parse(await readFile(abs, "utf8"));
  if (!Array.isArray(raw.tools) || (raw.tools.length === 0 && !allowEmptyTools)) {
    throw new Error(`suite ${abs}: "tools" must be a non-empty array`);
  }
  if (!Array.isArray(raw.cases) || (raw.cases.length === 0 && !allowEmptyCases)) {
    throw new Error(`suite ${abs}: "cases" must be a non-empty array`);
  }

  const baseDir = dirname(abs);
  const tools = await Promise.all(raw.tools.map((entry) => normalizeTool(entry, baseDir)));
  const seen = new Set();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`suite ${abs}: duplicate tool "${tool.name}"`);
    seen.add(tool.name);
  }

  const cases = raw.cases.map((entry, index) => normalizeCase(entry, index, seen));
  return {
    name: raw.name ?? "unnamed",
    description: raw.description ?? "",
    path: abs,
    tools,
    cases,
    profiles: raw.profiles ?? null,
    skills: Array.isArray(raw.skills) ? raw.skills.map(normalizeSkill) : [],
    execution:
      raw.execution && typeof raw.execution === "object" && !Array.isArray(raw.execution)
        ? { ...raw.execution }
        : null
  };
}

async function normalizeTool(entry, baseDir) {
  if (entry.ref) {
    const specPath = resolve(baseDir, entry.ref);
    const spec = JSON.parse(await readFile(specPath, "utf8"));
    return {
      name: requireString(spec.name, `tool ${specPath}: "name"`),
      description: spec.description ?? "",
      parameters: spec.input ?? spec.parameters ?? EMPTY_SCHEMA,
      source: specPath,
      sideEffects: normalizeSideEffects(spec.sideEffects ?? spec.side_effects)
    };
  }
  return {
    name: requireString(entry.name, "tool name"),
    description: entry.description ?? "",
    parameters: entry.parameters ?? entry.input ?? EMPTY_SCHEMA,
    source: null,
    sideEffects: normalizeSideEffects(entry.sideEffects ?? entry.side_effects),
    ...(entry.descriptionSource === "runtime" ? { descriptionSource: "runtime" } : {})
  };
}

// Skills carry no parameter schema in the prompt-injected form (SKILL.md
// frontmatter), so the only checkable surface is name + description. Both the
// bare-name shorthand and the full form are accepted.
function normalizeSkill(entry, index) {
  if (typeof entry === "string") {
    const name = entry.trim();
    if (!name) throw new Error(`skill #${index + 1}: name must be a non-empty string`);
    return { name, description: "" };
  }
  if (entry && typeof entry === "object") {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) throw new Error(`skill #${index + 1}: "name" must be a non-empty string`);
    return { name, description: typeof entry.description === "string" ? entry.description : "" };
  }
  throw new Error(`skill #${index + 1}: must be a name or {name, description}`);
}

function normalizeCase(entry, index, toolNames) {
  const id = entry.id ?? `case_${index + 1}`;
  if (typeof entry.input !== "string" || entry.input.trim() === "") {
    throw new Error(`case ${id}: "input" must be a non-empty string`);
  }
  const expectedTool = entry.expectedTool ?? null;
  if (expectedTool !== null && !toolNames.has(expectedTool)) {
    throw new Error(`case ${id}: expectedTool "${expectedTool}" is not in the tool list`);
  }
  if (expectedTool === null && entry.expectedArgs && Object.keys(entry.expectedArgs).length > 0) {
    throw new Error(`case ${id}: expectedArgs requires an expectedTool`);
  }
  const toolInput =
    entry.toolInput && typeof entry.toolInput === "object" && !Array.isArray(entry.toolInput)
      ? entry.toolInput
      : null;
  if (toolInput && expectedTool === null) {
    throw new Error(`case ${id}: toolInput requires an expectedTool`);
  }
  for (const key of ["excludeFromBase", "excludeFromProfiles"]) {
    if (entry[key] !== undefined && typeof entry[key] !== "boolean") {
      throw new Error(`case ${id}: "${key}" must be a boolean`);
    }
  }
  return {
    id,
    input: entry.input,
    expectedTool,
    expectedArgs: entry.expectedArgs ?? {},
    note: entry.note ?? "",
    source: typeof entry.source === "string" && entry.source ? entry.source : "manual",
    reviewed: entry.reviewed === undefined ? true : Boolean(entry.reviewed),
    ...(entry.excludeFromBase ? { excludeFromBase: true } : {}),
    ...(entry.excludeFromProfiles ? { excludeFromProfiles: true } : {}),
    tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    toolInput,
    expect:
      entry.expect && typeof entry.expect === "object" && !Array.isArray(entry.expect)
        ? entry.expect
        : null
  };
}

function normalizeSideEffects(value) {
  if (typeof value !== "string") return null;
  const level = value.trim().toLowerCase();
  return ["none", "read", "write", "external"].includes(level) ? level : null;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function toModelTools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSuite } from "./suite.js";
import { writeFileAtomic } from "./fsutil.js";
import { normalizeProfiles, profileCaseCoverage } from "./profile.js";

const MIN_CASES_PER_TOOL = 3;
const MIN_NEGATIVE_RATIO = 0.2;
const PAIR_SIMILARITY = 0.35;

// `get_stock_data` and `get_news` share only the verb; that is not a family.
// These tokens carry no domain meaning, so they never count as a shared name
// signal (neither for confusability nor for clustering).
export const GENERIC_NAME_TOKENS = new Set(["tool", "tools", "api", "get", "set", "do"]);

// English boilerplate: function words plus the verbs every tool description
// starts with. Left in, "Retrieve data for a given ticker" makes any two tools
// look half-identical.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "these", "those", "are", "was", "were",
  "has", "have", "you", "your", "can", "will", "given", "based", "using", "into", "over", "per",
  "via", "not", "all", "any", "each", "its", "their", "data",
  "get", "gets", "retrieve", "retrieves", "retrieved", "fetch", "fetches", "query", "queries",
  "search", "searches", "find", "finds", "read", "reads", "write", "writes", "create", "creates",
  "update", "updates", "delete", "deletes", "list", "lists", "run", "runs", "call", "calls",
  "use", "uses", "return", "returns", "tool", "tools", "api", "apis"
]);

export async function addCases(suitePath, incoming, { source = "agent", reviewed = false, dryRun = false } = {}) {
  const abs = resolve(suitePath);
  const raw = JSON.parse(await readFile(abs, "utf8"));
  const suite = await loadSuite(abs, { allowEmptyCases: true });
  const tools = new Map(suite.tools.map((tool) => [tool.name, tool]));
  const ids = new Set(suite.cases.map((testCase) => testCase.id));

  const added = [];
  const rejected = [];
  const warnings = [];
  const list = Array.isArray(incoming) ? incoming : [incoming];

  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== "object") {
      rejected.push({ id: `#${index + 1}`, reason: "case must be an object" });
      continue;
    }
    const id =
      typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : `case_${ids.size + index + 1}`;
    if (ids.has(id)) {
      rejected.push({ id, reason: "duplicate id" });
      continue;
    }
    if (typeof entry.input !== "string" || entry.input.trim() === "") {
      rejected.push({ id, reason: "input must be a non-empty string" });
      continue;
    }
    const expectedTool = entry.expectedTool ?? null;
    if (expectedTool !== null && !tools.has(expectedTool)) {
      rejected.push({ id, reason: `unknown expectedTool "${expectedTool}"` });
      continue;
    }
    const expectedArgs = entry.expectedArgs ?? {};
    if (expectedTool === null && Object.keys(expectedArgs).length > 0) {
      rejected.push({ id, reason: "expectedArgs requires expectedTool (omit both for negative cases)" });
      continue;
    }
    const bucket = entry.bucket ?? "singleIntent";
    if (!["singleIntent", "multiStep", "ambiguous"].includes(bucket)) {
      rejected.push({ id, reason: "bucket must be one of singleIntent, multiStep, ambiguous" });
      continue;
    }
    if (bucket !== "singleIntent" && expectedTool === null) {
      rejected.push({ id, reason: `bucket "${bucket}" requires an expectedTool` });
      continue;
    }
    let acceptableFirstCalls = null;
    if (entry.acceptableFirstCalls !== undefined) {
      if (!Array.isArray(entry.acceptableFirstCalls) || entry.acceptableFirstCalls.length === 0) {
        rejected.push({ id, reason: "acceptableFirstCalls must be a non-empty array" });
        continue;
      }
      const unknown = entry.acceptableFirstCalls.filter((name) => !tools.has(name));
      if (unknown.length > 0) {
        rejected.push({ id, reason: `unknown acceptableFirstCalls: ${unknown.join(", ")}` });
        continue;
      }
      if (!entry.acceptableFirstCalls.includes(expectedTool)) {
        rejected.push({ id, reason: `acceptableFirstCalls must include expectedTool "${expectedTool}"` });
        continue;
      }
      acceptableFirstCalls = [...new Set(entry.acceptableFirstCalls.map(String))];
    }
    if (expectedTool !== null) {
      const properties = tools.get(expectedTool).parameters?.properties ?? {};
      for (const key of Object.keys(expectedArgs)) {
        if (!(key in properties)) {
          warnings.push(`${id}: expectedArgs.${key} 不在 ${expectedTool} 的 schema 中，请确认`);
        }
      }
    }

    const testCase = {
      id,
      input: entry.input,
      expectedTool,
      expectedArgs,
      bucket,
      ...(acceptableFirstCalls ? { acceptableFirstCalls } : {}),
      ...(typeof entry.bucketReason === "string" && entry.bucketReason
        ? { bucketReason: entry.bucketReason }
        : {}),
      ...(entry.note ? { note: String(entry.note) } : {}),
      source: typeof entry.source === "string" && entry.source ? entry.source : source,
      reviewed: entry.reviewed === undefined ? reviewed : Boolean(entry.reviewed),
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : []
    };
    ids.add(id);
    added.push(testCase);
  }

  if (!dryRun && added.length > 0) {
    raw.cases = Array.isArray(raw.cases) ? raw.cases : [];
    raw.cases.push(...added);
    await writeFileAtomic(abs, `${JSON.stringify(raw, null, 2)}\n`);
  }

  return { path: abs, added, rejected, warnings, dryRun };
}

export function computeCoverage(suite) {
  const perTool = new Map(
    suite.tools.map((tool) => [tool.name, { total: 0, withArgs: 0, reviewed: 0, unreviewed: 0 }])
  );
  let negative = 0;
  let unreviewed = 0;

  for (const testCase of suite.cases) {
    const unreviewedCase = testCase.reviewed === false;
    if (unreviewedCase) unreviewed += 1;

    if (testCase.expectedTool === null) {
      negative += 1;
      continue;
    }
    const bucket = perTool.get(testCase.expectedTool);
    if (!bucket) continue;
    bucket.total += 1;
    if (Object.keys(testCase.expectedArgs ?? {}).length > 0) bucket.withArgs += 1;
    if (unreviewedCase) bucket.unreviewed += 1;
    else bucket.reviewed += 1;
  }

  const tools = [...perTool.entries()].map(([name, counts]) => ({
    name,
    ...counts,
    missing: Math.max(0, MIN_CASES_PER_TOOL - counts.total)
  }));

  const total = suite.cases.length;
  const negativeRatio = total ? negative / total : 0;
  const warnings = [];

  for (const tool of tools) {
    if (tool.total === 0) warnings.push(`${tool.name}: 0 条用例`);
    else if (tool.missing > 0) warnings.push(`${tool.name}: ${tool.total}/${MIN_CASES_PER_TOOL} 条，缺 ${tool.missing} 条`);
    if (tool.total > 0 && tool.withArgs === 0) warnings.push(`${tool.name}: 没有校验参数的用例`);
  }
  if (negativeRatio < MIN_NEGATIVE_RATIO) {
    warnings.push(`负例占比 ${Math.round(negativeRatio * 100)}% < ${Math.round(MIN_NEGATIVE_RATIO * 100)}%`);
  }
  if (unreviewed > 0) warnings.push(`${unreviewed} 条未复核用例不计入正式分数`);

  const skills = suite.skills?.length ?? 0;
  if (skills > 0) warnings.push(`${skills} 个 skill 只做静态检查，不参与模型评测`);

  const profileList = suite.profiles
    ? normalizeProfiles(suite.profiles, suite.tools.map((tool) => tool.name))
    : null;
  const profiles = profileList ? profileCaseCoverage(profileList, suite.cases) : null;
  if (profiles) {
    for (const row of profiles) {
      if (row.cases === 0) warnings.push(`组 ${row.name}: 0 条正例（只有负例），该组工具没被真正测试`);
      else if (row.missing.length > 0) {
        warnings.push(`组 ${row.name}: 工具 ${row.missing.join(", ")} 没有对应用例`);
      }
    }
  }

  return {
    total,
    negative,
    negativeRatio,
    unreviewed,
    skills,
    tools,
    profiles,
    pairs: suspectedPairs(suite.tools),
    warnings
  };
}

export function formatCoverage(report) {
  const lines = [
    `cases: ${report.total}（负例 ${report.negative}，${Math.round(report.negativeRatio * 100)}%；未复核 ${report.unreviewed}）`
  ];
  if (report.skills > 0) lines.push(`skills: ${report.skills}（仅静态检查，不参与模型评测）`);
  lines.push(
    "",
    "tool                            cases  args  reviewed",
    "------------------------------  -----  ----  --------"
  );
  for (const tool of report.tools) {
    lines.push(
      `${tool.name.padEnd(30)}  ${String(tool.total).padStart(5)}  ${String(tool.withArgs).padStart(4)}  ${String(tool.reviewed).padStart(8)}`
    );
  }
  if (report.profiles && report.profiles.length > 0) {
    lines.push("", "profiles（分组后可评分的用例；负例每组都跑，比例按组内正例+负例计）:");
    lines.push("group                   tools  cases  neg  neg%  tools-without-cases");
    lines.push("----------------------  -----  -----  ---  ----  -------------------");
    for (const row of report.profiles) {
      lines.push(
        `${row.name.padEnd(22)}  ${String(row.tools).padStart(5)}  ${String(row.cases).padStart(5)}  ${String(row.negatives).padStart(3)}  ${`${Math.round((row.negativeRatio ?? 0) * 100)}%`.padStart(4)}  ${row.missing.length ? row.missing.join(", ") : "-"}`
      );
    }
  }
  if (report.pairs.length > 0) {
    lines.push("", "suspected confusing pairs（建议各补 1 条歧义用例）:");
    for (const pair of report.pairs) {
      lines.push(`  ${pair.a} × ${pair.b}  similarity ${pair.similarity.toFixed(2)}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}

// O(n²) callers prepare each capability once; the pair loop then only compares
// sets. Tokenizing inside the loop made a 550-capability gate take ~14s.
export function prepareItem(item, { extraStop } = {}) {
  const names = nameTokens(item.name).filter((token) => !GENERIC_NAME_TOKENS.has(token));
  return {
    name: item.name,
    tokens: tokens(`${item.name} ${item.description}`, extraStop),
    nameTokens: names,
    nameTokenSet: new Set(names),
    params: paramNames(item),
    required: new Set(item.parameters?.required ?? [])
  };
}

export function pairSimilarityPrepared(a, b) {
  const shared = intersectionSize(a.tokens, b.tokens);
  const union = a.tokens.size + b.tokens.size - shared;
  const lexical = union > 0 ? shared / union : 0;
  const structural = intersects(a.nameTokenSet, b.nameTokenSet) ? structuralScorePrepared(a, b) : 0;
  return {
    similarity: Math.max(lexical, structural),
    basis: structural > lexical ? "structural" : "lexical"
  };
}

export function pairSimilarity(x, y, { extraStop } = {}) {
  return pairSimilarityPrepared(prepareItem(x, { extraStop }), prepareItem(y, { extraStop }));
}

// Clustering wants "same family" (alarm_query / alarm_ack belong to one agent),
// which is looser than "confusable" (lint's question). Shared name token plus
// any parameter overlap is enough to belong together; two shared tokens are
// enough on their own (fault_alarm_query / fault_alarm_ack take different ids).
// One shared token with disjoint params is not: cross-domain tools often share
// a bare verb (query / list) and nothing else.
export function familyScorePrepared(x, y) {
  const shared = intersectionSize(x.nameTokenSet, y.nameTokenSet);
  if (shared === 0) return 0;
  const paramOverlap = jaccard(x.params, y.params);
  if (paramOverlap > 0) return 0.8;
  if (shared >= 2) return 0.7;
  return x.params.size === 0 && y.params.size === 0 ? 0.6 : 0.2;
}

export function familyScore(x, y) {
  return familyScorePrepared(prepareItem(x), prepareItem(y));
}

// Turn a confusable pair into an authoring instruction. We do not invent the
// semantic rule (which one wins when); we point at the dimensions the author
// controls — the words unique to each name and the parameters only one side
// takes — so the boundary sentence can be written without guessing.
export function boundaryHint(x, y) {
  const left = [...new Set(nameTokens(x.name))].filter((token) => !GENERIC_NAME_TOKENS.has(token));
  const right = [...new Set(nameTokens(y.name))].filter((token) => !GENERIC_NAME_TOKENS.has(token));
  const sharedName = left.filter((token) => right.includes(token)).sort();
  const distinctName = {
    a: left.filter((token) => !right.includes(token)).sort(),
    b: right.filter((token) => !left.includes(token)).sort()
  };
  const aParams = Object.keys(x.parameters?.properties ?? {}).sort();
  const bParams = Object.keys(y.parameters?.properties ?? {}).sort();
  const sharedParams = aParams.filter((param) => bParams.includes(param));
  const paramsOnly = {
    a: aParams.filter((param) => !bParams.includes(param)),
    b: bParams.filter((param) => !aParams.includes(param))
  };

  let axis;
  if (distinctName.a.length > 0 || distinctName.b.length > 0) {
    axis = `${x.name} 独有 ${distinctName.a.join("/") || "无"}，${y.name} 独有 ${distinctName.b.join("/") || "无"}`;
  } else if (paramsOnly.a.length > 0 || paramsOnly.b.length > 0) {
    axis = `${x.name} 要传 ${paramsOnly.a.join("/") || "无"}，${y.name} 要传 ${paramsOnly.b.join("/") || "无"}`;
  } else {
    axis = "各自的触发场景";
  }
  const shared = sharedParams.length > 0 ? `；共享参数 ${sharedParams.join("、")} 不能当判据` : "";
  return {
    sharedName,
    distinctName,
    sharedParams,
    paramsOnly,
    suggestion: `在 ${x.name} 和 ${y.name} 的 description 里各补一句选择条件（区分维度：${axis}${shared}），再补一条歧义用例`
  };
}

export function suspectedPairs(tools, { threshold = PAIR_SIMILARITY, extraStop } = {}) {
  const prepared = tools.map((tool) => prepareItem(tool, { extraStop }));
  const pairs = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const { similarity, basis } = pairSimilarityPrepared(prepared[i], prepared[j]);
      if (similarity >= threshold) {
        pairs.push({ a: prepared[i].name, b: prepared[j].name, similarity, basis });
      }
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

// Tools that share part of the name (search / file / read...) and the same
// parameter shape confuse the model even when the wording differs, which the
// lexical score alone misses. Name order is unreliable: `tavily_search` leads
// with the vendor, `search_docs` with the action.
function structuralScorePrepared(x, y) {
  const sharedName = x.nameTokens.some((token) => y.nameTokens.includes(token));
  if (!sharedName) return 0;
  if (x.params.size === 0 && y.params.size === 0) return 0;
  const paramOverlap = jaccard(x.params, y.params);
  if (paramOverlap < 0.34) return 0;
  const requiredOverlap = jaccard(x.required, y.required);
  return 0.5 + 0.5 * (0.6 * paramOverlap + 0.4 * requiredOverlap);
}

// Plural folds matter on real tool sets: sessions_list / session_status and
// issue / issues describe the same thing, but naive token matching misses both.
// Only the safe cases are folded; "class"/"process" already end in ss and pass
// through untouched.
export function normalizeWord(word) {
  const value = String(word ?? "").toLowerCase();
  if (value.length < 3) return value;
  if (/ies$/.test(value)) return `${value.slice(0, -3)}y`;
  if (/s$/.test(value) && !/(ss|us|is)$/.test(value)) return value.slice(0, -1);
  return value;
}

export function nameTokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(normalizeWord);
}

function paramNames(tool) {
  return new Set(Object.keys(tool.parameters?.properties ?? {}));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  const shared = intersectionSize(a, b);
  return shared / (a.size + b.size - shared);
}

// Iterate the smaller set; avoids allocating a union Set for every pair in the
// O(n²) loops.
function intersectionSize(a, b) {
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared;
}

function intersects(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  for (const item of small) if (large.has(item)) return true;
  return false;
}

function tokens(text, extraStop) {
  const set = new Set();
  const lowered = String(text ?? "").toLowerCase();
  for (const word of lowered.match(/[a-z][a-z0-9_]{1,}/g) ?? []) {
    for (const part of word.split("_")) {
      const normalized = normalizeWord(part);
      if (!normalized) continue;
      if (STOPWORDS.has(part) || STOPWORDS.has(normalized)) continue;
      if (extraStop?.has(part) || extraStop?.has(normalized)) continue;
      set.add(normalized);
    }
  }
  for (const chunk of lowered.match(/[一-鿿]+/g) ?? []) {
    if (chunk.length === 1) set.add(chunk);
    for (let i = 0; i + 1 < chunk.length; i += 1) set.add(chunk.slice(i, i + 2));
  }
  return set;
}

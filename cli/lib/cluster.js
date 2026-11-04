import {
  prepareItem,
  pairSimilarityPrepared,
  familyScorePrepared,
  nameTokens,
  GENERIC_NAME_TOKENS
} from "./cases.js";

// A shared domain noun ("session", "goal", "tool") says these tools serve one
// purpose even when their verbs and parameter shapes differ — exactly what
// familyScore refuses to merge. Surface it as a hint instead of guessing: the
// platform already knows its real mounting map.
const FAMILY_HINT_STOP = new Set([
  ...GENERIC_NAME_TOKENS,
  "run", "call", "use", "search", "find", "query", "fetch", "create", "update",
  "list", "send", "read", "write", "add", "remove", "delete", "start", "stop",
  "open", "close", "poll", "log", "status", "data", "info", "result", "generate",
  "save", "load", "merge", "sync", "scan", "check", "compare", "exec", "probe"
]);

// A pair below the clustering link but above these marks is still confusable
// enough to need a boundary sentence: same lint threshold for wording/shape,
// plus the stronger family scores (shared distinctive token with parameter
// overlap, two shared tokens, or two zero-parameter tools).
const BOUNDARY_SIMILARITY = 0.35;
const BOUNDARY_FAMILY = 0.6;

export function clusterTools(tools, { threshold = 0.5, maxSize = 10 } = {}) {
  const scores = tools.map(() => new Array(tools.length).fill(0));
  const prepared = tools.map((tool) => prepareItem(tool));
  const pairs = [];
  const edges = [];
  for (let i = 0; i < tools.length; i += 1) {
    for (let j = i + 1; j < tools.length; j += 1) {
      const { similarity, basis } = pairSimilarityPrepared(prepared[i], prepared[j]);
      const family = familyScorePrepared(prepared[i], prepared[j]);
      const link = Math.max(similarity, family);
      scores[i][j] = link;
      scores[j][i] = link;
      if (link >= threshold) {
        pairs.push({ i, j, similarity, basis: family > similarity ? "family" : basis });
      }
      if (similarity >= BOUNDARY_SIMILARITY || family >= BOUNDARY_FAMILY) {
        edges.push({ i, j, similarity, basis, family });
      }
    }
  }

  const degree = tools.map((_, index) =>
    pairs.reduce((sum, pair) => sum + (pair.i === index || pair.j === index ? 1 : 0), 0)
  );
  const order = tools
    .map((tool, index) => index)
    .sort((a, b) => degree[b] - degree[a] || tools[a].name.localeCompare(tools[b].name));

  const raw = [];
  for (const index of order) {
    let best = null;
    for (const cluster of raw) {
      if (cluster.members.length >= maxSize) continue;
      const average =
        cluster.members.reduce((sum, member) => sum + scores[index][member], 0) / cluster.members.length;
      if (average >= threshold && (!best || average > best.average)) best = { cluster, average };
    }
    if (best) best.cluster.members.push(index);
    else raw.push({ members: [index] });
  }

  const clusterOf = new Map();
  raw.forEach((cluster, position) => cluster.members.forEach((member) => clusterOf.set(member, position)));
  const clusterSize = raw.map((cluster) => cluster.members.length);
  const familyHints = buildFamilyHints(tools, clusterOf, clusterSize);

  const usedLabels = new Set();
  const clusters = raw.map((cluster, position) => {
    const members = [...cluster.members].sort((a, b) => tools[a].name.localeCompare(tools[b].name));
    const label = uniqueLabel(labelFor(members.map((index) => tools[index].name)), usedLabels, position);
    return { label, tools: members.map((index) => tools[index].name) };
  });

  const riskyPairs = pairs
    .filter((pair) => clusterOf.get(pair.i) !== clusterOf.get(pair.j))
    .map((pair) => ({
      a: tools[pair.i].name,
      b: tools[pair.j].name,
      similarity: Number(pair.similarity.toFixed(2)),
      basis: pair.basis
    }))
    .sort((x, y) => y.similarity - x.similarity);

  const boundaries = buildBoundaries(tools, edges);

  return { threshold, total: tools.length, clusters, riskyPairs, familyHints, boundaries };
}

// Confusable pairs form connected components: that is the unit a platform can
// hand to an author ("these N tools compete; here is what each must say").
// Overlap with clusters is intentional — one asks where tools mount, the other
// asks what still needs a sentence.
function buildBoundaries(tools, edges) {
  const parent = tools.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  for (const edge of edges) union(edge.i, edge.j);

  const groups = new Map();
  for (const edge of edges) {
    const root = find(edge.i);
    const list = groups.get(root) ?? [];
    list.push(edge);
    groups.set(root, list);
  }

  const usedLabels = new Set();
  const boundaries = [];
  let position = 0;
  for (const list of groups.values()) {
    const memberSet = new Set();
    for (const edge of list) {
      memberSet.add(edge.i);
      memberSet.add(edge.j);
    }
    const members = [...memberSet].sort((a, b) => tools[a].name.localeCompare(tools[b].name));
    const label = uniqueLabel(labelFor(members.map((index) => tools[index].name)), usedLabels, position, "family");
    position += 1;
    const pairs = list
      .map((edge) => ({
        a: tools[edge.i].name,
        b: tools[edge.j].name,
        similarity: Number(edge.similarity.toFixed(2)),
        basis: edge.similarity >= BOUNDARY_SIMILARITY ? (edge.basis === "structural" ? "structural" : "lexical") : "family"
      }))
      .sort((x, y) => y.similarity - x.similarity || x.a.localeCompare(y.a));
    const { axes, sharedParams } = familyAxes(tools, members);
    boundaries.push({
      label,
      size: members.length,
      tools: members.map((index) => tools[index].name),
      axes,
      sharedParams,
      pairs,
      suggestion: familySuggestion(axes, sharedParams)
    });
  }

  return boundaries.sort(
    (x, y) => y.pairs.length - x.pairs.length || y.size - x.size || x.label.localeCompare(y.label)
  );
}

// The dimension each tool can claim inside its family: a name word no sibling
// uses, or failing that a parameter only it takes. A tool with neither has to
// describe its trigger scenario — no static signal can write that sentence.
function familyAxes(tools, members) {
  const tokenSets = new Map();
  const paramSets = new Map();
  const tokenCounts = new Map();
  const paramCounts = new Map();
  for (const index of members) {
    const tokens = new Set(nameTokens(tools[index].name));
    tokenSets.set(index, tokens);
    for (const token of tokens) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    const params = new Set(Object.keys(tools[index].parameters?.properties ?? {}));
    paramSets.set(index, params);
    for (const param of params) paramCounts.set(param, (paramCounts.get(param) ?? 0) + 1);
  }
  const axes = members.map((index) => ({
    tool: tools[index].name,
    distinct: [...tokenSets.get(index)].filter((token) => tokenCounts.get(token) === 1).sort(),
    paramsOnly: [...paramSets.get(index)].filter((param) => paramCounts.get(param) === 1).sort()
  }));
  const sharedParams = [...paramCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([param]) => param)
    .sort();
  return { axes, sharedParams };
}

function familySuggestion(axes, sharedParams) {
  const named = axes.filter((axis) => axis.distinct.length > 0);
  const unnamed = axes.filter((axis) => axis.distinct.length === 0);
  const parts = [];
  if (named.length > 0) {
    parts.push(`用名称里的独有词作判据：${named.map((axis) => `${axis.tool}=${axis.distinct.join("/")}`).join("；")}`);
  }
  if (unnamed.length > 0) {
    parts.push(`${unnamed.map((axis) => axis.tool).join("、")} 名称里没有独有词，需写明各自的触发场景`);
  }
  const shared = sharedParams.length > 0 ? `；共享参数 ${sharedParams.slice(0, 8).join("、")} 不能当判据` : "";
  return `${parts.join("；")}${shared}。在每个工具的 description 里各补一句“何时用我、何时用对方”，再补一条歧义用例`;
}

function buildFamilyHints(tools, clusterOf, clusterSize) {
  const byToken = new Map();
  tools.forEach((tool, index) => {
    for (const token of new Set(nameTokens(tool.name))) {
      if (token.length < 3 || FAMILY_HINT_STOP.has(token)) continue;
      const list = byToken.get(token) ?? [];
      list.push(index);
      byToken.set(token, list);
    }
  });

  const hints = [];
  const seen = new Set();
  for (const [token, members] of byToken) {
    if (members.length < 2) continue;
    const clusterIds = new Set(members.map((index) => clusterOf.get(index)));
    if (clusterIds.size < 2) continue;
    const names = members.map((index) => tools[index].name).sort();
    const signature = names.join("\n");
    if (seen.has(signature)) continue;
    seen.add(signature);
    const isLoose = (index) => clusterSize[clusterOf.get(index)] === 1;
    hints.push({
      token,
      size: names.length,
      merged: members.filter((index) => !isLoose(index)).map((index) => tools[index].name).sort(),
      loose: members.filter(isLoose).map((index) => tools[index].name).sort()
    });
  }
  return hints.sort((a, b) => b.size - a.size || a.token.localeCompare(b.token)).slice(0, 8);
}

function labelFor(names) {
  const counts = new Map();
  for (const name of names) {
    for (const token of nameTokens(name)) {
      if (!token || GENERIC_NAME_TOKENS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  let best = null;
  for (const [token, count] of counts) {
    if (!best || count > best.count || (count === best.count && token < best.token)) best = { token, count };
  }
  return best && best.count > 1 ? best.token : "";
}

function uniqueLabel(base, used, position, prefix = "cluster") {
  let label = base || `${prefix}-${position + 1}`;
  let suffix = 2;
  while (used.has(label)) {
    label = `${base || `${prefix}-${position + 1}`}-${suffix}`;
    suffix += 1;
  }
  used.add(label);
  return label;
}

export function formatClusters(result) {
  const lines = [
    `tools ${result.total} → clusters ${result.clusters.length}（threshold ${result.threshold}）`
  ];
  for (const cluster of result.clusters) {
    lines.push(`  [${cluster.label}] ${cluster.tools.length}: ${cluster.tools.join(", ")}`);
  }
  if (result.riskyPairs.length > 0) {
    lines.push("", "跨组高风险（相似但被分到不同组，合并挂载会互抢）：");
    for (const pair of result.riskyPairs) {
      const reason = pair.basis === "structural" ? "形状接近" : "描述相近";
      lines.push(`  ${pair.a} × ${pair.b}  ${pair.similarity.toFixed(2)}（${reason}）`);
    }
  }
  if ((result.familyHints ?? []).length > 0) {
    lines.push("", "同族候选（共享标识词但参数形状不同，未自动合并；以平台侧真实挂载映射为准）:");
    for (const hint of result.familyHints) {
      const parts = [];
      if (hint.merged.length > 0) parts.push(`已合并 ${hint.merged.join(", ")}`);
      if (hint.loose.length > 0) parts.push(`未合并 ${hint.loose.join(", ")}`);
      lines.push(`  [${hint.token}] ${hint.size} 个：${parts.join(" | ")}`);
    }
  }
  if ((result.boundaries ?? []).length > 0) {
    lines.push("", "族内边界清单（同族互抢的对，以及每个工具要补的区分词）:");
    for (const family of result.boundaries) {
      lines.push(`  [${family.label}] ${family.size} 个工具，${family.pairs.length} 对`);
      const axes = family.axes.map((axis) => {
        const label = axis.distinct.length > 0 ? axis.distinct.join("/") : axis.paramsOnly.length > 0 ? `参数 ${axis.paramsOnly.join("/")}` : "（无独有词）";
        return `${axis.tool}=${label}`;
      });
      lines.push(`    区分轴：${axes.join("；")}`);
      if (family.sharedParams.length > 0) {
        const shown = family.sharedParams.slice(0, 8).join("、");
        const more = family.sharedParams.length > 8 ? ` 等 ${family.sharedParams.length} 个` : "";
        lines.push(`    共享参数：${shown}${more}（不能当判据）`);
      }
      const top = family.pairs.slice(0, 5);
      const pairText = top
        .map((pair) => `${pair.a} × ${pair.b} ${pair.similarity.toFixed(2)}${pair.basis === "family" ? "（同族）" : ""}`)
        .join("；");
      const rest = family.pairs.length > top.length ? `；…共 ${family.pairs.length} 对（--json 看全部）` : "";
      lines.push(`    互抢对：${pairText}${rest}`);
      lines.push("    → 在各自 description 里补一句“何时用我、何时用对方”（判据见区分轴），再补一条歧义用例");
    }
  }
  return lines.join("\n");
}

const INTENTS = [
  { tool: "resume_score", words: ["简历", "匹配", "打分", "评分", "resume", "match"] },
  { tool: "interview_question", words: ["面试", "提问", "interview"] },
  { tool: "salary_band", words: ["薪资", "薪水", "工资", "salary", "pay", "多少"] },
  { tool: "jd_rewrite", words: ["改写", "润色", "重写", "rewrite", "jd"] }
];

const PARAM_HINTS = {
  resume: ["简历", "resume"],
  jd: ["职位描述", "岗位描述", "jd"],
  role: ["岗位", "职位", "role"],
  city: ["城市", "city"],
  level: ["级别", "职级", "level"],
  years: ["年限", "经验", "years"]
};

const NAME_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1.5;
const PARAM_WEIGHT = 0.5;
const INTENT_WEIGHT = 2.5;
const THRESHOLD = 2.5;

export function createMockAdapter() {
  return {
    label: "mock-router-v1",
    async call({ input, tools }) {
      const started = performance.now();
      const picked = pickTool(input, tools.map((tool) => tool.function ?? tool));
      const toolCalls = picked ? [{ name: picked.name, arguments: fillArgs(picked, input) }] : [];
      const toolNames = tools.map((tool) => (tool.function ?? tool).name).join(" ");
      const promptChars = input.length + toolNames.length + JSON.stringify(tools).length;
      const completionChars = JSON.stringify(toolCalls).length;
      return {
        ok: true,
        toolCalls,
        usage: {
          input: Math.ceil(promptChars / 2),
          output: Math.ceil(completionChars / 2),
          estimated: true
        },
        latencyMs: Math.round(performance.now() - started)
      };
    }
  };
}

function pickTool(input, tools) {
  const queryTokens = tokenize(input);
  let best = null;
  for (const tool of tools) {
    const score = scoreTool(tool, queryTokens, input);
    if (!best || score > best.score) best = { tool, score };
  }
  return best && best.score >= THRESHOLD ? best.tool : null;
}

function scoreTool(tool, queryTokens, input) {
  const lowered = input.toLowerCase();
  let score = overlap(queryTokens, tokenize(tool.name)) * NAME_WEIGHT;
  score += overlap(queryTokens, tokenize(tool.description)) * DESCRIPTION_WEIGHT;

  const props = tool.parameters?.properties ?? {};
  for (const [name, schema] of Object.entries(props)) {
    score += overlap(queryTokens, tokenize(`${name} ${schema?.description ?? ""}`)) * PARAM_WEIGHT;
  }

  for (const intent of INTENTS) {
    if (intent.tool !== tool.name) continue;
    if (intent.words.some((word) => lowered.includes(word.toLowerCase()))) {
      score += INTENT_WEIGHT;
      break;
    }
  }
  return score;
}

function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const token of b) if (a.has(token)) hits += 1;
  return hits;
}

function tokenize(text) {
  const tokens = new Set();
  const lowered = String(text ?? "").toLowerCase();
  for (const word of lowered.match(/[a-z][a-z0-9_]{1,}/g) ?? []) tokens.add(word);
  for (const chunk of lowered.match(/[一-鿿]+/g) ?? []) {
    if (chunk.length === 1) tokens.add(chunk);
    for (let i = 0; i + 1 < chunk.length; i += 1) tokens.add(chunk.slice(i, i + 2));
  }
  return tokens;
}

function fillArgs(tool, input) {
  const sections = parseSections(input);
  const args = {};
  const props = tool.parameters?.properties ?? {};
  for (const name of Object.keys(props)) {
    const value = findSectionValue(name, sections);
    if (value !== undefined) args[name] = value;
  }
  return args;
}

function parseSections(text) {
  const lines = String(text).split(/\r?\n/);
  const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*([^\s：:]{1,20})\s*[：:]\s*(.*)$/);
    if (!match) continue;
    const header = match[1].trim();
    let value = match[2].trim();
    if (value === "") {
      const body = [];
      let j = i + 1;
      while (j < lines.length) {
        const line = lines[j].trim();
        if (line === "" || /^[^\s：:]{1,20}\s*[：:]/.test(line)) break;
        body.push(line);
        j += 1;
      }
      value = body.join("\n");
    }
    if (value !== "") sections.push({ header, value });
  }
  return sections;
}

function findSectionValue(paramName, sections) {
  const hints = PARAM_HINTS[paramName] ?? [paramName];
  const loweredHints = hints.map((hint) => hint.toLowerCase());
  const hit = sections.find((section) => {
    const header = section.header.toLowerCase();
    return loweredHints.some((hint) => header.includes(hint));
  });
  if (!hit) return undefined;
  if (paramName === "years") {
    const number = hit.value.match(/\d+(?:\.\d+)?/);
    return number ? Number(number[0]) : undefined;
  }
  return hit.value;
}

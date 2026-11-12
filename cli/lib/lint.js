import { suspectedPairs, nameTokens, boundaryHint } from "./cases.js";
import { normalizeProfiles } from "./profile.js";

const GENERIC_NAMES = new Set([
  "run",
  "do",
  "tool",
  "helper",
  "execute",
  "action",
  "process",
  "handle",
  "call",
  "use"
]);

const WHEN_HINT = /(用于|用来|当|如果|适用|适合|use when|use this|helps? )/i;

// Identifier tokens, matched on token boundaries only: `request_text` is text,
// `request_id` is an identifier. Strong = platform-injected (session/tenant/trace
// class); weak = business id the user may or may not supply.
const STRONG_ID_TOKENS = new Set([
  "uuid", "guid", "sid", "nonce", "token", "signature",
  "sessionid", "tenantid", "traceid", "threadid", "conversationid", "correlationid", "requestid",
  "session", "tenant", "trace", "thread", "conversation", "correlation"
]);
const WEAK_ID_TOKENS = new Set(["id", "ids"]);
const OPAQUE_ID_SCHEMA = /uuid|[0-9a-f]{8}-[0-9a-f]{4}/i;
const DESCRIPTION_ID_HINT = /(会话\s*id|session\s*id|租户|tenant|trace|请求\s*id|request\s*id|签名|signature|\btoken\b|nonce|uuid|标识|编号)/i;
const ID_SOURCE_HINT = /(来源|取自|来自|传入|注入|平台|系统|上下文|请求头|header|无需|自动|会提供|由调用方|上一步)/i;
const FIXED_ID_LENGTHS = new Set([8, 16, 24, 32, 36, 40, 64]);

// Skills have no parameter schema, so name + description is all there is to
// compare. Two skills above this similarity are competing for the same intent.
// SKILL.md files share an authoring vocabulary ("Discord archive: search, sync
// freshness") that says nothing about overlap; tuned against a real 53-skill
// set, without it unrelated per-platform skills pair up.
const SKILL_PAIR_SIMILARITY = 0.35;
const SKILL_BOILERPLATE = new Set([
  "skill", "description", "operation", "management", "archive", "sync",
  "freshness", "triage", "work", "group", "related", "state", "count", "sql",
  "repo", "activate", "mention", "pipeline", "provider", "handle", "handling"
]);
const SKILL_NAME = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function idStrength(name) {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1];
  const joinedTail = tokens.slice(-2).join("");
  if (STRONG_ID_TOKENS.has(last) || STRONG_ID_TOKENS.has(joinedTail)) return "strong";
  if (WEAK_ID_TOKENS.has(last)) return "weak";
  return null;
}

const BOUNDARY_HINT = /(不适用|不要用于|不用于|不能用于|而非|区别于|not for|do not use)/i;
// Chinese descriptions are compared as bigrams, so mid-0.3s similarity is noise.
const NO_BOUNDARY_SIMILARITY = 0.5;
// Two advisory checks from real description experiments: imperatives aimed at
// optional params can suppress the call entirely, and renamed tools leave stale
// names in sibling descriptions. Both are info-only; they depend on wording.
const OPTIONAL_HINT =
  /(可选|optional|非必填|如有|如果需要|可提供|if [^.\n]{0,30}\b(provided|available|present|omitted)\b|when [^.\n]{0,30}\b(provided|available|present)\b)/i;
const IMPERATIVE_ZH = /(传入|传|提供|带上|设置|指定|填写|附上|注明)/;
// `Include tool messages` is a noun-phrase switch description, not an
// imperative; `include` stays out of the start-of-description list.
const IMPERATIVE_START_EN = /^(pass|provide|supply|set|specify|add|send|put)\b/i;
const IMPERATIVE_START_ZH = /^(传入|传|提供|带上|设置|指定|填写|附上|注明)/;
// English descriptions routinely start with the tool's own action
// ("Send message to ... by sessionKey"). Require an explicit parameter link
// ("... via the title parameter") so tool behaviour is not read as guidance.
const BACKTICK_ID = /`([a-z][a-z0-9_-]{2,})`/g;
const SNAKE_ID = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
const NON_TOOL_SUFFIX =
  /_(id|ids|key|token|path|name|url|uri|type|schema|count|size|format|length|text|json|yaml|yml|md|txt|html|htm|pdf|csv)$/;
const NON_TOOL_NAMES = new Set([
  "api_key", "access_token", "base_url", "content_type", "status_code", "error_code",
  "http_status", "input_schema", "output_schema", "json_schema", "file_path", "file_name",
  "user_id", "session_id", "tenant_id", "request_id", "trace_id", "tool_name", "mcp_server"
]);
const ACTION_TOKENS = new Set([
  "get", "set", "list", "read", "write", "search", "create", "delete", "update", "send",
  "fetch", "query", "run", "exec", "execute", "open", "close", "add", "remove", "check",
  "scan", "parse", "score", "match", "generate", "render", "save", "load", "find", "lookup",
  "call", "invoke", "publish", "edit", "rewrite", "analyze", "analyse", "summarize",
  "summarise", "translate", "copy", "move", "mark", "reply", "download", "upload",
  "tool", "tools", "info", "data", "result", "results", "item",
  "items", "skill", "skills", "mcp"
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsImperatively(text, name) {
  if (!text || !name) return false;
  let index = text.indexOf(name);
  while (index !== -1) {
    const around = text.slice(Math.max(0, index - 80), Math.min(text.length, index + name.length + 80));
    // "optional charts" earlier in a long description must not mask a real
    // imperative later. Only a hint next to this occurrence exempts it.
    const optionalAround = text.slice(
      Math.max(0, index - 30),
      Math.min(text.length, index + name.length + 30)
    );
    if (!OPTIONAL_HINT.test(optionalAround)) {
      if (explicitImperativeEnglish(around, name) || IMPERATIVE_ZH.test(around)) return true;
    }
    index = text.indexOf(name, index + name.length);
  }
  return false;
}

function explicitImperativeEnglish(text, name) {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(
    `\\b(pass|provide|supply|set|specify|add|send|put)\\b[^.!?\\n]{0,80}(?:^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])[^.!?\\n]{0,40}\\b(parameter|param|argument|field|option)\\b`,
    "i"
  );
  return pattern.test(text);
}

function startsImperatively(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || OPTIONAL_HINT.test(trimmed)) return false;
  return IMPERATIVE_START_EN.test(trimmed) || IMPERATIVE_START_ZH.test(trimmed);
}

// A one-shot claim contradicts a parameter that accepts both inline content and
// a locator ("file contents or file paths"). The model reads the parameter as a
// licence to fetch first, and first-call scoring records the legal two-step plan
// as a misroute. The claim has three observed wordings: direct-call ("call this
// tool directly"), imperative negative ("do NOT call file_read first") and
// self-contained ("this tool does the reading itself"). Only the first was
// recognised in 0.8.0, and the field data says the latter two dominate.
const ONE_SHOT_HINT = /(?:call|use)\s+(?:this|the)\s+tool\s+directly|直接调用(?:本|该|此)工具/i;
const ONE_SHOT_FORBIDS_PREP =
  /\b(?:do\s+not|don't|never)\s+(?:call|use|invoke)\s+[^\s,.!?;]+(?:\s+or\s+[^\s,.!?;]+)*\s+(?:first|before|prior)\b/i;
const ONE_SHOT_SELF_CONTAINED =
  /\b(?:does|performs|handles)\s+the\s+(?:reading|writing|reading\s+and\s+writing)\b[^.!?\n]{0,30}\b(?:itself|internally)\b/i;
const ONE_SHOT_ZH = /(?:不要|请勿|无需|不需要|禁止)\s*先\s*(?:调用|使用)|(?:本工具|该工具)(?:会)?(?:自己|自行)(?:完成)?(?:读取|读写|读和写)/;
const CONTENT_INPUT = /(?:内容|正文|\bcontents?\b|\braw text\b|\btext body\b|\binline text\b)/i;
const LOCATOR_INPUT = /(?:路径|\bpaths?\b|\bfile ?names?\b|\bfilenames?\b|\burls?\b|\buris?\b|\blinks?\b|\blocations?\b)/i;
const ALTERNATIVE_SPLIT = /([^.;。；\n]{0,40})(?:或者|或|\s+\bor\b\s+|\s+[\/／]\s+)([^.;。；\n]{0,40})/gi;

function contradictoryAlternatives(text) {
  for (const match of String(text ?? "").matchAll(ALTERNATIVE_SPLIT)) {
    const left = match[1];
    const right = match[2];
    if (
      (CONTENT_INPUT.test(left) && LOCATOR_INPUT.test(right)) ||
      (LOCATOR_INPUT.test(left) && CONTENT_INPUT.test(right))
    ) {
      return true;
    }
  }
  return false;
}

function referencedNames(text) {
  const found = new Set();
  for (const match of String(text ?? "").matchAll(BACKTICK_ID)) found.add(match[1]);
  for (const match of String(text ?? "").matchAll(SNAKE_ID)) found.add(match[1]);
  return found;
}

function familySibling(a, b) {
  const aTokens = nameTokens(a);
  const bTokens = nameTokens(b);
  if (aTokens.length === 0 || bTokens.length === 0) return null;
  const family = aTokens[0] === bTokens[0] ? aTokens[0] : null;
  // `search_docs` × `search_wiki` share an action verb, not a product family;
  // those still warrant a boundary. A family prefix is a domain noun.
  if (!family || ACTION_TOKENS.has(family)) return null;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const uniqueA = aTokens.filter((token) => !bSet.has(token));
  const uniqueB = bTokens.filter((token) => !aSet.has(token));
  // Both sides must carry a distinct action token. Same-domain tools with
  // different objects can still be confusable (`events_poll` × `events_wait`).
  if (!uniqueA.some((token) => ACTION_TOKENS.has(token))) return null;
  if (!uniqueB.some((token) => ACTION_TOKENS.has(token))) return null;
  return { family, a: uniqueA.join("/"), b: uniqueB.join("/") };
}

function sharedDomainToken(candidate, toolNames) {
  const candidateTokens = new Set(nameTokens(candidate).filter((token) => !ACTION_TOKENS.has(token)));
  if (candidateTokens.size === 0) return null;
  for (const known of toolNames) {
    const knownTokens = new Set(nameTokens(known).filter((token) => !ACTION_TOKENS.has(token)));
    for (const token of candidateTokens) {
      if (knownTokens.has(token)) return { name: known, token };
    }
  }
  return null;
}

// `pairScope` (a Set of names) is for incremental gates: only emit pair
// findings that touch one of the new capabilities. Installed × installed pairs
// are computed and then discarded by the caller, which dominates large sets.
export function lintSuite(suite, { pairScope } = {}) {
  const inScope = (pair) => !pairScope || pairScope.has(pair.a) || pairScope.has(pair.b);
  const toolByName = new Map(suite.tools.map((tool) => [tool.name, tool]));
  const toolNamesList = suite.tools.map((tool) => tool.name);
  const knownNames = new Set([
    ...toolNamesList,
    ...(suite.skills ?? []).map((skill) => skill.name),
    ...suite.tools.flatMap((tool) => Object.keys(tool.parameters?.properties ?? {}))
  ]);
  const findings = [];
  const add = (severity, code, tool, message, extra = {}) =>
    findings.push({ severity, code, kind: "tool", tool, message, ...extra });
  const addSkill = (severity, code, skill, message, extra = {}) =>
    findings.push({ severity, code, kind: "skill", skill, message, ...extra });

  // Mounting groups, when declared: a confusable pair split across groups is a
  // merge hazard (mounting both groups on one agent recreates the collision),
  // while the same pair inside one group is just a normal authoring problem.
  const profileGroups = suite.profiles
    ? normalizeProfiles(suite.profiles, suite.tools.map((tool) => tool.name))
    : [];
  const toolGroups = new Map();
  for (const profile of profileGroups) {
    for (const name of profile.tools) {
      const groups = toolGroups.get(name);
      if (groups) groups.push(profile.name);
      else toolGroups.set(name, [profile.name]);
    }
  }
  const crossGroups = new Map();
  const recordCrossPair = (groupA, groupB, pair) => {
    const [a, b] = groupA < groupB ? [groupA, groupB] : [groupB, groupA];
    const key = `${JSON.stringify([a, b])}`;
    const entry = crossGroups.get(key) ?? { a, b, pairs: [] };
    entry.pairs.push({ toolA: pair.a, toolB: pair.b, similarity: pair.similarity });
    crossGroups.set(key, entry);
  };

  for (const tool of suite.tools) {
    const description = (tool.description ?? "").trim();
    const template = `建议：\`${tool.name}：当用户需要____时使用。输入____，返回____。不适用于____。\``;
    const oneShotClaim =
      ONE_SHOT_HINT.test(description) ||
      ONE_SHOT_FORBIDS_PREP.test(description) ||
      ONE_SHOT_SELF_CONTAINED.test(description) ||
      ONE_SHOT_ZH.test(description);

    if (tool.descriptionSource === "runtime") {
      // The description exists at runtime but is assembled in code, so static
      // review cannot judge its wording. Not a defect.
      add("info", "desc-runtime", tool.name, "description 由代码在运行时生成，静态不可评；请确认运行时输出包含触发时机与边界");
    } else if (!description) {
      add("error", "desc-missing", tool.name, "工具没有 description，模型无法判断何时调用", { suggestion: template });
    } else {
      if (description.length < 20) {
        add("warn", "desc-short", tool.name, `description 只有 ${description.length} 字，信息不足`, { suggestion: template });
      }
      if (description.length > 600) {
        add("info", "desc-long", tool.name, `description ${description.length} 字，可能挤占上下文`);
      }
      if (!WHEN_HINT.test(description)) {
        add("warn", "desc-no-when", tool.name, "description 没说明触发时机（用于/当/适用…），模型容易误选", {
          suggestion: template
        });
      }
    }

    // Naming style is an ecosystem convention, not a model-facing defect:
    // Claude-style PascalCase agents work fine on their own. Info only.
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      add("info", "name-style", tool.name, "工具名不是小写 snake_case；对外分发（MCP/插件市场）时建议统一");
    }
    if (GENERIC_NAMES.has(tool.name)) {
      add("warn", "name-generic", tool.name, "工具名过于通用，容易和其它工具混淆", {
        suggestion: "建议用“动词_名词”，例如 search_docs、score_resume"
      });
    }

    const parameters = tool.parameters ?? {};
    const properties = parameters.properties ?? {};
    const required = parameters.required ?? [];
    const names = Object.keys(properties);

    if (names.length === 0) {
      add("info", "schema-empty", tool.name, "工具没有参数；确认确实不需要输入");
    }
    if (required.length > 5) {
      add("warn", "required-many", tool.name, `有 ${required.length} 个必填参数，模型容易漏填或编造`, {
        suggestion: "把非关键参数改为可选，或在输入里提供默认值"
      });
    }

    for (const name of required) {
      const schema = properties[name];
      if (!schema) continue;
      const description = String(schema.description ?? "");
      const fixedLength =
        typeof schema.minLength === "number" &&
        schema.minLength === schema.maxLength &&
        FIXED_ID_LENGTHS.has(schema.minLength);
      const schemaOpaque =
        (typeof schema.format === "string" && OPAQUE_ID_SCHEMA.test(schema.format)) ||
        (typeof schema.pattern === "string" && OPAQUE_ID_SCHEMA.test(schema.pattern)) ||
        fixedLength;
      const nameStrength = idStrength(name);
      // Name tokens alone are a weak signal: the author picks the names. Schema
      // shape and the description are what the model actually reasons from.
      const strong = schemaOpaque || DESCRIPTION_ID_HINT.test(description) || nameStrength === "strong";
      const weak = nameStrength === "weak";
      const scalar = schema.type === undefined || schema.type === "string";
      if ((strong || weak) && scalar && !ID_SOURCE_HINT.test(description)) {
        add(
          strong ? "warn" : "info",
          "required-unsourced",
          tool.name,
          strong
            ? `必填参数 ${name} 像是外部注入的标识，但没说明从哪里获取；模型拿不到它时可能干脆不调用任何工具`
            : `必填参数 ${name} 是业务 ID；如果用户不会在对话里给出，模型可能编造或干脆不调用`,
          {
            param: name,
            suggestion: `改为平台注入（移出 schema），或在 description 写明来源，例如「由平台在会话开始时注入，模型无需生成」`
          }
        );
      }
    }

    const toolCases = (suite.cases ?? []).filter((testCase) => testCase.expectedTool === tool.name);
    if (toolCases.length > 0) {
      for (const name of required) {
        const covered = toolCases.some(
          (testCase) => testCase.expectedArgs && Object.prototype.hasOwnProperty.call(testCase.expectedArgs, name)
        );
        if (!covered) {
          add("info", "required-uncovered", tool.name, `必填参数 ${name} 没有任何用例校验过，模型是否真能填对它还没有证据`, {
            param: name,
            suggestion: `补一条用例在 expectedArgs 里断言 ${name}，或把它降为可选 / 改为平台注入`
          });
        }
      }
    }

    for (const [name, schema] of Object.entries(properties)) {
      if (!schema?.description) {
        add("warn", "param-desc-missing", tool.name, `参数 ${name} 没有说明`, {
          param: name,
          suggestion: `建议：\`${name}：____（格式：____；示例：____）\``
        });
      }
      if (!schema?.type) {
        add("error", "param-type-missing", tool.name, `参数 ${name} 没有 type`, { param: name });
      }
      if (schema?.type === "object" && !schema.properties) {
        add("warn", "param-object-no-props", tool.name, `参数 ${name} 是 object 但未定义 properties`, { param: name });
      }
      if (schema?.type === "array" && !schema.items) {
        add("warn", "param-array-no-items", tool.name, `参数 ${name} 是数组但未定义 items`, { param: name });
      }
      if (oneShotClaim && contradictoryAlternatives(schema?.description)) {
        add(
          "warn",
          "desc-or-contradiction",
          tool.name,
          `参数 ${name} 同时接受“内容”和“路径/链接”两种输入，但 description 声称无需前置调用；模型可能先调用读取类工具，首轮评分会把合法两步记为误选`,
          {
            param: name,
            suggestion: `二选一：只接受已提供的内容，或只接受路径并在 description 写明“本工具会读取”；不要把两种输入模式放在同一参数里`
          }
        );
      }
    }

    for (const name of names) {
      if (required.includes(name)) continue;
      const schema = properties[name] ?? {};
      if (mentionsImperatively(description, name) || startsImperatively(schema.description)) {
        add(
          "info",
          "param-optional-imperative",
          tool.name,
          `可选参数 ${name} 用了祈使句提示；用户输入没提供它时，模型可能因此干脆不调用`,
          {
            param: name,
            suggestion: `改成条件式（例如「如有${name}可传入」），或把 ${name} 改为必填`
          }
        );
      }
    }

    for (const ref of referencedNames(description)) {
      if (ref === tool.name || knownNames.has(ref) || NON_TOOL_NAMES.has(ref) || NON_TOOL_SUFFIX.test(ref)) {
        continue;
      }
      const similar = sharedDomainToken(ref, toolNamesList);
      const backticked = new RegExp(`\`${escapeRegExp(ref)}\``).test(description);
      if (!similar && !backticked) continue;
      add(
        "info",
        "desc-dangling-tool",
        tool.name,
        similar
          ? `description 提到 ${ref}，但套件里没有这个工具；最接近的是 ${similar.name}（共享 ${similar.token}）。若是改名，请同步描述引用`
          : `description 用代码格式提到 ${ref}，但套件里没有这个工具；确认不是改名后遗留的悬空引用`,
        { ref, ...(similar ? { similarTo: similar.name } : {}) }
      );
    }
  }

  for (const pair of suspectedPairs(suite.tools)) {
    if (!inScope(pair)) continue;
    const similarity = pair.similarity.toFixed(2);
    const declaresBoundary = [pair.a, pair.b].some((name) => {
      const tool = toolByName.get(name);
      return BOUNDARY_HINT.test(tool?.description ?? "");
    });
    const sibling = familySibling(pair.a, pair.b);
    if (declaresBoundary) {
      add("info", "pair-overlap", pair.a, `与 ${pair.b} 的描述相似度 ${similarity}，已写互斥边界`, {
        pair: [pair.a, pair.b]
      });
    } else if (sibling) {
      add(
        "info",
        "pair-family-sibling",
        pair.a,
        `与 ${pair.b} 同族（共享 ${sibling.family}，区分词 ${sibling.a} vs ${sibling.b}），描述相近但动作/对象不同`,
        {
          pair: [pair.a, pair.b],
          family: sibling.family,
          suggestion: `确认 ${pair.a} 与 ${pair.b} 的 description 各自写清动作区别；同族分开挂载通常没问题`
        }
      );
    } else if (pair.similarity >= NO_BOUNDARY_SIMILARITY) {
      const aGroups = toolGroups.get(pair.a) ?? [];
      const bGroups = toolGroups.get(pair.b) ?? [];
      if (aGroups.length > 0 && bGroups.length > 0 && !aGroups.some((group) => bGroups.includes(group))) {
        for (const groupA of aGroups) {
          for (const groupB of bGroups) recordCrossPair(groupA, groupB, pair);
        }
      }
      const reason = pair.basis === "structural" ? "名字与参数形状接近" : "描述相近";
      const toolA = toolByName.get(pair.a);
      const toolB = toolByName.get(pair.b);
      add("warn", "pair-no-boundary", pair.a, `与 ${pair.b} ${reason}（相似度 ${similarity}），且两边都没写“不适用于”边界，模型只能靠相似度硬猜`, {
        pair: [pair.a, pair.b],
        suggestion: boundaryHint(toolA, toolB).suggestion
      });
    }
  }

  // Skills are prompt-injected (name + description only), so the install-time
  // question is narrower than for tools: is the description specific enough to
  // be triggered, and does it collide with another installed skill?
  const skills = suite.skills ?? [];
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  for (const skill of skills) {
    const description = String(skill.description ?? "").trim();
    if (!description) {
      addSkill("info", "skill-desc-missing", skill.name, "skill 没有 description，模型只能靠名字判断是否触发", {
        suggestion: "在 SKILL.md frontmatter 补一句 description，写清楚“用于什么任务、不适用于什么”"
      });
    } else if (description.length < 20) {
      addSkill("warn", "skill-desc-short", skill.name, `description 只有 ${description.length} 字，信息不足`, {
        suggestion: "写清楚触发场景与边界，例如「用于____；不适用于____」"
      });
    } else if (description.length > 600) {
      addSkill("info", "skill-desc-long", skill.name, `description ${description.length} 字，可能挤占上下文`);
    }
    if (!SKILL_NAME.test(skill.name)) {
      addSkill("warn", "skill-name-style", skill.name, "skill 名建议用小写 kebab-case 或 snake_case");
    }
  }

  for (const pair of suspectedPairs(skills, {
    threshold: SKILL_PAIR_SIMILARITY,
    extraStop: SKILL_BOILERPLATE
  })) {
    if (!inScope(pair)) continue;
    const similarity = pair.similarity.toFixed(2);
    const declaresBoundary = [pair.a, pair.b].some((name) => {
      const skill = skillByName.get(name);
      return BOUNDARY_HINT.test(skill?.description ?? "");
    });
    // Same-vendor siblings ("feishu-doc" / "feishu-wiki") share the vendor token
    // but each name carries its own distinguishing word. That is a family, not a
    // duplicate — worth telling the author, not worth a warning.
    const nameBits = [pair.a, pair.b].map(
      (name) => new Set(nameTokens(name).filter((token) => !SKILL_BOILERPLATE.has(token)))
    );
    const sharedNames = [...nameBits[0]].filter((token) => nameBits[1].has(token));
    const uniqueNames = nameBits.map((own, index) =>
      [...own].filter((token) => !nameBits[1 - index].has(token))
    );
    const sibling = sharedNames.length > 0 && uniqueNames.every((list) => list.length > 0);

    if (declaresBoundary) {
      addSkill("info", "skill-pair-overlap", pair.a, `与 ${pair.b} 的描述相似度 ${similarity}，已写互斥边界`, {
        pair: [pair.a, pair.b]
      });
    } else if (sibling) {
      addSkill(
        "info",
        "skill-pair-sibling",
        pair.a,
        `与 ${pair.b} 同族（共享 ${sharedNames.join("/")}，以 ${uniqueNames[0].join("/")} 与 ${uniqueNames[1].join("/")} 区分），相似度 ${similarity}`,
        {
          pair: [pair.a, pair.b],
          suggestion: `确认 ${pair.a} 与 ${pair.b} 的 description 里各自写清区别；同族分开挂载通常没问题`
        }
      );
    } else {
      addSkill(
        "warn",
        "skill-pair-no-boundary",
        pair.a,
        `与 ${pair.b} 的描述高度重叠（相似度 ${similarity}），skills 没有参数形状可区分，模型只能靠字面猜`,
        {
          pair: [pair.a, pair.b],
          suggestion: `在 ${pair.a} 和 ${pair.b} 的 description 里写清各自边界，或合并成一个 skill`
        }
      );
    }
  }

  const counts = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const profilePairs = [...crossGroups.values()]
    .map((entry) => ({ ...entry, max: Math.max(...entry.pairs.map((item) => item.similarity)) }))
    .sort(
      (x, y) =>
        y.max - x.max ||
        y.pairs.length - x.pairs.length ||
        `${x.a} ${x.b}`.localeCompare(`${y.a} ${y.b}`)
    );
  return { tools: suite.tools.length, skills: skills.length, counts, findings, profilePairs };
}

// A mature 47-tool gateway produces ~70 findings where 60 are the same rule
// repeated. An install gate that prints all of them is unreadable, so repeats
// are folded into one block; the JSON keeps every finding for tooling.
const AGGREGATE_MIN = 3;
const KEEP_INDIVIDUAL = new Set([
  "pair-no-boundary",
  "pair-overlap",
  "skill-pair-no-boundary",
  "skill-pair-overlap"
]);

function subjectOf(finding) {
  if (finding.kind === "skill") return `skill ${finding.skill}`;
  return `${finding.tool}${finding.param ? `.${finding.param}` : ""}`;
}

export function formatLint(report) {
  const { counts, findings } = report;
  const skillCount = report.skills ?? 0;
  const head = `tools: ${report.tools}${skillCount > 0 ? `  skills: ${skillCount}` : ""}  findings: ${findings.length}（error ${counts.error} / warn ${counts.warn} / info ${counts.info}）`;
  const profilePairs = report.profilePairs ?? [];
  if (findings.length === 0 && profilePairs.length === 0) {
    return `${head}\n没有发现问题`;
  }

  const byCode = new Map();
  for (const finding of findings) {
    const list = byCode.get(finding.code) ?? [];
    list.push(finding);
    byCode.set(finding.code, list);
  }
  const bulk = [...byCode].filter(
    ([code, list]) =>
      list.length >= AGGREGATE_MIN && !KEEP_INDIVIDUAL.has(code) && list[0].severity !== "error"
  );
  const bulkCodes = new Set(bulk.map(([code]) => code));
  const lines = [head];

  if (bulk.length > 0) {
    lines.push("", `重复问题（同一规则 ≥${AGGREGATE_MIN} 条，已合并；逐条明细见 --json）:`);
    for (const [code, list] of bulk) {
      const first = list[0];
      lines.push(`[${first.severity}] ${code} × ${list.length}  ${first.message}`);
      const subjects = list.map(subjectOf);
      lines.push(
        `        涉及：${subjects.slice(0, 8).join("、")}${subjects.length > 8 ? ` 等 ${subjects.length} 处` : ""}`
      );
      if (first.suggestion) lines.push(`         ${first.suggestion}`);
    }
  }

  const rest = findings.filter((finding) => !bulkCodes.has(finding.code));
  if (rest.length > 0) {
    if (bulk.length > 0) lines.push("", "逐条:");
    for (const finding of rest) {
      lines.push(`[${finding.severity}] ${subjectOf(finding)}  ${finding.code}: ${finding.message}`);
      if (finding.suggestion) lines.push(`         ${finding.suggestion}`);
    }
  }

  if (profilePairs.length > 0) {
    lines.push("", "组间高风险对（这些组不建议合并挂载）:");
    for (const group of profilePairs) {
      lines.push(`  ${group.a} × ${group.b}  ${group.pairs.length} 对（最高 ${group.max.toFixed(2)}）`);
      for (const item of group.pairs) {
        lines.push(`    ${item.toolA} × ${item.toolB}  ${item.similarity.toFixed(2)}`);
      }
    }
  }
  return lines.join("\n");
}

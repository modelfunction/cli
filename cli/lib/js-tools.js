// Static extraction of tool definitions from JS/TS source. This never executes
// the file: it parses the subset of expressions that real registries use —
// object/array literals, `const` references to those literals, and the TypeBox
// (`Type.Object`) / zod (`z.object`) builders. Anything else is reported as
// unresolved instead of being guessed, because a wrong schema is worse than a
// missing tool.
const MAX_VALUE_DEPTH = 24;
const MAX_RESOLVE_DEPTH = 8;
const MAX_ARRAY_ATTEMPTS = 300;

const PREFILTER = /inputSchema|parameters\s*:|registerTool|\.tool\s*\(|buildTool|defineTool|createTool|Type\.Object|[tz]\.object/;
const TOOL_BUILDERS = new Set(["buildTool", "defineTool", "createTool", "makeTool"]);
// `async () => {}` and `function () {}` otherwise parse as a call named
// "async"/"function" and swallow the rest of the argument list.
const RESERVED = new Set([
  "async", "await", "function", "new", "return", "if", "else", "for", "while",
  "do", "switch", "case", "try", "catch", "finally", "throw", "typeof", "void",
  "delete", "in", "of", "instanceof", "class", "const", "let", "var", "export",
  "import", "yield", "this", "super"
]);
const SCHEMA_KEYS = ["inputSchema", "parameters", "input", "parametersSchema", "schema"];

export function extractJsTools(src, { externals, onUnresolvedName } = {}) {
  if (typeof src !== "string" || !PREFILTER.test(src)) return [];
  const ctx = { src, bindings: collectBindings(src), parsed: new Map(), externals, onUnresolvedName };
  const tools = [];
  const seen = new Set();
  const push = (tool) => {
    if (!tool || !tool.name || seen.has(tool.name)) return;
    seen.add(tool.name);
    tools.push(tool);
  };
  let attempts = 0;

  for (const match of src.matchAll(/([A-Za-z_$][\w$]*)\.(tool|registerTool)\s*\(/g)) {
    const parsed = parseArgs(src, match.index + match[0].length - 1);
    if (parsed) push(toolFromArgs(parsed.items, ctx));
  }
  // Plugin registries (e.g. anything-llm) call `aibitat.function({ name,
  // description, parameters })` inside a setup hook instead of a builder.
  for (const match of src.matchAll(/\.function\s*\(/g)) {
    const parsed = parseArgs(src, match.index + match[0].length - 1);
    if (!parsed || !parsed.items[0] || parsed.items[0].t !== "obj") continue;
    const node = parsed.items[0];
    const preset = {};
    const nameNode = node.props.get("name");
    if (!nameNode || nameNode.t !== "str") {
      // Plugin registries often write `name: this.name` inside the setup hook;
      // the literal lives on the enclosing plugin object just above it.
      const before = src.slice(Math.max(0, match.index - 2000), match.index);
      const names = [...before.matchAll(/name\s*:\s*["']([^"']+)["']/g)];
      if (names.length > 0) preset.name = names[names.length - 1][1];
    }
    push(toolFromObject(node, ctx, preset));
  }
  for (const match of src.matchAll(/(?<![.\w$])registerTool\s*\(/g)) {
    const parsed = parseArgs(src, match.index + match[0].length - 1);
    if (parsed) push(toolFromArgs(parsed.items, ctx));
  }
  for (const match of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!TOOL_BUILDERS.has(match[1])) continue;
    const parsed = parseArgs(src, match.index + match[0].length - 1);
    if (!parsed || !parsed.items[0] || parsed.items[0].t !== "obj") continue;
    push(toolFromObject(parsed.items[0], ctx));
  }
  for (const match of src.matchAll(/(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=\n]{0,200})?=\s*\{/g)) {
    const parsed = parseValue(src, match.index + match[0].length - 1, 0);
    if (parsed && parsed.node.t === "obj") push(toolFromObject(parsed.node, ctx));
  }
  for (const match of src.matchAll(/\[\s*\{/g)) {
    if (attempts >= MAX_ARRAY_ATTEMPTS) break;
    attempts += 1;
    const parsed = parseValue(src, match.index, 0);
    if (!parsed || parsed.node.t !== "arr") continue;
    for (const item of parsed.node.items) {
      if (item && item.t === "obj") push(toolFromObject(item, ctx));
    }
  }
  return tools;
}

function toolFromArgs(args, ctx) {
  const name = stringOf(args[0], ctx);
  if (!name) return null;
  let description = "";
  let parameters = null;
  for (const arg of args.slice(1)) {
    if (!arg) continue;
    if (arg.t === "str") {
      if (!description) description = arg.value;
      continue;
    }
    if (arg.t !== "obj") continue;
    const fromObject = toolFromObject(arg, ctx, { name, description });
    if (fromObject) return fromObject;
  }
  for (const arg of args.slice(1)) {
    if (!arg) continue;
    const { schema, resolved } = schemaOf(arg, ctx);
    if (!resolved || !isSchema(schema)) continue;
    parameters = schema;
    break;
  }
  if (!parameters) return null;
  return { name, description, parameters };
}

function toolFromObject(node, ctx, preset = {}) {
  const name = preset.name ?? stringOf(node.props.get("name"), ctx) ?? stringOf(node.props.get("toolName"), ctx);
  if (!name) return undefined;
  const description =
    stringOf(node.props.get("description"), ctx) ??
    stringOf(node.props.get("summary"), ctx) ??
    preset.description ??
    "";
  let schemaNode = null;
  for (const key of SCHEMA_KEYS) {
    if (node.props.has(key)) {
      schemaNode = node.props.get(key);
      break;
    }
  }
  if (!schemaNode) return undefined;
  const { schema, resolved } = schemaOf(schemaNode, ctx);
  if (!resolved || !isSchema(schema)) return undefined;
  // An empty schema with no description and no tool behaviour is a config
  // object that happens to be shaped like a tool (`{ name: "mcp" }`).
  const toolish =
    node.props.has("call") ||
    node.props.has("prompt") ||
    node.props.has("userFacingName") ||
    node.props.has("isEnabled") ||
    node.props.has("searchHint");
  if (!description && Object.keys(schema.properties ?? {}).length === 0 && !toolish) return undefined;
  // Claude-style tools build the description in `async description()`, a
  // template string, or a constant the parser cannot resolve; lint must not
  // call that "missing". A literal empty string is still missing.
  const descNode = node.props.get("description");
  const runtimeDescription =
    !description &&
    ((descNode !== undefined && descNode.t !== "str") || node.props.has("prompt"));
  return { name, description, parameters: schema, ...(runtimeDescription ? { descriptionSource: "runtime" } : {}) };
}

function isSchema(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function stringOf(node, ctx) {
  if (!node) return null;
  if (node.t === "str") return node.value;
  if (node.t === "ident") {
    // `name: CONFIG_TOOL_NAME` — a local const, or a repo-wide uppercase
    // constant indexed by the scanner across files.
    const local = resolveIdent(node.name, ctx);
    if (local && local.t === "str") return local.value;
    const external = ctx?.externals?.get(node.name);
    if (typeof external === "string") return external;
    ctx?.onUnresolvedName?.(node.name);
    return null;
  }
  if (node.t === "obj") {
    const value = node.props.get("value");
    if (value && value.t === "str") return value.value;
  }
  return null;
}

// ---- schema construction -------------------------------------------------

function schemaOf(node, ctx, depth = 0) {
  if (!node || depth > MAX_VALUE_DEPTH) return { schema: {}, resolved: false };
  if (node.t === "ident") {
    const resolvedNode = resolveIdent(node.name, ctx, depth);
    if (!resolvedNode) return { schema: {}, resolved: false };
    return schemaOf(resolvedNode, ctx, depth + 1);
  }
  if (node.t === "obj") {
    if (node.props.has("type") || node.props.has("properties") || node.props.has("items")) {
      return { schema: jsonSchemaLiteral(node, ctx, depth), resolved: true };
    }
    // MCP SDK shape argument: server.tool("x", "desc", { query: z.string() }).
    const rawShape = rawShapeSchema(node, ctx, depth);
    return rawShape ? { schema: rawShape, resolved: true } : { schema: {}, resolved: false };
  }
  if (node.t !== "call") return { schema: {}, resolved: false };

  const args = node.args ?? [];
  const callee = node.callee;
  let schema = null;
  let optional = false;

  switch (callee) {
    case "Type.Object":
    case "t.Object":
    case "z.object":
    case "z.strictObject":
    case "z.looseObject":
      schema = objectSchema(args[0], ctx, depth);
      break;
    case "Type.String":
    case "t.String":
    case "z.string":
      schema = { type: "string" };
      break;
    case "Type.Number":
    case "t.Number":
    case "z.number":
      schema = { type: "number" };
      break;
    case "Type.Integer":
    case "t.Integer":
    case "z.int":
      schema = { type: "integer" };
      break;
    case "z.coerce.number":
      schema = { type: "number" };
      break;
    case "z.coerce.string":
      schema = { type: "string" };
      break;
    case "z.coerce.boolean":
      schema = { type: "boolean" };
      break;
    case "Type.Boolean":
    case "t.Boolean":
    case "z.boolean":
      schema = { type: "boolean" };
      break;
    case "Type.Array":
    case "t.Array":
    case "z.array": {
      const item = schemaOf(args[0], ctx, depth + 1);
      schema = { type: "array", items: item.schema };
      break;
    }
    case "Type.Optional":
    case "z.optional": {
      const inner = schemaOf(args[0], ctx, depth + 1);
      return { ...inner, optional: true };
    }
    case "Type.Literal":
    case "t.Literal":
    case "z.literal": {
      const value = plainOf(args[0]);
      schema = value === undefined ? {} : { enum: [value] };
      break;
    }
    case "z.enum": {
      const values = plainOf(args[0]);
      schema = Array.isArray(values) ? { type: "string", enum: values } : {};
      break;
    }
    case "Type.Union":
    case "t.Union":
    case "z.union": {
      const nodes = args.length === 1 && args[0] && args[0].t === "arr" ? args[0].items : args;
      const literals = nodes.map((item) => plainOf(item));
      if (literals.length > 0 && literals.every((item) => item !== undefined)) {
        schema = { enum: literals };
        break;
      }
      // z.union([z.string(), z.boolean()]) — keep the types we can name.
      const types = [
        ...new Set(nodes.map((item) => schemaOf(item, ctx, depth + 1).schema?.type).filter((t) => typeof t === "string"))
      ];
      schema = types.length > 0 ? { type: types.length === 1 ? types[0] : types } : {};
      break;
    }
    case "lazySchema":
    case "memoize":
    case "lazy":
    case "once":
      return schemaOf(args[0], ctx, depth + 1);
    case "Type.Record":
    case "t.Record":
    case "z.record":
      schema = { type: "object", additionalProperties: true };
      break;
    case "Type.Any":
    case "Type.Unknown":
    case "z.any":
    case "z.unknown":
      schema = {};
      break;
    default: {
      // Factory call: `inputSchema()` where
      // `inputSchema = lazySchema(() => z.object({...}))`.
      if (/^[A-Za-z_$][\w$]*$/.test(callee)) {
        const target = resolveIdent(callee, ctx, depth);
        if (target) return schemaOf(target, ctx, depth + 1);
      }
      // Wrapper helpers take exactly one schema and add semantics to it
      // (`semanticNumber(z.number().int())`). Unwrap only when exactly one
      // argument resolves to a schema, so arrays of schemas are left alone.
      const inner = args
        .filter(Boolean)
        .map((arg) => schemaOf(arg, ctx, depth + 1))
        .filter((candidate) => candidate.resolved && isSchema(candidate.schema));
      if (inner.length === 1) return inner[0];
      return { schema: {}, resolved: false };
    }
  }

  // TypeBox carries options as the first object argument, e.g.
  // Type.String({ description: "File path", format: "uuid" }).
  if (schema && args[0] && args[0].t === "obj" && /^(Type|t)\./.test(callee)) {
    applyOptions(schema, args[0]);
  }
  for (const chained of node.calls ?? []) {
    if (applyMethod(schema, chained) === "optional") optional = true;
  }
  return { schema, resolved: true, optional };
}

function rawShapeSchema(node, ctx, depth) {
  const properties = {};
  const required = [];
  for (const [key, valueNode] of node.props) {
    if (!valueNode || !["call", "ident", "obj"].includes(valueNode.t)) return null;
    const { schema, resolved, optional } = schemaOf(valueNode, ctx, depth + 1);
    if (!resolved) return null;
    properties[key] = schema;
    if (!optional) required.push(key);
  }
  if (Object.keys(properties).length === 0) return null;
  return { type: "object", properties, required };
}

function objectSchema(node, ctx, depth) {
  if (!node) return { type: "object", properties: {} };
  const resolved = node.t === "ident" ? resolveIdent(node.name, ctx, depth) : node;
  if (!resolved || resolved.t !== "obj") return { type: "object", properties: {} };
  const properties = {};
  const required = [];
  for (const [key, valueNode] of resolved.props) {
    const { schema, optional } = schemaOf(valueNode, ctx, depth + 1);
    properties[key] = schema;
    if (!optional) required.push(key);
  }
  return { type: "object", properties, required };
}

function jsonSchemaLiteral(node, ctx, depth) {
  const schema = {};
  const type = plainOf(node.props.get("type"));
  if (typeof type === "string") schema.type = type;
  const description = plainOf(node.props.get("description"));
  if (typeof description === "string") schema.description = description;
  const format = plainOf(node.props.get("format"));
  if (typeof format === "string") schema.format = format;
  const enumValues = plainOf(node.props.get("enum"));
  if (Array.isArray(enumValues)) schema.enum = enumValues;
  for (const key of ["default", "minimum", "maximum", "minLength", "maxLength", "pattern"]) {
    const value = plainOf(node.props.get(key));
    if (value !== undefined) schema[key] = value;
  }
  if (node.props.has("items")) {
    const item = schemaOf(node.props.get("items"), ctx, depth + 1);
    schema.items = item.schema;
  }
  if (node.props.has("properties")) {
    const raw = node.props.get("properties");
    const resolved = raw && raw.t === "ident" ? resolveIdent(raw.name, ctx, depth) : raw;
    if (resolved && resolved.t === "obj") {
      schema.type = schema.type ?? "object";
      schema.properties = objectSchema(resolved, ctx, depth).properties;
    }
  }
  if (node.props.has("required")) {
    const required = plainOf(node.props.get("required"));
    if (Array.isArray(required)) schema.required = required;
  } else if (schema.properties) {
    schema.required = Object.keys(schema.properties);
  }
  if (schema.type === "object" && !schema.properties) schema.properties = {};
  return schema;
}

function applyOptions(schema, optionsNode) {
  for (const [key, valueNode] of optionsNode.props) {
    if (key === "description") {
      const value = plainOf(valueNode);
      if (typeof value === "string") schema.description = value;
      continue;
    }
    if (["format", "default", "minimum", "maximum", "minLength", "maxLength", "pattern"].includes(key)) {
      const value = plainOf(valueNode);
      if (value !== undefined) schema[key] = value;
    }
  }
}

function applyMethod(schema, chained) {
  const [first] = chained.args ?? [];
  switch (chained.name) {
    case "describe": {
      const value = plainOf(first);
      if (typeof value === "string") schema.description = value;
      return null;
    }
    case "optional":
      return "optional";
    case "default": {
      const value = plainOf(first);
      if (value !== undefined) schema.default = value;
      return null;
    }
    case "min": {
      const value = plainOf(first);
      if (typeof value === "number") {
        if (schema.type === "string") schema.minLength = value;
        else schema.minimum = value;
      }
      return null;
    }
    case "max": {
      const value = plainOf(first);
      if (typeof value === "number") {
        if (schema.type === "string") schema.maxLength = value;
        else schema.maximum = value;
      }
      return null;
    }
    case "int":
      schema.type = "integer";
      return null;
    case "uuid":
      schema.format = "uuid";
      return null;
    default:
      return null;
  }
}

function plainOf(node, depth = 0) {
  if (!node || depth > MAX_VALUE_DEPTH) return undefined;
  switch (node.t) {
    case "str":
    case "num":
    case "bool":
      return node.value;
    case "null":
      return null;
    case "arr": {
      const values = node.items.map((item) => plainOf(item, depth + 1));
      return values.some((value) => value === undefined) ? undefined : values;
    }
    case "obj": {
      if (node.props.has("type") || node.props.has("properties")) return undefined;
      const value = {};
      for (const [key, item] of node.props) {
        const plain = plainOf(item, depth + 1);
        if (plain === undefined) return undefined;
        value[key] = plain;
      }
      return value;
    }
    default:
      return undefined;
  }
}

// ---- bindings and identifier resolution ----------------------------------

function collectBindings(src) {
  const bindings = new Map();
  const pattern = /(?:^|[;\n{}])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,200})?=\s*/g;
  for (const match of src.matchAll(pattern)) {
    if (!bindings.has(match[1])) bindings.set(match[1], match.index + match[0].length);
  }
  return bindings;
}

function resolveIdent(name, ctx, depth = 0) {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  if (ctx.parsed.has(name)) return ctx.parsed.get(name);
  const start = ctx.bindings.get(name);
  if (start === undefined) return null;
  ctx.parsed.set(name, null);
  const parsed = parseValue(ctx.src, start, 0);
  const node = parsed ? parsed.node : null;
  ctx.parsed.set(name, node);
  return node;
}

// ---- value parser --------------------------------------------------------

function parseValue(src, start, depth) {
  if (depth > MAX_VALUE_DEPTH) return null;
  const i = skipTrivia(src, start);
  const ch = src[i];
  if (ch === undefined) return null;
  if (ch === "{") return parseObject(src, i, depth);
  if (ch === "[") return parseArray(src, i, depth);
  if (ch === '"' || ch === "'" || ch === "`") return parseString(src, i);
  if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber(src, i);
  if (ch === "(") return tryArrow(src, i, depth);
  const ident = readIdent(src, i);
  if (ident) {
    const arrow = tryArrow(src, i, depth);
    if (arrow) return arrow;
    if (!RESERVED.has(ident.name)) return parseChain(src, i, depth);
  }
  return null;
}

// `lazySchema(() => z.object({...}))` — the schema lives in the arrow body. A
// block body is a function, not a value, so it becomes unknown rather than a
// guess.
function tryArrow(src, start, depth) {
  let bodyFrom;
  if (src[start] === "(") {
    const close = matchParen(src, start);
    if (close === null) return null;
    bodyFrom = close + 1;
  } else {
    const ident = readIdent(src, start);
    if (!ident) return null;
    bodyFrom = ident.end;
  }
  const arrowAt = skipTrivia(src, bodyFrom);
  if (!src.startsWith("=>", arrowAt)) return null;
  const bodyStart = skipTrivia(src, arrowAt + 2);
  if (src[bodyStart] === "{") {
    const end = skipBraced(src, bodyStart + 1);
    return end === null ? null : { node: { t: "unknown" }, end };
  }
  return parseValue(src, bodyStart, depth + 1);
}

function matchParen(src, start) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const parsed = parseString(src, i);
      if (parsed) {
        i = parsed.end;
        continue;
      }
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return null;
}

function parseObject(src, start, depth) {
  const props = new Map();
  let i = skipTrivia(src, start + 1);
  if (src[i] === "}") return { node: { t: "obj", props }, end: i + 1 };
  for (;;) {
    i = skipTrivia(src, i);
    // A trailing comma leaves us on the closing brace.
    if (src[i] === "}") return { node: { t: "obj", props }, end: i + 1 };
    if (src.startsWith("...", i)) return null;
    let key = null;
    if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const parsed = parseString(src, i);
      if (!parsed) return null;
      key = parsed.node.value;
      i = parsed.end;
    } else {
      const ident = readIdent(src, i);
      if (ident) {
        key = ident.name;
        i = ident.end;
      } else if (src[i] >= "0" && src[i] <= "9") {
        const num = parseNumber(src, i);
        if (!num) return null;
        key = String(num.node.value);
        i = num.end;
      } else {

      return null;
      }
    }
    i = skipTrivia(src, i);
    if (src[i] !== ":") {
      // Property shorthand: `{ inputSchema, name, description }` refers to a
      // local binding of the same name.
      if (src[i] === "," || src[i] === "}") {
        props.set(key, { t: "ident", name: key });
        if (src[i] === ",") {
          i += 1;
          continue;
        }
        return { node: { t: "obj", props }, end: i + 1 };
      }
      // Accessors: `get inputSchema(): T { return inputSchema(); }`. Only a
      // single-return body is taken; a conditional getter is left unknown
      // rather than guessed from its first branch.
      if ((key === "get" || key === "set") && /[A-Za-z_$]/.test(src[i] ?? "")) {
        const accessor = readIdent(src, i);
        const parenAt = skipTrivia(src, accessor.end);
        if (src[parenAt] === "(") {
          const params = parseArgs(src, parenAt);
          if (!params) return null;
          let braceAt = skipTrivia(src, params.end);
          // `get inputSchema(): InputSchema {` — skip a simple return type.
          if (src[braceAt] === ":") braceAt = findBrace(src, braceAt + 1);
          if (src[braceAt] !== "{") return null;
          const bodyEnd = skipBraced(src, braceAt + 1);
          if (bodyEnd === null) return null;
          props.set(accessor.name, getterValue(src, braceAt + 1, bodyEnd, depth));
          i = skipTrivia(src, bodyEnd);
          if (src[i] === ",") {
            i += 1;
            continue;
          }
          if (src[i] === "}") return { node: { t: "obj", props }, end: i + 1 };
          return null;
        }
      }
      // Shorthand methods and getters: `async call(args) { ... }`, `get x() {}`.
      const shorthand = src[i] === "(" || src[i] === "<" || src[i] === "[" || /[A-Za-z_$]/.test(src[i] ?? "");
      if (!shorthand) {
      return null; }
      const skipped = skipToValueEnd(src, i);
      if (skipped === null) {
      return null; }
      // `async description() {...}` — record the method's real name so lint can
      // tell "description generated at runtime" apart from "no description".
      let methodName = key;
      if ((key === "async" || key === "get" || key === "set") && /[A-Za-z_$]/.test(src[i] ?? "")) {
        const inner = readIdent(src, i);
        if (inner && src[skipTrivia(src, inner.end)] === "(") methodName = inner.name;
      }
      props.set(methodName, { t: "unknown" });
      i = skipped;
      if (src[i] === ",") {
        i += 1;
        continue;
      }
      if (src[i] === "}") return { node: { t: "obj", props }, end: i + 1 };
      return null;
    }
    const value = parseValue(src, i + 1, depth + 1);
    const after = value ? skipTrivia(src, value.end) : -1;
    if (value && (src[after] === "," || src[after] === "}")) {
      props.set(key, value.node);
      i = after;
    } else {
      // Unparseable or only partially parsed expression (`x => a || b`):
      // keep the keys we understand and skip this value.
      const skipped = skipToValueEnd(src, i + 1);
      if (skipped === null) return null;
      props.set(key, { t: "unknown" });
      i = skipped;
    }
    if (src[i] === ",") {
      i += 1;
      continue;
    }
    if (src[i] === "}") return { node: { t: "obj", props }, end: i + 1 };
    return null;
  }
}

function findBrace(src, start) {
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const parsed = parseString(src, i);
      if (parsed) {
        i = parsed.end;
        continue;
      }
    }
    if (ch === "{") return i;
    if (ch === ";" || ch === "}") return i;
    i += 1;
  }
  return i;
}

function getterValue(src, start, end, depth) {
  const body = src.slice(start, end);
  const returns = body.match(/\breturn\b/g) ?? [];
  if (returns.length !== 1) return { t: "unknown" };
  const at = start + body.indexOf("return") + "return".length;
  const parsed = parseValue(src, at, depth + 1);
  return parsed ? parsed.node : { t: "unknown" };
}

function skipToValueEnd(src, start) {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const parsed = parseString(src, i);
      if (parsed) {
        i = parsed.end;
        continue;
      }
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]") {
      if (depth > 0) depth -= 1;
    } else if (ch === "}") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === "," && depth === 0) return i;
    i += 1;
  }
  return null;
}

function parseArray(src, start, depth) {
  const items = [];
  let i = skipTrivia(src, start + 1);
  if (src[i] === "]") return { node: { t: "arr", items }, end: i + 1 };
  for (;;) {
    const value = parseValue(src, i, depth + 1);
    if (!value) return null;
    items.push(value.node);
    i = skipTrivia(src, value.end);
    if (src[i] === ",") {
      i = skipTrivia(src, i + 1);
      if (src[i] === "]") return { node: { t: "arr", items }, end: i + 1 };
      continue;
    }
    if (src[i] === "]") return { node: { t: "arr", items }, end: i + 1 };
    return null;
  }
}

function parseString(src, start) {
  const quote = src[start];
  if (quote === "`") return parseTemplate(src, start);
  let i = start + 1;
  let value = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1];
      const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
      value += map[next] ?? next ?? "";
      i += 2;
      continue;
    }
    if (ch === quote) return { node: { t: "str", value }, end: i + 1 };
    if (ch === "\n") return null;
    value += ch;
    i += 1;
  }
  return null;
}

// Template literals appear inside handler bodies (`Slept for ${n} seconds`).
// Their end must be found structurally: a naive scan confuses the closing and
// opening backticks of two different templates and unbalances the object parse.
function parseTemplate(src, start) {
  let i = start + 1;
  let value = "";
  let dynamic = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      value += src[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "`") {
      return dynamic ? { node: { t: "unknown" }, end: i + 1 } : { node: { t: "str", value }, end: i + 1 };
    }
    if (ch === "$" && src[i + 1] === "{") {
      dynamic = true;
      const end = skipBraced(src, i + 2);
      if (end === null) return null;
      i = end;
      continue;
    }
    value += ch;
    i += 1;
  }
  return null;
}

function skipBraced(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const parsed = parseString(src, i);
      if (parsed) {
        i = parsed.end;
        continue;
      }
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return null;
}

function parseNumber(src, start) {
  // Numeric separators (`50_000`) are common in real tool defaults.
  const match = /^-?\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?/i.exec(src.slice(start, start + 40));
  if (!match) return null;
  return { node: { t: "num", value: Number(match[0].replace(/_/g, "")) }, end: start + match[0].length };
}

function parseChain(src, start, depth) {
  let i = start;
  const segments = [];
  const head = readIdent(src, i);
  if (!head) return null;
  segments.push(head.name);
  i = head.end;
  for (;;) {
    const j = skipTrivia(src, i);
    if (src[j] === ".") {
      const next = readIdent(src, j + 1);
      if (!next) break;
      segments.push(next.name);
      i = next.end;
      continue;
    }
    if (src[j] === "(") {
      const parsed = parseArgs(src, j);
      if (!parsed) return null;
      const calls = [];
      let end = parsed.end;
      for (;;) {
        const k = skipTrivia(src, end);
        if (src[k] !== ".") break;
        const method = readIdent(src, k + 1);
        if (!method) break;
        const l = skipTrivia(src, method.end);
        if (src[l] !== "(") break;
        const methodArgs = parseArgs(src, l);
        if (!methodArgs) break;
        calls.push({ name: method.name, args: methodArgs.items });
        end = methodArgs.end;
      }
      return { node: { t: "call", callee: segments.join("."), args: parsed.items, calls }, end };
    }
    break;
  }
  return { node: { t: "ident", name: segments.join(".") }, end: i };
}

function parseArgs(src, start) {
  const items = [];
  let i = skipTrivia(src, start + 1);
  if (src[i] === ")") return { items, end: i + 1 };
  for (;;) {
    let value = parseValue(src, i, 0);
    let after = value ? skipTrivia(src, value.end) : -1;
    if (value) {
      // TypeScript wrappers: `{...} satisfies ToolDef<...>` and `x as T`.
      if (isTypeWrapperAt(src, after)) {
        const skipped = skipTypeExpression(src, after);
        if (skipped === null) return null;
        after = skipped;
      }
      if (src[after] === "," || src[after] === ")") {
        items.push(value.node);
        i = after;
      } else {
        // Binary expressions (`a || b`, `a ?? b`) parse only their first
        // operand; treat the whole argument as unknown instead.
        value = null;
      }
    }
    if (!value) {
      const skipped = skipArgument(src, i);
      if (skipped === null) return null;
      items.push(null);
      i = skipped;
    }
    if (src[i] === ",") {
      i = skipTrivia(src, i + 1);
      continue;
    }
    if (src[i] === ")") return { items, end: i + 1 };
    return null;
  }
}

function isTypeWrapperAt(src, i) {
  return (
    (src.startsWith("satisfies", i) && !/[\w$]/.test(src[i + 9] ?? "")) ||
    (src.startsWith("as", i) && /[\s<]/.test(src[i + 2] ?? ""))
  );
}

// Skips an annotation after satisfies/as. Generic argument commas are not
// argument separators, so `<...>` is tracked as depth.
function skipTypeExpression(src, start) {
  let i = start;
  let paren = 0;
  let angle = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const parsed = parseString(src, i);
      if (parsed) {
        i = parsed.end;
        continue;
      }
    }
    if (ch === "(" || ch === "[" || ch === "{") paren += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (paren === 0) return i;
      paren -= 1;
    } else if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (ch === "," && paren === 0 && angle === 0) return i;
    i += 1;
  }
  return null;
}

// A handler argument (`async (args) => {...}`) is not a value we can parse; step
// over it so one unparseable parameter does not discard the whole definition.
function skipArgument(src, start) {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const parsed = parseString(src, i);
      if (parsed) {
        i = parsed.end;
        continue;
      }
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return ch === ")" ? i : null;
      depth -= 1;
    } else if (ch === "," && depth === 0) return i;
    i += 1;
  }
  return null;
}

function readIdent(src, start) {
  const match = /^[A-Za-z_$][\w$]*/.exec(src.slice(start, start + 120));
  if (!match) return null;
  return { name: match[0], end: start + match[0].length };
}

function skipTrivia(src, start) {
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close < 0 ? src.length : close + 2;
      continue;
    }
    return i;
  }
  return i;
}

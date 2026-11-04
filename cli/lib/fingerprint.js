import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value.replace(/\s+/g, " ").trim());
  return JSON.stringify(value ?? null);
}

export function hashOf(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex").slice(0, 16);
}

export function toolFingerprint(tool) {
  return hashOf({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
    sideEffects: tool.sideEffects ?? null
  });
}

export function caseFingerprint(testCase) {
  return hashOf({
    input: testCase.input ?? "",
    expectedTool: testCase.expectedTool ?? null,
    expectedArgs: testCase.expectedArgs ?? {},
    toolInput: testCase.toolInput ?? null,
    expect: testCase.expect ?? null
  });
}

export function hashText(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

export function suiteFingerprint(suite, selectedCases = suite.cases) {
  const tools = suite.tools.map((tool) => ({ name: tool.name, hash: toolFingerprint(tool) }));
  const cases = selectedCases.map((testCase) => ({ id: testCase.id, hash: caseFingerprint(testCase) }));
  return {
    hash: hashOf({
      tools: tools.map((tool) => [tool.name, tool.hash]),
      cases: cases.map((testCase) => [testCase.id, testCase.hash])
    }),
    tools,
    cases,
    reviewed: selectedCases.filter((testCase) => testCase.reviewed !== false).length
  };
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const COMPARED_FIELDS_IGNORED = new Set(["generatedAt", "unknown"]);

export async function buildEnvironment({ modelsFile, version, sampling = {}, now = new Date() } = {}) {
  const unknown = [];
  let modelsFileHash = null;
  try {
    const bytes = await readFile(modelsFile);
    modelsFileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch {
    unknown.push("modelsFileHash");
  }

  const mfVersion = version ?? null;
  if (mfVersion === null) unknown.push("mfVersion");

  return {
    mfVersion,
    node: process.version,
    os: `${process.platform}-${process.arch}`,
    generatedAt: now.toISOString(),
    modelsFileHash,
    sampling: {
      repeat: sampling.repeat ?? 1,
      retries: sampling.retries ?? null,
      minIntervalMs: sampling.minIntervalMs ?? 0
    },
    unknown
  };
}

export function compareEnvironments(before, after, { crossEnv = false } = {}) {
  const beforeCaptured = isEnvironment(before);
  const afterCaptured = isEnvironment(after);
  const warnings = [];

  if (!beforeCaptured && !afterCaptured) {
    return {
      beforeCaptured,
      afterCaptured,
      comparable: true,
      crossEnv,
      differences: [],
      unknown: [],
      reason: null,
      warnings
    };
  }

  if (!beforeCaptured || !afterCaptured) {
    warnings.push("至少一份报告无环境信息（0.9.1 及更早评分卡）；按 unknown 处理");
    return {
      beforeCaptured,
      afterCaptured,
      comparable: true,
      crossEnv,
      differences: [],
      unknown: [],
      reason: null,
      warnings
    };
  }

  const declared = {
    before: new Set(Array.isArray(before.unknown) ? before.unknown : []),
    after: new Set(Array.isArray(after.unknown) ? after.unknown : [])
  };
  const fields = new Set();
  for (const env of [before, after]) {
    for (const key of Object.keys(env)) {
      if (!COMPARED_FIELDS_IGNORED.has(key)) fields.add(key);
    }
  }

  const differences = [];
  const unknown = [];
  for (const field of [...fields].sort()) {
    if (declared.before.has(field) || declared.after.has(field)) {
      unknown.push({
        field,
        before: declared.before.has(field),
        after: declared.after.has(field)
      });
      continue;
    }
    const beforeValue = before[field] ?? null;
    const afterValue = after[field] ?? null;
    if (sameValue(beforeValue, afterValue)) continue;
    differences.push({ field, before: beforeValue, after: afterValue });
  }

  const comparable = crossEnv || differences.length === 0;
  return {
    beforeCaptured,
    afterCaptured,
    comparable,
    crossEnv,
    differences,
    unknown,
    reason: comparable
      ? null
      : `环境不一致（${differences.map((entry) => entry.field).join(", ")}）`,
    warnings
  };
}

export function formatEnvironmentDifferences(environment) {
  if (!environment) return null;
  const parts = [];
  if (environment.crossEnv) {
    const detail = environment.differences.length
      ? ` — 放行 ${environment.differences.map((entry) => entry.field).join(", ")}`
      : "";
    parts.push(`environment: 跨环境比较（强制）${detail}`);
  } else if (environment.differences.length) {
    parts.push(
      `environment: 不一致（${environment.differences.map((entry) => entry.field).join(", ")}）；默认不可比较，--cross-env 可显式放行`
    );
  }
  if (environment.unknown.length) {
    parts.push(`environment unknown (declared): ${environment.unknown.map((entry) => entry.field).join(", ")}`);
  }
  return parts.length ? parts.join("\n") : null;
}

function isEnvironment(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameValue(a, b) {
  return canonical(a) === canonical(b);
}

function canonical(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

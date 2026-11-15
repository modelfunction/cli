import { createHash } from "node:crypto";

// Goodhart protection: a fixed suite invites tuning against its exact cases.
// The label is the rotation unit (a night, a release); the same label always
// picks the same subset so results stay reproducible and comparable.
export function rotateCases(cases, { label, size }) {
  const pool = cases.filter((testCase) => testCase.reviewed !== false);
  const requested = Number.isInteger(size) && size > 0 ? size : pool.length;
  if (!label || requested >= pool.length) {
    return {
      label: label ?? null,
      size: requested,
      total: pool.length,
      rotated: false,
      selectedIds: pool.map((testCase) => testCase.id),
      selected: cases
    };
  }
  const ranked = pool
    .map((testCase) => ({
      id: testCase.id,
      key: createHash("sha256").update(`${label}:${testCase.id}`).digest("hex")
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
  const keep = new Set(ranked.slice(0, requested).map((entry) => entry.id));
  return {
    label,
    size: requested,
    total: pool.length,
    rotated: true,
    selectedIds: ranked.slice(0, requested).map((entry) => entry.id),
    selected: cases.filter((testCase) => keep.has(testCase.id))
  };
}

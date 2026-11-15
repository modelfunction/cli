import test from "node:test";
import assert from "node:assert/strict";
import { rotateCases } from "../lib/rotation.js";

const cases = Array.from({ length: 20 }, (_, index) => ({
  id: `c${String(index + 1).padStart(2, "0")}`,
  reviewed: true
}));
const withDraft = [...cases, { id: "draft", reviewed: false }];

test("rotateCases picks a deterministic subset per label", () => {
  const first = rotateCases(withDraft, { label: "night-1", size: 6 });
  const second = rotateCases(withDraft, { label: "night-1", size: 6 });
  assert.equal(first.rotated, true);
  assert.equal(first.selectedIds.length, 6);
  assert.deepEqual(first.selectedIds, second.selectedIds);
  assert.ok(first.selected.every((testCase) => testCase.reviewed !== false));
  assert.ok(!first.selectedIds.includes("draft"));

  const other = rotateCases(withDraft, { label: "night-2", size: 6 });
  assert.notDeepEqual(other.selectedIds, first.selectedIds);
});

test("rotateCases keeps every reviewed case when the size covers the pool", () => {
  const all = rotateCases(withDraft, { label: "night-1", size: 20 });
  assert.equal(all.rotated, false);
  assert.equal(all.selectedIds.length, 20);
  assert.equal(all.selected.length, withDraft.length);
});

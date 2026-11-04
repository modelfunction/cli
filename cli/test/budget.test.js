import test from "node:test";
import assert from "node:assert/strict";
import { createBudget, CostLimitError } from "../lib/budget.js";

test("budget accumulates spend and throws once the limit is crossed", () => {
  const budget = createBudget(0.01);
  budget.spend(0.004);
  budget.spend(0.004);
  assert.equal(budget.calls, 2);
  assert.ok(Math.abs(budget.spent - 0.008) < 1e-9);

  assert.throws(
    () => budget.spend(0.004),
    (error) => {
      assert.ok(error instanceof CostLimitError);
      assert.match(error.message, /cost limit reached/);
      assert.equal(error.limit, 0.01);
      assert.equal(error.calls, 3);
      return true;
    }
  );
});

test("no limit never throws and invalid costs are ignored", () => {
  const budget = createBudget();
  budget.spend(1);
  budget.spend(Number.NaN);
  budget.spend(-5);
  assert.equal(budget.spent, 1);
  assert.equal(budget.calls, 3);
});

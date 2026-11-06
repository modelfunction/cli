import test from "node:test";
import assert from "node:assert/strict";
import { createBudget, CostLimitError, TokenLimitError } from "../lib/budget.js";

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

test("token limit is enforced independently of cost", () => {
  const budget = createBudget({ maxTokens: 100 });
  budget.spend({ cost: 0, tokens: 60 });
  assert.equal(budget.tokens, 60);
  assert.equal(budget.spent, 0);

  assert.throws(
    () => budget.spend({ cost: 0, tokens: 60 }),
    (error) => {
      assert.ok(error instanceof TokenLimitError);
      assert.match(error.message, /token limit reached/);
      assert.equal(error.limit, 100);
      assert.equal(error.calls, 2);
      return true;
    }
  );
});

test("cost and token limits can be combined", () => {
  const budget = createBudget({ maxCost: 0.01, maxTokens: 1000 });
  budget.spend({ cost: 0.004, tokens: 400 });
  budget.spend({ cost: 0.004, tokens: 400 });
  assert.equal(budget.tokens, 800);
  assert.throws(() => budget.spend({ cost: 0.004, tokens: 200 }), CostLimitError);
});

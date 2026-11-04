// Running cost guard for evaluations. Pricing is known per model, but token
// usage is only known after a call returns, so the limit is enforced after
// each call: the run stops as soon as the budget is crossed.
export class CostLimitError extends Error {
  constructor({ limit, spent, calls }) {
    super(`cost limit reached: spent ¥${spent.toFixed(4)} of ¥${limit} after ${calls} call(s)`);
    this.name = "CostLimitError";
    this.limit = limit;
    this.spent = spent;
    this.calls = calls;
  }
}

export function createBudget(limit = null) {
  let spent = 0;
  let calls = 0;
  return {
    get spent() {
      return spent;
    },
    get calls() {
      return calls;
    },
    spend(cost) {
      calls += 1;
      if (Number.isFinite(cost) && cost > 0) spent += cost;
      if (limit !== null && spent > limit) throw new CostLimitError({ limit, spent, calls });
    }
  };
}

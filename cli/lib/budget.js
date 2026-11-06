// Running guards for evaluations. Token and cost usage are only known after a
// call returns, so limits are enforced after each call: the run stops as soon
// as either limit is crossed.
export class CostLimitError extends Error {
  constructor({ limit, spent, calls }) {
    super(`cost limit reached: spent ${spent.toFixed(4)} of ${limit} after ${calls} call(s)`);
    this.name = "CostLimitError";
    this.limit = limit;
    this.spent = spent;
    this.calls = calls;
  }
}

export class TokenLimitError extends Error {
  constructor({ limit, spent, calls }) {
    super(`token limit reached: used ${spent} of ${limit} tokens after ${calls} call(s)`);
    this.name = "TokenLimitError";
    this.limit = limit;
    this.spent = spent;
    this.calls = calls;
  }
}

export function createBudget(limits = null) {
  const { maxCost = null, maxTokens = null } =
    typeof limits === "object" && limits !== null
      ? limits
      : { maxCost: limits, maxTokens: null };
  let spent = 0;
  let tokens = 0;
  let calls = 0;
  return {
    get spent() {
      return spent;
    },
    get tokens() {
      return tokens;
    },
    get calls() {
      return calls;
    },
    spend(usage) {
      const { cost, tokens: usedTokens } =
        typeof usage === "number" ? { cost: usage, tokens: 0 } : (usage ?? {});
      calls += 1;
      if (Number.isFinite(cost) && cost > 0) spent += cost;
      if (Number.isFinite(usedTokens) && usedTokens > 0) tokens += usedTokens;
      if (maxCost !== null && spent > maxCost) throw new CostLimitError({ limit: maxCost, spent, calls });
      if (maxTokens !== null && tokens > maxTokens) throw new TokenLimitError({ limit: maxTokens, spent: tokens, calls });
    }
  };
}

const TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;

export function createOpenAiAdapter(config) {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`${config.id}: environment variable ${config.apiKeyEnv} is not set`);
  }
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const retries = clampInt(config.retries, 0, 10, DEFAULT_RETRIES);
  const minIntervalMs = clampInt(config.minIntervalMs, 0, 60_000, 0);
  let lastRequestAt = 0;

  async function throttle() {
    if (minIntervalMs <= 0) return;
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  return {
    label: config.model,
    async call({ messages, tools }) {
      const started = performance.now();
      let lastError = "request failed";
      for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        const retried = attempt - 1;
        await throttle();
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: config.model,
              messages,
              tools,
              tool_choice: "auto",
              temperature: 0
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
          });

          if (response.status === 429 || response.status >= 500) {
            lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
            if (attempt <= retries) {
              await sleep(retryDelayMs(response.headers.get("retry-after"), retried));
            }
            continue;
          }
          if (!response.ok) {
            const body = await response.text();
            return {
              ok: false,
              retries: retried,
              error: `HTTP ${response.status}: ${body.slice(0, 300)}`,
              toolCalls: [],
              usage: { input: 0, output: 0 },
              latencyMs: Math.round(performance.now() - started)
            };
          }

          const data = await response.json();
          const message = data.choices?.[0]?.message ?? {};
          const toolCalls = (message.tool_calls ?? []).map((call) => ({
            name: call.function?.name,
            arguments: parseArguments(call.function?.arguments)
          }));
          return {
            ok: true,
            retries: retried,
            toolCalls,
            usage: {
              input: data.usage?.prompt_tokens ?? 0,
              cached: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
              output: data.usage?.completion_tokens ?? 0,
              estimated: false
            },
            latencyMs: Math.round(performance.now() - started)
          };
        } catch (error) {
          lastError = error?.name === "TimeoutError" ? `timeout after ${TIMEOUT_MS}ms` : String(error?.message ?? error);
          if (attempt <= retries) await sleep(retryDelayMs(null, retried));
        }
      }
      return {
        ok: false,
        retries,
        error: lastError,
        toolCalls: [],
        usage: { input: 0, output: 0 },
        latencyMs: Math.round(performance.now() - started)
      };
    }
  };
}

function retryDelayMs(retryAfter, retried) {
  const header = retryAfter == null || String(retryAfter).trim() === "" ? NaN : Number(retryAfter);
  if (Number.isFinite(header) && header >= 0) {
    return Math.min(header * 1000, MAX_RETRY_DELAY_MS);
  }
  return Math.min(1000 * 2 ** retried, MAX_RETRY_DELAY_MS);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function parseArguments(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: String(raw) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

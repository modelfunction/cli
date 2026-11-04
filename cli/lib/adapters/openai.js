const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export function createOpenAiAdapter(config) {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`${config.id}: environment variable ${config.apiKeyEnv} is not set`);
  }
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    label: config.model,
    async call({ messages, tools }) {
      const started = performance.now();
      let lastError = "request failed";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
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
            await sleep(attempt * 1000);
            continue;
          }
          if (!response.ok) {
            const body = await response.text();
            return {
              ok: false,
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
          if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1000);
        }
      }
      return {
        ok: false,
        error: lastError,
        toolCalls: [],
        usage: { input: 0, output: 0 },
        latencyMs: Math.round(performance.now() - started)
      };
    }
  };
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

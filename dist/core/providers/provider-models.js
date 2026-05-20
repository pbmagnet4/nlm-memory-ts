/**
 * Provider model discovery — runtime lookup of available models.
 *
 * Per-kind strategy:
 *   - ollama:            GET {baseUrl}/api/tags
 *   - openai:            GET {baseUrl}/models with Bearer key
 *   - openrouter:        GET {baseUrl}/models with Bearer key
 *   - openai-compatible: GET {baseUrl}/models, key optional
 *   - deepseek:          hardcoded (no public list endpoint)
 *   - anthropic:         hardcoded (their /v1/models exists but
 *                         requires beta header + returns subsets;
 *                         a hardcoded list is more reliable)
 *
 * Returns a flat `string[]`. Errors throw — callers (the HTTP endpoint
 * and connection-test) catch and surface to the user.
 */
const HARDCODED_MODELS = {
    deepseek: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat"],
    anthropic: [
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    ],
};
export async function listModels(provider, opts = {}) {
    const hardcoded = HARDCODED_MODELS[provider.kind];
    if (hardcoded)
        return [...hardcoded];
    const fetchImpl = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const baseUrl = (provider.baseUrl ?? "").replace(/\/+$/, "");
    if (!baseUrl)
        throw new Error(`${provider.name}: baseUrl not configured`);
    if (provider.kind === "ollama") {
        return fetchOllamaModels(baseUrl, fetchImpl, timeoutMs);
    }
    return fetchOpenAIModels(baseUrl, opts.apiKey ?? null, fetchImpl, timeoutMs);
}
async function fetchOllamaModels(baseUrl, fetchImpl, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal });
        if (!res.ok)
            throw new Error(`Ollama returned ${res.status}`);
        const data = (await res.json());
        const names = (data.models ?? []).map((m) => m.name).filter((n) => typeof n === "string");
        return names.sort();
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchOpenAIModels(baseUrl, apiKey, fetchImpl, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = {};
        if (apiKey)
            headers["Authorization"] = `Bearer ${apiKey}`;
        const res = await fetchImpl(`${baseUrl}/models`, { signal: controller.signal, headers });
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
        const data = (await res.json());
        const ids = (data.data ?? []).map((m) => m.id).filter((s) => typeof s === "string");
        return ids.sort();
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=provider-models.js.map
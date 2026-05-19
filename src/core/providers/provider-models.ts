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

import type { ProviderKind, ProviderRow } from "./provider-registry.js";

export type FetchImpl = typeof fetch;

const HARDCODED_MODELS: Partial<Record<ProviderKind, string[]>> = {
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat"],
  anthropic: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ],
};

interface OllamaTagsResponse {
  readonly models?: ReadonlyArray<{ readonly name?: string }>;
}

interface OpenAIModelsResponse {
  readonly data?: ReadonlyArray<{ readonly id?: string }>;
}

export interface ListModelsOptions {
  readonly apiKey?: string | null;
  readonly fetchImpl?: FetchImpl;
  readonly timeoutMs?: number;
}

export async function listModels(
  provider: ProviderRow,
  opts: ListModelsOptions = {},
): Promise<string[]> {
  const hardcoded = HARDCODED_MODELS[provider.kind];
  if (hardcoded) return [...hardcoded];

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseUrl = (provider.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error(`${provider.name}: baseUrl not configured`);

  if (provider.kind === "ollama") {
    return fetchOllamaModels(baseUrl, fetchImpl, timeoutMs);
  }
  return fetchOpenAIModels(baseUrl, opts.apiKey ?? null, fetchImpl, timeoutMs);
}

async function fetchOllamaModels(
  baseUrl: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = (await res.json()) as OllamaTagsResponse;
    const names = (data.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string");
    return names.sort();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenAIModels(
  baseUrl: string,
  apiKey: string | null,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetchImpl(`${baseUrl}/models`, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = (await res.json()) as OpenAIModelsResponse;
    const ids = (data.data ?? []).map((m) => m.id).filter((s): s is string => typeof s === "string");
    return ids.sort();
  } finally {
    clearTimeout(timer);
  }
}

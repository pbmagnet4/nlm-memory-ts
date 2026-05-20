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
import type { ProviderRow } from "./provider-registry.js";
export type FetchImpl = typeof fetch;
export interface ListModelsOptions {
    readonly apiKey?: string | null;
    readonly fetchImpl?: FetchImpl;
    readonly timeoutMs?: number;
}
export declare function listModels(provider: ProviderRow, opts?: ListModelsOptions): Promise<string[]>;

/**
 * OllamaClient — LLMClient backed by a local Ollama HTTP endpoint.
 *
 * embed()    → POST /api/embeddings  (nomic-embed-text by default)
 * classify() → POST /api/chat        (phi4-mini by default, format=json)
 *
 * Network/HTTP failure maps to LLMUnreachableError so RecallService can
 * degrade to keyword mode without crashing. Classification parse failures
 * resolve to null (caller's choice whether to retry or route to inbox).
 *
 * Layering: this file lives in the outer ring. core/ depends on LLMClient,
 * not on this concrete class. Tests can substitute a fake client.
 */
import type { ClassifyResult, EmbedResult, EmbeddingKind, LLMClient } from "../ports/llm-client.js";
export type FetchImpl = typeof fetch;
export declare function l2Normalize(vec: Float32Array): Float32Array;
export interface OllamaClientOptions {
    readonly baseUrl?: string;
    readonly embedModel?: string;
    readonly classifyModel?: string;
    readonly timeoutMs?: number;
    readonly classifyTimeoutMs?: number;
    /** Inject a fake fetch for tests. Defaults to global fetch. */
    readonly fetchImpl?: FetchImpl;
}
export declare class OllamaClient implements LLMClient {
    private readonly baseUrl;
    private readonly embedModel;
    private readonly classifyModel;
    private readonly timeoutMs;
    private readonly classifyTimeoutMs;
    private readonly fetchImpl;
    constructor(opts?: OllamaClientOptions);
    embed(text: string, kind: EmbeddingKind): Promise<EmbedResult>;
    /**
     * Send a transcript through the Ollama classifier with the shared system
     * prompt. Returns a ClassifyResult on success, or throws on network failure
     * (LLMUnreachableError) or schema-invalid output (Error). The Python
     * counterpart returned None on parse failure; we throw a typed error so
     * callers explicitly handle retry / inbox routing rather than swallowing
     * silent nulls.
     */
    classify(transcript: string, priorContext?: string): Promise<ClassifyResult>;
}
export declare class ClassifierSchemaError extends Error {
    constructor(message: string);
}

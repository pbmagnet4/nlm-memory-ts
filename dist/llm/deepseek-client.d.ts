/**
 * DeepSeekClient — LLMClient backed by DeepSeek's OpenAI-compatible chat API.
 *
 * Use case (per Python notes confirmed 2026-05-07 / 2026-05-13):
 *   • v4-flash handles inputs up to ~60K chars reliably; we cap at 30K to
 *     stay well inside the deterministic zone.
 *   • ~$0.002/session at typical sizes — full backfill of ~1,200 sessions
 *     ≈ $2.50.
 *   • Strong extraction quality (12+ entities, accurate decisions,
 *     0.9 confidence) where phi4-mini struggles or times out.
 *
 * Same prompt module as OllamaClient — only the transport differs. Same
 * error semantics: LLMUnreachableError for network/HTTP, ClassifierSchemaError
 * for unparseable / shape-wrong output. Reads DEEPSEEK_API_KEY at construct
 * time unless an explicit key is passed.
 *
 * Embedding is not supported by DeepSeek's API — `embed()` throws. Wire a
 * separate embedder (OllamaClient) for semantic recall.
 */
import type { ClassifyResult, EmbedResult, EmbeddingKind, LLMClient } from "../ports/llm-client.js";
export type FetchImpl = typeof fetch;
export interface DeepSeekClientOptions {
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly classifyModel?: string;
    readonly classifyTimeoutMs?: number;
    readonly maxTranscriptChars?: number;
    readonly fetchImpl?: FetchImpl;
}
export declare class DeepSeekClient implements LLMClient {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly classifyModel;
    private readonly classifyTimeoutMs;
    private readonly maxTranscriptChars;
    private readonly fetchImpl;
    constructor(opts?: DeepSeekClientOptions);
    embed(_text: string, _kind: EmbeddingKind): Promise<EmbedResult>;
    classify(transcript: string, priorContext?: string): Promise<ClassifyResult>;
}

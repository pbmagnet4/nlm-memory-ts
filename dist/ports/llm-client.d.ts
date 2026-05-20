/**
 * LLMClient — outbound LLM calls (embedding + classification).
 *
 * Implementations: OllamaClient (default, local), AnthropicClient, OpenAIClient.
 * core/ only sees this interface; it never imports an HTTP client.
 */
export interface EmbedResult {
    readonly vector: Float32Array;
    readonly model: string;
}
export type EmbeddingKind = "query" | "document";
/**
 * Raw fact extracted by the classifier. No id, no source_session_id, no
 * created_at yet — those get filled in at ingest time by extractFacts().
 *
 * `subject` and `predicate` come from the classifier already normalized
 * (lowercased, trimmed) per the prompt contract, but the coercer re-normalizes
 * defensively because LLM output is not trustworthy.
 */
export interface ExtractedFact {
    readonly kind: "decision" | "open" | "attribute";
    readonly subject: string;
    readonly predicate: string;
    readonly value: string;
    readonly sourceQuote?: string;
}
export interface ClassifyResult {
    readonly label: string;
    readonly summary: string;
    readonly entities: ReadonlyArray<string>;
    readonly decisions: ReadonlyArray<string>;
    readonly open: ReadonlyArray<string>;
    readonly confidence: number;
    readonly facts: ReadonlyArray<ExtractedFact>;
}
export declare class LLMUnreachableError extends Error {
    constructor(provider: string, cause?: unknown);
}
export interface LLMClient {
    embed(text: string, kind: EmbeddingKind): Promise<EmbedResult>;
    classify(transcript: string): Promise<ClassifyResult>;
}

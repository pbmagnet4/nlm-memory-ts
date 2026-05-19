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

export interface ClassifyResult {
  readonly label: string;
  readonly summary: string;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
  readonly confidence: number;
}

export class LLMUnreachableError extends Error {
  constructor(provider: string, cause?: unknown) {
    super(`LLM unreachable: ${provider}`);
    this.name = "LLMUnreachableError";
    this.cause = cause;
  }
}

export interface LLMClient {
  embed(text: string, kind: EmbeddingKind): Promise<EmbedResult>;
  classify(transcript: string): Promise<ClassifyResult>;
}

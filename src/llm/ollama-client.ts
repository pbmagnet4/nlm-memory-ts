/**
 * OllamaClient — LLMClient that calls a local Ollama HTTP endpoint.
 *
 * Phase A scope: embed() against /api/embeddings is enough to unblock
 * semantic recall against a real Ollama. classify() is stubbed until
 * Phase B/C, where the prompt + JSON-mode plumbing lands alongside the
 * ingest pipeline. Throws LLMUnreachableError on network failure so
 * RecallService degrades to keyword-only without crashing.
 */

import type {
  ClassifyResult,
  EmbedResult,
  EmbeddingKind,
  LLMClient,
} from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";

export interface OllamaClientOptions {
  readonly baseUrl?: string;
  readonly embedModel?: string;
  readonly timeoutMs?: number;
}

interface EmbeddingsResponse {
  readonly embedding?: ReadonlyArray<number>;
}

export class OllamaClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly embedModel: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.embedModel = opts.embedModel ?? "nomic-embed-text";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async embed(text: string, _kind: EmbeddingKind): Promise<EmbedResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.embedModel, prompt: text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMUnreachableError("ollama", `status ${res.status}`);
      }
      const data = (await res.json()) as EmbeddingsResponse;
      if (!data.embedding || data.embedding.length === 0) {
        throw new LLMUnreachableError("ollama", "empty embedding");
      }
      return {
        vector: new Float32Array(data.embedding),
        model: this.embedModel,
      };
    } catch (e) {
      if (e instanceof LLMUnreachableError) throw e;
      throw new LLMUnreachableError("ollama", e);
    } finally {
      clearTimeout(timer);
    }
  }

  async classify(_transcript: string): Promise<ClassifyResult> {
    throw new Error(
      "OllamaClient.classify not implemented yet — landing in Phase B alongside the ingest pipeline",
    );
  }
}

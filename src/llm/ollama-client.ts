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

import type {
  ClassifyResult,
  EmbedResult,
  EmbeddingKind,
  LLMClient,
} from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildUserPrompt,
  coerceClassifyResult,
  stripJsonFences,
  validateClassifierJson,
} from "@core/classifier/prompt.js";

export type FetchImpl = typeof fetch;

export interface OllamaClientOptions {
  readonly baseUrl?: string;
  readonly embedModel?: string;
  readonly classifyModel?: string;
  readonly timeoutMs?: number;
  readonly classifyTimeoutMs?: number;
  /** Inject a fake fetch for tests. Defaults to global fetch. */
  readonly fetchImpl?: FetchImpl;
}

interface EmbeddingsResponse {
  readonly embedding?: ReadonlyArray<number>;
}

interface ChatResponse {
  readonly message?: { readonly content?: string };
}

export class OllamaClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly embedModel: string;
  private readonly classifyModel: string;
  private readonly timeoutMs: number;
  private readonly classifyTimeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.embedModel = opts.embedModel ?? "nomic-embed-text";
    this.classifyModel = opts.classifyModel ?? "phi4-mini:latest";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.classifyTimeoutMs = opts.classifyTimeoutMs ?? 180_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(text: string, _kind: EmbeddingKind): Promise<EmbedResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
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
      return { vector: new Float32Array(data.embedding), model: this.embedModel };
    } catch (e) {
      if (e instanceof LLMUnreachableError) throw e;
      throw new LLMUnreachableError("ollama", e);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a transcript through the Ollama classifier with the shared system
   * prompt. Returns a ClassifyResult on success, or throws on network failure
   * (LLMUnreachableError) or schema-invalid output (Error). The Python
   * counterpart returned None on parse failure; we throw a typed error so
   * callers explicitly handle retry / inbox routing rather than swallowing
   * silent nulls.
   */
  async classify(transcript: string, priorContext: string = ""): Promise<ClassifyResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
    try {
      const userPrompt = buildUserPrompt(transcript, priorContext);
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.classifyModel,
          messages: [
            { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          format: "json",
          options: { temperature: 0.1 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMUnreachableError("ollama", `status ${res.status}`);
      }
      const data = (await res.json()) as ChatResponse;
      const rawContent = data.message?.content?.trim() ?? "";
      const content = stripJsonFences(rawContent);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new ClassifierSchemaError("ollama returned non-JSON content");
      }
      if (!validateClassifierJson(parsed)) {
        throw new ClassifierSchemaError("ollama response missing required keys");
      }
      return coerceClassifyResult(parsed);
    } catch (e) {
      if (e instanceof LLMUnreachableError || e instanceof ClassifierSchemaError) throw e;
      throw new LLMUnreachableError("ollama", e);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ClassifierSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierSchemaError";
  }
}

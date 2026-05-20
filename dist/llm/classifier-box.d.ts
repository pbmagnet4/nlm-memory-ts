/**
 * ClassifierBox — a mutable LLMClient wrapper holding the active classifier
 * client. The scheduler reads `inner` on each tick, so a runtime swap takes
 * effect on the next session ingest without restarting the daemon.
 *
 * Only `classify()` is delegated. `embed()` throws — embeddings are wired
 * separately through the dedicated Ollama embedder; the classifier slot is
 * for transcript classification only.
 */
import type { ClassifyResult, EmbedResult, EmbeddingKind, LLMClient } from "../ports/llm-client.js";
export type ClassifierProvider = "deepseek" | "ollama";
export interface ClassifierBoxOptions {
    readonly provider: ClassifierProvider;
    readonly model: string;
    readonly ollamaUrl?: string;
}
export declare class ClassifierBox implements LLMClient {
    private inner;
    private providerName;
    private modelName;
    private readonly ollamaUrl;
    constructor(opts: ClassifierBoxOptions);
    get provider(): ClassifierProvider;
    get model(): string;
    swap(provider: ClassifierProvider, model: string): void;
    embed(_text: string, _kind: EmbeddingKind): Promise<EmbedResult>;
    classify(transcript: string): Promise<ClassifyResult>;
    private construct;
}

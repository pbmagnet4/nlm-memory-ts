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
import { LLMUnreachableError } from "../ports/llm-client.js";
import { CLASSIFIER_SYSTEM_PROMPT, buildUserPrompt, coerceClassifyResult, stripJsonFences, validateClassifierJson, } from "../core/classifier/prompt.js";
const MAX_EMBED_CHARS = 8_000;
const EMBED_PREFIXES = {
    query: "search_query: ",
    document: "search_document: ",
};
export function l2Normalize(vec) {
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
        const v = vec[i] ?? 0;
        sumSq += v * v;
    }
    if (sumSq === 0)
        return vec;
    const norm = Math.sqrt(sumSq);
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
        out[i] = (vec[i] ?? 0) / norm;
    }
    return out;
}
export class OllamaClient {
    baseUrl;
    embedModel;
    classifyModel;
    timeoutMs;
    classifyTimeoutMs;
    fetchImpl;
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
        this.embedModel = opts.embedModel ?? "nomic-embed-text";
        this.classifyModel = opts.classifyModel ?? "phi4-mini:latest";
        this.timeoutMs = opts.timeoutMs ?? 10_000;
        this.classifyTimeoutMs = opts.classifyTimeoutMs ?? 180_000;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }
    async embed(text, kind) {
        // nomic-embed-text v1.5 is an asymmetric retrieval model. The
        // search_query:/search_document: prefix is part of the training
        // contract; omitting it or using the wrong one degrades retrieval
        // quality measurably. MAX_EMBED_CHARS matches the Python ceiling.
        const truncated = text.slice(0, MAX_EMBED_CHARS);
        const prompt = `${EMBED_PREFIXES[kind]}${truncated}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: this.embedModel, prompt }),
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new LLMUnreachableError("ollama", `status ${res.status}`);
            }
            const data = (await res.json());
            if (!data.embedding || data.embedding.length === 0) {
                throw new LLMUnreachableError("ollama", "empty embedding");
            }
            const raw = new Float32Array(data.embedding);
            return { vector: l2Normalize(raw), model: this.embedModel };
        }
        catch (e) {
            if (e instanceof LLMUnreachableError)
                throw e;
            throw new LLMUnreachableError("ollama", e);
        }
        finally {
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
    async classify(transcript, priorContext = "") {
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
            const data = (await res.json());
            const rawContent = data.message?.content?.trim() ?? "";
            const content = stripJsonFences(rawContent);
            let parsed;
            try {
                parsed = JSON.parse(content);
            }
            catch {
                throw new ClassifierSchemaError("ollama returned non-JSON content");
            }
            if (!validateClassifierJson(parsed)) {
                throw new ClassifierSchemaError("ollama response missing required keys");
            }
            return coerceClassifyResult(parsed);
        }
        catch (e) {
            if (e instanceof LLMUnreachableError || e instanceof ClassifierSchemaError)
                throw e;
            throw new LLMUnreachableError("ollama", e);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
export class ClassifierSchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = "ClassifierSchemaError";
    }
}
//# sourceMappingURL=ollama-client.js.map
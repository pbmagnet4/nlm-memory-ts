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
import { LLMUnreachableError } from "../ports/llm-client.js";
import { CLASSIFIER_SYSTEM_PROMPT, buildUserPrompt, coerceClassifyResult, stripJsonFences, validateClassifierJson, } from "../core/classifier/prompt.js";
import { ClassifierSchemaError } from "./ollama-client.js";
export class DeepSeekClient {
    apiKey;
    baseUrl;
    classifyModel;
    classifyTimeoutMs;
    maxTranscriptChars;
    fetchImpl;
    constructor(opts = {}) {
        const key = opts.apiKey ?? process.env["DEEPSEEK_API_KEY"];
        if (!key) {
            throw new Error("DEEPSEEK_API_KEY not set. Export it, place it in ~/.nlm/.env, or pass apiKey explicitly.");
        }
        this.apiKey = key;
        this.baseUrl = (opts.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
        this.classifyModel = opts.classifyModel ?? "deepseek-v4-flash";
        this.classifyTimeoutMs = opts.classifyTimeoutMs ?? 180_000;
        this.maxTranscriptChars = opts.maxTranscriptChars ?? 30_000;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }
    async embed(_text, _kind) {
        throw new Error("DeepSeekClient.embed not supported — DeepSeek's API has no embeddings endpoint. Wire OllamaClient for embeddings.");
    }
    async classify(transcript, priorContext = "") {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
        try {
            // DeepSeek's reliable zone is ≤30K, narrower than the prompt module's
            // 15K default. We pre-truncate to our wider cap to feed the model more
            // context than Ollama can handle, then buildUserPrompt's own truncation
            // is a no-op.
            const sized = transcript.length <= this.maxTranscriptChars
                ? transcript
                : transcript.slice(0, this.maxTranscriptChars / 2 - 40) +
                    "\n\n[... transcript truncated; below is the closing portion ...]\n\n" +
                    transcript.slice(transcript.length - this.maxTranscriptChars / 2 + 40);
            const userPrompt = buildUserPrompt(sized, priorContext);
            const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.classifyModel,
                    messages: [
                        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
                        { role: "user", content: userPrompt },
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.1,
                    // 8192 covers reasoning + JSON output. deepseek-v4-flash is a
                    // reasoning model — its hidden chain-of-thought counts against
                    // max_tokens but never reaches `content`. At 1024 the reasoning
                    // consumed the entire budget and the JSON output came back empty
                    // (finish_reason: length, content: ""). Backfill verified ~72% of
                    // real claude-code sessions hit that mode at 1024. Real-world
                    // observed reasoning_tokens: ~900-1100; JSON body adds 200-1000
                    // depending on facts/entity counts. 8192 leaves headroom.
                    max_tokens: 8192,
                    stream: false,
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new LLMUnreachableError("deepseek", `status ${res.status}: ${await res.text().catch(() => "")}`);
            }
            const data = (await res.json());
            const rawContent = data.choices?.[0]?.message?.content?.trim() ?? "";
            const content = stripJsonFences(rawContent);
            let parsed;
            try {
                parsed = JSON.parse(content);
            }
            catch {
                throw new ClassifierSchemaError("deepseek returned non-JSON content");
            }
            if (!validateClassifierJson(parsed)) {
                throw new ClassifierSchemaError("deepseek response missing required keys");
            }
            return coerceClassifyResult(parsed);
        }
        catch (e) {
            if (e instanceof LLMUnreachableError || e instanceof ClassifierSchemaError)
                throw e;
            throw new LLMUnreachableError("deepseek", e);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
//# sourceMappingURL=deepseek-client.js.map
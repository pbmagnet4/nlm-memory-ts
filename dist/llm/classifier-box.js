/**
 * ClassifierBox — a mutable LLMClient wrapper holding the active classifier
 * client. The scheduler reads `inner` on each tick, so a runtime swap takes
 * effect on the next session ingest without restarting the daemon.
 *
 * Only `classify()` is delegated. `embed()` throws — embeddings are wired
 * separately through the dedicated Ollama embedder; the classifier slot is
 * for transcript classification only.
 */
import { DeepSeekClient } from "./deepseek-client.js";
import { OllamaClient } from "./ollama-client.js";
export class ClassifierBox {
    inner;
    providerName;
    modelName;
    ollamaUrl;
    constructor(opts) {
        this.providerName = opts.provider;
        this.modelName = opts.model;
        this.ollamaUrl = opts.ollamaUrl ?? "http://localhost:11434";
        this.inner = this.construct(opts.provider, opts.model);
    }
    get provider() { return this.providerName; }
    get model() { return this.modelName; }
    swap(provider, model) {
        this.inner = this.construct(provider, model);
        this.providerName = provider;
        this.modelName = model;
    }
    embed(_text, _kind) {
        throw new Error("ClassifierBox.embed is not supported — wire OllamaClient as the embedder.");
    }
    classify(transcript) {
        return this.inner.classify(transcript);
    }
    construct(provider, model) {
        if (provider === "ollama") {
            return new OllamaClient({ baseUrl: this.ollamaUrl, classifyModel: model });
        }
        return new DeepSeekClient({ classifyModel: model });
    }
}
//# sourceMappingURL=classifier-box.js.map
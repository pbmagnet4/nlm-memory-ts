/**
 * LLMClient — outbound LLM calls (embedding + classification).
 *
 * Implementations: OllamaClient (default, local), AnthropicClient, OpenAIClient.
 * core/ only sees this interface; it never imports an HTTP client.
 */
export class LLMUnreachableError extends Error {
    constructor(provider, cause) {
        super(`LLM unreachable: ${provider}`);
        this.name = "LLMUnreachableError";
        this.cause = cause;
    }
}
//# sourceMappingURL=llm-client.js.map
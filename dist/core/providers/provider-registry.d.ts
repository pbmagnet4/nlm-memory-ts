/**
 * ProviderRegistry — CRUD over the `providers` table.
 *
 * One row per LLM endpoint the user has configured. The classifier reads
 * this at boot to pick a provider/model; the UI lets users add their own.
 *
 * API keys live in the `api_key` column today. Phase 2 (Tauri shell)
 * migrates them to the OS keychain; the API shape stays identical so this
 * module's consumers don't change.
 *
 * `redact()` strips secrets on the way out — every HTTP response sends
 * redacted rows, with the key only retrievable via getSecret() inside the
 * daemon process.
 */
import type Database from "better-sqlite3";
export type ProviderKind = "deepseek" | "ollama" | "openai" | "anthropic" | "openrouter" | "openai-compatible";
export interface ProviderRow {
    readonly id: number;
    readonly kind: ProviderKind;
    readonly name: string;
    readonly baseUrl: string | null;
    /** Always `null` on rows returned by `list()` / `get()`. Use `getSecret()`. */
    readonly apiKey: string | null;
    readonly hasApiKey: boolean;
    readonly defaultModel: string | null;
    readonly enabled: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface ProviderInsert {
    readonly kind: ProviderKind;
    readonly name: string;
    readonly baseUrl?: string | null;
    readonly apiKey?: string | null;
    readonly defaultModel?: string | null;
    readonly enabled?: boolean;
}
export interface ProviderUpdate {
    readonly name?: string;
    readonly baseUrl?: string | null;
    readonly apiKey?: string | null;
    readonly defaultModel?: string | null;
    readonly enabled?: boolean;
}
export declare class ProviderRegistry {
    private readonly db;
    constructor(db: Database.Database);
    list(): ProviderRow[];
    get(id: number): ProviderRow | null;
    getByName(name: string): ProviderRow | null;
    /** Returns the secret. Use only inside the daemon — never echo to HTTP. */
    getSecret(id: number): string | null;
    insert(input: ProviderInsert): ProviderRow;
    update(id: number, patch: ProviderUpdate): ProviderRow | null;
    delete(id: number): boolean;
    /**
     * Seed defaults on an empty registry. Bridges from the legacy env-var
     * setup: if DEEPSEEK_API_KEY is present, the DeepSeek row carries it
     * forward; Ollama is always seeded since it needs no key.
     */
    seedDefaults(): void;
}

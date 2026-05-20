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
function rowFromDb(r, includeSecret) {
    return {
        id: r.id,
        kind: r.kind,
        name: r.name,
        baseUrl: r.base_url,
        apiKey: includeSecret ? r.api_key : null,
        hasApiKey: r.api_key !== null && r.api_key.length > 0,
        defaultModel: r.default_model,
        enabled: r.enabled === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
const DEFAULT_BASE_URLS = {
    deepseek: "https://api.deepseek.com",
    ollama: "http://localhost:11434",
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
    openrouter: "https://openrouter.ai/api/v1",
    "openai-compatible": null,
};
const DEFAULT_MODELS = {
    deepseek: "deepseek-v4-flash",
    ollama: "phi4-mini:latest",
    openai: "gpt-4o-mini",
    anthropic: "claude-haiku-4-5-20251001",
    openrouter: "anthropic/claude-haiku-4-5",
    "openai-compatible": null,
};
export class ProviderRegistry {
    db;
    constructor(db) {
        this.db = db;
    }
    list() {
        const rows = this.db.prepare(`SELECT * FROM providers ORDER BY id ASC`).all();
        return rows.map((r) => rowFromDb(r, false));
    }
    get(id) {
        const row = this.db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id);
        return row ? rowFromDb(row, false) : null;
    }
    getByName(name) {
        const row = this.db.prepare(`SELECT * FROM providers WHERE name = ?`).get(name);
        return row ? rowFromDb(row, false) : null;
    }
    /** Returns the secret. Use only inside the daemon — never echo to HTTP. */
    getSecret(id) {
        const row = this.db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id);
        return row?.api_key ?? null;
    }
    insert(input) {
        const baseUrl = input.baseUrl ?? DEFAULT_BASE_URLS[input.kind];
        const defaultModel = input.defaultModel ?? DEFAULT_MODELS[input.kind];
        const result = this.db.prepare(`
      INSERT INTO providers (kind, name, base_url, api_key, default_model, enabled)
      VALUES (@kind, @name, @base_url, @api_key, @default_model, @enabled)
    `).run({
            kind: input.kind,
            name: input.name,
            base_url: baseUrl ?? null,
            api_key: input.apiKey ?? null,
            default_model: defaultModel ?? null,
            enabled: input.enabled === false ? 0 : 1,
        });
        const id = Number(result.lastInsertRowid);
        const row = this.get(id);
        if (!row)
            throw new Error(`ProviderRegistry.insert: row ${id} not found after insert`);
        return row;
    }
    update(id, patch) {
        const fields = [];
        const params = { id };
        if (patch.name !== undefined) {
            fields.push("name = @name");
            params["name"] = patch.name;
        }
        if (patch.baseUrl !== undefined) {
            fields.push("base_url = @url");
            params["url"] = patch.baseUrl;
        }
        if (patch.apiKey !== undefined) {
            fields.push("api_key = @key");
            params["key"] = patch.apiKey;
        }
        if (patch.defaultModel !== undefined) {
            fields.push("default_model = @m");
            params["m"] = patch.defaultModel;
        }
        if (patch.enabled !== undefined) {
            fields.push("enabled = @en");
            params["en"] = patch.enabled ? 1 : 0;
        }
        if (fields.length === 0)
            return this.get(id);
        fields.push("updated_at = datetime('now')");
        this.db.prepare(`UPDATE providers SET ${fields.join(", ")} WHERE id = @id`).run(params);
        return this.get(id);
    }
    delete(id) {
        const result = this.db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
        return result.changes > 0;
    }
    /**
     * Seed defaults on an empty registry. Bridges from the legacy env-var
     * setup: if DEEPSEEK_API_KEY is present, the DeepSeek row carries it
     * forward; Ollama is always seeded since it needs no key.
     */
    seedDefaults() {
        const count = this.db.prepare(`SELECT COUNT(*) AS c FROM providers`).get();
        if ((count?.c ?? 0) > 0)
            return;
        this.insert({
            kind: "ollama",
            name: "Ollama (local)",
            baseUrl: process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434",
        });
        const deepseekKey = process.env["DEEPSEEK_API_KEY"];
        this.insert({
            kind: "deepseek",
            name: "DeepSeek",
            apiKey: deepseekKey ?? null,
            enabled: Boolean(deepseekKey),
        });
    }
}
//# sourceMappingURL=provider-registry.js.map
/**
 * provider-models — live model discovery across provider kinds.
 *
 * Mocked fetch so the suite doesn't depend on Ollama/OpenAI being up.
 * Real connectivity is covered by the connection-test endpoint in
 * integration tests, not here.
 */

import { describe, expect, it, vi } from "vitest";
import { listModels } from "../../../../src/core/providers/provider-models.js";
import type { ProviderRow } from "../../../../src/core/providers/provider-registry.js";

function row(overrides: Partial<ProviderRow>): ProviderRow {
  return {
    id: 1, kind: "ollama", name: "test", baseUrl: "http://localhost:11434",
    apiKey: null, hasApiKey: false, defaultModel: null, enabled: true,
    createdAt: "", updatedAt: "",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("listModels", () => {
  it("returns hardcoded list for deepseek without hitting network", async () => {
    const fetchImpl = vi.fn();
    const models = await listModels(row({ kind: "deepseek", baseUrl: "https://api.deepseek.com" }), { fetchImpl });
    expect(models).toContain("deepseek-v4-flash");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns hardcoded list for anthropic without hitting network", async () => {
    const fetchImpl = vi.fn();
    const models = await listModels(row({ kind: "anthropic", baseUrl: "https://api.anthropic.com" }), { fetchImpl });
    expect(models.length).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("hits Ollama /api/tags and sorts results", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      models: [{ name: "phi4-mini:latest" }, { name: "llama3.2:3b" }, { name: "mistral:7b" }],
    }));
    const models = await listModels(row({ kind: "ollama" }), { fetchImpl });
    expect(models).toEqual(["llama3.2:3b", "mistral:7b", "phi4-mini:latest"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((fetchImpl.mock.calls[0]?.[0] as string).endsWith("/api/tags")).toBe(true);
  });

  it("hits OpenAI /models with Bearer key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
    }));
    const models = await listModels(
      row({ kind: "openai", baseUrl: "https://api.openai.com/v1" }),
      { fetchImpl, apiKey: "sk-test" },
    );
    expect(models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
  });

  it("hits OpenRouter the same way as OpenAI", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ id: "anthropic/claude-haiku-4-5" }],
    }));
    const models = await listModels(
      row({ kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }),
      { fetchImpl, apiKey: "or-key" },
    );
    expect(models).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("openai-compatible omits Authorization when no key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "local-model" }] }));
    await listModels(
      row({ kind: "openai-compatible", baseUrl: "http://192.168.1.50:8000/v1" }),
      { fetchImpl, apiKey: null },
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("propagates HTTP errors as thrown messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401, statusText: "Unauthorized" }));
    await expect(listModels(
      row({ kind: "openai", baseUrl: "https://api.openai.com/v1" }),
      { fetchImpl, apiKey: "bad" },
    )).rejects.toThrow(/401/);
  });

  it("throws when baseUrl is missing for live-discovery kinds", async () => {
    const fetchImpl = vi.fn();
    await expect(listModels(row({ kind: "ollama", baseUrl: null }), { fetchImpl }))
      .rejects.toThrow(/baseUrl/);
  });
});

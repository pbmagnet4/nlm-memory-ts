/**
 * Shared types + tiny helpers for the sources and providers registries.
 *
 * Mirrors the daemon contracts in src/core/sources/source-registry.ts and
 * src/core/providers/provider-registry.ts. HTTP responses always carry
 * redacted rows (no api_key, no source token) except the one-time reveal
 * on insert/regenerate.
 */

export type SourceKind = "claude-code" | "codex" | "hermes" | "pi" | "jsonl-generic" | "webhook";

export interface SourceRow {
  id: number;
  kind: SourceKind;
  name: string;
  pathOrUrl: string | null;
  runtimeLabel: string;
  parseConfig: Record<string, unknown>;
  enabled: boolean;
  token: string | null;
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProviderKind =
  | "deepseek"
  | "ollama"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "openai-compatible";

export interface ProviderRow {
  id: number;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  apiKey: string | null;
  hasApiKey: boolean;
  defaultModel: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const SOURCE_KINDS: ReadonlyArray<SourceKind> = [
  "claude-code", "codex", "hermes", "pi", "jsonl-generic", "webhook",
];

export const PROVIDER_KINDS: ReadonlyArray<ProviderKind> = [
  "deepseek", "ollama", "openai", "anthropic", "openrouter", "openai-compatible",
];

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  deepseek: "DeepSeek",
  ollama: "Ollama",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "openai-compatible": "OpenAI-compatible",
};

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  hermes: "Hermes",
  pi: "pi.dev",
  "jsonl-generic": "Custom JSONL",
  webhook: "Webhook",
};

/** Defaults the "Add source" wizard offers per kind. The user can edit. */
export const SOURCE_PRESETS: Record<
  SourceKind,
  { name: string; runtimeLabel: string; pathOrUrl: string | null; parseConfig: Record<string, unknown> }
> = {
  "claude-code": {
    name: "Claude Code",
    runtimeLabel: "claude-code",
    pathOrUrl: "~/.claude/projects",
    parseConfig: {},
  },
  codex: {
    name: "Codex",
    runtimeLabel: "codex",
    pathOrUrl: "~/.codex/sessions",
    parseConfig: {},
  },
  hermes: {
    name: "Hermes",
    runtimeLabel: "hermes",
    pathOrUrl: "~/.hermes/sessions",
    parseConfig: {},
  },
  pi: {
    name: "pi.dev",
    runtimeLabel: "pi",
    pathOrUrl: "~/.pi/transcripts",
    parseConfig: {},
  },
  "jsonl-generic": {
    name: "",
    runtimeLabel: "",
    pathOrUrl: "",
    parseConfig: {
      idField: "session_id",
      textField: "text",
      startedAtField: "started_at",
      endedAtField: "ended_at",
    },
  },
  webhook: {
    name: "",
    runtimeLabel: "",
    pathOrUrl: null,
    parseConfig: {},
  },
};

export const PROVIDER_PRESETS: Record<ProviderKind, { baseUrl: string | null; defaultModel: string | null }> = {
  deepseek: { baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash" },
  ollama: { baseUrl: "http://localhost:11434", defaultModel: "phi4-mini:latest" },
  openai: { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  anthropic: { baseUrl: "https://api.anthropic.com", defaultModel: "claude-haiku-4-5-20251001" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", defaultModel: "anthropic/claude-haiku-4-5" },
  "openai-compatible": { baseUrl: "", defaultModel: null },
};

export async function fetchSources(): Promise<SourceRow[]> {
  const r = await fetch("/api/sources");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { sources: SourceRow[] };
  return data.sources;
}

export async function fetchProviders(): Promise<ProviderRow[]> {
  const r = await fetch("/api/providers");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { providers: ProviderRow[] };
  return data.providers;
}

export async function fetchProviderModels(id: number): Promise<string[]> {
  const r = await fetch(`/api/providers/${id}/models`);
  const data = (await r.json()) as { models?: string[]; error?: string };
  if (!r.ok || data.error) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data.models ?? [];
}

export interface TestResult {
  ok: boolean;
  modelCount?: number;
  latencyMs: number;
  error?: string;
}

export async function testProvider(id: number): Promise<TestResult> {
  const r = await fetch(`/api/providers/${id}/test`, { method: "POST" });
  const data = (await r.json()) as TestResult;
  return data;
}

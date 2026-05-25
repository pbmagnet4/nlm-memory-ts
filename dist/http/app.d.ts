/**
 * Hono app factory. Routes mirror the Python daemon's API surface (GET
 * /api/recall, GET /api/recall/stats, GET /api/session/:id, GET /api/health)
 * so existing UI clients and the agent-recall observability panel can switch
 * to this server without contract changes.
 *
 * Layering: this module knows about RecallService and SessionStore (the
 * inner ring), but core/ knows nothing about Hono. Adapter direction stays
 * one-way.
 *
 * POST /mcp — Streamable-HTTP MCP endpoint for container agents (e.g. Hermes
 * WebUI). Requires Authorization: Bearer <NLM_MCP_TOKEN>. Stateless: each
 * request gets its own transport + server instance so there is no in-memory
 * session state to manage. The existing stdio MCP path is untouched.
 */
import { Hono } from "hono";
import type { RecallService } from "../core/recall/recall-service.js";
import type { FactRecallService } from "../core/recall-facts/fact-recall-service.js";
import type { FactStore } from "../ports/fact-store.js";
import { ClassifierBox } from "../llm/classifier-box.js";
import { SourceRegistry } from "../core/sources/source-registry.js";
import { ProviderRegistry } from "../core/providers/provider-registry.js";
import { type IngestDeps } from "../core/ingest/ingest-session.js";
import type { SessionStore } from "../ports/session-store.js";
import type { SqliteSessionStore } from "../core/storage/sqlite-session-store.js";
import type { McpDeps } from "../mcp/server.js";
export interface HttpDeps {
    readonly recall: RecallService;
    readonly store: SessionStore;
    /** Pass the concrete store when /live endpoints (recent-writes / recent-markers) should be served. */
    readonly liveStore?: SqliteSessionStore;
    /** Optional override for the query log path. Defaults to ~/.nlm/query_log.jsonl or $NLM_QUERY_LOG. */
    readonly queryLogPath?: string;
    /** Optional override for the citation log path. Defaults to ~/.nlm/citation-log.jsonl or $NLM_CITATION_LOG. */
    readonly citationLogPath?: string;
    /** Fact recall — wire to enable /api/recall/facts + /api/facts/history. */
    readonly factRecall?: FactRecallService;
    readonly factStore?: FactStore;
    /** Optional override for the fact query log path. Defaults to ~/.nlm/fact_query_log.jsonl. */
    readonly factQueryLogPath?: string;
    /** Path to canonical.sqlite for the /api/dataset endpoint. */
    readonly dbPath?: string;
    /** Mutable classifier — read by /api/classifier/info, swapped by POST /api/classifier. */
    readonly classifier?: ClassifierBox;
    /** Sources registry — exposes /api/sources CRUD for the desktop UI. */
    readonly sources?: SourceRegistry;
    /** Providers registry — exposes /api/providers CRUD for the desktop UI. */
    readonly providers?: ProviderRegistry;
    /** Wire to enable POST /api/ingest. When omitted, push ingest is disabled. */
    readonly ingest?: IngestDeps;
    /** Static embedder info — embeddings are always Ollama in this build (DeepSeek has no /embed). */
    readonly embedderInfo?: {
        provider: string;
        model: string;
        dims: number;
    };
    /** Directory containing the built UI (dist/ui). When set, /ui/* serves the SPA. */
    readonly uiDist?: string;
    /**
     * When provided, POST /mcp is mounted and token-gated with NLM_MCP_TOKEN.
     * Omitting this keeps the route absent — no auth surface, no risk.
     */
    readonly mcpDeps?: McpDeps;
}
export declare function createApp(deps: HttpDeps): Hono;

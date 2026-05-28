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
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import { snapshotScratchPath, stageRestore, vacuumSnapshot, } from "../core/storage/db-restore.js";
import { logQuery, recallStats } from "../core/recall/query-log.js";
import { recentQueryLog } from "../core/recall/recent-log.js";
import { appendCitation, citationStats } from "../core/recall/citation-log.js";
import { factRecallStats, logFactQuery } from "../core/recall-facts/fact-query-log.js";
import { buildDataset } from "../core/dataset/build-dataset.js";
import { ClassifierBox } from "../llm/classifier-box.js";
import { SourceRegistry, } from "../core/sources/source-registry.js";
import { ProviderRegistry, } from "../core/providers/provider-registry.js";
import { listModels } from "../core/providers/provider-models.js";
import { ingestSession, deriveSessionId } from "../core/ingest/ingest-session.js";
import { listActions, undoAction, writeAction, writeActionsBatch, } from "../core/actions/actions-log.js";
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
};
/** Tables surfaced on the Settings → Data page, in display order. */
const DATA_STAT_TABLES = [
    "sessions",
    "entities",
    "markers",
    "facts",
    "session_embedding_chunks",
    "fact_embeddings",
    "actions",
    "session_edges",
    "sources",
    "providers",
];
function parseLimit(raw, fallback, max) {
    if (raw === undefined)
        return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1)
        return fallback;
    return Math.min(max, n);
}
const VALID_MODES = ["keyword", "semantic", "hybrid"];
const VALID_KINDS = ["decision", "open"];
const VALID_FACT_KINDS = ["decision", "open", "attribute"];
export function createApp(deps) {
    const app = new Hono();
    app.get("/api/health", (c) => c.json({ status: "ok", service: "nlm-memory", version: "0.2.0-dev" }));
    // ── MCP over HTTP (for container agents — e.g. Hermes WebUI) ─────────
    // Stateless: one transport + McpServer instance per request, no in-memory
    // session state. Bearer token from NLM_MCP_TOKEN is mandatory.
    // The existing stdio MCP path (nlm mcp / .mcp.json) is untouched.
    if (deps.mcpDeps) {
        const mcpToken = process.env["NLM_MCP_TOKEN"];
        if (!mcpToken) {
            throw new Error("NLM_MCP_TOKEN must be set when mcpDeps is provided — " +
                "refusing to mount an unauthenticated /mcp endpoint");
        }
        const capturedMcpDeps = deps.mcpDeps;
        app.all("/mcp", async (c) => {
            const auth = c.req.header("authorization") ?? "";
            const match = /^Bearer\s+(\S+)$/i.exec(auth);
            if (!match || match[1] !== mcpToken) {
                return c.json({ error: "unauthorized" }, 401);
            }
            // No sessionIdGenerator = stateless mode: no session ID in responses,
            // no session validation. Correct for per-request agent calls.
            const transport = new WebStandardStreamableHTTPServerTransport({});
            const server = createMcpServer(capturedMcpDeps);
            await server.connect(transport);
            return transport.handleRequest(c.req.raw);
        });
    }
    app.get("/api/recall", async (c) => {
        const q = c.req.query("q") ?? "";
        const entity = c.req.query("entity");
        const kind = c.req.query("kind");
        const mode = (c.req.query("mode") ?? "keyword");
        const limitStr = c.req.query("limit");
        if (kind !== undefined && !VALID_KINDS.includes(kind)) {
            return c.json({ error: "kind must be 'decision', 'open', or omitted" }, 400);
        }
        if (!VALID_MODES.includes(mode)) {
            return c.json({ error: "mode must be 'keyword', 'semantic', or 'hybrid'" }, 400);
        }
        const limit = limitStr === undefined ? 20 : Number.parseInt(limitStr, 10);
        if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
            return c.json({ error: "limit must be 1..100" }, 400);
        }
        const query = {
            query: q,
            mode: mode,
            limit,
            ...(entity !== undefined ? { entity } : {}),
            ...(kind !== undefined ? { kind: kind } : {}),
        };
        const result = await deps.recall.search(query);
        // Fire-and-forget telemetry — never blocks the response.
        const source = c.req.header("x-recall-source") ?? "http";
        void logQuery({
            source,
            query: q || null,
            entity: entity ?? null,
            kind: kind ?? null,
            mode: mode,
            limit,
            nResults: result.total,
            returnedIds: result.results.map((r) => r.id),
        }, ...(deps.queryLogPath !== undefined ? [deps.queryLogPath] : []));
        return c.json(result);
    });
    app.get("/api/recall/stats", async (c) => {
        const daysStr = c.req.query("days") ?? "7";
        const days = Number.parseInt(daysStr, 10);
        if (!Number.isFinite(days) || days < 1 || days > 365) {
            return c.json({ error: "days must be 1..365" }, 400);
        }
        const stats = await recallStats(days, ...(deps.queryLogPath !== undefined ? [deps.queryLogPath] : []));
        return c.json(stats);
    });
    app.get("/api/recall/recent", (c) => {
        const limit = parseLimit(c.req.query("limit"), 50, 200);
        const entries = recentQueryLog(limit, ...(deps.queryLogPath !== undefined ? [deps.queryLogPath] : []));
        return c.json({ entries });
    });
    // Citation events from the Stop hook. One POST per surfaced ID the
    // assistant cited in its response. Drives useful_hit_rate and is the
    // training-data substrate for the future learned reranker.
    app.post("/api/recall/cite-event", async (c) => {
        let body;
        try {
            body = (await c.req.json());
        }
        catch {
            return c.json({ error: "body must be JSON" }, 400);
        }
        const conversationId = body["conversation_id"];
        const citedId = body["cited_id"];
        if (typeof conversationId !== "string" || !conversationId) {
            return c.json({ error: "conversation_id required" }, 400);
        }
        if (typeof citedId !== "string" || !citedId) {
            return c.json({ error: "cited_id required" }, 400);
        }
        const responsePreview = body["response_preview"];
        const kind = body["kind"];
        await appendCitation({
            conversationId,
            citedId,
            ...(kind === "tool_use" || kind === "prose" ? { kind } : {}),
            ...(typeof responsePreview === "string"
                ? { responsePreview }
                : {}),
        }, ...(deps.citationLogPath !== undefined ? [deps.citationLogPath] : []));
        return c.json({ ok: true });
    });
    app.get("/api/recall/cite-stats", async (c) => {
        const daysStr = c.req.query("days") ?? "7";
        const days = Number.parseInt(daysStr, 10);
        if (!Number.isFinite(days) || days < 1 || days > 365) {
            return c.json({ error: "days must be 1..365" }, 400);
        }
        const stats = await citationStats(days, ...(deps.citationLogPath !== undefined ? [deps.citationLogPath] : []));
        return c.json(stats);
    });
    // Explicit citation from the cite_session MCP tool. One POST per session
    // the agent explicitly declares it referenced. Source is always "mcp_tool"
    // so the training extractor can distinguish deterministic tool citations
    // from stop-hook detected prose citations.
    app.post("/api/citation/explicit", async (c) => {
        let body;
        try {
            body = (await c.req.json());
        }
        catch {
            return c.json({ error: "body must be JSON" }, 400);
        }
        const id = body["id"];
        if (typeof id !== "string" || !id) {
            return c.json({ error: "id required" }, 400);
        }
        await appendCitation({
            conversationId: typeof body["conversation_id"] === "string" ? body["conversation_id"] : "mcp_tool",
            citedId: id,
            kind: "tool_use",
            ...(typeof body["note"] === "string" ? { responsePreview: body["note"] } : {}),
        }, ...(deps.citationLogPath !== undefined ? [deps.citationLogPath] : []));
        return c.json({ logged: true, id, source: "mcp_tool" });
    });
    // ── Fact recall (Phase B.3 surface, exposed over HTTP for the MCP proxy) ──
    app.get("/api/recall/facts", async (c) => {
        if (!deps.factRecall) {
            return c.json({ error: "fact recall not wired in this deployment" }, 503);
        }
        const q = c.req.query("q") ?? "";
        const subject = c.req.query("subject");
        const predicate = c.req.query("predicate");
        const kind = c.req.query("kind");
        const mode = (c.req.query("mode") ?? "keyword");
        const includeSuperseded = c.req.query("includeSuperseded") === "true";
        const minConfidenceStr = c.req.query("minConfidence");
        const limitStr = c.req.query("limit");
        if (kind !== undefined && !VALID_FACT_KINDS.includes(kind)) {
            return c.json({ error: "kind must be 'decision', 'open', 'attribute', or omitted" }, 400);
        }
        if (!VALID_MODES.includes(mode)) {
            return c.json({ error: "mode must be 'keyword', 'semantic', or 'hybrid'" }, 400);
        }
        const limit = limitStr === undefined ? 10 : Number.parseInt(limitStr, 10);
        if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
            return c.json({ error: "limit must be 1..100" }, 400);
        }
        let minConfidence;
        if (minConfidenceStr !== undefined) {
            minConfidence = Number.parseFloat(minConfidenceStr);
            if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
                return c.json({ error: "minConfidence must be 0..1" }, 400);
            }
        }
        const query = {
            query: q,
            mode: mode,
            limit,
            includeSuperseded,
            ...(subject !== undefined ? { subject } : {}),
            ...(predicate !== undefined ? { predicate } : {}),
            ...(kind !== undefined ? { kind: kind } : {}),
            ...(minConfidence !== undefined ? { minConfidence } : {}),
        };
        const result = await deps.factRecall.search(query);
        const source = c.req.header("x-recall-source") ?? "http";
        void logFactQuery({
            source,
            query: q || null,
            subject: subject ?? null,
            predicate: predicate ?? null,
            kind: kind ?? null,
            mode: mode,
            limit,
            nResults: result.total,
            returnedIds: result.results.map((r) => r.id),
        }, ...(deps.factQueryLogPath !== undefined ? [deps.factQueryLogPath] : []));
        return c.json(result);
    });
    app.get("/api/facts/history", async (c) => {
        if (!deps.factStore) {
            return c.json({ error: "fact store not wired in this deployment" }, 503);
        }
        const subject = c.req.query("subject");
        if (!subject) {
            return c.json({ error: "subject is required" }, 400);
        }
        const predicate = c.req.query("predicate");
        const chains = await deps.factStore.getHistory(subject, predicate);
        return c.json({ subject, predicate: predicate ?? null, chains });
    });
    app.get("/api/recall/facts/stats", async (c) => {
        const daysStr = c.req.query("days") ?? "7";
        const days = Number.parseInt(daysStr, 10);
        if (!Number.isFinite(days) || days < 1 || days > 365) {
            return c.json({ error: "days must be 1..365" }, 400);
        }
        const stats = await factRecallStats(days, ...(deps.factQueryLogPath !== undefined ? [deps.factQueryLogPath] : []));
        return c.json(stats);
    });
    app.get("/api/live/recent-writes", (c) => {
        if (!deps.liveStore)
            return c.json({ writes: [] });
        const limit = parseLimit(c.req.query("limit"), 50, 200);
        return c.json({ writes: deps.liveStore.recentWrites(limit) });
    });
    app.get("/api/live/recent-markers", (c) => {
        if (!deps.liveStore)
            return c.json({ markers: [] });
        const limit = parseLimit(c.req.query("limit"), 50, 200);
        return c.json({ markers: deps.liveStore.recentMarkers(limit) });
    });
    app.get("/api/dataset", (c) => {
        if (!deps.dbPath)
            return c.json({ error: "dataset endpoint requires dbPath" }, 503);
        const includePaths = c.req.query("include_paths") === "true";
        return c.json(buildDataset(deps.dbPath, { includePaths }));
    });
    // ── Data management ─────────────────────────────────────────────
    // Storage stats, live-safe backup snapshot, and staged restore.
    app.get("/api/data/stats", (c) => {
        if (!deps.liveStore || !deps.dbPath) {
            return c.json({ error: "data stats require liveStore + dbPath" }, 503);
        }
        const db = deps.liveStore.rawDb();
        const countOf = (table) => {
            try {
                const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
                return row?.n ?? 0;
            }
            catch {
                return 0;
            }
        };
        const tables = DATA_STAT_TABLES.map((name) => ({ name, rows: countOf(name) }));
        const migrations = db
            .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
            .all();
        const runtimes = db
            .prepare("SELECT runtime, COUNT(*) AS n FROM sessions GROUP BY runtime ORDER BY n DESC")
            .all();
        let dbBytes = 0;
        let dbPresent = false;
        try {
            dbBytes = statSync(deps.dbPath).size;
            dbPresent = true;
        }
        catch { /* file absent */ }
        for (const sidecar of [`${deps.dbPath}-wal`, `${deps.dbPath}-shm`]) {
            try {
                dbBytes += statSync(sidecar).size;
            }
            catch { /* no sidecar */ }
        }
        return c.json({
            dbPath: deps.dbPath,
            dbBytes,
            dbPresent,
            schemaVersion: migrations.length > 0 ? migrations[migrations.length - 1].version : null,
            migrations,
            tables,
            runtimes,
        });
    });
    app.get("/api/data/backup", (c) => {
        if (!deps.liveStore || !deps.dbPath) {
            return c.json({ error: "backup requires liveStore + dbPath" }, 503);
        }
        const scratch = snapshotScratchPath(deps.dbPath);
        try {
            vacuumSnapshot(deps.liveStore.rawDb(), scratch);
            const bytes = readFileSync(scratch);
            const stamp = new Date().toISOString().slice(0, 10);
            c.header("Content-Type", "application/x-sqlite3");
            c.header("Content-Disposition", `attachment; filename="nlm-memory-backup-${stamp}.sqlite"`);
            return c.body(bytes);
        }
        catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
        finally {
            rmSync(scratch, { force: true });
        }
    });
    app.post("/api/data/restore", async (c) => {
        if (!deps.dbPath)
            return c.json({ error: "restore requires dbPath" }, 503);
        const form = await c.req.parseBody().catch(() => null);
        const file = form?.["file"];
        if (!(file instanceof File)) {
            return c.json({ error: "multipart body must include a `file` field" }, 400);
        }
        const scratch = snapshotScratchPath(deps.dbPath);
        try {
            writeFileSync(scratch, Buffer.from(await file.arrayBuffer()));
            const result = stageRestore(deps.dbPath, scratch);
            if (!result.ok) {
                return c.json({ error: `rejected: ${result.error}` }, 400);
            }
            return c.json({
                staged: true,
                restartRequired: true,
                sessions: result.sessions,
                schemaVersion: result.schemaVersion,
            });
        }
        catch (e) {
            rmSync(scratch, { force: true });
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });
    // ── Actions API ────────────────────────────────────────────────
    // Append-only event log: dismiss/snooze/retire/label/merge all land here.
    // Mutations are projected into the dataset at read time, never applied to
    // the underlying sessions/entities/markers tables.
    app.post("/api/action", async (c) => {
        if (!deps.liveStore)
            return c.json({ error: "actions require liveStore" }, 503);
        const body = await c.req.json().catch(() => null);
        const parsed = parseActionInput(body);
        if (!parsed)
            return c.json({ error: "invalid action payload" }, 400);
        const id = writeAction(deps.liveStore.rawDb(), parsed);
        return c.json({ id, timestamp: new Date().toISOString() });
    });
    app.post("/api/action/batch", async (c) => {
        if (!deps.liveStore)
            return c.json({ error: "actions require liveStore" }, 503);
        const body = (await c.req.json().catch(() => null));
        if (!body || !Array.isArray(body.actions))
            return c.json({ error: "missing actions array" }, 400);
        const inputs = body.actions
            .map(parseActionInput)
            .filter((x) => x !== null);
        if (inputs.length === 0)
            return c.json({ accepted: 0, ids: [] });
        const ids = writeActionsBatch(deps.liveStore.rawDb(), inputs);
        return c.json({ accepted: ids.length, ids });
    });
    app.post("/api/action/:id/undo", (c) => {
        if (!deps.liveStore)
            return c.json({ error: "actions require liveStore" }, 503);
        const result = undoAction(deps.liveStore.rawDb(), c.req.param("id"));
        if (!result)
            return c.json({ error: "action not found or already undone" }, 404);
        return c.json({ id: result.undoId, timestamp: new Date().toISOString() });
    });
    app.get("/api/actions", (c) => {
        if (!deps.liveStore)
            return c.json({ actions: [] });
        const limitRaw = c.req.query("limit");
        const subjectId = c.req.query("subject_id");
        const kind = c.req.query("kind");
        const limit = limitRaw ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10))) : 100;
        const rows = listActions(deps.liveStore.rawDb(), {
            limit,
            ...(subjectId ? { subjectId } : {}),
            ...(kind ? { kind } : {}),
        });
        return c.json({ actions: rows });
    });
    app.get("/api/classifier/info", (c) => {
        const provider = deps.classifier?.provider ?? "deepseek";
        const model = deps.classifier?.model ?? "deepseek-v4-flash";
        return c.json({
            provider,
            model,
            available_providers: ["deepseek", "ollama"],
            env_present: {
                deepseek: Boolean(process.env["DEEPSEEK_API_KEY"]),
                ollama: true,
            },
            default_models: {
                deepseek: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat"],
                ollama: ["phi4-mini:latest", "qwen2.5:3b-instruct", "llama3.2:3b", "mistral:7b"],
            },
            embedder: deps.embedderInfo ?? { provider: "ollama", model: "nomic-embed-text", dims: 768 },
        });
    });
    app.post("/api/classifier", async (c) => {
        if (!deps.classifier)
            return c.json({ error: "classifier swap requires classifier box" }, 503);
        const body = (await c.req.json().catch(() => null));
        const provider = body?.provider;
        const model = body?.model;
        if (provider !== "deepseek" && provider !== "ollama") {
            return c.json({ error: "provider must be 'deepseek' or 'ollama'" }, 400);
        }
        if (!model || typeof model !== "string" || model.length === 0) {
            return c.json({ error: "model is required" }, 400);
        }
        if (provider === "deepseek" && !process.env["DEEPSEEK_API_KEY"]) {
            return c.json({ error: "DEEPSEEK_API_KEY not set — cannot swap to deepseek" }, 400);
        }
        deps.classifier.swap(provider, model);
        return c.json({ provider: deps.classifier.provider, model: deps.classifier.model });
    });
    // ── Sources registry ────────────────────────────────────────────
    // Each row = one transcript origin the daemon scans. UI uses these
    // endpoints to surface existing sources + let users add custom ones.
    app.get("/api/sources", (c) => {
        if (!deps.sources)
            return c.json({ sources: [] });
        return c.json({ sources: deps.sources.list() });
    });
    app.post("/api/sources", async (c) => {
        if (!deps.sources)
            return c.json({ error: "sources registry unavailable" }, 503);
        const body = (await c.req.json().catch(() => null));
        const parsed = parseSourceInsert(body);
        if (!parsed)
            return c.json({ error: "invalid source payload" }, 400);
        if (deps.sources.getByName(parsed.name)) {
            return c.json({ error: `source named '${parsed.name}' already exists` }, 409);
        }
        return c.json(deps.sources.insert(parsed), 201);
    });
    app.patch("/api/sources/:id", async (c) => {
        if (!deps.sources)
            return c.json({ error: "sources registry unavailable" }, 503);
        const id = Number.parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id))
            return c.json({ error: "invalid id" }, 400);
        const body = (await c.req.json().catch(() => null));
        const patch = parseSourceUpdate(body);
        if (!patch)
            return c.json({ error: "invalid patch payload" }, 400);
        const updated = deps.sources.update(id, patch);
        if (!updated)
            return c.json({ error: `source ${id} not found` }, 404);
        return c.json(updated);
    });
    app.delete("/api/sources/:id", (c) => {
        if (!deps.sources)
            return c.json({ error: "sources registry unavailable" }, 503);
        const id = Number.parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id))
            return c.json({ error: "invalid id" }, 400);
        const ok = deps.sources.delete(id);
        if (!ok)
            return c.json({ error: `source ${id} not found` }, 404);
        return c.json({ deleted: id });
    });
    app.post("/api/sources/:id/regenerate-token", (c) => {
        if (!deps.sources)
            return c.json({ error: "sources registry unavailable" }, 503);
        const id = Number.parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id))
            return c.json({ error: "invalid id" }, 400);
        const token = deps.sources.regenerateToken(id);
        if (!token)
            return c.json({ error: "regenerate-token only applies to webhook sources" }, 400);
        return c.json({ token });
    });
    // Ingest (webhook push). Auth: Bearer token tied to a webhook source.
    // Classification runs async so callers get a fast 202.
    app.post("/api/ingest", async (c) => {
        if (!deps.ingest || !deps.sources) {
            return c.json({ error: "ingest pipeline not wired" }, 503);
        }
        const auth = c.req.header("authorization") ?? "";
        const match = /^Bearer\s+(\S+)$/i.exec(auth);
        if (!match || !match[1])
            return c.json({ error: "missing or malformed bearer token" }, 401);
        const source = deps.sources.findByToken(match[1]);
        if (!source || source.kind !== "webhook")
            return c.json({ error: "invalid token" }, 401);
        if (!source.enabled)
            return c.json({ error: "source is disabled" }, 403);
        const body = (await c.req.json().catch(() => null));
        if (!body || typeof body["text"] !== "string" || body["text"].length === 0) {
            return c.json({ error: "body must include `text` string" }, 400);
        }
        const text = body["text"];
        const startedAt = typeof body["startedAt"] === "string" ? body["startedAt"] : new Date().toISOString();
        const suppliedId = typeof body["id"] === "string" ? body["id"] : null;
        const id = suppliedId ?? deriveSessionId(source.runtimeLabel, startedAt, text);
        const input = {
            id,
            runtime: source.runtimeLabel,
            runtimeSessionId: typeof body["runtimeSessionId"] === "string" ? body["runtimeSessionId"] : null,
            text,
            startedAt,
            endedAt: typeof body["endedAt"] === "string" ? body["endedAt"] : null,
            transcriptPath: typeof body["transcriptPath"] === "string" ? body["transcriptPath"] : null,
            sourceId: source.id,
        };
        const ingest = deps.ingest;
        void ingestSession(input, ingest).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[ingest] background failure for ${id}: ${msg}`);
        });
        return c.json({ id, status: "accepted", source: source.name }, 202);
    });
    // ── Providers registry ──────────────────────────────────────────
    // Each row = one LLM endpoint. Keys are redacted on every response
    // (rows carry hasApiKey:boolean instead).
    app.get("/api/providers", (c) => {
        if (!deps.providers)
            return c.json({ providers: [] });
        return c.json({ providers: deps.providers.list() });
    });
    app.post("/api/providers", async (c) => {
        if (!deps.providers)
            return c.json({ error: "providers registry unavailable" }, 503);
        const body = (await c.req.json().catch(() => null));
        const parsed = parseProviderInsert(body);
        if (!parsed)
            return c.json({ error: "invalid provider payload" }, 400);
        if (deps.providers.getByName(parsed.name)) {
            return c.json({ error: `provider named '${parsed.name}' already exists` }, 409);
        }
        return c.json(deps.providers.insert(parsed), 201);
    });
    app.patch("/api/providers/:id", async (c) => {
        if (!deps.providers)
            return c.json({ error: "providers registry unavailable" }, 503);
        const id = Number.parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id))
            return c.json({ error: "invalid id" }, 400);
        const body = (await c.req.json().catch(() => null));
        const patch = parseProviderUpdate(body);
        if (!patch)
            return c.json({ error: "invalid patch payload" }, 400);
        const updated = deps.providers.update(id, patch);
        if (!updated)
            return c.json({ error: `provider ${id} not found` }, 404);
        return c.json(updated);
    });
    app.delete("/api/providers/:id", (c) => {
        if (!deps.providers)
            return c.json({ error: "providers registry unavailable" }, 503);
        const id = Number.parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id))
            return c.json({ error: "invalid id" }, 400);
        const ok = deps.providers.delete(id);
        if (!ok)
            return c.json({ error: `provider ${id} not found` }, 404);
        return c.json({ deleted: id });
    });
    app.get("/api/providers/:id/models", async (c) => {
        if (!deps.providers)
            return c.json({ error: "providers registry unavailable" }, 503);
        const id = Number.parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id))
            return c.json({ error: "invalid id" }, 400);
        const provider = deps.providers.get(id);
        if (!provider)
            return c.json({ error: `provider ${id} not found` }, 404);
        const key = deps.providers.getSecret(id);
        try {
            const models = await listModels(provider, { apiKey: key });
            return c.json({ models });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return c.json({ error: message }, 502);
        }
    });
    app.post("/api/providers/:id/test", async (c) => {
        if (!deps.providers)
            return c.json({ error: "providers registry unavailable" }, 503);
        const id = Number.parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id))
            return c.json({ error: "invalid id" }, 400);
        const provider = deps.providers.get(id);
        if (!provider)
            return c.json({ error: `provider ${id} not found` }, 404);
        const key = deps.providers.getSecret(id);
        const startedAt = Date.now();
        try {
            const models = await listModels(provider, { apiKey: key });
            return c.json({
                ok: true,
                modelCount: models.length,
                latencyMs: Date.now() - startedAt,
            });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return c.json({ ok: false, error: message, latencyMs: Date.now() - startedAt }, 200);
        }
    });
    app.get("/api/session/:id", async (c) => {
        const id = c.req.param("id");
        const session = await deps.store.getById(id);
        if (!session) {
            return c.json({ error: `session ${id} not found` }, 404);
        }
        return c.json(session);
    });
    if (deps.uiDist) {
        mountSpa(app, deps.uiDist);
    }
    return app;
}
function parseActionInput(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const r = raw;
    const kind = typeof r["kind"] === "string" ? r["kind"] : null;
    const subjectType = typeof r["subject_type"] === "string" ? r["subject_type"] : null;
    const subjectId = typeof r["subject_id"] === "string" ? r["subject_id"] : null;
    if (!kind || !subjectType || !subjectId)
        return null;
    return {
        kind,
        subjectType,
        subjectId,
        ...(r["payload"] && typeof r["payload"] === "object" && !Array.isArray(r["payload"])
            ? { payload: r["payload"] }
            : {}),
        ...(typeof r["actor"] === "string" ? { actor: r["actor"] } : {}),
        ...(typeof r["runtime"] === "string" ? { runtime: r["runtime"] } : {}),
    };
}
const VALID_SOURCE_KINDS = [
    "claude-code", "hermes", "pi", "jsonl-generic", "webhook",
];
function parseSourceInsert(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const r = raw;
    const kind = r["kind"];
    const name = r["name"];
    const runtimeLabel = r["runtimeLabel"] ?? r["runtime_label"];
    if (typeof kind !== "string" || !VALID_SOURCE_KINDS.includes(kind))
        return null;
    if (typeof name !== "string" || name.length === 0)
        return null;
    if (typeof runtimeLabel !== "string" || runtimeLabel.length === 0)
        return null;
    const pathOrUrl = r["pathOrUrl"] ?? r["path_or_url"];
    const parseConfig = r["parseConfig"] ?? r["parse_config"];
    const enabled = r["enabled"];
    const out = { kind: kind, name, runtimeLabel };
    if (typeof pathOrUrl === "string" || pathOrUrl === null) {
        out.pathOrUrl = pathOrUrl;
    }
    if (parseConfig && typeof parseConfig === "object") {
        out.parseConfig = parseConfig;
    }
    if (typeof enabled === "boolean") {
        out.enabled = enabled;
    }
    return out;
}
function parseSourceUpdate(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const r = raw;
    const patch = {};
    if (typeof r["name"] === "string")
        patch.name = r["name"];
    if ("pathOrUrl" in r || "path_or_url" in r) {
        const v = r["pathOrUrl"] ?? r["path_or_url"];
        if (typeof v === "string" || v === null)
            patch.pathOrUrl = v;
    }
    const rt = r["runtimeLabel"] ?? r["runtime_label"];
    if (typeof rt === "string")
        patch.runtimeLabel = rt;
    const cfg = r["parseConfig"] ?? r["parse_config"];
    if (cfg && typeof cfg === "object")
        patch.parseConfig = cfg;
    if (typeof r["enabled"] === "boolean")
        patch.enabled = r["enabled"];
    if (Object.keys(patch).length === 0)
        return null;
    return patch;
}
const VALID_PROVIDER_KINDS = [
    "deepseek", "ollama", "openai", "anthropic", "openrouter", "openai-compatible",
];
function parseProviderInsert(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const r = raw;
    const kind = r["kind"];
    const name = r["name"];
    if (typeof kind !== "string" || !VALID_PROVIDER_KINDS.includes(kind))
        return null;
    if (typeof name !== "string" || name.length === 0)
        return null;
    const out = { kind: kind, name };
    const baseUrl = r["baseUrl"] ?? r["base_url"];
    if (typeof baseUrl === "string" || baseUrl === null) {
        out.baseUrl = baseUrl;
    }
    const apiKey = r["apiKey"] ?? r["api_key"];
    if (typeof apiKey === "string" || apiKey === null) {
        out.apiKey = apiKey;
    }
    const defaultModel = r["defaultModel"] ?? r["default_model"];
    if (typeof defaultModel === "string" || defaultModel === null) {
        out.defaultModel = defaultModel;
    }
    if (typeof r["enabled"] === "boolean") {
        out.enabled = r["enabled"];
    }
    return out;
}
function parseProviderUpdate(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const r = raw;
    const patch = {};
    if (typeof r["name"] === "string")
        patch.name = r["name"];
    if ("baseUrl" in r || "base_url" in r) {
        const v = r["baseUrl"] ?? r["base_url"];
        if (typeof v === "string" || v === null)
            patch.baseUrl = v;
    }
    if ("apiKey" in r || "api_key" in r) {
        const v = r["apiKey"] ?? r["api_key"];
        if (typeof v === "string" || v === null)
            patch.apiKey = v;
    }
    if ("defaultModel" in r || "default_model" in r) {
        const v = r["defaultModel"] ?? r["default_model"];
        if (typeof v === "string" || v === null)
            patch.defaultModel = v;
    }
    if (typeof r["enabled"] === "boolean")
        patch.enabled = r["enabled"];
    if (Object.keys(patch).length === 0)
        return null;
    return patch;
}
function mountSpa(app, dist) {
    const indexHtml = join(dist, "index.html");
    if (!existsSync(indexHtml))
        return;
    app.get("/ui/*", (c) => {
        const rel = c.req.path.replace(/^\/ui\/?/, "");
        if (rel) {
            const safe = normalize(rel);
            if (!safe.startsWith("..") && !safe.startsWith(sep)) {
                const candidate = join(dist, safe);
                if (existsSync(candidate) && statSync(candidate).isFile()) {
                    const mime = MIME_TYPES[extname(candidate)] ?? "application/octet-stream";
                    return c.body(readFileSync(candidate), 200, { "content-type": mime });
                }
            }
        }
        return c.html(readFileSync(indexHtml, "utf8"));
    });
    app.get("/ui", (c) => c.redirect("/ui/"));
}
//# sourceMappingURL=app.js.map
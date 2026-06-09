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
 *
 * Structure: createApp is a thin composition root that wires the local-only
 * access middleware and then delegates each route group to a registerXxx
 * function defined below. Route handlers themselves are unchanged.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { Hono } from "hono";
import pkg from "../../package.json" with { type: "json" };
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import {
  snapshotScratchPath,
  stageRestore,
  vacuumSnapshot,
} from "@core/storage/db-restore.js";
import type { RecallService } from "@core/recall/recall-service.js";
import { logQuery, recallStats } from "@core/recall/query-log.js";
import { recentQueryLog } from "@core/recall/recent-log.js";
import { appendCitation, citationStats } from "@core/recall/citation-log.js";
import { appendSupersedence } from "@core/storage/supersedence-log.js";
import { getUpdateStatus } from "@core/update-check/check.js";
import {
  buildClearCookie,
  buildSessionCookie,
  deriveSessionValue,
  parseCookies,
  sanitizeNextPath,
  SESSION_COOKIE_NAME,
  verifySessionCookie,
} from "./ui-auth.js";
import { createNonceStore, type NonceStore } from "./auth-nonce.js";
import { clearSurfaced, loadSurfaced, recordSurfaced } from "@core/hook/memo.js";
import { clearCited } from "@core/hook/cite-memo.js";
import { classifyPrompt } from "@core/hook/gate.js";
import { selectHits, type RecallHitInput } from "@core/hook/select.js";
import { formatPointerBlock } from "@core/hook/pointer-block.js";
import type { FactRecallService } from "@core/recall-facts/fact-recall-service.js";
import { factRecallStats, logFactQuery } from "@core/recall-facts/fact-query-log.js";
import type { FactStore } from "@ports/fact-store.js";
import { buildDataset } from "@core/dataset/build-dataset.js";
import { ClassifierBox, type ClassifierProvider } from "../llm/classifier-box.js";
import {
  SourceRegistry,
  PgSourceRegistry,
  type SourceInsert,
  type SourceKind,
  type SourceUpdate,
} from "@core/sources/source-registry.js";
import {
  ProviderRegistry,
  PgProviderRegistry,
  type ProviderInsert,
  type ProviderKind,
  type ProviderUpdate,
} from "@core/providers/provider-registry.js";
import { listModels } from "@core/providers/provider-models.js";
import { ingestSession, deriveSessionId, type IngestDeps } from "@core/ingest/ingest-session.js";
import {
  listActions,
  undoAction,
  writeAction,
  writeActionsBatch,
} from "@core/actions/actions-log.js";
import type { SessionStore } from "@ports/session-store.js";
import type { SqliteSessionStore } from "@core/storage/sqlite-session-store.js";
import type { PgSessionStore } from "@core/storage/pg-session-store.js";
import type { McpDeps } from "../mcp/server.js";
import type {
  FactKind,
  FactRecallQuery,
  RecallKindFilter,
  RecallMode,
  RecallQuery,
} from "@shared/types.js";
import type { SignalStore } from "@ports/signal-store.js";
import { normalizeSignal } from "@core/signals/ingest-signal.js";
import { buildFailureModeBlock } from "@core/signals/failure-mode-recall.js";
import { aggregateFailureModes } from "@core/signals/aggregate.js";

export interface HttpDeps {
  readonly recall: RecallService;
  readonly store: SessionStore;
  /** Pass the concrete store when /live endpoints (recent-writes / recent-markers) should be served. */
  readonly liveStore?: SqliteSessionStore | PgSessionStore;
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
  readonly sources?: SourceRegistry | PgSourceRegistry;
  /** Providers registry — exposes /api/providers CRUD for the desktop UI. */
  readonly providers?: ProviderRegistry | PgProviderRegistry;
  /** Wire to enable POST /api/ingest. When omitted, push ingest is disabled. */
  readonly ingest?: IngestDeps;
  /** Static embedder info — embeddings are always Ollama in this build (DeepSeek has no /embed). */
  readonly embedderInfo?: { provider: string; model: string; dims: number };
  /** Directory containing the built UI (dist/ui). When set, /ui/* serves the SPA. */
  readonly uiDist?: string;
  /**
   * When provided, POST /mcp is mounted and token-gated with NLM_MCP_TOKEN.
   * Omitting this keeps the route absent — no auth surface, no risk.
   */
  readonly mcpDeps?: McpDeps;
  /** Signal store - wire to enable POST /api/signal + GET /api/signals/*. */
  readonly signalStore?: SignalStore;
  /** Per-install scope stamped on every ingested signal. */
  readonly installScope?: string;
}

const MIME_TYPES: Record<string, string> = {
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
] as const;

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, n);
}

// Accept Host headers that point to loopback, with or without the bound port.
// Rejecting non-loopback Hosts closes the DNS-rebinding hole: a malicious
// site can resolve attacker.com to 127.0.0.1 in the browser but cannot
// forge a Host header browsers send automatically.
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower === `localhost:${port}` ||
    lower === "127.0.0.1" ||
    lower === `127.0.0.1:${port}` ||
    lower === "[::1]" ||
    lower === `[::1]:${port}`
  );
}

// Browser Origin headers are set automatically and cannot be spoofed by
// page-level JS. A request with a non-loopback Origin reaching loopback
// means the user is on attacker.com — the page is trying to read our data.
export function isLoopbackOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  const lower = origin.toLowerCase();
  return (
    lower === `http://localhost:${port}` ||
    lower === `http://127.0.0.1:${port}` ||
    lower === `http://[::1]:${port}`
  );
}

const VALID_MODES: ReadonlyArray<RecallMode> = ["keyword", "semantic", "hybrid"];
const VALID_KINDS: ReadonlyArray<RecallKindFilter> = ["decision", "open"];
const VALID_FACT_KINDS: ReadonlyArray<FactKind> = ["decision", "open", "attribute"];

export function createApp(deps: HttpDeps): Hono {
  const app = new Hono();
  const boundPort = process.env["NLM_PORT"] ? Number.parseInt(process.env["NLM_PORT"], 10) : 3940;

  installLocalOnlyMiddleware(app, boundPort);
  registerHealthRoute(app);
  registerMcpRoute(app, deps);
  registerRecallRoutes(app, deps);
  registerHookRoutes(app);
  registerHermesAgentHookRoutes(app, deps);
  registerFactRoutes(app, deps);
  registerLiveRoutes(app, deps);
  registerDatasetRoute(app, deps);
  registerDataManagementRoutes(app, deps);
  registerActionRoutes(app, deps);
  registerClassifierRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerIngestRoute(app, deps);
  registerProviderRoutes(app, deps);
  registerSessionRoute(app, deps);
  registerSignalRoutes(app, deps);

  const nonceStore = createNonceStore();
  registerNonceRoute(app, nonceStore);

  if (deps.uiDist) {
    installUiGate(app);
    registerUiAuthRoutes(app, nonceStore);
    mountSpa(app, deps.uiDist);
  }

  return app;
}

function registerNonceRoute(app: Hono, nonceStore: NonceStore): void {
  // Bearer-protected via the existing /api/* gate. The CLI calls this
  // with NLM_MCP_TOKEN already in its env (autoloaded), gets a nonce,
  // then opens /ui/auth?nonce=<short-lived-single-use> in the browser.
  app.post("/api/ui-bootstrap-nonce", (c) => {
    const minted = nonceStore.mint();
    return c.json(minted);
  });
}

// ── Local-only access middleware (defense in depth on top of 127.0.0.1 bind) ──
//
// Threat model: server binds to loopback so external network is blocked.
// What's left:
//   1. DNS rebinding from a malicious tab — Host check blocks it
//   2. Browser drive-by from a cross-origin tab — Origin check blocks it
//   3. Port forwarding (ssh -L, ngrok) reaching another machine — auth blocks it
//
// Auth is opt-in via NLM_UI_AUTH=cookie. Default is off because the median
// user is alone on their Mac and loopback bind is already the boundary —
// forcing them to bootstrap a cookie just to load /ui/pulse is hostile UX.
// Users who actually expose the port (Tailscale, ssh -L) flip the toggle
// via `nlm config ui-auth on`.
function uiAuthMode(): "cookie" | "none" {
  return process.env["NLM_UI_AUTH"] === "cookie" ? "cookie" : "none";
}

function installLocalOnlyMiddleware(app: Hono, boundPort: number): void {
  const skipLocalGate = !!process.env["VITEST"] || process.env["NODE_ENV"] === "test";
  app.use("/api/*", async (c, next) => {
    if (skipLocalGate) return next();
    const host = c.req.header("host");
    if (!isLoopbackHost(host, boundPort)) {
      return c.json({ error: "host header not allowed" }, 403);
    }
    if (c.req.path === "/api/health") {
      return next();
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLoopbackOrigin(origin, boundPort)) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    if (uiAuthMode() === "none") {
      // Auth disabled by user. Loopback Host + Origin checks already passed.
      return next();
    }
    const token = process.env["NLM_MCP_TOKEN"];
    if (!token) {
      // Misconfig: NLM_UI_AUTH=cookie but no token to key the HMAC. Fail
      // closed — silently dropping to no-auth would be a worse surprise.
      return c.json({ error: "NLM_UI_AUTH=cookie requires NLM_MCP_TOKEN to be set" }, 500);
    }
    // UI session cookie (HMAC of the token, set by /ui/auth bootstrap).
    // Carries the browser's API calls and survives token-stable restarts.
    const cookies = parseCookies(c.req.header("cookie"));
    if (verifySessionCookie(cookies[SESSION_COOKIE_NAME], token)) {
      // Rolling expiry: every authenticated hit re-issues Set-Cookie so an
      // actively-used session never sees an expiry. Only 30 days of true
      // inactivity force a re-bootstrap.
      c.header("Set-Cookie", buildSessionCookie(deriveSessionValue(token)));
      return next();
    }
    // Bearer: programmatic clients (Hermes WebUI, agents, the MCP path).
    // Same secret as the cookie HMAC derives from, but transmitted directly.
    const auth = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    const given = Buffer.from(match?.[1] ?? "", "utf8");
    const want = Buffer.from(token, "utf8");
    if (match && given.length === want.length && timingSafeEqual(given, want)) {
      return next();
    }
    return c.json({ error: "unauthorized" }, 401);
  });
}

// ── UI session-cookie gate ───────────────────────────────────────────
//
// Closes the port-forward bypass: any client reaching localhost:3940
// could previously set Host + Origin headers and bypass the Bearer check
// to fetch /api/*. Putting the static UI behind cookie auth too means
// an attacker can no longer fetch /ui/* to discover anything useful,
// AND the SPA's /api/* fetches now carry a cookie that requires the
// shared secret to mint (see ui-auth.ts for the HMAC contract).
//
// `nlm ui` is the bootstrap path — it opens /ui/auth?t=<token>, which
// validates and sets the cookie. After that the cookie carries every
// subsequent /ui/* and /api/* call.
function installUiGate(app: Hono): void {
  const skipGate = !!process.env["VITEST"] || process.env["NODE_ENV"] === "test";
  app.use("/ui/*", async (c, next) => {
    if (skipGate) return next();
    if (uiAuthMode() === "none") return next();
    const token = process.env["NLM_MCP_TOKEN"];
    if (!token) return next();
    // Auth bootstrap and logout must be reachable without a valid cookie —
    // otherwise users with a stale/forged cookie couldn't sign in or out.
    if (c.req.path === "/ui/auth" || c.req.path === "/ui/logout") return next();
    const cookies = parseCookies(c.req.header("cookie"));
    if (verifySessionCookie(cookies[SESSION_COOKIE_NAME], token)) {
      // Rolling expiry: any /ui/* page load extends the session another 30
      // days from today. Means a user who hits the UI weekly never sees a
      // login page.
      c.header("Set-Cookie", buildSessionCookie(deriveSessionValue(token)));
      return next();
    }
    const here = c.req.path;
    return c.redirect(`/ui/auth?next=${encodeURIComponent(here)}`);
  });
}

function registerUiAuthRoutes(app: Hono, nonceStore: NonceStore): void {
  app.get("/ui/auth", (c) => {
    const token = process.env["NLM_MCP_TOKEN"];
    const next = sanitizeNextPath(c.req.query("next"));
    if (!token) {
      // No token configured → nothing to authenticate against. Send the
      // user straight in; the /api/* gate is also pass-through in this mode.
      return c.redirect(next);
    }
    const nonce = c.req.query("nonce");
    if (nonce && nonceStore.redeem(nonce)) {
      c.header("Set-Cookie", buildSessionCookie(deriveSessionValue(token)));
      return c.redirect(next);
    }
    // Missing/expired/forged nonce → render the same instructions page.
    // No discrimination in the response: an attacker can't tell whether
    // their nonce was wrong, expired, already redeemed, or never existed.
    return c.html(renderAuthPage());
  });

  app.post("/ui/logout", (c) => {
    c.header("Set-Cookie", buildClearCookie());
    return c.redirect("/ui/auth");
  });
}

function renderAuthPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>nlm-memory</title>
<style>
  body{background:#111;color:#ddd;font:14px/1.5 -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  main{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:24px;max-width:420px}
  h1{font-size:16px;margin:0 0 8px}
  p{color:#aaa;margin:0 0 10px;font-size:13px}
  p:last-child{margin-bottom:0}
  code{background:#0a0a0a;color:#eee;padding:2px 6px;border-radius:3px;font-family:ui-monospace,monospace}
  .hint{color:#666;font-size:12px}
</style></head>
<body><main>
  <h1>nlm-memory</h1>
  <p>Run <code>nlm ui</code> from a terminal on this machine to sign in.</p>
  <p class="hint">Sessions roll forward on every visit, so this page only appears after ~30 days of inactivity. To turn auth off entirely, run <code>nlm config ui-auth off</code>.</p>
</main></body></html>`;
}

function registerHealthRoute(app: Hono): void {
  app.get("/api/health", (c) =>
    c.json({ status: "ok", service: "nlm-memory", version: pkg.version }),
  );

  // Passive update poll for the UI. Same daily-cached check the CLI
  // startup banner uses — see src/core/update-check/check.ts for the
  // no-telemetry contract this honors.
  app.get("/api/update-status", async (c) => {
    const status = await getUpdateStatus({ currentVersion: pkg.version });
    return c.json(status);
  });
}

// ── MCP over HTTP (for container agents — e.g. Hermes WebUI) ─────────
// Stateless: one transport + McpServer instance per request, no in-memory
// session state. Bearer token from NLM_MCP_TOKEN is mandatory.
// The existing stdio MCP path (nlm mcp / .mcp.json) is untouched.
function registerMcpRoute(app: Hono, deps: HttpDeps): void {
  if (!deps.mcpDeps) return;
  const mcpToken = process.env["NLM_MCP_TOKEN"];
  if (!mcpToken) {
    throw new Error(
      "NLM_MCP_TOKEN must be set when mcpDeps is provided — " +
      "refusing to mount an unauthenticated /mcp endpoint",
    );
  }
  const capturedMcpDeps = deps.mcpDeps;
  app.all("/mcp", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    const given = Buffer.from(match?.[1] ?? "", "utf8");
    const want = Buffer.from(mcpToken, "utf8");
    if (!match || given.length !== want.length || !timingSafeEqual(given, want)) {
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

function registerRecallRoutes(app: Hono, deps: HttpDeps): void {
  app.get("/api/recall", async (c) => {
    const q = c.req.query("q") ?? "";
    const entity = c.req.query("entity");
    const kind = c.req.query("kind");
    const mode = (c.req.query("mode") ?? "keyword") as string;
    const limitStr = c.req.query("limit");

    if (kind !== undefined && !VALID_KINDS.includes(kind as RecallKindFilter)) {
      return c.json({ error: "kind must be 'decision', 'open', or omitted" }, 400);
    }
    if (!VALID_MODES.includes(mode as RecallMode)) {
      return c.json({ error: "mode must be 'keyword', 'semantic', or 'hybrid'" }, 400);
    }
    const limit = limitStr === undefined ? 20 : Number.parseInt(limitStr, 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      return c.json({ error: "limit must be 1..100" }, 400);
    }

    const query: RecallQuery = {
      query: q,
      mode: mode as RecallMode,
      limit,
      ...(entity !== undefined ? { entity } : {}),
      ...(kind !== undefined ? { kind: kind as RecallKindFilter } : {}),
    };
    const result = await deps.recall.search(query);

    // Fire-and-forget telemetry — never blocks the response.
    const source = c.req.header("x-recall-source") ?? "http";
    const runtime = c.req.header("x-recall-runtime") ?? null;
    void logQuery(
      {
        source,
        runtime,
        query: q || null,
        entity: entity ?? null,
        kind: (kind as RecallKindFilter | undefined) ?? null,
        mode: mode as RecallMode,
        limit,
        nResults: result.total,
        returnedIds: result.results.map((r) => r.id),
      },
      ...(deps.queryLogPath !== undefined ? [deps.queryLogPath] : []),
    );

    return c.json(result);
  });

  app.get("/api/recall/stats", async (c) => {
    const daysStr = c.req.query("days") ?? "7";
    const days = Number.parseInt(daysStr, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return c.json({ error: "days must be 1..365" }, 400);
    }
    const stats = await recallStats(
      days,
      ...(deps.queryLogPath !== undefined ? [deps.queryLogPath] : []),
    );
    return c.json(stats);
  });

  app.get("/api/recall/recent", (c) => {
    const limit = parseLimit(c.req.query("limit"), 50, 200);
    const entries = recentQueryLog(
      limit,
      ...(deps.queryLogPath !== undefined ? [deps.queryLogPath] : []),
    );
    return c.json({ entries });
  });

  // Citation events from the Stop hook. One POST per surfaced ID the
  // assistant cited in its response. Training-data substrate for the future learned reranker.
  app.post("/api/recall/cite-event", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
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
    await appendCitation(
      {
        conversationId,
        citedId,
        ...(kind === "tool_use" || kind === "prose" ? { kind } : {}),
        ...(typeof responsePreview === "string"
          ? { responsePreview }
          : {}),
      },
      ...(deps.citationLogPath !== undefined ? [deps.citationLogPath] : []),
    );
    return c.json({ ok: true });
  });

  app.get("/api/recall/cite-stats", async (c) => {
    const daysStr = c.req.query("days") ?? "7";
    const days = Number.parseInt(daysStr, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return c.json({ error: "days must be 1..365" }, 400);
    }
    const stats = await citationStats(
      days,
      ...(deps.citationLogPath !== undefined ? [deps.citationLogPath] : []),
    );
    return c.json(stats);
  });

  // Explicit citation from the cite_session MCP tool. One POST per session
  // the agent explicitly declares it referenced. Source is always "mcp_tool"
  // so the training extractor can distinguish deterministic tool citations
  // from stop-hook detected prose citations.
  app.post("/api/citation/explicit", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const id = body["id"];
    if (typeof id !== "string" || !id) {
      return c.json({ error: "id required" }, 400);
    }
    await appendCitation(
      {
        conversationId: typeof body["conversation_id"] === "string" ? body["conversation_id"] : "mcp_tool",
        citedId: id,
        kind: "tool_use",
        ...(typeof body["reason"] === "string" ? { responsePreview: body["reason"] } : {}),
      },
      ...(deps.citationLogPath !== undefined ? [deps.citationLogPath] : []),
    );
    return c.json({ logged: true, id, source: "mcp_tool" });
  });
}

// ── Hook endpoints (Phase 1d) ─────────────────────────────────────────────
function registerHookRoutes(app: Hono): void {
  // PreCompact hook: flush surfaced-ID memo for the compacting conversation
  // and stamp a compaction record so post-compaction recalls don't get
  // suppressed by stale "already surfaced" gates.
  // Payload: { conversation_id, transcript_path?, surfaced_set?, ts? }
  app.post("/api/hook/pre-compact", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const conversationId = body["conversation_id"];
    if (typeof conversationId !== "string" || !conversationId) {
      return c.json({ error: "conversation_id required" }, 400);
    }
    const flushed = loadSurfaced(conversationId).size;
    clearSurfaced(conversationId);
    const compactedAt = new Date().toISOString();
    const logPath = process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(
        logPath,
        `${JSON.stringify({ ts: compactedAt, kind: "pre-compact", conversationId, flushed })}\n`,
        "utf8",
      );
    } catch {
      // Log failure must not fail the endpoint.
    }
    return c.json({ ok: true, flushed, compacted_at: compactedAt });
  });

  // SubagentStart hook: logging-only stub. Records the parent→subagent link
  // so future corpus-linking logic can correlate subagent sessions back to
  // their dispatching conversation.
  // Payload: { parent_conversation_id, subagent_session_id, subagent_description?, ts? }
  app.post("/api/hook/subagent-start", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const parentConversationId = body["parent_conversation_id"];
    const subagentSessionId = body["subagent_session_id"];
    if (typeof parentConversationId !== "string" || !parentConversationId) {
      return c.json({ error: "parent_conversation_id required" }, 400);
    }
    if (typeof subagentSessionId !== "string" || !subagentSessionId) {
      return c.json({ error: "subagent_session_id required" }, 400);
    }
    const subagentDescription = typeof body["subagent_description"] === "string" ? body["subagent_description"] : "";
    const ts = typeof body["ts"] === "string" ? body["ts"] : new Date().toISOString();
    const logPath = process.env["NLM_SUBAGENT_LOG"] ?? join(homedir(), ".nlm", "subagent-log.jsonl");
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(
        logPath,
        `${JSON.stringify({ ts, parent_conversation_id: parentConversationId, subagent_session_id: subagentSessionId, subagent_description: subagentDescription })}\n`,
        "utf8",
      );
    } catch {
      // Log failure must not fail the endpoint.
    }
    return c.json({ ok: true, recorded: true });
  });
}

// ── NousResearch Hermes Agent lifecycle hooks ─────────────────────────────
//
// Python plugin (~/.hermes/plugins/nlm-memory/__init__.py) calls these
// endpoints for the 6 events it registers with ctx.register_hook().
//
// pre_llm_call  → POST /api/hook/hermes-agent/pre-turn  (recall + inject)
// post_llm_call → POST /api/hook/hermes-agent/post-turn (citation detect)
// on_session_{start,end,finalize,reset} → POST /api/hook/hermes-agent/session-lifecycle
function registerHermesAgentHookRoutes(app: Hono, deps: HttpDeps): void {
  // pre-turn: run keyword recall against user_message, update the per-session
  // memo to avoid re-surfacing the same sessions within one conversation, and
  // return the formatted pointer block as {"context": "..."}.
  // Returns {"context": null} when there is nothing worth surfacing.
  app.post("/api/hook/hermes-agent/pre-turn", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const sessionId = body["session_id"];
    const userMessage = body["user_message"];
    if (typeof sessionId !== "string" || !sessionId) {
      return c.json({ error: "session_id required" }, 400);
    }
    if (typeof userMessage !== "string" || !userMessage.trim()) {
      return c.json({ context: null });
    }
    if (classifyPrompt(userMessage) === "generative") {
      return c.json({ context: null });
    }
    try {
      const result = await deps.recall.search({ query: userMessage, mode: "keyword", limit: 5 });
      const hits: ReadonlyArray<RecallHitInput> = result.results.map((r) => ({
        id: r.id,
        label: r.label,
        startedAt: r.startedAt,
        matchScore: r.matchScore,
      }));
      const surfaced = loadSurfaced(sessionId);
      const selected = selectHits({ hits, surfaced, scoreThreshold: 0, perFireCap: 3, perConversationCap: 10 });
      if (selected.length === 0) return c.json({ context: null });
      recordSurfaced(sessionId, selected.map((h) => h.id));
      return c.json({ context: formatPointerBlock(selected) });
    } catch {
      return c.json({ context: null });
    }
  });

  // post-turn: scan assistant_response for session IDs that were surfaced in
  // this conversation and log prose citation events.
  app.post("/api/hook/hermes-agent/post-turn", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const sessionId = body["session_id"];
    const assistantResponse = body["assistant_response"];
    if (typeof sessionId !== "string" || !sessionId) {
      return c.json({ error: "session_id required" }, 400);
    }
    if (typeof assistantResponse !== "string" || !assistantResponse) {
      return c.json({ ok: true, cited: 0 });
    }
    const surfacedIds = [...loadSurfaced(sessionId)];
    const cited: string[] = [];
    for (const id of surfacedIds) {
      if (assistantResponse.includes(id)) cited.push(id);
    }
    const preview = assistantResponse.slice(0, 200);
    for (const citedId of cited) {
      await appendCitation(
        { conversationId: sessionId, citedId, kind: "prose", responsePreview: preview },
        ...(deps.citationLogPath !== undefined ? [deps.citationLogPath] : []),
      );
    }
    return c.json({ ok: true, cited: cited.length });
  });

  // session-lifecycle: memo housekeeping for on_session_{start,end,finalize,reset}.
  // start is a no-op (memo is created lazily). end/finalize/reset clear the memo.
  app.post("/api/hook/hermes-agent/session-lifecycle", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const event = body["event"];
    if (typeof event !== "string" || !["start", "end", "finalize", "reset"].includes(event)) {
      return c.json({ error: "event must be one of: start, end, finalize, reset" }, 400);
    }
    if (event !== "start") {
      const sessionId = body["session_id"];
      if (typeof sessionId === "string" && sessionId) {
        clearSurfaced(sessionId);
        clearCited(sessionId);
      }
    }
    return c.json({ ok: true, event });
  });
}

// ── Fact recall (Phase B.3 surface, exposed over HTTP for the MCP proxy) ──
function registerFactRoutes(app: Hono, deps: HttpDeps): void {
  app.get("/api/recall/facts", async (c) => {
    if (!deps.factRecall) {
      return c.json({ error: "fact recall not wired in this deployment" }, 503);
    }
    const q = c.req.query("q") ?? "";
    const subject = c.req.query("subject");
    const predicate = c.req.query("predicate");
    const kind = c.req.query("kind");
    const mode = (c.req.query("mode") ?? "keyword") as string;
    const includeSuperseded = c.req.query("includeSuperseded") === "true";
    const minConfidenceStr = c.req.query("minConfidence");
    const limitStr = c.req.query("limit");

    if (kind !== undefined && !VALID_FACT_KINDS.includes(kind as FactKind)) {
      return c.json({ error: "kind must be 'decision', 'open', 'attribute', or omitted" }, 400);
    }
    if (!VALID_MODES.includes(mode as RecallMode)) {
      return c.json({ error: "mode must be 'keyword', 'semantic', or 'hybrid'" }, 400);
    }
    const limit = limitStr === undefined ? 10 : Number.parseInt(limitStr, 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      return c.json({ error: "limit must be 1..100" }, 400);
    }
    let minConfidence: number | undefined;
    if (minConfidenceStr !== undefined) {
      minConfidence = Number.parseFloat(minConfidenceStr);
      if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        return c.json({ error: "minConfidence must be 0..1" }, 400);
      }
    }

    const query: FactRecallQuery = {
      query: q,
      mode: mode as RecallMode,
      limit,
      includeSuperseded,
      ...(subject !== undefined ? { subject } : {}),
      ...(predicate !== undefined ? { predicate } : {}),
      ...(kind !== undefined ? { kind: kind as FactKind } : {}),
      ...(minConfidence !== undefined ? { minConfidence } : {}),
    };
    const result = await deps.factRecall.search(query);

    const source = c.req.header("x-recall-source") ?? "http";
    void logFactQuery(
      {
        source,
        query: q || null,
        subject: subject ?? null,
        predicate: predicate ?? null,
        kind: (kind as FactKind | undefined) ?? null,
        mode: mode as RecallMode,
        limit,
        nResults: result.total,
        returnedIds: result.results.map((r) => r.id),
      },
      ...(deps.factQueryLogPath !== undefined ? [deps.factQueryLogPath] : []),
    );

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
    const stats = await factRecallStats(
      days,
      ...(deps.factQueryLogPath !== undefined ? [deps.factQueryLogPath] : []),
    );
    return c.json(stats);
  });
}

function registerLiveRoutes(app: Hono, deps: HttpDeps): void {
  app.get("/api/live/recent-writes", (c) => {
    if (!deps.liveStore) return c.json({ writes: [] });
    const limit = parseLimit(c.req.query("limit"), 50, 200);
    return c.json({ writes: deps.liveStore.recentWrites(limit) });
  });

  app.get("/api/live/recent-markers", (c) => {
    if (!deps.liveStore) return c.json({ markers: [] });
    const limit = parseLimit(c.req.query("limit"), 50, 200);
    return c.json({ markers: deps.liveStore.recentMarkers(limit) });
  });
}

function registerDatasetRoute(app: Hono, deps: HttpDeps): void {
  app.get("/api/dataset", (c) => {
    if (!deps.dbPath) return c.json({ error: "dataset endpoint requires dbPath" }, 503);
    const includePaths = c.req.query("include_paths") === "true";
    return c.json(buildDataset(deps.dbPath, { includePaths }));
  });
}

// ── Data management ─────────────────────────────────────────────
// Storage stats, live-safe backup snapshot, and staged restore.
function registerDataManagementRoutes(app: Hono, deps: HttpDeps): void {
  app.get("/api/data/stats", (c) => {
    if (!deps.liveStore || !deps.dbPath) {
      return c.json({ error: "data stats require liveStore + dbPath" }, 503);
    }
    // TODO(#215a): replace rawDb() with port methods; cast until then
    const db = (deps.liveStore as import("@core/storage/sqlite-session-store.js").SqliteSessionStore).rawDb();
    const countOf = (table: string): number => {
      try {
        const row = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get();
        return row?.n ?? 0;
      } catch {
        return 0;
      }
    };
    const tables = DATA_STAT_TABLES.map((name) => ({ name, rows: countOf(name) }));

    const migrations = db
      .prepare<[], { version: number; name: string; applied_at: string }>(
        "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
      )
      .all();

    const runtimes = db
      .prepare<[], { runtime: string; n: number }>(
        "SELECT runtime, COUNT(*) AS n FROM sessions GROUP BY runtime ORDER BY n DESC",
      )
      .all();

    let dbBytes = 0;
    let dbPresent = false;
    try {
      dbBytes = statSync(deps.dbPath).size;
      dbPresent = true;
    } catch { /* file absent */ }
    for (const sidecar of [`${deps.dbPath}-wal`, `${deps.dbPath}-shm`]) {
      try { dbBytes += statSync(sidecar).size; } catch { /* no sidecar */ }
    }

    return c.json({
      dbPath: deps.dbPath,
      dbBytes,
      dbPresent,
      schemaVersion: migrations.length > 0 ? migrations[migrations.length - 1]!.version : null,
      migrations,
      tables,
      runtimes,
    });
  });

  app.get("/api/data/backup", (c) => {
    const adminToken = process.env["NLM_MCP_TOKEN"];
    if (adminToken) {
      const auth = c.req.header("authorization") ?? "";
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      const given = Buffer.from(m?.[1] ?? "", "utf8");
      const want = Buffer.from(adminToken, "utf8");
      if (!m || given.length !== want.length || !timingSafeEqual(given, want)) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    if (!deps.liveStore || !deps.dbPath) {
      return c.json({ error: "backup requires liveStore + dbPath" }, 503);
    }
    const scratch = snapshotScratchPath(deps.dbPath);
    try {
      // TODO(#215a): replace rawDb() with port methods; cast until then
      vacuumSnapshot((deps.liveStore as import("@core/storage/sqlite-session-store.js").SqliteSessionStore).rawDb(), scratch);
      const bytes = readFileSync(scratch);
      const stamp = new Date().toISOString().slice(0, 10);
      c.header("Content-Type", "application/x-sqlite3");
      c.header("Content-Disposition", `attachment; filename="nlm-memory-backup-${stamp}.sqlite"`);
      return c.body(bytes);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    } finally {
      rmSync(scratch, { force: true });
    }
  });

  app.post("/api/data/restore", async (c) => {
    const adminToken = process.env["NLM_MCP_TOKEN"];
    if (adminToken) {
      const auth = c.req.header("authorization") ?? "";
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      const given = Buffer.from(m?.[1] ?? "", "utf8");
      const want = Buffer.from(adminToken, "utf8");
      if (!m || given.length !== want.length || !timingSafeEqual(given, want)) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    if (!deps.dbPath) return c.json({ error: "restore requires dbPath" }, 503);
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
    } catch (e) {
      rmSync(scratch, { force: true });
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}

// ── Actions API ────────────────────────────────────────────────
// Append-only event log: dismiss/snooze/retire/label/merge all land here.
// Mutations are projected into the dataset at read time, never applied to
// the underlying sessions/entities/markers tables.
function registerActionRoutes(app: Hono, deps: HttpDeps): void {
  app.post("/api/action", async (c) => {
    if (!deps.liveStore) return c.json({ error: "actions require liveStore" }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = parseActionInput(body);
    if (!parsed) return c.json({ error: "invalid action payload" }, 400);
    // TODO(#215a): replace rawDb() with port methods; cast until then
    const id = writeAction((deps.liveStore as import("@core/storage/sqlite-session-store.js").SqliteSessionStore).rawDb(), parsed);
    return c.json({ id, timestamp: new Date().toISOString() });
  });

  app.post("/api/action/batch", async (c) => {
    if (!deps.liveStore) return c.json({ error: "actions require liveStore" }, 503);
    const body = (await c.req.json().catch(() => null)) as { actions?: unknown[] } | null;
    if (!body || !Array.isArray(body.actions)) return c.json({ error: "missing actions array" }, 400);
    const inputs = body.actions
      .map(parseActionInput)
      .filter((x): x is NonNullable<ReturnType<typeof parseActionInput>> => x !== null);
    if (inputs.length === 0) return c.json({ accepted: 0, ids: [] });
    // TODO(#215a): replace rawDb() with port methods; cast until then
    const ids = writeActionsBatch((deps.liveStore as import("@core/storage/sqlite-session-store.js").SqliteSessionStore).rawDb(), inputs);
    return c.json({ accepted: ids.length, ids });
  });

  app.post("/api/action/:id/undo", (c) => {
    if (!deps.liveStore) return c.json({ error: "actions require liveStore" }, 503);
    // TODO(#215a): replace rawDb() with port methods; cast until then
    const result = undoAction((deps.liveStore as import("@core/storage/sqlite-session-store.js").SqliteSessionStore).rawDb(), c.req.param("id"));
    if (!result) return c.json({ error: "action not found or already undone" }, 404);
    return c.json({ id: result.undoId, timestamp: new Date().toISOString() });
  });

  app.get("/api/actions", (c) => {
    if (!deps.liveStore) return c.json({ actions: [] });
    const limitRaw = c.req.query("limit");
    const subjectId = c.req.query("subject_id");
    const kind = c.req.query("kind");
    const limit = limitRaw ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10))) : 100;
    // TODO(#215a): replace rawDb() with port methods; cast until then
    const rows = listActions((deps.liveStore as import("@core/storage/sqlite-session-store.js").SqliteSessionStore).rawDb(), {
      limit,
      ...(subjectId ? { subjectId } : {}),
      ...(kind ? { kind } : {}),
    });
    return c.json({ actions: rows });
  });
}

function registerClassifierRoutes(app: Hono, deps: HttpDeps): void {
  app.get("/api/classifier/info", (c) => {
    const provider = deps.classifier?.provider ?? "deepseek";
    const model = deps.classifier?.model ?? "deepseek-v4-flash";
    return c.json({
      provider,
      model,
      available_providers: ["deepseek", "ollama"] as const,
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
    if (!deps.classifier) return c.json({ error: "classifier swap requires classifier box" }, 503);
    const body = (await c.req.json().catch(() => null)) as { provider?: string; model?: string } | null;
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
    deps.classifier.swap(provider as ClassifierProvider, model);
    return c.json({ provider: deps.classifier.provider, model: deps.classifier.model });
  });
}

// ── Sources registry ────────────────────────────────────────────
// Each row = one transcript origin the daemon scans. UI uses these
// endpoints to surface existing sources + let users add custom ones.
function registerSourceRoutes(app: Hono, deps: HttpDeps): void {
  app.get("/api/sources", (c) => {
    if (!deps.sources) return c.json({ sources: [] });
    return c.json({ sources: deps.sources.list() });
  });

  app.post("/api/sources", async (c) => {
    if (!deps.sources) return c.json({ error: "sources registry unavailable" }, 503);
    const body = (await c.req.json().catch(() => null)) as Partial<SourceInsert> | null;
    const parsed = parseSourceInsert(body);
    if (!parsed) return c.json({ error: "invalid source payload" }, 400);
    // TODO(#215a): PgSourceRegistry port; cast until then
    if ((deps.sources as SourceRegistry).getByName(parsed.name)) {
      return c.json({ error: `source named '${parsed.name}' already exists` }, 409);
    }
    return c.json(deps.sources.insert(parsed), 201);
  });

  app.patch("/api/sources/:id", async (c) => {
    if (!deps.sources) return c.json({ error: "sources registry unavailable" }, 503);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const body = (await c.req.json().catch(() => null)) as Partial<SourceUpdate> | null;
    const patch = parseSourceUpdate(body);
    if (!patch) return c.json({ error: "invalid patch payload" }, 400);
    const updated = deps.sources.update(id, patch);
    if (!updated) return c.json({ error: `source ${id} not found` }, 404);
    return c.json(updated);
  });

  app.delete("/api/sources/:id", (c) => {
    if (!deps.sources) return c.json({ error: "sources registry unavailable" }, 503);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const ok = deps.sources.delete(id);
    if (!ok) return c.json({ error: `source ${id} not found` }, 404);
    return c.json({ deleted: id });
  });

  app.post("/api/sources/:id/regenerate-token", (c) => {
    if (!deps.sources) return c.json({ error: "sources registry unavailable" }, 503);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    // TODO(#215a): PgSourceRegistry port; cast until then
    const token = (deps.sources as SourceRegistry).regenerateToken(id);
    if (!token) return c.json({ error: "regenerate-token only applies to webhook sources" }, 400);
    return c.json({ token });
  });
}

// Ingest (webhook push). Auth: Bearer token tied to a webhook source.
// Classification runs async so callers get a fast 202.
function registerIngestRoute(app: Hono, deps: HttpDeps): void {
  app.post("/api/ingest", async (c) => {
    if (!deps.ingest || !deps.sources) {
      return c.json({ error: "ingest pipeline not wired" }, 503);
    }
    const auth = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!match || !match[1]) return c.json({ error: "missing or malformed bearer token" }, 401);
    // TODO(#215a): PgSourceRegistry port; cast until then
    const source = (deps.sources as SourceRegistry).findByToken(match[1]);
    if (!source || source.kind !== "webhook") return c.json({ error: "invalid token" }, 401);
    if (!source.enabled) return c.json({ error: "source is disabled" }, 403);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body["text"] !== "string" || (body["text"] as string).length === 0) {
      return c.json({ error: "body must include `text` string" }, 400);
    }
    const text = body["text"] as string;
    const startedAt = typeof body["startedAt"] === "string" ? (body["startedAt"] as string) : new Date().toISOString();
    const suppliedId = typeof body["id"] === "string" ? (body["id"] as string) : null;
    const id = suppliedId ?? deriveSessionId(source.runtimeLabel, startedAt, text);

    const input = {
      id,
      runtime: source.runtimeLabel,
      runtimeSessionId: typeof body["runtimeSessionId"] === "string" ? (body["runtimeSessionId"] as string) : null,
      text,
      startedAt,
      endedAt: typeof body["endedAt"] === "string" ? (body["endedAt"] as string) : null,
      transcriptPath: typeof body["transcriptPath"] === "string" ? (body["transcriptPath"] as string) : null,
      sourceId: source.id,
    };

    const ingest = deps.ingest;
    void ingestSession(input, ingest).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ingest] background failure for ${id}: ${msg}`);
    });

    return c.json({ id, status: "accepted", source: source.name }, 202);
  });
}

// ── Providers registry ──────────────────────────────────────────
// Each row = one LLM endpoint. Keys are redacted on every response
// (rows carry hasApiKey:boolean instead).
function registerProviderRoutes(app: Hono, deps: HttpDeps): void {
  app.get("/api/providers", (c) => {
    if (!deps.providers) return c.json({ providers: [] });
    return c.json({ providers: deps.providers.list() });
  });

  app.post("/api/providers", async (c) => {
    if (!deps.providers) return c.json({ error: "providers registry unavailable" }, 503);
    const body = (await c.req.json().catch(() => null)) as Partial<ProviderInsert> | null;
    const parsed = parseProviderInsert(body);
    if (!parsed) return c.json({ error: "invalid provider payload" }, 400);
    // TODO(#215a): PgProviderRegistry port; cast until then
    if ((deps.providers as ProviderRegistry).getByName(parsed.name)) {
      return c.json({ error: `provider named '${parsed.name}' already exists` }, 409);
    }
    return c.json(deps.providers.insert(parsed), 201);
  });

  app.patch("/api/providers/:id", async (c) => {
    if (!deps.providers) return c.json({ error: "providers registry unavailable" }, 503);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const body = (await c.req.json().catch(() => null)) as Partial<ProviderUpdate> | null;
    const patch = parseProviderUpdate(body);
    if (!patch) return c.json({ error: "invalid patch payload" }, 400);
    const updated = deps.providers.update(id, patch);
    if (!updated) return c.json({ error: `provider ${id} not found` }, 404);
    return c.json(updated);
  });

  app.delete("/api/providers/:id", (c) => {
    if (!deps.providers) return c.json({ error: "providers registry unavailable" }, 503);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const ok = deps.providers.delete(id);
    if (!ok) return c.json({ error: `provider ${id} not found` }, 404);
    return c.json({ deleted: id });
  });

  app.get("/api/providers/:id/models", async (c) => {
    if (!deps.providers) return c.json({ error: "providers registry unavailable" }, 503);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    // TODO(#215a): PgProviderRegistry port; cast until then
    const provider = (deps.providers as ProviderRegistry).get(id);
    if (!provider) return c.json({ error: `provider ${id} not found` }, 404);
    const key = (deps.providers as ProviderRegistry).getSecret(id);
    try {
      const models = await listModels(provider, { apiKey: key });
      return c.json({ models });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 502);
    }
  });

  app.post("/api/providers/:id/test", async (c) => {
    if (!deps.providers) return c.json({ error: "providers registry unavailable" }, 503);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    // TODO(#215a): PgProviderRegistry port; cast until then
    const provider = (deps.providers as ProviderRegistry).get(id);
    if (!provider) return c.json({ error: `provider ${id} not found` }, 404);
    const key = (deps.providers as ProviderRegistry).getSecret(id);
    const startedAt = Date.now();
    try {
      const models = await listModels(provider, { apiKey: key });
      return c.json({
        ok: true,
        modelCount: models.length,
        latencyMs: Date.now() - startedAt,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: message, latencyMs: Date.now() - startedAt }, 200);
    }
  });
}

function registerSessionRoute(app: Hono, deps: HttpDeps): void {
  app.get("/api/session/:id", async (c) => {
    const id = c.req.param("id");
    const session = await deps.store.getById(id);
    if (!session) {
      return c.json({ error: `session ${id} not found` }, 404);
    }
    return c.json(session);
  });

  // Post-hoc supersedence write path. Mirrors the `mark_superseded` MCP tool
  // so UI + CLI + MCP all share one backend gesture. Path param is the
  // predecessor (the session being retired); body names the successor.
  app.post("/api/session/:id/supersede", async (c) => {
    const predecessorId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "request body must be a JSON object" }, 400);
    }
    const r = body as Record<string, unknown>;
    const successorId = r["successor_id"] ?? r["successorId"];
    const reason = r["reason"];
    if (typeof successorId !== "string" || successorId.length === 0) {
      return c.json({ error: "successor_id is required" }, 400);
    }
    if (reason !== undefined && typeof reason !== "string") {
      return c.json({ error: "reason must be a string if provided" }, 400);
    }
    try {
      await deps.store.markSuperseded(predecessorId, successorId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes("not found") || msg.includes("itself") ? 400 : 500;
      return c.json({ error: msg }, status);
    }
    void appendSupersedence({
      predecessorId,
      successorId,
      source: c.req.header("x-supersedence-source") ?? "http",
      ...(typeof reason === "string" ? { reason } : {}),
    });
    return c.json({
      marked: true,
      predecessor_id: predecessorId,
      successor_id: successorId,
      ...(typeof reason === "string" ? { reason } : {}),
    });
  });
}

function parseActionInput(raw: unknown): {
  kind: string;
  subjectType: string;
  subjectId: string;
  payload?: Record<string, unknown>;
  actor?: string;
  runtime?: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r["kind"] === "string" ? r["kind"] : null;
  const subjectType = typeof r["subject_type"] === "string" ? r["subject_type"] : null;
  const subjectId = typeof r["subject_id"] === "string" ? r["subject_id"] : null;
  if (!kind || !subjectType || !subjectId) return null;
  return {
    kind,
    subjectType,
    subjectId,
    ...(r["payload"] && typeof r["payload"] === "object" && !Array.isArray(r["payload"])
      ? { payload: r["payload"] as Record<string, unknown> }
      : {}),
    ...(typeof r["actor"] === "string" ? { actor: r["actor"] } : {}),
    ...(typeof r["runtime"] === "string" ? { runtime: r["runtime"] } : {}),
  };
}

const VALID_SOURCE_KINDS: ReadonlyArray<SourceKind> = [
  "claude-code", "codex", "hermes", "pi", "jsonl-generic", "webhook",
];

function parseSourceInsert(raw: unknown): SourceInsert | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];
  const name = r["name"];
  const runtimeLabel = r["runtimeLabel"] ?? r["runtime_label"];
  if (typeof kind !== "string" || !VALID_SOURCE_KINDS.includes(kind as SourceKind)) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof runtimeLabel !== "string" || runtimeLabel.length === 0) return null;
  const pathOrUrl = r["pathOrUrl"] ?? r["path_or_url"];
  const parseConfig = r["parseConfig"] ?? r["parse_config"];
  const enabled = r["enabled"];
  const out: SourceInsert = { kind: kind as SourceKind, name, runtimeLabel };
  if (typeof pathOrUrl === "string" || pathOrUrl === null) {
    (out as { pathOrUrl?: string | null }).pathOrUrl = pathOrUrl;
  }
  if (parseConfig && typeof parseConfig === "object") {
    (out as { parseConfig?: Record<string, unknown> }).parseConfig = parseConfig as Record<string, unknown>;
  }
  if (typeof enabled === "boolean") {
    (out as { enabled?: boolean }).enabled = enabled;
  }
  return out;
}

function parseSourceUpdate(raw: unknown): SourceUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const patch: SourceUpdate = {};
  if (typeof r["name"] === "string") (patch as { name?: string }).name = r["name"];
  if ("pathOrUrl" in r || "path_or_url" in r) {
    const v = r["pathOrUrl"] ?? r["path_or_url"];
    if (typeof v === "string" || v === null) (patch as { pathOrUrl?: string | null }).pathOrUrl = v;
  }
  const rt = r["runtimeLabel"] ?? r["runtime_label"];
  if (typeof rt === "string") (patch as { runtimeLabel?: string }).runtimeLabel = rt;
  const cfg = r["parseConfig"] ?? r["parse_config"];
  if (cfg && typeof cfg === "object") (patch as { parseConfig?: Record<string, unknown> }).parseConfig = cfg as Record<string, unknown>;
  if (typeof r["enabled"] === "boolean") (patch as { enabled?: boolean }).enabled = r["enabled"] as boolean;
  if (Object.keys(patch).length === 0) return null;
  return patch;
}

const VALID_PROVIDER_KINDS: ReadonlyArray<ProviderKind> = [
  "deepseek", "ollama", "openai", "anthropic", "openrouter", "openai-compatible",
];

function parseProviderInsert(raw: unknown): ProviderInsert | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];
  const name = r["name"];
  if (typeof kind !== "string" || !VALID_PROVIDER_KINDS.includes(kind as ProviderKind)) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  const out: ProviderInsert = { kind: kind as ProviderKind, name };
  const baseUrl = r["baseUrl"] ?? r["base_url"];
  if (typeof baseUrl === "string" || baseUrl === null) {
    (out as { baseUrl?: string | null }).baseUrl = baseUrl;
  }
  const apiKey = r["apiKey"] ?? r["api_key"];
  if (typeof apiKey === "string" || apiKey === null) {
    (out as { apiKey?: string | null }).apiKey = apiKey;
  }
  const defaultModel = r["defaultModel"] ?? r["default_model"];
  if (typeof defaultModel === "string" || defaultModel === null) {
    (out as { defaultModel?: string | null }).defaultModel = defaultModel;
  }
  if (typeof r["enabled"] === "boolean") {
    (out as { enabled?: boolean }).enabled = r["enabled"] as boolean;
  }
  return out;
}

function parseProviderUpdate(raw: unknown): ProviderUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const patch: ProviderUpdate = {};
  if (typeof r["name"] === "string") (patch as { name?: string }).name = r["name"];
  if ("baseUrl" in r || "base_url" in r) {
    const v = r["baseUrl"] ?? r["base_url"];
    if (typeof v === "string" || v === null) (patch as { baseUrl?: string | null }).baseUrl = v;
  }
  if ("apiKey" in r || "api_key" in r) {
    const v = r["apiKey"] ?? r["api_key"];
    if (typeof v === "string" || v === null) (patch as { apiKey?: string | null }).apiKey = v;
  }
  if ("defaultModel" in r || "default_model" in r) {
    const v = r["defaultModel"] ?? r["default_model"];
    if (typeof v === "string" || v === null) (patch as { defaultModel?: string | null }).defaultModel = v;
  }
  if (typeof r["enabled"] === "boolean") (patch as { enabled?: boolean }).enabled = r["enabled"] as boolean;
  if (Object.keys(patch).length === 0) return null;
  return patch;
}

function registerSignalRoutes(app: Hono, deps: HttpDeps): void {
  app.post("/api/signal", async (c) => {
    if (!deps.signalStore || deps.installScope === undefined) {
      return c.json({ error: "signal store not wired in this deployment" }, 503);
    }
    if (process.env["NLM_SIGNALS_ENABLED"] === "0") {
      return c.json({ error: "signals disabled" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    let signal;
    try {
      signal = normalizeSignal(body, deps.installScope);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "invalid signal" }, 400);
    }
    try {
      await deps.signalStore.insert(signal);
    } catch {
      return c.json({ error: "signal insert failed" }, 500);
    }
    return c.json({ id: signal.id, status: "accepted" }, 202);
  });

  app.get("/api/signals/failure-modes", async (c) => {
    if (!deps.signalStore || deps.installScope === undefined) {
      return c.json({ error: "signal store not wired in this deployment" }, 503);
    }
    const repo = c.req.query("repo");
    if (!repo) return c.json({ error: "repo is required" }, 400);
    const model = c.req.query("model");
    const block = await buildFailureModeBlock(
      deps.signalStore,
      { installScope: deps.installScope, repo, ...(model ? { model } : {}) },
    );
    return c.json({ repo, model: model ?? null, block });
  });

  app.get("/api/signals/stats", async (c) => {
    if (!deps.signalStore || deps.installScope === undefined) {
      return c.json({ error: "signal store not wired in this deployment" }, 503);
    }
    const daysStr = c.req.query("days") ?? "14";
    const days = Number.parseInt(daysStr, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return c.json({ error: "days must be 1..365" }, 400);
    }
    const sinceTs = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = await deps.signalStore.listForAggregation({ installScope: deps.installScope, sinceTs });
    const modes = aggregateFailureModes(rows);
    return c.json({ days, total: rows.length, modes });
  });
}

function mountSpa(app: Hono, dist: string): void {
  const indexHtml = join(dist, "index.html");
  if (!existsSync(indexHtml)) return;

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

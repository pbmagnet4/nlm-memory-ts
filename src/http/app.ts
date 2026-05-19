/**
 * Hono app factory. Routes mirror the Python daemon's API surface (GET
 * /api/recall, GET /api/recall/stats, GET /api/session/:id, GET /api/health)
 * so existing UI clients and the agent-recall observability panel can switch
 * to this server without contract changes.
 *
 * Layering: this module knows about RecallService and SessionStore (the
 * inner ring), but core/ knows nothing about Hono. Adapter direction stays
 * one-way.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Hono } from "hono";
import type { RecallService } from "@core/recall/recall-service.js";
import { logQuery, recallStats } from "@core/recall/query-log.js";
import { recentQueryLog } from "@core/recall/recent-log.js";
import { buildDataset } from "@core/dataset/build-dataset.js";
import { ClassifierBox, type ClassifierProvider } from "../llm/classifier-box.js";
import {
  SourceRegistry,
  type SourceInsert,
  type SourceKind,
  type SourceUpdate,
} from "@core/sources/source-registry.js";
import {
  listActions,
  undoAction,
  writeAction,
  writeActionsBatch,
} from "@core/actions/actions-log.js";
import type { SessionStore } from "@ports/session-store.js";
import type { SqliteSessionStore } from "@core/storage/sqlite-session-store.js";
import type {
  RecallKindFilter,
  RecallMode,
  RecallQuery,
} from "@shared/types.js";

export interface HttpDeps {
  readonly recall: RecallService;
  readonly store: SessionStore;
  /** Pass the concrete store when /live endpoints (recent-writes / recent-markers) should be served. */
  readonly liveStore?: SqliteSessionStore;
  /** Optional override for the query log path. Defaults to ~/.nle/query_log.jsonl or $NLE_QUERY_LOG. */
  readonly queryLogPath?: string;
  /** Path to canonical.sqlite for the /api/dataset endpoint. */
  readonly dbPath?: string;
  /** Mutable classifier — read by /api/classifier/info, swapped by POST /api/classifier. */
  readonly classifier?: ClassifierBox;
  /** Sources registry — exposes /api/sources CRUD for the desktop UI. */
  readonly sources?: SourceRegistry;
  /** Static embedder info — embeddings are always Ollama in this build (DeepSeek has no /embed). */
  readonly embedderInfo?: { provider: string; model: string; dims: number };
  /** Directory containing the built UI (dist/ui). When set, /ui/* serves the SPA. */
  readonly uiDist?: string;
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

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, n);
}

const VALID_MODES: ReadonlyArray<RecallMode> = ["keyword", "semantic", "hybrid"];
const VALID_KINDS: ReadonlyArray<RecallKindFilter> = ["decision", "open"];

export function createApp(deps: HttpDeps): Hono {
  const app = new Hono();

  app.get("/api/health", (c) =>
    c.json({ status: "ok", service: "nle-memory", version: "0.2.0-dev" }),
  );

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
    void logQuery(
      {
        source,
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

  app.get("/api/dataset", (c) => {
    if (!deps.dbPath) return c.json({ error: "dataset endpoint requires dbPath" }, 503);
    const includePaths = c.req.query("include_paths") === "true";
    return c.json(buildDataset(deps.dbPath, { includePaths }));
  });

  // ── Actions API ────────────────────────────────────────────────
  // Append-only event log: dismiss/snooze/retire/label/merge all land here.
  // Mutations are projected into the dataset at read time, never applied to
  // the underlying sessions/entities/markers tables.

  app.post("/api/action", async (c) => {
    if (!deps.liveStore) return c.json({ error: "actions require liveStore" }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = parseActionInput(body);
    if (!parsed) return c.json({ error: "invalid action payload" }, 400);
    const id = writeAction(deps.liveStore.rawDb(), parsed);
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
    const ids = writeActionsBatch(deps.liveStore.rawDb(), inputs);
    return c.json({ accepted: ids.length, ids });
  });

  app.post("/api/action/:id/undo", (c) => {
    if (!deps.liveStore) return c.json({ error: "actions require liveStore" }, 503);
    const result = undoAction(deps.liveStore.rawDb(), c.req.param("id"));
    if (!result) return c.json({ error: "action not found or already undone" }, 404);
    return c.json({ id: result.undoId, timestamp: new Date().toISOString() });
  });

  app.get("/api/actions", (c) => {
    if (!deps.liveStore) return c.json({ actions: [] });
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

  // ── Sources registry ────────────────────────────────────────────
  // Each row = one transcript origin the daemon scans. UI uses these
  // endpoints to surface existing sources + let users add custom ones.

  app.get("/api/sources", (c) => {
    if (!deps.sources) return c.json({ sources: [] });
    return c.json({ sources: deps.sources.list() });
  });

  app.post("/api/sources", async (c) => {
    if (!deps.sources) return c.json({ error: "sources registry unavailable" }, 503);
    const body = (await c.req.json().catch(() => null)) as Partial<SourceInsert> | null;
    const parsed = parseSourceInsert(body);
    if (!parsed) return c.json({ error: "invalid source payload" }, 400);
    if (deps.sources.getByName(parsed.name)) {
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
  "claude-code", "hermes", "pi", "jsonl-generic", "webhook",
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

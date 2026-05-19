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
  /** Active classifier provider + model for /api/classifier/info. */
  readonly classifierInfo?: { provider: string; model: string };
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
    return c.json(buildDataset(deps.dbPath));
  });

  app.get("/api/classifier/info", (c) => {
    const provider = deps.classifierInfo?.provider ?? "deepseek";
    const model = deps.classifierInfo?.model ?? "deepseek-v4-flash";
    return c.json({
      provider,
      model,
      available_providers: ["deepseek", "ollama"],
      env_present: {
        deepseek: Boolean(process.env["DEEPSEEK_API_KEY"]),
        ollama: true,
      },
      default_models: {
        deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
        ollama: ["phi4-mini:latest", "qwen2.5:3b-instruct"],
      },
    });
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

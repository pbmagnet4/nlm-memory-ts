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

import { Hono } from "hono";
import type { RecallService } from "@core/recall/recall-service.js";
import type { SessionStore } from "@ports/session-store.js";
import type {
  RecallKindFilter,
  RecallMode,
  RecallQuery,
} from "@shared/types.js";

export interface HttpDeps {
  readonly recall: RecallService;
  readonly store: SessionStore;
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
    return c.json(result);
  });

  // Stats endpoint stub. Real implementation lives in Phase B once the
  // query log (~/.nle/query_log.jsonl) is ported. For now we return an
  // empty-shape response so UI clients don't crash.
  app.get("/api/recall/stats", (c) => {
    const daysStr = c.req.query("days") ?? "7";
    const days = Number.parseInt(daysStr, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return c.json({ error: "days must be 1..365" }, 400);
    }
    return c.json({
      days,
      total: 0,
      by_mode: {},
      by_source: {},
      empty_rate: 0,
      not_implemented: true,
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

  return app;
}

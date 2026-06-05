/**
 * Backend-agnostic contract test for the FactStore port.
 *
 * Each adapter integration test imports runFactStoreContract and supplies a
 * harness that builds a fresh, migrated, empty Storage instance per test.
 * Identical assertions run against every backend. That is the only proof
 * that a new adapter (e.g. Postgres) is behaviorally equivalent to SQLite.
 *
 * Do NOT put module-level describe() blocks here. The function shape lets
 * each integration test file own its own describe naming.
 *
 * Note on `seedSession`: the SessionStore port has no public `insert(session)`
 * because production sessions arrive through the heavier `insertSession`
 * ingest path. Tests need a thin seed that bypasses extraction. Each backend
 * supplies that seed helper through the harness so this contract stays
 * adapter-agnostic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/shared/types.js";
import type { Storage } from "../../src/ports/storage.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

export interface FactStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
  /** Test-only session seed; bypasses ingest extraction. */
  seedSession(storage: Storage, session: Session): Promise<void>;
}

export function runFactStoreContract(h: FactStoreContractHarness): void {
  describe(`FactStore contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
      await h.seedSession(
        storage,
        makeSession({ id: "sess_parent", label: "Parent session" }),
      );
    });

    afterEach(async () => {
      await h.teardown(storage);
    });

    it("inserts and retrieves a fact round-trip", async () => {
      const fact = makeFact({ id: "fact_1", sourceSessionId: "sess_parent" });
      await storage.facts.insert(fact);
      const fetched = await storage.facts.getById("fact_1");
      expect(fetched).toEqual(fact);
    });

    it("returns null for missing ids", async () => {
      expect(await storage.facts.getById("nonexistent")).toBeNull();
    });

    it("insertMany commits atomically", async () => {
      await storage.facts.insertMany([
        makeFact({ id: "fact_a", subject: "alpha", sourceSessionId: "sess_parent" }),
        makeFact({ id: "fact_b", subject: "beta", sourceSessionId: "sess_parent" }),
      ]);
      expect(await storage.facts.getById("fact_a")).not.toBeNull();
      expect(await storage.facts.getById("fact_b")).not.toBeNull();
    });

    it("insertMany rolls back the whole batch on duplicate id", async () => {
      await storage.facts.insert(
        makeFact({ id: "fact_existing", sourceSessionId: "sess_parent" }),
      );
      await expect(
        storage.facts.insertMany([
          makeFact({ id: "fact_new", subject: "alpha", sourceSessionId: "sess_parent" }),
          makeFact({ id: "fact_existing", subject: "beta", sourceSessionId: "sess_parent" }),
        ]),
      ).rejects.toThrow();
      expect(await storage.facts.getById("fact_new")).toBeNull();
    });

    it("findCurrent returns only non-superseded facts", async () => {
      await storage.facts.insert(
        makeFact({
          id: "fact_old",
          subject: "nlm-memory-ts",
          predicate: "framework",
          value: "Fastify",
          sourceSessionId: "sess_parent",
          createdAt: "2026-05-18T10:00:00Z",
        }),
      );
      await storage.facts.insert(
        makeFact({
          id: "fact_new",
          subject: "nlm-memory-ts",
          predicate: "framework",
          value: "Hono",
          sourceSessionId: "sess_parent",
          createdAt: "2026-05-19T10:00:00Z",
        }),
      );
      await storage.facts.markSuperseded("fact_old", "fact_new");

      const current = await storage.facts.findCurrent("nlm-memory-ts", "framework");
      expect(current?.id).toBe("fact_new");
      expect(current?.value).toBe("Hono");
    });

    it("findCurrent returns null when no current fact exists", async () => {
      expect(await storage.facts.findCurrent("nlm-memory-ts", "framework")).toBeNull();
    });

    it("list filters by subject and excludes superseded by default", async () => {
      await storage.facts.insertMany([
        makeFact({
          id: "f1",
          subject: "mac-pro",
          predicate: "endpoint",
          value: "http://macpro:8080/v1",
          sourceSessionId: "sess_parent",
          createdAt: "2026-05-19T10:00:00Z",
        }),
        makeFact({
          id: "f2",
          subject: "mac-pro",
          predicate: "model",
          value: "qwen2.5-3b",
          sourceSessionId: "sess_parent",
          createdAt: "2026-05-19T10:05:00Z",
        }),
        makeFact({
          id: "f3",
          subject: "other",
          predicate: "framework",
          value: "Hono",
          sourceSessionId: "sess_parent",
        }),
      ]);
      await storage.facts.markSuperseded("f1", "f2");

      const current = await storage.facts.list({ subject: "mac-pro" });
      expect(current.map((f) => f.id)).toEqual(["f2"]);

      const all = await storage.facts.list({
        subject: "mac-pro",
        includeSuperseded: true,
      });
      expect(all.map((f) => f.id)).toEqual(["f2", "f1"]); // created_at DESC
    });

    it("list with predicate narrows further", async () => {
      await storage.facts.insertMany([
        makeFact({ id: "f1", subject: "x", predicate: "alpha", sourceSessionId: "sess_parent" }),
        makeFact({ id: "f2", subject: "x", predicate: "beta", sourceSessionId: "sess_parent" }),
      ]);
      const out = await storage.facts.list({ subject: "x", predicate: "beta" });
      expect(out.map((f) => f.id)).toEqual(["f2"]);
    });

    it("listBySession returns all facts (including superseded) for a session", async () => {
      await h.seedSession(storage, makeSession({ id: "sess_other" }));
      await storage.facts.insertMany([
        makeFact({ id: "f1", subject: "a", sourceSessionId: "sess_parent" }),
        makeFact({ id: "f2", subject: "b", sourceSessionId: "sess_parent" }),
        makeFact({ id: "f3", subject: "c", sourceSessionId: "sess_other" }),
      ]);
      await storage.facts.markSuperseded("f1", "f2");

      const out = await storage.facts.listBySession("sess_parent");
      expect(out.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
    });

    it("markSuperseded throws when either id is missing", async () => {
      await storage.facts.insert(makeFact({ id: "real", sourceSessionId: "sess_parent" }));
      await expect(storage.facts.markSuperseded("nope", "real")).rejects.toThrow(/not found/);
      await expect(storage.facts.markSuperseded("real", "nope")).rejects.toThrow(/not found/);
    });

    it("markSuperseded rejects self-supersedence", async () => {
      await storage.facts.insert(makeFact({ id: "self", sourceSessionId: "sess_parent" }));
      await expect(storage.facts.markSuperseded("self", "self")).rejects.toThrow(/itself/);
    });

    it("markSuperseded with null reverses an earlier supersedence", async () => {
      await storage.facts.insertMany([
        makeFact({ id: "a", subject: "s", predicate: "p", value: "v1", sourceSessionId: "sess_parent" }),
        makeFact({ id: "b", subject: "s", predicate: "p", value: "v2", sourceSessionId: "sess_parent" }),
      ]);
      await storage.facts.markSuperseded("a", "b");
      expect((await storage.facts.getById("a"))?.supersededBy).toBe("b");
      await storage.facts.markSuperseded("a", null);
      expect((await storage.facts.getById("a"))?.supersededBy).toBeNull();
    });

    it("CHECK constraints reject invalid kind", async () => {
      await expect(
        storage.facts.insert(
          // @ts-expect-error: exercising the CHECK constraint at runtime
          makeFact({ id: "bad", kind: "garbage", sourceSessionId: "sess_parent" }),
        ),
      ).rejects.toThrow();
    });

    it("CHECK constraints reject confidence out of [0, 1]", async () => {
      await expect(
        storage.facts.insert(
          makeFact({ id: "bad", confidence: 1.5, sourceSessionId: "sess_parent" }),
        ),
      ).rejects.toThrow();
    });

    it("FK constraint rejects facts pointing at missing sessions", async () => {
      await expect(
        storage.facts.insert(
          makeFact({ id: "orphan", sourceSessionId: "no_such_session" }),
        ),
      ).rejects.toThrow();
    });

    describe("listForRecall", () => {
      beforeEach(async () => {
        await storage.facts.insertMany([
          makeFact({
            id: "f_hono", subject: "nlm-memory-ts", predicate: "framework",
            value: "Hono", confidence: 0.9, sourceSessionId: "sess_parent",
          }),
          makeFact({
            id: "f_endpoint", kind: "attribute", subject: "mac-pro", predicate: "endpoint",
            value: "http://macpro:8080/v1", confidence: 0.85, sourceSessionId: "sess_parent",
          }),
          makeFact({
            id: "f_low", subject: "x", predicate: "other", value: "y",
            confidence: 0.5, sourceSessionId: "sess_parent",
          }),
          makeFact({
            id: "f_fastify", subject: "nlm-memory-ts", predicate: "framework",
            value: "Fastify", confidence: 0.9, sourceSessionId: "sess_parent",
          }),
        ]);
        await storage.facts.markSuperseded("f_fastify", "f_hono");
      });

      it("filters by subject + predicate, excluding superseded by default", async () => {
        const out = await storage.facts.listForRecall({
          subject: "nlm-memory-ts",
          predicate: "framework",
        });
        expect(out.map((f) => f.id)).toEqual(["f_hono"]);
      });

      it("applies minConfidence at the SQL layer", async () => {
        const all = await storage.facts.listForRecall({ minConfidence: 0 });
        expect(all.map((f) => f.id).sort()).toEqual(["f_endpoint", "f_hono", "f_low"]);
        const high = await storage.facts.listForRecall({ minConfidence: 0.8 });
        expect(high.map((f) => f.id).sort()).toEqual(["f_endpoint", "f_hono"]);
      });

      it("kind filter restricts the result set", async () => {
        const out = await storage.facts.listForRecall({ kind: "attribute" });
        expect(out.map((f) => f.id)).toEqual(["f_endpoint"]);
      });
    });

    describe("getHistory", () => {
      it("returns one chain per predicate when only subject is given", async () => {
        await storage.facts.insertMany([
          makeFact({
            id: "f1", subject: "s", predicate: "framework", value: "Fastify",
            sourceSessionId: "sess_parent", createdAt: "2026-05-18T00:00:00Z",
          }),
          makeFact({
            id: "f2", subject: "s", predicate: "framework", value: "Hono",
            sourceSessionId: "sess_parent", createdAt: "2026-05-19T00:00:00Z",
          }),
          makeFact({
            id: "f3", subject: "s", predicate: "endpoint", value: ":8080",
            sourceSessionId: "sess_parent", createdAt: "2026-05-19T00:00:00Z",
          }),
        ]);
        await storage.facts.markSuperseded("f1", "f2");

        const chains = await storage.facts.getHistory("s");
        expect(chains).toHaveLength(2);
        const framework = chains.find((c) => c.predicate === "framework");
        expect(framework?.history.map((f) => f.id)).toEqual(["f2", "f1"]);
        const endpoint = chains.find((c) => c.predicate === "endpoint");
        expect(endpoint?.history.map((f) => f.id)).toEqual(["f3"]);
      });

      it("narrows to a single chain when predicate is provided", async () => {
        await storage.facts.insertMany([
          makeFact({
            id: "a", subject: "s", predicate: "framework", value: "v1",
            sourceSessionId: "sess_parent", createdAt: "2026-05-18T00:00:00Z",
          }),
          makeFact({
            id: "b", subject: "s", predicate: "framework", value: "v2",
            sourceSessionId: "sess_parent", createdAt: "2026-05-19T00:00:00Z",
          }),
          makeFact({
            id: "c", subject: "s", predicate: "endpoint", value: ":8080",
            sourceSessionId: "sess_parent",
          }),
        ]);
        const chains = await storage.facts.getHistory("s", "framework");
        expect(chains).toHaveLength(1);
        expect(chains[0]?.history.map((f) => f.id)).toEqual(["b", "a"]);
      });

      it("returns empty array when no matches", async () => {
        const chains = await storage.facts.getHistory("nonexistent");
        expect(chains).toEqual([]);
      });
    });

    describe("corroborationCounts", () => {
      it("returns 0 for triples never asserted", async () => {
        const counts = await storage.facts.corroborationCounts([
          { subject: "x", predicate: "y", value: "z" },
        ]);
        expect(counts.get("x y z")).toBe(0);
      });

      it("counts a single assertion as 1", async () => {
        await storage.facts.insert(
          makeFact({
            id: "f1",
            subject: "polysignal",
            predicate: "uses",
            value: "duckdb",
            sourceSessionId: "sess_parent",
          }),
        );
        const counts = await storage.facts.corroborationCounts([
          { subject: "polysignal", predicate: "uses", value: "duckdb" },
        ]);
        expect(counts.get("polysignal uses duckdb")).toBe(1);
      });

      it("counts distinct sessions across the full history (including superseded)", async () => {
        await h.seedSession(storage, makeSession({ id: "sess_a", label: "A" }));
        await h.seedSession(storage, makeSession({ id: "sess_b", label: "B" }));
        await h.seedSession(storage, makeSession({ id: "sess_c", label: "C" }));
        await storage.facts.insertMany([
          makeFact({ id: "f_a", subject: "p", predicate: "u", value: "duckdb", sourceSessionId: "sess_a" }),
          makeFact({ id: "f_b", subject: "p", predicate: "u", value: "duckdb", sourceSessionId: "sess_b" }),
          makeFact({ id: "f_c", subject: "p", predicate: "u", value: "duckdb", sourceSessionId: "sess_c" }),
        ]);
        // Mark earlier ones as superseded — the contract is that they STILL count.
        await storage.facts.markSuperseded("f_a", "f_c");
        await storage.facts.markSuperseded("f_b", "f_c");
        const counts = await storage.facts.corroborationCounts([
          { subject: "p", predicate: "u", value: "duckdb" },
        ]);
        expect(counts.get("p u duckdb")).toBe(3);
      });

      it("does not double-count multiple facts from the same session", async () => {
        await storage.facts.insertMany([
          makeFact({ id: "f1", subject: "x", predicate: "y", value: "v", sourceSessionId: "sess_parent" }),
          makeFact({ id: "f2", subject: "x", predicate: "y", value: "v", sourceSessionId: "sess_parent" }),
        ]);
        const counts = await storage.facts.corroborationCounts([
          { subject: "x", predicate: "y", value: "v" },
        ]);
        // Distinct sessions, so 2 rows from one session = 1
        expect(counts.get("x y v")).toBe(1);
      });

      it("returns the empty map for empty input", async () => {
        const counts = await storage.facts.corroborationCounts([]);
        expect(counts.size).toBe(0);
      });

      it("batches multiple triples in a single call", async () => {
        await h.seedSession(storage, makeSession({ id: "sess_a", label: "A" }));
        await storage.facts.insertMany([
          makeFact({ id: "f1", subject: "x", predicate: "y", value: "a", sourceSessionId: "sess_parent" }),
          makeFact({ id: "f2", subject: "x", predicate: "y", value: "a", sourceSessionId: "sess_a" }),
          makeFact({ id: "f3", subject: "x", predicate: "y", value: "b", sourceSessionId: "sess_a" }),
        ]);
        const counts = await storage.facts.corroborationCounts([
          { subject: "x", predicate: "y", value: "a" },
          { subject: "x", predicate: "y", value: "b" },
          { subject: "x", predicate: "y", value: "never-asserted" },
        ]);
        expect(counts.get("x y a")).toBe(2);
        expect(counts.get("x y b")).toBe(1);
        expect(counts.get("x y never-asserted")).toBe(0);
      });
    });

    describe("semanticSearch", () => {
      it("returns nearest neighbors by L2 distance over fact_embeddings", async () => {
        await storage.facts.insertMany([
          makeFact({ id: "near", sourceSessionId: "sess_parent" }),
          makeFact({ id: "far", subject: "other", sourceSessionId: "sess_parent" }),
        ]);
        // Unit vectors: nearVec aligned with query, farVec orthogonal. Use
        // ordering assertion only (distance, lower is better) so a PG
        // adapter with a different distance literal still passes.
        const near = new Float32Array(768);
        near[0] = 1;
        const far = new Float32Array(768);
        far[1] = 1;
        await storage.facts.upsertEmbedding("near", near);
        await storage.facts.upsertEmbedding("far", far);

        const query = new Float32Array(768);
        query[0] = 1;
        const neighbors = await storage.facts.semanticSearch(query, 5);
        expect(neighbors[0]?.factId).toBe("near");
        expect(neighbors[0]!.distance).toBeLessThan(neighbors[1]!.distance);
      });
    });

    describe("ingestSessionFacts", () => {
      it("inserts new facts attributed to the session", async () => {
        const f1 = makeFact({
          id: "f1",
          subject: "alpha",
          predicate: "color",
          value: "red",
          sourceSessionId: "sess_parent",
        });
        await storage.withTransaction((ctx) => {
          ctx.facts.ingestSessionFacts("sess_parent", [f1]);
        });
        const stored = await storage.facts.getById("f1");
        expect(stored?.value).toBe("red");
      });

      it("deletes prior facts for the same session before re-ingesting", async () => {
        const original = makeFact({
          id: "orig",
          subject: "alpha",
          predicate: "color",
          value: "red",
          sourceSessionId: "sess_parent",
        });
        await storage.withTransaction((ctx) => {
          ctx.facts.ingestSessionFacts("sess_parent", [original]);
        });
        const replacement = makeFact({
          id: "new",
          subject: "alpha",
          predicate: "color",
          value: "blue",
          sourceSessionId: "sess_parent",
        });
        await storage.withTransaction((ctx) => {
          ctx.facts.ingestSessionFacts("sess_parent", [replacement]);
        });
        expect(await storage.facts.getById("orig")).toBeNull();
        expect((await storage.facts.getById("new"))?.value).toBe("blue");
      });

      it("supersedes a current fact from another session on (subject,predicate) collision", async () => {
        await h.seedSession(storage, makeSession({ id: "sess_other", label: "Other" }));
        const older = makeFact({
          id: "older",
          subject: "alpha",
          predicate: "color",
          value: "red",
          sourceSessionId: "sess_other",
        });
        const newer = makeFact({
          id: "newer",
          subject: "alpha",
          predicate: "color",
          value: "blue",
          sourceSessionId: "sess_parent",
        });
        await storage.withTransaction((ctx) => {
          ctx.facts.ingestSessionFacts("sess_other", [older]);
        });
        await storage.withTransaction((ctx) => {
          ctx.facts.ingestSessionFacts("sess_parent", [newer]);
        });
        const olderFetched = await storage.facts.getById("older");
        expect(olderFetched?.supersededBy).toBe("newer");
        const current = await storage.facts.findCurrent("alpha", "color");
        expect(current?.id).toBe("newer");
      });

      it("is a no-op for empty fact array but still deletes prior session facts", async () => {
        const f = makeFact({
          id: "to-delete",
          subject: "alpha",
          predicate: "color",
          value: "red",
          sourceSessionId: "sess_parent",
        });
        await storage.withTransaction((ctx) => {
          ctx.facts.ingestSessionFacts("sess_parent", [f]);
        });
        await storage.withTransaction((ctx) => {
          ctx.facts.ingestSessionFacts("sess_parent", []);
        });
        expect(await storage.facts.getById("to-delete")).toBeNull();
      });
    });
  });
}

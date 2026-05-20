/**
 * SqliteFactStore — the canonical FactStore implementation, sharing the same
 * better-sqlite3 connection as SqliteSessionStore so session+facts ingest can
 * commit in one transaction (Section 5 of factstore-design.md).
 *
 * Constructor takes an already-opened, already-migrated Database handle from
 * SqliteSessionStore.rawDb(). It does not open its own connection. This is
 * the only way to get a single-writer SQLite to behave atomically across
 * both stores without WAL ordering surprises.
 *
 * Surface evolution:
 *   B.1 — insert, getById, findCurrent, list, listBySession, markSuperseded
 *   B.2 — insertManyInTxn (atomic session+facts ingest), embedding write helper
 *   B.3 — listForRecall (pre-filter for FactRecallService), semanticSearch,
 *         getHistory (supersedence chain inspection)
 *   B.4 — auto-supersedence on (subject, predicate) collision (deferred)
 */
export class SqliteFactStore {
    db;
    constructor(db) {
        this.db = db;
    }
    async insert(fact) {
        this.insertStmt().run(this.toRow(fact));
    }
    async insertMany(facts) {
        if (facts.length === 0)
            return;
        const stmt = this.insertStmt();
        const txn = this.db.transaction((rows) => {
            for (const row of rows)
                stmt.run(row);
        });
        txn(facts.map((f) => this.toRow(f)));
    }
    /**
     * Insert facts inside an already-open transaction (no own txn opened).
     * Callable only from code that has already begun a transaction on the same
     * connection — currently SqliteSessionStore.insertSession. Phase B.2: this
     * is how session+facts ingest commits atomically (Section 5 of the plan).
     */
    insertManyInTxn(facts) {
        if (facts.length === 0)
            return;
        const stmt = this.insertStmt();
        for (const f of facts)
            stmt.run(this.toRow(f));
    }
    async getById(id) {
        const row = this.db
            .prepare(`SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts WHERE id = ?`)
            .get(id);
        return row ? this.rowToFact(row) : null;
    }
    async findCurrent(subject, predicate) {
        const row = this.db
            .prepare(`SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE subject = ? AND predicate = ? AND superseded_by IS NULL
         ORDER BY created_at DESC
         LIMIT 1`)
            .get(subject, predicate);
        return row ? this.rowToFact(row) : null;
    }
    async list(query) {
        const limit = Math.max(1, Math.trunc(query.limit ?? 50));
        const includeSuperseded = query.includeSuperseded === true;
        const where = ["subject = ?"];
        const params = [query.subject];
        if (query.predicate !== undefined) {
            where.push("predicate = ?");
            params.push(query.predicate);
        }
        if (!includeSuperseded)
            where.push("superseded_by IS NULL");
        params.push(limit);
        const rows = this.db
            .prepare(`SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`)
            .all(...params);
        return rows.map((r) => this.rowToFact(r));
    }
    async listBySession(sessionId) {
        const rows = this.db
            .prepare(`SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE source_session_id = ?
         ORDER BY created_at ASC`)
            .all(sessionId);
        return rows.map((r) => this.rowToFact(r));
    }
    async listForRecall(filter) {
        const where = [];
        const params = [];
        if (filter.subject !== undefined) {
            where.push("subject = ?");
            params.push(filter.subject);
        }
        if (filter.predicate !== undefined) {
            where.push("predicate = ?");
            params.push(filter.predicate);
        }
        if (filter.kind !== undefined) {
            where.push("kind = ?");
            params.push(filter.kind);
        }
        if (filter.minConfidence !== undefined) {
            where.push("confidence >= ?");
            params.push(filter.minConfidence);
        }
        if (filter.includeSuperseded !== true) {
            where.push("superseded_by IS NULL");
        }
        const limit = Math.max(1, Math.trunc(filter.limit ?? 500));
        params.push(limit);
        const sql = `
      SELECT id, kind, subject, predicate, value, source_session_id,
             source_quote, created_at, superseded_by, confidence
      FROM facts
      ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `;
        const rows = this.db
            .prepare(sql)
            .all(...params);
        return rows.map((r) => this.rowToFact(r));
    }
    async semanticSearch(queryVector, limit) {
        const k = Math.max(1, Math.trunc(limit));
        const blob = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
        const rows = this.db
            .prepare(`
        SELECT fact_id, distance
        FROM fact_embeddings
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `)
            .all(blob, k);
        return rows.map((r) => ({ factId: r.fact_id, distance: r.distance }));
    }
    async getHistory(subject, predicate) {
        const sql = predicate
            ? `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE subject = ? AND predicate = ?
         ORDER BY predicate ASC, created_at DESC`
            : `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE subject = ?
         ORDER BY predicate ASC, created_at DESC`;
        const rows = predicate
            ? this.db.prepare(sql).all(subject, predicate)
            : this.db.prepare(sql).all(subject);
        const byPred = new Map();
        for (const r of rows) {
            const fact = this.rowToFact(r);
            const bucket = byPred.get(fact.predicate);
            if (bucket)
                bucket.push(fact);
            else
                byPred.set(fact.predicate, [fact]);
        }
        const chains = [];
        for (const [pred, history] of byPred.entries()) {
            chains.push({ subject, predicate: pred, history });
        }
        return chains;
    }
    /**
     * Insert (or replace) the embedding row for a fact. Best-effort: callers
     * trap embedder errors so an unreachable Ollama doesn't roll back ingest.
     * vec0 doesn't UPDATE, so this is a DELETE+INSERT pair.
     */
    upsertEmbedding(factId, vector) {
        const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        this.db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?").run(factId);
        this.db
            .prepare("INSERT INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)")
            .run(factId, blob);
    }
    async markSuperseded(oldId, newId) {
        if (newId !== null && oldId === newId) {
            throw new Error("A fact cannot supersede itself");
        }
        const txn = this.db.transaction(() => {
            const old = this.db
                .prepare("SELECT id FROM facts WHERE id = ?")
                .get(oldId);
            if (!old)
                throw new Error(`Fact ${oldId} not found`);
            if (newId !== null) {
                const next = this.db
                    .prepare("SELECT id FROM facts WHERE id = ?")
                    .get(newId);
                if (!next)
                    throw new Error(`Fact ${newId} not found`);
            }
            this.db
                .prepare("UPDATE facts SET superseded_by = ? WHERE id = ?")
                .run(newId, oldId);
        });
        txn();
    }
    insertStmt() {
        return this.db.prepare(`
      INSERT INTO facts (
        id, kind, subject, predicate, value, source_session_id,
        source_quote, created_at, superseded_by, confidence
      ) VALUES (
        @id, @kind, @subject, @predicate, @value, @source_session_id,
        @source_quote, @created_at, @superseded_by, @confidence
      )
    `);
    }
    toRow(fact) {
        return {
            id: fact.id,
            kind: fact.kind,
            subject: fact.subject,
            predicate: fact.predicate,
            value: fact.value,
            source_session_id: fact.sourceSessionId,
            source_quote: fact.sourceQuote,
            created_at: fact.createdAt,
            superseded_by: fact.supersededBy,
            confidence: fact.confidence,
        };
    }
    rowToFact(row) {
        return {
            id: row.id,
            kind: row.kind,
            subject: row.subject,
            predicate: row.predicate,
            value: row.value,
            sourceSessionId: row.source_session_id,
            sourceQuote: row.source_quote,
            createdAt: row.created_at,
            supersededBy: row.superseded_by,
            confidence: row.confidence,
        };
    }
}
//# sourceMappingURL=sqlite-fact-store.js.map
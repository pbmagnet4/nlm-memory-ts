/**
 * embed-backfill — re-embed every session in canonical.sqlite into the
 * chunk + max-pool index (session_embedding_chunks). Replaces the prior
 * one-vector-per-session backfill that wrote to session_embeddings.
 *
 * For each session: chunk (label + summary + body) via chunkSessionText,
 * embed each chunk with kind="document", and write to the chunk table +
 * session_chunk_map via the same INSERT pair used by the live ingest path.
 *
 * Resumable via a JSON state file at $NLM_EMBED_STATE (default
 * ~/.nlm/embed_reembed.state). Interrupting + rerunning skips already-done
 * session ids. A session is considered "done" only when ALL its chunks
 * embed successfully — partial sessions are retried on the next run.
 *
 * Layering: depends on the LLMClient port. SQLite touched directly via
 * better-sqlite3 because this is a one-shot operational tool, not a hot
 * path. Lives under core/ but is invoked from the CLI composition root.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { LLMUnreachableError } from "../../ports/llm-client.js";
import { chunkSessionText } from "../embedding/chunk-body.js";
const DEFAULT_STATE_PATH = join(homedir(), ".nlm", "embed_reembed.state");
const SAVE_EVERY = 25;
function loadState(path) {
    if (!existsSync(path))
        return new Set();
    try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        return new Set(data.done ?? []);
    }
    catch {
        return new Set();
    }
}
function saveState(path, done) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ done: [...done].sort() }));
}
export async function reembedCorpus(opts) {
    const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
    if (!existsSync(opts.dbPath)) {
        return { total: 0, processed: 0, succeeded: 0, failed: 0, skippedAlreadyDone: 0, dbMissing: true };
    }
    const db = new Database(opts.dbPath);
    sqliteVec.load(db);
    // Backfill every session with content; live ingest covers ongoing writes.
    // The state file dedupes across runs so partial completion resumes cleanly.
    const sql = "SELECT s.id, s.label, s.summary, s.body FROM sessions s " +
        "WHERE s.body IS NOT NULL OR s.summary IS NOT NULL OR s.label IS NOT NULL " +
        "ORDER BY s.started_at" +
        (opts.limit ? ` LIMIT ${Math.trunc(opts.limit)}` : "");
    const rows = db.prepare(sql).all();
    const total = rows.length;
    const done = loadState(statePath);
    const selectChunks = db.prepare("SELECT chunk_id FROM session_chunk_map WHERE session_id = ?");
    const delChunks = (sessionId) => {
        const existing = selectChunks.all(sessionId);
        if (existing.length === 0)
            return;
        const placeholders = existing.map(() => "?").join(",");
        const ids = existing.map((r) => r.chunk_id);
        db.prepare(`DELETE FROM session_embedding_chunks WHERE chunk_id IN (${placeholders})`).run(...ids);
        db.prepare("DELETE FROM session_chunk_map WHERE session_id = ?").run(sessionId);
    };
    const insChunk = db.prepare("INSERT INTO session_embedding_chunks (embedding, session_id, chunk_idx) VALUES (?, ?, ?)");
    const insMap = db.prepare("INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES (?, ?, ?)");
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    try {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const idx = i + 1;
            if (done.has(row.id)) {
                skipped += 1;
                continue;
            }
            const chunks = chunkSessionText({
                label: row.label,
                summary: row.summary,
                body: row.body,
            });
            if (chunks.length === 0) {
                failed += 1;
                opts.onProgress?.(idx, total, row.id, "SKIP (no text)");
                continue;
            }
            // Embed all chunks before mutating the DB. A partial run leaves the
            // session id off the done-set, so the next run retries it whole.
            const vectors = [];
            let embedFailed = false;
            for (const chunk of chunks) {
                try {
                    const out = await opts.embedder.embed(chunk, "document");
                    vectors.push(out.vector);
                }
                catch (e) {
                    if (!(e instanceof LLMUnreachableError))
                        throw e;
                    embedFailed = true;
                    break;
                }
            }
            if (embedFailed) {
                failed += 1;
                opts.onProgress?.(idx, total, row.id, "FAIL (embedder)");
                continue;
            }
            try {
                delChunks(row.id);
                for (let c = 0; c < vectors.length; c++) {
                    const vec = vectors[c];
                    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
                    const info = insChunk.run(blob, row.id, c);
                    insMap.run(Number(info.lastInsertRowid), row.id, c);
                }
            }
            catch {
                failed += 1;
                opts.onProgress?.(idx, total, row.id, "FAIL (db)");
                continue;
            }
            done.add(row.id);
            succeeded += 1;
            opts.onProgress?.(idx, total, row.id, `OK (${vectors.length} chunks)`);
            if (succeeded % SAVE_EVERY === 0)
                saveState(statePath, done);
        }
        saveState(statePath, done);
    }
    finally {
        db.close();
    }
    return {
        total,
        processed: succeeded + failed + skipped,
        succeeded,
        failed,
        skippedAlreadyDone: skipped,
        dbMissing: false,
    };
}
export function clearBackfillState(statePath = DEFAULT_STATE_PATH) {
    if (existsSync(statePath)) {
        const { unlinkSync } = require("node:fs");
        unlinkSync(statePath);
    }
}
//# sourceMappingURL=embed-backfill.js.map
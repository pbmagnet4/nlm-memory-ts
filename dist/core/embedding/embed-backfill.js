/**
 * embed-backfill — re-embed every session in canonical.sqlite with the
 * document prefix + L2-normalized vectors. Ports `embed_reembed.py`.
 *
 * Pre-nomic-prefix vectors live alongside new ones in session_embeddings,
 * so the embedding space is inconsistent. This module reads each session's
 * (label + summary + body[:4000]) text, calls embedder.embed(kind="document"),
 * and replaces the old vector via DELETE + INSERT (vec0 doesn't support
 * UPDATE on the vector column).
 *
 * Resumable via a JSON state file at $NLM_EMBED_STATE (default
 * ~/.nlm/embed_reembed.state). Interrupting + rerunning skips already-done
 * session ids.
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
const DEFAULT_BODY_CHARS = 4_000;
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
function buildSessionText(row, bodyChars) {
    const parts = [
        row.label ?? "",
        row.summary ?? "",
        (row.body ?? "").slice(0, bodyChars),
    ].filter((s) => s.length > 0);
    return parts.join(" ").trim();
}
export async function reembedCorpus(opts) {
    const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
    const bodyChars = opts.bodyChars ?? DEFAULT_BODY_CHARS;
    if (!existsSync(opts.dbPath)) {
        return { total: 0, processed: 0, succeeded: 0, failed: 0, skippedAlreadyDone: 0, dbMissing: true };
    }
    const db = new Database(opts.dbPath);
    sqliteVec.load(db);
    const sql = "SELECT s.id, s.label, s.summary, s.body FROM sessions s " +
        "WHERE EXISTS (SELECT 1 FROM session_embeddings e WHERE e.session_id = s.id) " +
        "ORDER BY s.started_at" +
        (opts.limit ? ` LIMIT ${Math.trunc(opts.limit)}` : "");
    const rows = db.prepare(sql).all();
    const total = rows.length;
    const done = loadState(statePath);
    const del = db.prepare("DELETE FROM session_embeddings WHERE session_id = ?");
    const ins = db.prepare("INSERT INTO session_embeddings (session_id, embedding) VALUES (?, ?)");
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
            const text = buildSessionText(row, bodyChars);
            if (!text) {
                failed += 1;
                opts.onProgress?.(idx, total, row.id, "SKIP (no text)");
                continue;
            }
            let vec;
            try {
                const out = await opts.embedder.embed(text, "document");
                vec = out.vector;
            }
            catch (e) {
                if (!(e instanceof LLMUnreachableError))
                    throw e;
                failed += 1;
                opts.onProgress?.(idx, total, row.id, "FAIL (embedder)");
                continue;
            }
            try {
                const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
                del.run(row.id);
                ins.run(row.id, blob);
            }
            catch {
                failed += 1;
                opts.onProgress?.(idx, total, row.id, "FAIL (db)");
                continue;
            }
            done.add(row.id);
            succeeded += 1;
            opts.onProgress?.(idx, total, row.id, "OK");
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
/**
 * embed-normalize — one-shot migration: L2-normalize every row in
 * session_embeddings. Ports `embed_normalize.py`.
 *
 * vec0 with implicit L2 distance ranks correctly by cosine similarity
 * only when stored vectors are unit-length. New writes (post-this-fix)
 * are normalized at source by OllamaClient.embed; this module brings
 * existing rows to the same invariant.
 *
 * Idempotent: re-running on already-normalized vectors is a no-op
 * within float tolerance (EPS = 1e-3). Each row is rewritten in its
 * own transaction so interrupts are safe.
 */
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
const EPS = 1e-3;
const DEFAULT_DIM = 768;
const DEFAULT_BATCH = 100;
function bytesToFloats(buf, dim) {
    if (buf.byteLength !== dim * 4) {
        throw new Error(`expected ${dim * 4} bytes, got ${buf.byteLength}`);
    }
    return new Float32Array(buf.buffer, buf.byteOffset, dim);
}
function floatsToBytes(vec) {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
export function normalizeEmbeddings(opts) {
    const dim = opts.dim ?? DEFAULT_DIM;
    const batchSize = opts.batchSize ?? DEFAULT_BATCH;
    const dryRun = opts.dryRun ?? false;
    if (!existsSync(opts.dbPath)) {
        return { total: 0, alreadyNormalized: 0, rewritten: 0, zeroVector: 0, dbMissing: true, dryRun };
    }
    const db = new Database(opts.dbPath);
    sqliteVec.load(db);
    let total = 0;
    let alreadyNormalized = 0;
    let rewritten = 0;
    let zeroVector = 0;
    try {
        const ids = db
            .prepare("SELECT session_id FROM session_embeddings")
            .all()
            .map((r) => r.session_id);
        total = ids.length;
        const sel = db.prepare("SELECT session_id, embedding FROM session_embeddings WHERE session_id = ?");
        const del = db.prepare("DELETE FROM session_embeddings WHERE session_id = ?");
        const ins = db.prepare("INSERT INTO session_embeddings (session_id, embedding) VALUES (?, ?)");
        for (let start = 0; start < total; start += batchSize) {
            const batch = ids.slice(start, start + batchSize);
            for (const sid of batch) {
                const row = sel.get(sid);
                if (!row)
                    continue;
                const vec = bytesToFloats(row.embedding, dim);
                let sumSq = 0;
                for (let i = 0; i < dim; i++) {
                    const v = vec[i] ?? 0;
                    sumSq += v * v;
                }
                if (sumSq === 0) {
                    zeroVector += 1;
                    continue;
                }
                const norm = Math.sqrt(sumSq);
                if (Math.abs(norm - 1) <= EPS) {
                    alreadyNormalized += 1;
                    continue;
                }
                if (dryRun) {
                    rewritten += 1;
                    continue;
                }
                const normalized = new Float32Array(dim);
                for (let i = 0; i < dim; i++) {
                    normalized[i] = (vec[i] ?? 0) / norm;
                }
                del.run(sid);
                ins.run(sid, floatsToBytes(normalized));
                rewritten += 1;
            }
        }
    }
    finally {
        db.close();
    }
    return {
        total,
        alreadyNormalized,
        rewritten,
        zeroVector,
        dbMissing: false,
        dryRun,
    };
}
//# sourceMappingURL=embed-normalize.js.map
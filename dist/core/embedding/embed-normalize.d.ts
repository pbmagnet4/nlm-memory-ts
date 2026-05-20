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
export interface NormalizeOptions {
    readonly dbPath: string;
    readonly dim?: number;
    readonly batchSize?: number;
    readonly dryRun?: boolean;
}
export interface NormalizeReport {
    readonly total: number;
    readonly alreadyNormalized: number;
    readonly rewritten: number;
    readonly zeroVector: number;
    readonly dbMissing: boolean;
    readonly dryRun: boolean;
}
export declare function normalizeEmbeddings(opts: NormalizeOptions): NormalizeReport;

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
import type { LLMClient } from "../../ports/llm-client.js";
export interface BackfillOptions {
    readonly dbPath: string;
    readonly embedder: LLMClient;
    readonly statePath?: string;
    readonly limit?: number;
    readonly onProgress?: (i: number, total: number, sid: string, status: string) => void;
}
export interface BackfillReport {
    readonly total: number;
    readonly processed: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly skippedAlreadyDone: number;
    readonly dbMissing: boolean;
}
export declare function reembedCorpus(opts: BackfillOptions): Promise<BackfillReport>;
export declare function clearBackfillState(statePath?: string): void;

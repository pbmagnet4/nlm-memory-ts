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
import type { LLMClient } from "../../ports/llm-client.js";
export interface BackfillOptions {
    readonly dbPath: string;
    readonly embedder: LLMClient;
    readonly statePath?: string;
    readonly limit?: number;
    readonly bodyChars?: number;
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

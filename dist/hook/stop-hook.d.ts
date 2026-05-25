/**
 * Claude Code Stop hook entrypoint for NLM.
 *
 * Fires after the model finishes a response. Scans the last assistant message
 * in the transcript for substrings matching any session ID the recall hook
 * surfaced this conversation (via the dedup memo). Each match becomes a
 * citation event posted to the daemon at POST /api/recall/cite-event.
 *
 * Double duty:
 *  - Per-recall useful_hit_rate metric (was the returned ID actually used?)
 *  - Training-data substrate for a learned reranker (was_cited per query)
 *
 * Fail-open by design: any error yields a clean exit with no output. The
 * Stop hook can never block Claude Code's response. The smoke test path
 * succeeds even with missing transcript_path because the hook always logs
 * a `kind:"stop"` line.
 */
export interface StopHookInput {
    readonly conversationId: string;
    readonly transcriptPath: string;
    readonly stopHookActive: boolean;
}
export interface StopHookResult {
    readonly conversationId: string;
    readonly surfacedCount: number;
    readonly citedIds: ReadonlyArray<string>;
    readonly responsePreview: string;
    readonly skipped: boolean;
}
export interface RunStopHookDeps {
    readonly postCitation: (conversationId: string, citedId: string, responsePreview: string) => Promise<void>;
}
export declare function runStopHook(input: StopHookInput, deps: RunStopHookDeps): Promise<StopHookResult>;

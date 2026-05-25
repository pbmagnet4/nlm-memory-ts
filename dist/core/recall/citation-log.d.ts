/**
 * Append-only JSONL citation log. One line per (conversationId, citedId)
 * that the Stop hook detected. This is the training-data substrate for the
 * future learned reranker: each row is a (query, returned_id, was_cited)
 * triple once joined against ~/.nlm/query_log.jsonl by conversationId.
 *
 * Path defaults to ~/.nlm/citation-log.jsonl, overridable via
 * NLM_CITATION_LOG. Telemetry path — never raises.
 */
export interface CitationEntry {
    readonly conversationId: string;
    readonly citedId: string;
    readonly responsePreview?: string;
}
export interface CitationStats {
    readonly days: number;
    readonly total: number;
    readonly distinct_ids: number;
    readonly top_ids: ReadonlyArray<{
        readonly id: string;
        readonly count: number;
    }>;
    readonly log_present: boolean;
}
export declare function appendCitation(entry: CitationEntry, logPath?: string): Promise<void>;
export declare function citationStats(days: number, logPath?: string): Promise<CitationStats>;

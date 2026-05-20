/**
 * Hermes adapter.
 *
 * Reads ~/.hermes/sessions/*.json files. Two file shapes coexist:
 *
 *   session_<date>_<id>.json     — live session format
 *     { session_id, model, session_start, last_updated, messages: [...] }
 *
 *   request_dump_<date>_<id>_<date>_<time>.json  — error-dump format
 *     { timestamp, session_id, request: { body: { messages: [...] } } }
 *
 * Discovery dedupes by `session_id`: when both shapes exist for the same
 * session (failure case), the live `session_` file wins because it carries
 * richer metadata.
 */
import type { DetectionResult, DiscoverOptions, SessionChunk, TranscriptAdapter } from "../../ports/transcript-adapter.js";
export interface HermesAdapterOptions {
    readonly sessionsPath?: string;
    readonly idleMinutes?: number;
}
export declare class HermesAdapter implements TranscriptAdapter {
    readonly name = "hermes";
    readonly runtimeVersion = "hermes/1.0";
    readonly transcriptKind = "hermes-json";
    private readonly sessionsPath;
    readonly idleMinutes: number;
    constructor(opts?: HermesAdapterOptions);
    detect(): DetectionResult;
    discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;
    parseSession(path: string): Promise<SessionChunk | null>;
}

/**
 * Adapter factory — instantiates a TranscriptAdapter for a SourceRow.
 *
 * The three legacy preset kinds (claude-code, hermes, pi) stay as their
 * own classes; this factory just injects the path from the registry row.
 * The `jsonl-generic` kind delegates to JsonlGenericAdapter with the row's
 * parseConfig. `webhook` returns null — push-based ingest doesn't poll.
 */
import type { TranscriptAdapter } from "../../ports/transcript-adapter.js";
import type { SourceRow } from "../sources/source-registry.js";
export declare function adapterFromSource(source: SourceRow): TranscriptAdapter | null;

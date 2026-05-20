/**
 * TranscriptAdapter — the port every runtime-specific reader implements.
 *
 * One adapter per AI runtime (claude-code, hermes, pi, codex, gemini, aider).
 * Adapters discover transcript files on disk and parse one into a normalized
 * SessionChunk that the classifier/ingest pipeline can hand off to the
 * SessionStore. Adapters do not touch storage; they convert "files on disk"
 * into "candidate sessions" and stop there.
 *
 * Layering: core/recall consumes Session (already-classified). This port
 * lives between raw transcripts and the classifier — invoked by the
 * Scheduler in Phase D.
 */
export {};
//# sourceMappingURL=transcript-adapter.js.map
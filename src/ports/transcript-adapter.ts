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

export interface DetectionResult {
  readonly adapterName: string;
  readonly enabled: boolean;
  readonly path: string | null;
  readonly hint: string | null;
}

export interface SessionChunk {
  readonly id: string;
  readonly runtime: string;
  readonly runtimeSessionId: string;
  readonly sourcePath: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMin: number;
  readonly turnCount: number;
  readonly byteRange: readonly [number, number];
  readonly projectDir: string;
  readonly gitBranch: string;
  readonly text: string;
  readonly label: string;
}

export interface DiscoverOptions {
  readonly since?: Date;
}

export interface TranscriptAdapter {
  readonly name: string;
  readonly runtimeVersion: string;
  readonly transcriptKind: string;

  /** Detection: is this adapter usable on this host? */
  detect(): DetectionResult;

  /** List candidate transcript files, optionally filtered by mtime. */
  discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>>;

  /** Parse one transcript into a SessionChunk, or null if it's empty/garbage. */
  parseSession(path: string): Promise<SessionChunk | null>;
}

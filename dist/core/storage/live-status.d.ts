/**
 * live-status — derive the three-tier session status (active / idle / closed)
 * from a transcript file's mtime. Mirrors the Python daemon's
 * live_session_status(): explicit supersedence wins; missing file → closed;
 * otherwise bucketed by age.
 *
 * Thresholds match Python exactly:
 *   < 15 min       → active
 *   15 min – 24 h  → idle
 *   ≥ 24 h         → closed
 *
 * Pure function over filesystem mtime. Tested with synthetic file ages.
 */
import type { SessionStatus } from "../../shared/types.js";
export declare function liveSessionStatus(transcriptPath: string | null, persistedStatus: SessionStatus | "active" | "closed" | "superseded", now?: number): SessionStatus;

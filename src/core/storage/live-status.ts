/**
 * live-status — derive the three-tier session status (active / idle / closed)
 * from a transcript file's mtime. Mirrors the Python daemon's
 * live_session_status(): explicit supersedence/replacement wins; missing
 * file → closed; otherwise bucketed by age. A replaced session still has a
 * live transcript (it was re-ingested under a new id), so its persisted
 * status must short-circuit mtime bucketing the same way superseded does.
 *
 * Thresholds match Python exactly:
 *   < 15 min       → active
 *   15 min – 24 h  → idle
 *   ≥ 24 h         → closed
 *
 * Pure function over filesystem mtime. Tested with synthetic file ages.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionStatus } from "@shared/types.js";

const ACTIVE_THRESHOLD_MS = 15 * 60 * 1000;
const IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function liveSessionStatus(
  transcriptPath: string | null,
  persistedStatus: SessionStatus,
  now: number = Date.now(),
): SessionStatus {
  if (persistedStatus === "superseded") return "superseded";
  if (persistedStatus === "replaced") return "replaced";
  if (!transcriptPath) return "closed";
  try {
    const expanded = expandHome(transcriptPath);
    const st = statSync(expanded);
    const ageMs = now - st.mtimeMs;
    if (ageMs < ACTIVE_THRESHOLD_MS) return "active";
    if (ageMs < IDLE_THRESHOLD_MS) return "idle";
    return "closed";
  } catch {
    return "closed";
  }
}

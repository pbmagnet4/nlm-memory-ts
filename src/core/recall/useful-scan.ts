/**
 * Batch scanner for the useful_hit_rate metric.
 *
 * Joins hook-log.jsonl (recall events) against Claude Code conversation
 * transcripts, writes one useful-hit-log.jsonl entry per recall event,
 * and returns aggregate counts.
 *
 * A recall is "useful" when ≥1 of the surfaced session IDs appears in the
 * text or tool_use inputs of the next NEXT_TURNS_LIMIT assistant turns after
 * the hook fired. Entries with no matching transcript get useful=null
 * (unmeasurable).
 *
 * Probe entries (promptPreview matching PROBE_PATTERNS) are excluded from
 * the scan to keep the metric clean.
 */

import { readFile, appendFile, stat, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const NEXT_TURNS_LIMIT = 3;

const PROBE_PATTERNS = [
  /concurrency probe/i,
  /test probe/i,
  /path test/i,
  /recall test/i,
  /smoke/i,
  /cutover/i,
];

export interface UsefulHitEntry {
  readonly ts: string;
  readonly source: "hook";
  readonly conversationId: string;
  readonly returnedIds: ReadonlyArray<string>;
  readonly useful: boolean | null;
  readonly matchedId: string | null;
  readonly scannedAt: string;
}

export interface ScanResult {
  readonly total: number;
  readonly measurable: number;
  readonly useful: number;
  readonly appended: number;
}

export function defaultUsefulHitLogPath(): string {
  return process.env["NLM_USEFUL_HIT_LOG"] ?? join(homedir(), ".nlm", "useful-hit-log.jsonl");
}

function defaultHookLogPath(): string {
  return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}

function defaultTranscriptsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function isProbe(promptPreview: string): boolean {
  return PROBE_PATTERNS.some((re) => re.test(promptPreview));
}

async function findTranscriptPath(
  conversationId: string,
  transcriptsDir: string,
): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(transcriptsDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const candidate = join(transcriptsDir, name, `${conversationId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read assistant turns from a Claude Code transcript JSONL that have a
 * timestamp >= afterTs. Returns up to `limit` turns, each as a single
 * concatenated string of text + serialized tool_use inputs.
 */
export function extractAssistantTurnsAfter(
  transcriptPath: string,
  afterTs: number,
  limit: number,
): ReadonlyArray<string> {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const turns: string[] = [];
  let pastCutoff = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!pastCutoff) {
      const tsRaw = entry["timestamp"];
      if (typeof tsRaw === "string") {
        const ts = Date.parse(tsRaw);
        if (Number.isFinite(ts) && ts >= afterTs) pastCutoff = true;
      }
      if (!pastCutoff) continue;
    }
    if (entry["type"] !== "assistant") continue;
    const message = entry["message"] as Record<string, unknown> | undefined;
    if (!message) continue;
    const content = message["content"];
    const parts: string[] = [];
    if (typeof content === "string") {
      if (content) parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block["type"] === "text" && typeof block["text"] === "string") {
          parts.push(block["text"] as string);
        } else if (block["type"] === "tool_use") {
          parts.push(JSON.stringify(block["input"]));
        }
      }
    }
    if (parts.length > 0) {
      turns.push(parts.join(" "));
      if (turns.length >= limit) break;
    }
  }
  return turns;
}

export function findMatchedId(
  ids: ReadonlyArray<string>,
  turns: ReadonlyArray<string>,
): string | null {
  const haystack = turns.join(" ");
  for (const id of ids) {
    if (haystack.includes(id)) return id;
  }
  return null;
}

interface HookRecallEntry {
  readonly ts: string;
  readonly conversationId: string;
  readonly promptPreview: string;
  readonly wouldInject: ReadonlyArray<string>;
}

async function readHookRecalls(
  hookLogPath: string,
  cutoff: number,
): Promise<HookRecallEntry[]> {
  let raw: string;
  try {
    raw = await readFile(hookLogPath, "utf8");
  } catch {
    return [];
  }
  const results: HookRecallEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Skip stop-hook entries (they have a "kind" field)
    if (typeof entry["kind"] === "string") continue;
    const ts = typeof entry["ts"] === "string" ? entry["ts"] : null;
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs) || tsMs < cutoff) continue;
    const wouldInject = Array.isArray(entry["wouldInject"])
      ? (entry["wouldInject"] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (wouldInject.length === 0) continue;
    const conversationId =
      typeof entry["conversationId"] === "string" ? entry["conversationId"] : null;
    if (!conversationId) continue;
    const promptPreview =
      typeof entry["promptPreview"] === "string" ? entry["promptPreview"] : "";
    if (isProbe(promptPreview)) continue;
    results.push({ ts, conversationId, promptPreview, wouldInject });
  }
  return results;
}

async function readScannedKeys(usefulHitLogPath: string): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    await stat(usefulHitLogPath);
  } catch {
    return seen;
  }
  let raw: string;
  try {
    raw = await readFile(usefulHitLogPath, "utf8");
  } catch {
    return seen;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof entry["ts"] === "string" ? entry["ts"] : null;
    const convId = typeof entry["conversationId"] === "string" ? entry["conversationId"] : null;
    if (ts && convId) seen.add(`${ts}:${convId}`);
  }
  return seen;
}

export async function scanUsefulHits(opts: {
  days?: number;
  hookLogPath?: string;
  usefulHitLogPath?: string;
  transcriptsDir?: string;
  dryRun?: boolean;
}): Promise<ScanResult> {
  const days = opts.days ?? 1;
  const hookLogPath = opts.hookLogPath ?? defaultHookLogPath();
  const usefulHitLogPath = opts.usefulHitLogPath ?? defaultUsefulHitLogPath();
  const transcriptsDir = opts.transcriptsDir ?? defaultTranscriptsDir();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const recalls = await readHookRecalls(hookLogPath, cutoff);
  const scannedKeys = await readScannedKeys(usefulHitLogPath);

  let total = 0;
  let measurable = 0;
  let useful = 0;
  const newEntries: UsefulHitEntry[] = [];

  for (const recall of recalls) {
    total += 1;
    const key = `${recall.ts}:${recall.conversationId}`;
    if (scannedKeys.has(key)) continue;

    const transcriptPath = await findTranscriptPath(recall.conversationId, transcriptsDir);
    const hookTs = Date.parse(recall.ts);

    let usefulVal: boolean | null = null;
    let matchedId: string | null = null;

    if (transcriptPath !== null && Number.isFinite(hookTs)) {
      const turns = extractAssistantTurnsAfter(transcriptPath, hookTs, NEXT_TURNS_LIMIT);
      if (turns.length > 0) {
        measurable += 1;
        matchedId = findMatchedId(recall.wouldInject, turns);
        usefulVal = matchedId !== null;
        if (usefulVal) useful += 1;
      }
    }

    newEntries.push({
      ts: recall.ts,
      source: "hook",
      conversationId: recall.conversationId,
      returnedIds: recall.wouldInject,
      useful: usefulVal,
      matchedId,
      scannedAt: new Date().toISOString(),
    });
  }

  if (!opts.dryRun && newEntries.length > 0) {
    await mkdir(dirname(usefulHitLogPath), { recursive: true });
    await appendFile(
      usefulHitLogPath,
      newEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
  }

  return { total, measurable, useful, appended: opts.dryRun ? 0 : newEntries.length };
}

/**
 * Compute useful_hit_rate from an existing useful-hit-log.jsonl over a
 * rolling window. Returns null if the log is absent or has no measurable
 * entries in the window.
 */
export async function readUsefulHitRate(
  usefulHitLogPath: string = defaultUsefulHitLogPath(),
  days: number = 1,
): Promise<number | null> {
  try {
    await stat(usefulHitLogPath);
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(usefulHitLogPath, "utf8");
  } catch {
    return null;
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let measurable = 0;
  let useful = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tsRaw = typeof entry["ts"] === "string" ? entry["ts"] : null;
    if (!tsRaw) continue;
    const ts = Date.parse(tsRaw);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    if (entry["useful"] === null || entry["useful"] === undefined) continue;
    measurable += 1;
    if (entry["useful"] === true) useful += 1;
  }
  return measurable === 0 ? null : Math.round((useful / measurable) * 1000) / 1000;
}

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isProbe,
  extractAssistantTurnsAfter,
  findMatchedId,
  scanUsefulHits,
  readUsefulHitRate,
} from "../../../src/core/recall/useful-scan.js";

// ── isProbe ──────────────────────────────────────────────────────────────────

describe("isProbe", () => {
  it("returns true for probe patterns", () => {
    expect(isProbe("concurrency probe round 2")).toBe(true);
    expect(isProbe("test probe")).toBe(true);
    expect(isProbe("path test for the hook")).toBe(true);
    expect(isProbe("recall test")).toBe(true);
    expect(isProbe("smoke test run")).toBe(true);
    expect(isProbe("cutover validation")).toBe(true);
  });

  it("returns false for normal prompts", () => {
    expect(isProbe("what did we decide about pgvector")).toBe(false);
    expect(isProbe("how should we implement the recall hook")).toBe(false);
    expect(isProbe("review the PR")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isProbe("SMOKE TEST")).toBe(true);
    expect(isProbe("Concurrency Probe")).toBe(true);
  });
});

// ── extractAssistantTurnsAfter ───────────────────────────────────────────────

function makeTranscript(
  lines: Array<{ type: string; timestamp: string; content?: string | Array<Record<string, unknown>> }>,
): string {
  return lines
    .map((l) => {
      const msg =
        l.type === "assistant"
          ? {
              type: "assistant",
              timestamp: l.timestamp,
              message: { content: l.content ?? "" },
            }
          : { type: l.type, timestamp: l.timestamp };
      return JSON.stringify(msg);
    })
    .join("\n");
}

describe("extractAssistantTurnsAfter", () => {
  it("returns empty for a missing file", () => {
    expect(extractAssistantTurnsAfter("/tmp/nlm-nonexistent-transcript.jsonl", 0, 3)).toEqual([]);
  });

  it("returns empty when no assistant turns exist after the cutoff", () => {
    const dir = tmpdir();
    const path = join(dir, `transcript-past-${Date.now()}.jsonl`);
    writeFileSync(
      path,
      makeTranscript([
        { type: "user", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", content: "answer" },
      ]),
    );
    // cutoff is after the assistant turn
    const cutoff = Date.parse("2026-01-01T00:00:02.000Z");
    expect(extractAssistantTurnsAfter(path, cutoff, 3)).toEqual([]);
  });

  it("returns up to `limit` assistant turns at or after the cutoff", () => {
    const dir = tmpdir();
    const path = join(dir, `transcript-limit-${Date.now()}.jsonl`);
    const ts = "2026-05-01T10:00:00.000Z";
    writeFileSync(
      path,
      makeTranscript([
        { type: "user", timestamp: "2026-05-01T09:59:59.000Z" },
        { type: "assistant", timestamp: ts, content: "turn-1" },
        { type: "user", timestamp: "2026-05-01T10:00:01.000Z" },
        { type: "assistant", timestamp: "2026-05-01T10:00:02.000Z", content: "turn-2" },
        { type: "user", timestamp: "2026-05-01T10:00:03.000Z" },
        { type: "assistant", timestamp: "2026-05-01T10:00:04.000Z", content: "turn-3" },
        { type: "user", timestamp: "2026-05-01T10:00:05.000Z" },
        { type: "assistant", timestamp: "2026-05-01T10:00:06.000Z", content: "turn-4" },
      ]),
    );
    const cutoff = Date.parse(ts);
    const turns = extractAssistantTurnsAfter(path, cutoff, 3);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain("turn-1");
    expect(turns[1]).toContain("turn-2");
    expect(turns[2]).toContain("turn-3");
  });

  it("extracts text from content-array turns (text + tool_use)", () => {
    const dir = tmpdir();
    const path = join(dir, `transcript-blocks-${Date.now()}.jsonl`);
    const ts = "2026-05-01T10:00:00.000Z";
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: "I looked it up." },
      { type: "tool_use", name: "mcp__nlm-memory__get_session", input: { id: "cc_sub_abc123" } },
    ];
    writeFileSync(
      path,
      JSON.stringify({ type: "assistant", timestamp: ts, message: { content } }) + "\n",
    );
    const turns = extractAssistantTurnsAfter(path, Date.parse(ts), 3);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("I looked it up.");
    expect(turns[0]).toContain("cc_sub_abc123");
  });

  it("skips malformed JSON lines without throwing", () => {
    const dir = tmpdir();
    const path = join(dir, `transcript-malformed-${Date.now()}.jsonl`);
    const ts = "2026-05-01T10:00:00.000Z";
    writeFileSync(
      path,
      "not json\n" +
        JSON.stringify({ type: "assistant", timestamp: ts, message: { content: "ok" } }) +
        "\n",
    );
    const turns = extractAssistantTurnsAfter(path, Date.parse(ts), 3);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("ok");
  });
});

// ── findMatchedId ────────────────────────────────────────────────────────────

describe("findMatchedId", () => {
  it("returns the first matching ID", () => {
    expect(findMatchedId(["cc_sub_abc", "cc_sub_def"], ["context cc_sub_abc here"])).toBe(
      "cc_sub_abc",
    );
  });

  it("returns null when no ID appears", () => {
    expect(findMatchedId(["cc_sub_abc"], ["completely unrelated text"])).toBeNull();
  });

  it("matches IDs inside tool_use serialized JSON", () => {
    const turns = [JSON.stringify({ id: "cc_sub_xyz123" })];
    expect(findMatchedId(["cc_sub_xyz123"], turns)).toBe("cc_sub_xyz123");
  });

  it("returns null for empty ids list", () => {
    expect(findMatchedId([], ["some text"])).toBeNull();
  });

  it("returns null for empty turns list", () => {
    expect(findMatchedId(["cc_sub_abc"], [])).toBeNull();
  });
});

// ── scanUsefulHits ───────────────────────────────────────────────────────────

function setupScanDirs(): { root: string; hookLogPath: string; usefulHitLogPath: string; transcriptsDir: string } {
  const root = join(tmpdir(), `nlm-scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const hookLogPath = join(root, "hook-log.jsonl");
  const usefulHitLogPath = join(root, "useful-hit-log.jsonl");
  const transcriptsDir = join(root, "projects");
  mkdirSync(transcriptsDir, { recursive: true });
  return { root, hookLogPath, usefulHitLogPath, transcriptsDir };
}

function writeTranscript(transcriptsDir: string, conversationId: string, content: string): void {
  const projectDir = join(transcriptsDir, "test-project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${conversationId}.jsonl`), content);
}

describe("scanUsefulHits", () => {
  it("returns zero totals when hook log is absent", async () => {
    const { root, hookLogPath, usefulHitLogPath, transcriptsDir } = setupScanDirs();
    const result = await scanUsefulHits({
      days: 1,
      hookLogPath,
      usefulHitLogPath,
      transcriptsDir,
      dryRun: true,
    });
    expect(result).toEqual({ total: 0, measurable: 0, useful: 0, appended: 0 });
    // suppress unused warning
    void root;
  });

  it("counts a useful hit when the ID appears in the next assistant turn", async () => {
    const { hookLogPath, usefulHitLogPath, transcriptsDir } = setupScanDirs();
    const convId = "test-conv-useful-hit";
    const hookTs = new Date().toISOString();
    const afterTs = new Date(Date.parse(hookTs) + 1000).toISOString();

    // Hook log entry with wouldInject
    writeFileSync(
      hookLogPath,
      JSON.stringify({
        ts: hookTs,
        conversationId: convId,
        promptPreview: "what did we decide about the schema",
        gate: "evaluate",
        hits: [{ id: "cc_sub_abc123def456", score: 1.2 }],
        wouldInject: ["cc_sub_abc123def456"],
        estTokens: 50,
        mode: "shadow",
      }) + "\n",
    );

    // Transcript with the ID appearing in the assistant turn after the hook
    writeTranscript(
      transcriptsDir,
      convId,
      JSON.stringify({ type: "user", timestamp: hookTs }) +
        "\n" +
        JSON.stringify({
          type: "assistant",
          timestamp: afterTs,
          message: { content: "Per cc_sub_abc123def456 we chose the new schema." },
        }) +
        "\n",
    );

    const result = await scanUsefulHits({
      days: 1,
      hookLogPath,
      usefulHitLogPath,
      transcriptsDir,
    });

    expect(result.total).toBe(1);
    expect(result.measurable).toBe(1);
    expect(result.useful).toBe(1);
    expect(result.appended).toBe(1);
  });

  it("records useful=false when the ID does not appear in subsequent turns", async () => {
    const { hookLogPath, usefulHitLogPath, transcriptsDir } = setupScanDirs();
    const convId = "test-conv-not-useful";
    const hookTs = new Date().toISOString();
    const afterTs = new Date(Date.parse(hookTs) + 1000).toISOString();

    writeFileSync(
      hookLogPath,
      JSON.stringify({
        ts: hookTs,
        conversationId: convId,
        promptPreview: "explain this code",
        gate: "evaluate",
        hits: [{ id: "cc_sub_zzz999", score: 0.8 }],
        wouldInject: ["cc_sub_zzz999"],
        estTokens: 30,
        mode: "shadow",
      }) + "\n",
    );

    writeTranscript(
      transcriptsDir,
      convId,
      JSON.stringify({ type: "user", timestamp: hookTs }) +
        "\n" +
        JSON.stringify({
          type: "assistant",
          timestamp: afterTs,
          message: { content: "Here is the explanation." },
        }) +
        "\n",
    );

    const result = await scanUsefulHits({
      days: 1,
      hookLogPath,
      usefulHitLogPath,
      transcriptsDir,
    });

    expect(result.useful).toBe(0);
    expect(result.measurable).toBe(1);

    // Verify the written entry has useful=false
    const { readFileSync } = await import("node:fs");
    const written = JSON.parse(readFileSync(usefulHitLogPath, "utf8").trim()) as Record<string, unknown>;
    expect(written["useful"]).toBe(false);
    expect(written["matchedId"]).toBeNull();
  });

  it("records useful=null when no transcript is found", async () => {
    const { hookLogPath, usefulHitLogPath, transcriptsDir } = setupScanDirs();
    const hookTs = new Date().toISOString();

    writeFileSync(
      hookLogPath,
      JSON.stringify({
        ts: hookTs,
        conversationId: "missing-conv-id-xyz",
        promptPreview: "what is the error",
        gate: "evaluate",
        hits: [{ id: "cc_sub_missing", score: 1.0 }],
        wouldInject: ["cc_sub_missing"],
        estTokens: 20,
        mode: "shadow",
      }) + "\n",
    );

    const result = await scanUsefulHits({
      days: 1,
      hookLogPath,
      usefulHitLogPath,
      transcriptsDir,
    });

    expect(result.measurable).toBe(0);
    expect(result.useful).toBe(0);

    const { readFileSync } = await import("node:fs");
    const written = JSON.parse(readFileSync(usefulHitLogPath, "utf8").trim()) as Record<string, unknown>;
    expect(written["useful"]).toBeNull();
  });

  it("skips probe entries", async () => {
    const { hookLogPath, usefulHitLogPath, transcriptsDir } = setupScanDirs();
    const hookTs = new Date().toISOString();

    writeFileSync(
      hookLogPath,
      JSON.stringify({
        ts: hookTs,
        conversationId: "probe-conv",
        promptPreview: "recall test round 3",
        gate: "evaluate",
        hits: [{ id: "cc_sub_probe", score: 1.0 }],
        wouldInject: ["cc_sub_probe"],
        estTokens: 10,
        mode: "shadow",
      }) + "\n",
    );

    const result = await scanUsefulHits({
      days: 1,
      hookLogPath,
      usefulHitLogPath,
      transcriptsDir,
    });

    expect(result.total).toBe(0);
  });

  it("skips entries with empty wouldInject", async () => {
    const { hookLogPath, usefulHitLogPath, transcriptsDir } = setupScanDirs();
    const hookTs = new Date().toISOString();

    writeFileSync(
      hookLogPath,
      JSON.stringify({
        ts: hookTs,
        conversationId: "conv-no-inject",
        promptPreview: "what is the status",
        gate: "generative",
        hits: [],
        wouldInject: [],
        estTokens: 0,
        mode: "shadow",
      }) + "\n",
    );

    const result = await scanUsefulHits({
      days: 1,
      hookLogPath,
      usefulHitLogPath,
      transcriptsDir,
    });

    expect(result.total).toBe(0);
  });

  it("skips stop-hook entries (kind field present)", async () => {
    const { hookLogPath, usefulHitLogPath, transcriptsDir } = setupScanDirs();
    const hookTs = new Date().toISOString();

    writeFileSync(
      hookLogPath,
      JSON.stringify({
        ts: hookTs,
        kind: "stop",
        conversationId: "conv-stop",
        surfacedCount: 2,
        citedIds: ["cc_sub_abc"],
        citationKinds: ["tool_use"],
        skipped: false,
        mode: "shadow",
      }) + "\n",
    );

    const result = await scanUsefulHits({
      days: 1,
      hookLogPath,
      usefulHitLogPath,
      transcriptsDir,
    });

    expect(result.total).toBe(0);
  });

  it("skips already-scanned entries on a second run", async () => {
    const { hookLogPath, usefulHitLogPath, transcriptsDir } = setupScanDirs();
    const convId = "conv-dedup";
    const hookTs = new Date().toISOString();
    const afterTs = new Date(Date.parse(hookTs) + 1000).toISOString();

    writeFileSync(
      hookLogPath,
      JSON.stringify({
        ts: hookTs,
        conversationId: convId,
        promptPreview: "help with recall",
        gate: "evaluate",
        hits: [{ id: "cc_sub_dedup123", score: 1.1 }],
        wouldInject: ["cc_sub_dedup123"],
        estTokens: 40,
        mode: "shadow",
      }) + "\n",
    );

    writeTranscript(
      transcriptsDir,
      convId,
      JSON.stringify({ type: "user", timestamp: hookTs }) +
        "\n" +
        JSON.stringify({
          type: "assistant",
          timestamp: afterTs,
          message: { content: "Used cc_sub_dedup123 for the answer." },
        }) +
        "\n",
    );

    const first = await scanUsefulHits({ days: 1, hookLogPath, usefulHitLogPath, transcriptsDir });
    expect(first.appended).toBe(1);

    const second = await scanUsefulHits({ days: 1, hookLogPath, usefulHitLogPath, transcriptsDir });
    expect(second.appended).toBe(0);
    expect(second.total).toBe(1);
  });

  it("does not write when dryRun=true", async () => {
    const { hookLogPath, usefulHitLogPath, transcriptsDir } = setupScanDirs();
    const hookTs = new Date().toISOString();

    writeFileSync(
      hookLogPath,
      JSON.stringify({
        ts: hookTs,
        conversationId: "dry-conv",
        promptPreview: "explain the bug",
        gate: "evaluate",
        hits: [{ id: "cc_sub_dry", score: 1.0 }],
        wouldInject: ["cc_sub_dry"],
        estTokens: 20,
        mode: "shadow",
      }) + "\n",
    );

    const result = await scanUsefulHits({
      days: 1,
      hookLogPath,
      usefulHitLogPath,
      transcriptsDir,
      dryRun: true,
    });

    expect(result.appended).toBe(0);
    expect(result.total).toBe(1);
    const { existsSync } = await import("node:fs");
    expect(existsSync(usefulHitLogPath)).toBe(false);
  });
});

// ── readUsefulHitRate ────────────────────────────────────────────────────────

describe("readUsefulHitRate", () => {
  it("returns null when the log file is absent", async () => {
    const path = join(tmpdir(), `nlm-no-useful-${Date.now()}.jsonl`);
    expect(await readUsefulHitRate(path, 1)).toBeNull();
  });

  it("returns null when all entries have useful=null (unmeasurable)", async () => {
    const path = join(tmpdir(), `nlm-useful-null-${Date.now()}.jsonl`);
    const ts = new Date().toISOString();
    writeFileSync(
      path,
      JSON.stringify({ ts, conversationId: "x", useful: null, returnedIds: [], source: "hook", matchedId: null, scannedAt: ts }) + "\n",
    );
    expect(await readUsefulHitRate(path, 1)).toBeNull();
  });

  it("computes the rate correctly from measurable entries", async () => {
    const path = join(tmpdir(), `nlm-useful-rate-${Date.now()}.jsonl`);
    const ts = new Date().toISOString();
    writeFileSync(
      path,
      [
        { ts, conversationId: "a", useful: true, returnedIds: ["cc_sub_1"], source: "hook", matchedId: "cc_sub_1", scannedAt: ts },
        { ts, conversationId: "b", useful: false, returnedIds: ["cc_sub_2"], source: "hook", matchedId: null, scannedAt: ts },
        { ts, conversationId: "c", useful: true, returnedIds: ["cc_sub_3"], source: "hook", matchedId: "cc_sub_3", scannedAt: ts },
        { ts, conversationId: "d", useful: null, returnedIds: ["cc_sub_4"], source: "hook", matchedId: null, scannedAt: ts },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    // 2 useful out of 3 measurable = 0.667
    expect(await readUsefulHitRate(path, 1)).toBeCloseTo(0.667, 2);
  });

  it("excludes entries outside the window", async () => {
    const path = join(tmpdir(), `nlm-useful-window-${Date.now()}.jsonl`);
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    writeFileSync(
      path,
      [
        { ts: old, conversationId: "old", useful: true, returnedIds: [], source: "hook", matchedId: "x", scannedAt: old },
        { ts: recent, conversationId: "new", useful: false, returnedIds: [], source: "hook", matchedId: null, scannedAt: recent },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    // Only the recent entry is in the 1-day window: 0/1 = 0.0
    expect(await readUsefulHitRate(path, 1)).toBe(0);
  });
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHookRecallLog } from "../../../../src/core/recall/hook-recall-log.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nlm-hook-recall-"));
  logPath = join(dir, "hook-log.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

describe("readHookRecallLog", () => {
  it("returns only recall entries with injected ids and a real conversationId", async () => {
    const lines = [
      // valid recall fire
      { ts: now(), conversationId: "conv_a", wouldInject: ["s1", "s2"], gate: "evaluate" },
      // unknown conversationId — dropped (can't join)
      { ts: now(), conversationId: "unknown", wouldInject: ["s3"], gate: "evaluate" },
      // empty injection — dropped
      { ts: now(), conversationId: "conv_b", wouldInject: [], gate: "evaluate" },
      // stop entry (no wouldInject) — dropped
      { ts: now(), kind: "stop", conversationId: "conv_a", citedIds: ["s1"] },
    ];
    writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const out = await readHookRecallLog(30, logPath);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ conversationId: "conv_a", injectedIds: ["s1", "s2"] });
  });

  it("respects the day cutoff", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      { ts: old, conversationId: "conv_old", wouldInject: ["s1"], gate: "evaluate" },
      { ts: now(), conversationId: "conv_new", wouldInject: ["s2"], gate: "evaluate" },
    ];
    writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const out = await readHookRecallLog(30, logPath);
    expect(out.map((e) => e.conversationId)).toEqual(["conv_new"]);
  });

  it("returns empty array when the file is missing", async () => {
    const out = await readHookRecallLog(30, join(dir, "nope.jsonl"));
    expect(out).toEqual([]);
  });

  it("skips corrupt lines", async () => {
    writeFileSync(
      logPath,
      `${JSON.stringify({ ts: now(), conversationId: "conv_a", wouldInject: ["s1"] })}\nnot json\n`,
      "utf8",
    );
    const out = await readHookRecallLog(30, logPath);
    expect(out).toHaveLength(1);
  });
});

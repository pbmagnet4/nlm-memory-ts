import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiAdapter } from "../../../../src/core/adapters/pi.js";

describe("PiAdapter nlm.signal recognition", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-sig-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("collects nlm.signal custom entries into chunk.signals and ignores other custom types", async () => {
    const file = join(dir, "sess.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "pi_abc", cwd: "/repo/x" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "do work", timestamp: "2026-06-09T18:00:00Z" } }),
      JSON.stringify({ type: "custom", customType: "nlm.signal", data: { kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/repo/x", detail: { step: "types" }, ts: "2026-06-09T18:01:00Z" } }),
      JSON.stringify({ type: "custom", customType: "whtnxt-tasks", data: { ignored: true } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "done", timestamp: "2026-06-09T18:02:00Z" } }),
    ];
    writeFileSync(file, lines.join("\n"));
    const chunk = await new PiAdapter({ sessionsPath: dir }).parseSession(file);
    expect(chunk).not.toBeNull();
    expect(chunk!.signals).toHaveLength(1);
    expect((chunk!.signals![0] as { kind?: string }).kind).toBe("gate");
  });

  it("leaves signals undefined when there are none", async () => {
    const file = join(dir, "plain.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session", id: "pi_x", cwd: "/r" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: "2026-06-09T18:00:00Z" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "yo", timestamp: "2026-06-09T18:00:05Z" } }),
    ].join("\n"));
    const chunk = await new PiAdapter({ sessionsPath: dir }).parseSession(file);
    expect(chunk!.signals).toBeUndefined();
  });
});

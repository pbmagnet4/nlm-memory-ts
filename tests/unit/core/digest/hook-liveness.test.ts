import { describe, it, expect } from "vitest";
import { checkHookLiveness } from "@core/digest/hook-liveness.js";

const TODAY = new Date("2026-05-30T08:00:00-05:00");
const YESTERDAY_MID = "2026-05-29T15:00:00-05:00";
const TWO_DAYS_AGO = "2026-05-28T10:00:00-05:00";

describe("checkHookLiveness", () => {
  it("returns null when no Claude Code sessions yesterday", () => {
    const alert = checkHookLiveness({
      sessions: [
        { runtime: "hermes", started_at: YESTERDAY_MID },
        { runtime: "claude-code", started_at: TWO_DAYS_AGO },
      ],
      hookLog: [],
      hookLogPath: "/tmp/hook-log.jsonl",
      hookLogExists: true,
      now: TODAY,
    });
    expect(alert).toBeNull();
  });

  it("returns null when claude-code ran and hook fired live yesterday", () => {
    const alert = checkHookLiveness({
      sessions: [{ runtime: "claude-code", started_at: YESTERDAY_MID }],
      hookLog: [
        { ts: YESTERDAY_MID, mode: "live" },
        { ts: YESTERDAY_MID, mode: "live" },
      ],
      hookLogPath: "/tmp/hook-log.jsonl",
      hookLogExists: true,
      now: TODAY,
    });
    expect(alert).toBeNull();
  });

  it("alerts when claude-code ran but no live hook fires yesterday", () => {
    const alert = checkHookLiveness({
      sessions: [{ runtime: "claude-code", started_at: YESTERDAY_MID }],
      hookLog: [
        { ts: YESTERDAY_MID, mode: "shadow" }, // shadow doesn't count
        { ts: TWO_DAYS_AGO, mode: "live" }, // wrong window
      ],
      hookLogPath: "/tmp/hook-log.jsonl",
      hookLogExists: true,
      now: TODAY,
    });
    expect(alert).toContain("WARN hook silent");
    expect(alert).toContain("nlm hook install");
  });

  it("alerts about missing log file when claude-code ran and log absent", () => {
    const alert = checkHookLiveness({
      sessions: [{ runtime: "claude-code", started_at: YESTERDAY_MID }],
      hookLog: [],
      hookLogPath: "/tmp/missing.jsonl",
      hookLogExists: false,
      now: TODAY,
    });
    expect(alert).toContain("log file missing at /tmp/missing.jsonl");
  });

  it("matches claude-code prefix variants (claude-code-bash, etc.)", () => {
    const alert = checkHookLiveness({
      sessions: [{ runtime: "claude-code-bash", started_at: YESTERDAY_MID }],
      hookLog: [],
      hookLogPath: "/tmp/hook-log.jsonl",
      hookLogExists: true,
      now: TODAY,
    });
    expect(alert).toContain("WARN hook silent");
  });
});

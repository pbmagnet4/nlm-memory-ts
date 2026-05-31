import { describe, it, expect } from "vitest";
import { composeDigest, isProbe } from "@core/digest/compose.js";

const FIXED_NOW = new Date("2026-05-30T07:00:00-05:00");

describe("isProbe", () => {
  it("matches the probe substrings case-insensitively", () => {
    expect(isProbe("Concurrency Probe baseline")).toBe(true);
    expect(isProbe("running smoke")).toBe(true);
    expect(isProbe("real user query about deployment")).toBe(false);
    expect(isProbe(null)).toBe(false);
    expect(isProbe(undefined)).toBe(false);
    expect(isProbe("")).toBe(false);
  });
});

describe("composeDigest", () => {
  const baseStats = {
    total: 100,
    hit_rate: 0.85,
    top_queries: [
      { query: "deployment plan", count: 12 },
      { query: "smoke run", count: 3 }, // probe
    ],
  };

  it("formats the digest with 24h slice and 7d totals", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [
        { ts: "2026-05-30T05:00:00Z", source: "claude-code", query: "deployment plan" },
        { ts: "2026-05-30T04:00:00Z", source: "claude-code", query: "deployment plan" },
        { ts: "2026-05-29T15:00:00Z", source: "hermes", query: "what's blocked" },
        { ts: "2026-05-29T14:00:00Z", source: "claude-code", query: "smoke test" }, // probe
        { ts: "2026-05-28T10:00:00Z", source: "claude-code", query: "old entry" }, // outside 24h
      ],
      port: 3940,
      hookAlert: null,
      now: FIXED_NOW,
    });

    expect(text).toContain("Last 24h (real traffic): 3 queries");
    expect(text).toContain("claude-code=2");
    expect(text).toContain("hermes=1");
    expect(text).toContain("Last 7d: 97 real / 100 total"); // 100 - 3 probes
    expect(text).toContain("hit_rate 85%");
    expect(text).toContain("1. deployment plan");
    expect(text).toContain("UI: http://localhost:3940/ui/");
  });

  it("renders (none) when no real 24h traffic", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [
        { ts: "2026-05-28T10:00:00Z", source: "claude-code", query: "old entry" },
      ],
      port: 3940,
      hookAlert: null,
      now: FIXED_NOW,
    });
    expect(text).toContain("Last 24h (real traffic): 0 queries · none");
    expect(text).toContain("  (none)");
  });

  it("prepends hook alert when supplied", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [],
      port: 3940,
      hookAlert: "WARN hook silent: 5 CC sessions, 0 fires",
      now: FIXED_NOW,
    });
    const alertIdx = text.indexOf("WARN hook silent");
    const trafficIdx = text.indexOf("Last 24h");
    expect(alertIdx).toBeGreaterThan(0);
    expect(alertIdx).toBeLessThan(trafficIdx);
  });

  it("truncates top queries longer than 60 chars", () => {
    const longQuery = "a".repeat(120);
    const text = composeDigest({
      stats: baseStats,
      recent: [
        { ts: "2026-05-30T05:00:00Z", source: "x", query: longQuery },
      ],
      port: 3940,
      hookAlert: null,
      now: FIXED_NOW,
    });
    expect(text).toContain(`1. ${"a".repeat(60)}\n`);
    expect(text).not.toContain("a".repeat(61));
  });
});

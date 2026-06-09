import { describe, expect, it } from "vitest";
import { buildFailureModeBlock, renderFailureMode } from "../../../../src/core/signals/failure-mode-recall.js";
import type { SignalStore } from "../../../../src/ports/signal-store.js";
import { makeSignal } from "../../../fixtures/signals.js";

function storeOf(signals = makeSignals()): SignalStore {
  return {
    async insert() {}, async insertMany() {}, async countSince() { return 0; }, async pruneOlderThan() { return 0; },
    async listForAggregation() { return signals; },
  };
}
function makeSignals() {
  return [
    ...Array.from({ length: 8 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail", step: "types", model: "qwen3-coder", repo: "/repo/x" })),
    ...Array.from({ length: 2 }, (_, i) => makeSignal({ id: `p${i}`, outcome: "pass", step: "types", model: "qwen3-coder", repo: "/repo/x" })),
  ];
}
const NOW = () => new Date("2026-06-09T12:00:00.000Z");

describe("buildFailureModeBlock", () => {
  it("renders a block when a mode crosses threshold", async () => {
    const block = await buildFailureModeBlock(storeOf(), { installScope: "i", repo: "/repo/x", now: NOW });
    expect(block).toContain("Known failure modes");
    expect(block).toContain("types");
    expect(block).toContain("80%");
    expect(block).toContain("n=10");
  });

  it("returns empty string when nothing crosses threshold", async () => {
    const block = await buildFailureModeBlock(storeOf([]), { installScope: "i", repo: "/repo/x", now: NOW });
    expect(block).toBe("");
  });

  it("caps the number of modes", async () => {
    const many = [];
    for (const step of ["a", "b", "c", "d"]) {
      for (let i = 0; i < 10; i++) many.push(makeSignal({ id: `${step}${i}`, outcome: "fail", step }));
    }
    const block = await buildFailureModeBlock(storeOf(many), { installScope: "i", repo: "/repo/x", now: NOW }, { maxModes: 2 });
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("renderFailureMode produces a single deterministic line", () => {
    const line = renderFailureMode({ repo: "/r", model: "m", kind: "gate", step: "types", total: 120, failures: 46, failRate: 0.38, lastTs: "x" }, 14);
    expect(line).toBe("- m failed `types` on 38% of gate checks in this repo (n=120, 14d).");
  });
});

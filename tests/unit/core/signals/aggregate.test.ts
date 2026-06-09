import { describe, expect, it } from "vitest";
import { aggregateFailureModes } from "../../../../src/core/signals/aggregate.js";
import { makeSignal } from "../../../fixtures/signals.js";

describe("aggregateFailureModes", () => {
  it("buckets by (repo, model, kind, step) and computes fail rate", () => {
    const signals = [
      ...Array.from({ length: 8 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail", step: "types" })),
      ...Array.from({ length: 2 }, (_, i) => makeSignal({ id: `p${i}`, outcome: "pass", step: "types" })),
    ];
    const modes = aggregateFailureModes(signals, { minFailRate: 0.2, minSamples: 10 });
    expect(modes).toHaveLength(1);
    expect(modes[0]).toMatchObject({ step: "types", total: 10, failures: 8, failRate: 0.8 });
  });

  it("counts both fail and exhausted as failures", () => {
    const signals = [
      ...Array.from({ length: 5 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail" })),
      ...Array.from({ length: 5 }, (_, i) => makeSignal({ id: `e${i}`, outcome: "exhausted" })),
    ];
    const modes = aggregateFailureModes(signals, { minFailRate: 0.2, minSamples: 10 });
    expect(modes[0]!.failures).toBe(10);
  });

  it("gates out buckets below the sample-size floor", () => {
    const signals = Array.from({ length: 5 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail" }));
    expect(aggregateFailureModes(signals, { minSamples: 10 })).toHaveLength(0);
  });

  it("gates out buckets below the fail-rate floor", () => {
    const signals = [
      ...Array.from({ length: 1 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail" })),
      ...Array.from({ length: 19 }, (_, i) => makeSignal({ id: `p${i}`, outcome: "pass" })),
    ];
    expect(aggregateFailureModes(signals, { minFailRate: 0.2, minSamples: 10 })).toHaveLength(0);
  });

  it("sorts by fail rate descending", () => {
    const a = Array.from({ length: 10 }, (_, i) => makeSignal({ id: `a${i}`, step: "lint", outcome: i < 3 ? "fail" : "pass" }));
    const b = Array.from({ length: 10 }, (_, i) => makeSignal({ id: `b${i}`, step: "types", outcome: i < 9 ? "fail" : "pass" }));
    const modes = aggregateFailureModes([...a, ...b], { minFailRate: 0.2, minSamples: 10 });
    expect(modes.map((m) => m.step)).toEqual(["types", "lint"]);
  });
});

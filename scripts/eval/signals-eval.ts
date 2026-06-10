/**
 * Signals meaningfulness eval. Not a unit test - a quality pass that drives the
 * REAL pipeline (normalizeSignal -> SqliteSignalStore -> aggregate ->
 * buildFailureModeBlock -> recommendActions) with a realistic multi-model,
 * multi-repo corpus and checks the OUTPUTS are correct, useful, and non-noisy.
 *
 * Run: npx tsx scripts/eval/signals-eval.ts
 * Exits non-zero if any criterion fails. Prints the rendered failure-mode block
 * so a human can see a real meaningful result, not just a pass/fail count.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStorage } from "@core/storage/sqlite-storage.js";
import { normalizeSignal } from "@core/signals/ingest-signal.js";
import { buildFailureModeBlock } from "@core/signals/failure-mode-recall.js";
import { aggregateFailureModes } from "@core/signals/aggregate.js";
import { recommendActions } from "@core/signals/recommend.js";
import type { Signal } from "@shared/types.js";

const SCOPE = "eval-install";
const NOW = new Date("2026-06-09T12:00:00.000Z");
const fixedNow = () => NOW; // for buildFailureModeBlock (now: () => Date)
const nowIso = () => NOW.toISOString(); // for normalizeSignal (now: () => string)
// Deterministic ISO timestamps inside the 14d recall window, spread so each
// signal in a bucket is unique (ts is part of the dedup id).
function tsAt(daysAgo: number, seq: number): string {
  const ms = NOW.getTime() - daysAgo * 86_400_000 - seq * 1000;
  return new Date(ms).toISOString();
}

// One bucket of `n` signals at a target fail rate, deterministically interleaved.
function bucket(
  repo: string,
  model: string,
  step: string,
  n: number,
  failRate: number,
): Signal[] {
  const out: Signal[] = [];
  const failEvery = failRate === 0 ? Infinity : 1 / failRate;
  for (let i = 0; i < n; i++) {
    const fail = failRate > 0 && Math.floor(i * failRate) !== Math.floor((i - 1) * failRate);
    out.push(
      normalizeSignal(
        {
          kind: "gate",
          producer: "quality-gate",
          outcome: fail ? "fail" : "pass",
          model,
          repo,
          detail: { step, attempt: 1 },
          session: `${model}-${repo}-${step}-${i}`,
          ts: tsAt(3, out.length + i),
        },
        SCOPE,
        nowIso,
      ),
    );
  }
  void failEvery;
  return out;
}

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const migrationsDir = resolve(fileURLToPath(import.meta.url), "../../../migrations");
  const dir = mkdtempSync(join(tmpdir(), "nlm-signals-eval-"));
  const storage = SqliteStorage.create({ dbPath: join(dir, "c.sqlite"), migrationsDir });
  await storage.init();

  // ── Realistic corpus ───────────────────────────────────────────────────
  // qwen3-coder is weak at TS types in the active repo; fine elsewhere.
  // A strong model in the same repo is clean. A second repo stays below
  // threshold. One repo is bad enough to warrant a model swap.
  const NLM = "/repos/nlm-memory";
  const POLY = "/repos/polysignal";
  const TAX = "/repos/tx-tax";
  const corpus: Signal[] = [
    ...bucket(NLM, "qwen3-coder", "types", 120, 0.38), // headline failure mode
    ...bucket(NLM, "qwen3-coder", "lint", 80, 0.04), // clean -> must stay quiet
    ...bucket(NLM, "qwen3-coder", "test", 40, 0.10), // below rate floor -> quiet
    ...bucket(NLM, "claude-sonnet", "types", 90, 0.02), // strong model -> quiet
    ...bucket(POLY, "qwen3-coder", "types", 60, 0.08), // below 20% -> quiet
    ...bucket(TAX, "qwen3-coder", "types", 50, 0.62), // bad enough to swap model
  ];
  await storage.signals.insertMany(corpus);

  console.log(`\nSignals meaningfulness eval — ${corpus.length} signals across 3 repos, 2 models\n`);

  // ── Criterion 1: correctness + the headline mode surfaces with right numbers ─
  console.log("1. Correctness + recall of a real failure mode");
  const nlmQwen = await buildFailureModeBlock(
    storage.signals,
    { installScope: SCOPE, repo: NLM, model: "qwen3-coder", now: fixedNow },
  );
  console.log("\n  --- rendered block (nlm-memory / qwen3-coder) ---");
  console.log(nlmQwen.split("\n").map((l) => `    ${l}`).join("\n"));
  console.log("  --------------------------------------------------\n");
  check("surfaces a failure mode", nlmQwen.includes("Known failure modes"));
  check("identifies the `types` step", nlmQwen.includes("`types`"));
  check("reports ~38% (within rounding)", /3[78]%/.test(nlmQwen), `block pct`);
  check("reports n=120 sample size", nlmQwen.includes("n=120"));

  // ── Criterion 2: precision — healthy / sub-threshold scopes stay quiet ──
  console.log("\n2. Precision (no nagging when the model is fine)");
  const nlmStrong = await buildFailureModeBlock(
    storage.signals,
    { installScope: SCOPE, repo: NLM, model: "claude-sonnet", now: fixedNow },
  );
  check("strong model in same repo -> empty block", nlmStrong === "", `got ${nlmStrong.length} chars`);
  const polyQwen = await buildFailureModeBlock(
    storage.signals,
    { installScope: SCOPE, repo: POLY, model: "qwen3-coder", now: fixedNow },
  );
  check("sub-threshold repo (8% types) -> empty block", polyQwen === "");
  check("clean `lint` not surfaced for the weak model", !nlmQwen.includes("`lint`"));
  check("sub-floor `test` (10%) not surfaced", !nlmQwen.includes("`test`"));

  // ── Criterion 3: scoping / isolation ───────────────────────────────────
  console.log("\n3. Scoping (repo + model isolation)");
  check("nlm block does not mention claude-sonnet", !nlmQwen.includes("claude-sonnet"));
  const otherInstall = await buildFailureModeBlock(
    storage.signals,
    { installScope: "different-install", repo: NLM, model: "qwen3-coder", now: fixedNow },
  );
  check("a different install_scope sees nothing", otherInstall === "");

  // ── Criterion 4: recommendations are actionable + proportionate ─────────
  console.log("\n4. Recommendations (surface + recommend, no auto-act)");
  const sinceTs = new Date(NOW.getTime() - 14 * 86_400_000).toISOString();
  const allRows = await storage.signals.listForAggregation({ installScope: SCOPE, sinceTs });
  const modes = aggregateFailureModes(allRows);
  const recs = recommendActions(modes);
  const swapRecs = recs.filter((r) => r.kind === "model-swap");
  const ruleRecs = recs.filter((r) => r.kind === "agents-rule");
  check("the 62% repo earns a model-swap recommendation", swapRecs.some((r) => r.text.includes(TAX)));
  check("the 38% types mode earns an AGENTS.md rule", ruleRecs.some((r) => r.text.includes("types") && r.text.includes(NLM)));
  check("the 38% mode does NOT trigger a model swap (<50%)", !swapRecs.some((r) => r.text.includes(NLM) && r.text.includes("qwen3-coder") && r.text.includes("types")));
  console.log("\n  --- recommendations ---");
  for (const r of recs) console.log(`    [${r.kind}] ${r.text}`);
  console.log("  -----------------------\n");

  // ── Criterion 5: ranking (worst first, capped) ─────────────────────────
  console.log("5. Ranking + cap");
  check("worst failure rate ranks first", modes.length > 0 && modes[0]!.failRate >= (modes[1]?.failRate ?? 0));
  const capped = await buildFailureModeBlock(
    storage.signals,
    { installScope: SCOPE, repo: TAX, model: "qwen3-coder", now: fixedNow },
    { maxModes: 1 },
  );
  check("maxModes cap respected", capped.split("\n").filter((l) => l.startsWith("- ")).length <= 1);

  // ── Criterion 6: idempotency (re-ingest is a no-op) ────────────────────
  console.log("\n6. Idempotency (re-ingest must not inflate counts)");
  const before = (await storage.signals.listForAggregation({ installScope: SCOPE })).length;
  await storage.signals.insertMany(corpus); // identical payloads -> identical ids
  const after = (await storage.signals.listForAggregation({ installScope: SCOPE })).length;
  check("re-inserting the full corpus changes nothing", before === after, `${before} -> ${after}`);

  await storage.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${"=".repeat(60)}`);
  if (failures === 0) {
    console.log("RESULT: all criteria PASS - signals produce correct, useful, non-noisy results.");
  } else {
    console.log(`RESULT: ${failures} criterion(s) FAILED.`);
  }
  console.log("=".repeat(60));
  process.exit(failures === 0 ? 0 : 1);
}

void main();

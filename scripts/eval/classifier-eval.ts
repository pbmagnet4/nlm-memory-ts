/**
 * Classifier extraction-quality eval. The first eval in the repo that scores
 * TRUTH (are extracted decisions/entities faithful?) rather than structure
 * (JSON validity, counts). Extraction quality is upstream of every recall and
 * precision number; this harness gives it a measurable score.
 *
 * Pipeline:
 *   1. Load the gold set (capped bodies + reference extractions) from
 *      $NLM_EVAL_DATA_DIR (default /tmp/nlm-309). Transcripts and per-session
 *      extractions stay in /tmp by design — only aggregate scores reach the
 *      committed report.
 *   2. Re-classify every gold session with each candidate config.
 *   3. Judge each candidate's output against the transcript + reference with a
 *      pluggable OpenAI-compatible judge (Mac Studio oMLX for this run).
 *   4. Aggregate into decision P/R + entity P and write a per-run JSON to the
 *      data dir (working artifact, not committed).
 *
 * Co-residency: the Studio serves one big model at a time. The harness runs
 * ALL classifications first (candidate a, then candidate b), THEN all judge
 * calls, so each Studio model loads once instead of thrashing.
 *
 * Run: npx tsx scripts/eval/classifier-eval.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OllamaClient } from "../../src/llm/ollama-client.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildUserPrompt,
  coerceClassifyResult,
  stripJsonFences,
  validateClassifierJson,
} from "../../src/core/classifier/prompt.js";
import type { ClassifyResult } from "../../src/ports/llm-client.js";
import { ClassifierCache, type ClassifierClient } from "../longmemeval/classifier-cache.js";
import { JudgeCache, type JudgeOptions } from "./judge.js";
import {
  aggregateExtraction,
  scoreSession,
  type ExtractionVerdicts,
  type MatchVerdict,
  type SessionScore,
  type Verdict,
} from "./extraction-scoring.js";

interface GoldSession {
  readonly id: string;
  readonly runtime: string;
  readonly cited: boolean;
  readonly body: string;
}

interface ReferenceExtraction {
  readonly id: string;
  readonly decisions: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<string>;
}

export interface CandidateConfig {
  readonly key: string;
  readonly label: string;
  readonly client: ClassifierClient;
}

const STUDIO_BASE = "http://192.168.1.217:8000/v1";

/**
 * Minimal OpenAI-compatible classifier for eval candidates on the Studio.
 * Reuses the shared prompt + coercer; only the transport differs from the
 * production Ollama/DeepSeek clients. Not a production client — the daemon
 * never talks to the Studio, so this stays eval-local (no provider-registry
 * row, no NLM_CLASSIFIER wiring).
 */
class OpenAICompatibleClassifier implements ClassifierClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {}

  async classify(transcript: string): Promise<ClassifyResult> {
    const userPrompt = buildUserPrompt(transcript, "");
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`classify HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    const data = (await res.json()) as {
      choices?: ReadonlyArray<{ message?: { content?: string } }>;
    };
    const content = stripJsonFences(data.choices?.[0]?.message?.content?.trim() ?? "");
    const parsed = JSON.parse(content) as unknown;
    if (!validateClassifierJson(parsed)) throw new Error("response missing required keys");
    return coerceClassifyResult(parsed);
  }
}

const DECISION_PRECISION_SYSTEM = `You are a strict fact-checker. You are given a TRANSCRIPT of a coding session and ONE decision that a classifier claims was made in it. Decide whether the transcript SUPPORTS that the decision was actually made or committed to. A decision is "supported" only if the transcript shows the user/agent committing to it (not merely discussing it as an option). Output ONLY this JSON object, nothing else: {"verdict": "supported" | "unsupported"}`;

const DECISION_RECALL_SYSTEM = `You compare decisions for semantic equivalence. You are given ONE reference decision and a LIST of candidate decisions. Decide whether ANY candidate decision expresses the same commitment as the reference decision (paraphrases count; partial overlap does not). Output ONLY this JSON object, nothing else: {"verdict": "matched" | "unmatched"}`;

const ENTITY_PRECISION_SYSTEM = `You are a strict fact-checker. You are given a TRANSCRIPT and ONE entity (a named tool, project, service, person, or technology) that a classifier extracted. Decide whether that entity is actually present and relevant in the transcript (not hallucinated, not a generic noun). Output ONLY this JSON object, nothing else: {"verdict": "supported" | "unsupported"}`;

function asVerdict(o: Record<string, unknown>): Verdict {
  return o["verdict"] === "supported" ? "supported" : "unsupported";
}
function asMatch(o: Record<string, unknown>): MatchVerdict {
  return o["verdict"] === "matched" ? "matched" : "unmatched";
}

/**
 * Transcript cap for the precision-judge prompts. The judge model (122B on
 * oMLX) overflows its prefill memory ceiling when a 20K-char body is embedded
 * once per extracted decision/entity. 12K (head + tail) keeps the judge inside
 * memory while preserving opening intent + closing decisions — the two regions
 * that anchor a fact-check. Recall prompts don't embed the body, so they're
 * unaffected.
 */
export const JUDGE_TRANSCRIPT_CAP = 12_000;

export function judgeTranscript(body: string): string {
  if (body.length <= JUDGE_TRANSCRIPT_CAP) return body;
  const half = Math.floor((JUDGE_TRANSCRIPT_CAP - 80) / 2);
  return (
    body.slice(0, half) +
    "\n\n[... transcript truncated for judge; closing portion below ...]\n\n" +
    body.slice(body.length - half)
  );
}

/**
 * Count of judge verdicts that could not be parsed even after the in-cache
 * retry. These degrade to a conservative verdict (unsupported / unmatched) so a
 * single flaky oMLX reply doesn't crash a 30-session run, and the count is
 * reported as a judge-reliability caveat.
 */
let judgeAbstentions = 0;

async function judgeOnce(
  judge: JudgeCache,
  system: string,
  user: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await judge.judge(system, user);
  } catch {
    judgeAbstentions++;
    return null;
  }
}

async function judgeCandidateSession(
  judge: JudgeCache,
  body: string,
  ref: ReferenceExtraction,
  result: ClassifyResult,
): Promise<ExtractionVerdicts> {
  const tx = judgeTranscript(body);
  const decisionPrecision: Verdict[] = [];
  for (const d of result.decisions) {
    const o = await judgeOnce(
      judge,
      DECISION_PRECISION_SYSTEM,
      `TRANSCRIPT:\n${tx}\n\nDECISION TO CHECK:\n${d}`,
    );
    decisionPrecision.push(o ? asVerdict(o) : "unsupported");
  }

  const decisionRecall: MatchVerdict[] = [];
  const candList = result.decisions.length
    ? result.decisions.map((d, i) => `${i + 1}. ${d}`).join("\n")
    : "(none)";
  for (const refD of ref.decisions) {
    const o = await judgeOnce(
      judge,
      DECISION_RECALL_SYSTEM,
      `REFERENCE DECISION:\n${refD}\n\nCANDIDATE DECISIONS:\n${candList}`,
    );
    decisionRecall.push(o ? asMatch(o) : "unmatched");
  }

  const entityPrecision: Verdict[] = [];
  for (const e of result.entities) {
    const o = await judgeOnce(
      judge,
      ENTITY_PRECISION_SYSTEM,
      `TRANSCRIPT:\n${tx}\n\nENTITY TO CHECK:\n${e}`,
    );
    entityPrecision.push(o ? asVerdict(o) : "unsupported");
  }

  return { decisionPrecision, decisionRecall, entityPrecision };
}

interface CandidateRun {
  readonly key: string;
  readonly label: string;
  readonly results: Map<string, ClassifyResult | null>;
  readonly elapsedMsById: Map<string, number>;
}

async function classifyAll(
  candidate: CandidateConfig,
  gold: ReadonlyArray<GoldSession>,
  cache: ClassifierCache,
): Promise<CandidateRun> {
  const results = new Map<string, ClassifyResult | null>();
  const elapsedMsById = new Map<string, number>();
  for (let i = 0; i < gold.length; i++) {
    const g = gold[i]!;
    const entry = await cache.classify(g.body);
    results.set(g.id, entry.failed ? null : entry.result);
    if (entry.elapsedMs != null) elapsedMsById.set(g.id, entry.elapsedMs);
    process.stdout.write(
      `  [${candidate.label}] ${i + 1}/${gold.length} ${g.id} ${entry.failed ? "FAILED" : "ok"}\n`,
    );
  }
  return { key: candidate.key, label: candidate.label, results, elapsedMsById };
}

function buildCandidates(): CandidateConfig[] {
  const ollamaUrl = process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434";
  const prodModel = process.env["NLM_CLASSIFIER_MODEL"] ?? "qwen3:4b-instruct-2507-q4_K_M";
  return [
    {
      key: `ollama:${prodModel}`,
      label: `prod ollama ${prodModel}`,
      client: new OllamaClient({ baseUrl: ollamaUrl, classifyModel: prodModel }),
    },
    {
      key: "studio:Qwen3.5-9B-MLX-8bit",
      label: "audition Qwen3.5-9B-MLX-8bit",
      client: new OpenAICompatibleClassifier(STUDIO_BASE, "Qwen3.5-9B-MLX-8bit"),
    },
  ];
}

async function main(): Promise<void> {
  const dataDir = process.env["NLM_EVAL_DATA_DIR"] ?? "/tmp/nlm-309";
  const cacheDir = process.env["NLM_EVAL_CACHE_DIR"] ?? join(dataDir, "cache");
  const gold = JSON.parse(readFileSync(join(dataDir, "gold-bodies.json"), "utf8")) as GoldSession[];
  const reference = JSON.parse(readFileSync(join(dataDir, "reference.json"), "utf8")) as ReferenceExtraction[];
  const refById = new Map(reference.map((r) => [r.id, r]));

  const judgeOpts: JudgeOptions = {
    baseUrl: STUDIO_BASE,
    model: process.env["NLM_EVAL_JUDGE_MODEL"] ?? "Qwen3.5-122B-A10B-5bit",
    timeoutMs: 300_000,
  };

  console.log(`classifier-eval: ${gold.length} gold sessions, judge=${judgeOpts.model}`);

  const candidates = buildCandidates();

  // Phase 1: classify everything, both candidates, before any judge call.
  // Candidate (b) lives on the Studio; running all of (b)'s classifications
  // before the judge loads keeps the Studio from thrashing between the 9B and
  // the 122B.
  const runs: CandidateRun[] = [];
  for (const c of candidates) {
    console.log(`\nclassify: ${c.label}`);
    const cache = new ClassifierCache({
      dbPath: join(cacheDir, "classifier.sqlite"),
      provider: c.key.split(":")[0]!,
      model: c.key.slice(c.key.indexOf(":") + 1),
      client: c.client,
    });
    runs.push(await classifyAll(c, gold, cache));
    cache.close();
  }

  // Phase 2: judge everything with the 122B (loads once, stays loaded).
  console.log(`\njudge: all candidates with ${judgeOpts.model}`);
  const judge = new JudgeCache(join(cacheDir, "judge.sqlite"), judgeOpts);
  const perCandidate: Record<
    string,
    {
      label: string;
      scores: SessionScore[];
      meanLatencyMs: number | null;
    }
  > = {};

  for (const run of runs) {
    console.log(`\n  judging ${run.label}`);
    const scores: SessionScore[] = [];
    for (let i = 0; i < gold.length; i++) {
      const g = gold[i]!;
      const ref = refById.get(g.id);
      if (!ref) throw new Error(`no reference for gold session ${g.id}`);
      const result = run.results.get(g.id) ?? null;
      if (!result) {
        scores.push(scoreSession({ decisionPrecision: [], decisionRecall: [], entityPrecision: [] }, true));
        process.stdout.write(`    ${i + 1}/${gold.length} ${g.id} SCHEMA-FAIL\n`);
        continue;
      }
      const verdicts = await judgeCandidateSession(judge, g.body, ref, result);
      scores.push(scoreSession(verdicts, false));
      process.stdout.write(`    ${i + 1}/${gold.length} ${g.id}\n`);
    }
    const latencies = [...run.elapsedMsById.values()];
    const meanLatencyMs = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;
    perCandidate[run.key] = { label: run.label, scores, meanLatencyMs };
  }
  const judgeCacheStats = judge.stats();
  judge.close();

  // Aggregate + write working JSON (stays in /tmp).
  const out = {
    generated_at: new Date().toISOString(),
    gold_n: gold.length,
    gold_cited: gold.filter((g) => g.cited).length,
    gold_by_runtime: countBy(gold, (g) => g.runtime),
    judge_model: judgeOpts.model,
    judge_abstentions: judgeAbstentions,
    judge_cache: judgeCacheStats,
    candidates: Object.fromEntries(
      Object.entries(perCandidate).map(([key, v]) => [
        key,
        {
          label: v.label,
          mean_latency_ms: v.meanLatencyMs,
          schema_failure_rate: round3(
            v.scores.filter((s) => s.schemaFailed).length / v.scores.length,
          ),
          aggregate: aggregateExtraction(v.scores),
        },
      ]),
    ),
  };
  const outPath = join(dataDir, "eval-results.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nclassifier-eval: wrote ${outPath}`);
  console.log(renderTable(out));
}

function countBy<T>(items: ReadonlyArray<T>, key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of items) {
    const k = key(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function pct(x: number | null): string {
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`;
}

interface OutShape {
  judge_model: string;
  gold_n: number;
  candidates: Record<
    string,
    {
      label: string;
      mean_latency_ms: number | null;
      schema_failure_rate: number;
      aggregate: ReturnType<typeof aggregateExtraction>;
    }
  >;
}

function renderTable(out: OutShape): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("| Candidate | Decision P | Decision R | Entity P | Schema fail | Latency/session |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const c of Object.values(out.candidates)) {
    const a = c.aggregate;
    lines.push(
      `| ${c.label} | ${pct(a.decisionPrecision)} (n=${a.decisionPrecisionN}) | ${pct(a.decisionRecall)} (n=${a.decisionRecallN}) | ${pct(a.entityPrecision)} (n=${a.entityPrecisionN}) | ${(c.schema_failure_rate * 100).toFixed(1)}% | ${c.mean_latency_ms ?? "?"}ms |`,
    );
  }
  return lines.join("\n");
}

// Only run when invoked as a script — keeps the module importable from unit
// tests (which exercise judgeTranscript without triggering a live eval).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error("classifier-eval: fatal", err);
    process.exit(1);
  });
}

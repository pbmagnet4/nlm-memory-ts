/**
 * Pure scoring + aggregation for the classifier extraction-quality eval.
 *
 * The scoring model is precision/recall over three extraction surfaces:
 *  - DECISION PRECISION: of the decisions a candidate extracted, what fraction
 *    a judge ruled `supported` against the TRANSCRIPT (not the reference — a
 *    candidate may legitimately surface a true decision the reference missed).
 *  - DECISION RECALL: of the REFERENCE decisions, what fraction the judge ruled
 *    semantically matched by some candidate decision.
 *  - ENTITY PRECISION: of the entities a candidate extracted, what fraction the
 *    judge ruled actually present/relevant in the transcript.
 *
 * These functions are deterministic and dependency-free. The live judge work
 * (LLM verdicts) happens in the harness; this module only turns verdict arrays
 * into rates so the math is unit-testable without an LLM.
 */

export type Verdict = "supported" | "unsupported";
export type MatchVerdict = "matched" | "unmatched";

export interface ExtractionVerdicts {
  /** One per candidate-extracted decision: faithful to transcript? */
  readonly decisionPrecision: ReadonlyArray<Verdict>;
  /** One per reference decision: matched by any candidate decision? */
  readonly decisionRecall: ReadonlyArray<MatchVerdict>;
  /** One per candidate-extracted entity: present/relevant in transcript? */
  readonly entityPrecision: ReadonlyArray<Verdict>;
}

export interface SessionScore {
  readonly decisionPrecision: number | null;
  readonly decisionRecall: number | null;
  readonly entityPrecision: number | null;
  /** True when the candidate produced no usable ClassifyResult for this session. */
  readonly schemaFailed: boolean;
}

/**
 * Per-session rates. A surface with zero items yields `null` (not 0): a session
 * with no extracted decisions has undefined precision, not 0% precision, and
 * must not drag the mean down. nulls are dropped at aggregation time.
 */
export function scoreSession(
  verdicts: ExtractionVerdicts,
  schemaFailed: boolean,
): SessionScore {
  if (schemaFailed) {
    return {
      decisionPrecision: null,
      decisionRecall: null,
      entityPrecision: null,
      schemaFailed: true,
    };
  }
  return {
    decisionPrecision: rate(verdicts.decisionPrecision, (v) => v === "supported"),
    decisionRecall: rate(verdicts.decisionRecall, (v) => v === "matched"),
    entityPrecision: rate(verdicts.entityPrecision, (v) => v === "supported"),
    schemaFailed: false,
  };
}

function rate<T>(items: ReadonlyArray<T>, hit: (x: T) => boolean): number | null {
  if (items.length === 0) return null;
  let n = 0;
  for (const x of items) if (hit(x)) n++;
  return n / items.length;
}

export interface AggregateExtraction {
  readonly n: number;
  /** Sessions that produced a usable extraction (n - schema failures). */
  readonly scored: number;
  readonly schemaFailures: number;
  /** Macro-average across sessions that had ≥1 item on the surface. */
  readonly decisionPrecision: number | null;
  readonly decisionRecall: number | null;
  readonly entityPrecision: number | null;
  /** How many sessions contributed to each surface mean (had ≥1 item). */
  readonly decisionPrecisionN: number;
  readonly decisionRecallN: number;
  readonly entityPrecisionN: number;
}

/** Macro-average per-session rates, dropping nulls (surfaces with no items). */
export function aggregateExtraction(
  scores: ReadonlyArray<SessionScore>,
): AggregateExtraction {
  const schemaFailures = scores.filter((s) => s.schemaFailed).length;
  const dp = meanOfDefined(scores.map((s) => s.decisionPrecision));
  const dr = meanOfDefined(scores.map((s) => s.decisionRecall));
  const ep = meanOfDefined(scores.map((s) => s.entityPrecision));
  return {
    n: scores.length,
    scored: scores.length - schemaFailures,
    schemaFailures,
    decisionPrecision: dp.mean,
    decisionRecall: dr.mean,
    entityPrecision: ep.mean,
    decisionPrecisionN: dp.count,
    decisionRecallN: dr.count,
    entityPrecisionN: ep.count,
  };
}

function meanOfDefined(
  values: ReadonlyArray<number | null>,
): { mean: number | null; count: number } {
  const defined = values.filter((v): v is number => v !== null);
  if (defined.length === 0) return { mean: null, count: 0 };
  const sum = defined.reduce((a, b) => a + b, 0);
  return { mean: sum / defined.length, count: defined.length };
}

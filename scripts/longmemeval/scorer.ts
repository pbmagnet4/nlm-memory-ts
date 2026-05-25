/**
 * Pure scoring functions for the LongMemEval harness. Two metrics:
 *
 *  - R@k (recall at k): did the retriever return any gold session ID in
 *    its top-k results? Standard benchmark metric.
 *  - Session-body hit: did the gold answer text appear anywhere in the
 *    bodies of the top-k returned sessions? NLM-specific companion that
 *    captures session-as-primary-unit value the strict-ID R@k can miss
 *    (e.g. a session that supersedes the gold session and quotes its
 *    decision).
 *
 * Both functions are deterministic and dependency-free so the harness can
 * test them with synthetic inputs.
 */

export interface ScoreInputs {
  readonly returnedIds: ReadonlyArray<string>;
  readonly goldIds: ReadonlyArray<string>;
  /** Map id → body for the bodies of the top-k returned sessions. */
  readonly returnedBodies: ReadonlyArray<string>;
  /** Some LongMemEval answers are ints (counting questions); coerced to string. */
  readonly answer: string | number | boolean;
  readonly k: number;
}

export interface SingleScore {
  readonly recallAtK: 0 | 1;
  readonly sessionBodyHit: 0 | 1;
}

/** Score a single question. Returns 0/1 indicators that aggregate via mean. */
export function scoreOne(input: ScoreInputs): SingleScore {
  const topK = input.returnedIds.slice(0, input.k);
  const goldSet = new Set(input.goldIds);
  const recallAtK = topK.some((id) => goldSet.has(id)) ? 1 : 0;

  // Session-body hit: substring match for multi-word answers; word-boundary
  // match for short answers (single token <4 chars: "3", "yes", numeric
  // counts). Without the boundary, a numeric answer "3" hits every body
  // containing "3 days", "$3", etc., inflating the metric to noise.
  const ans = normalize(String(input.answer));
  let sessionBodyHit: 0 | 1 = 0;
  if (ans.length > 0) {
    const isShortToken = !ans.includes(" ") && ans.length < 4;
    const test = isShortToken
      ? (body: string): boolean =>
          new RegExp(`\\b${escapeRegExp(ans)}\\b`).test(normalize(body))
      : (body: string): boolean => normalize(body).includes(ans);
    const bodies = input.returnedBodies.slice(0, input.k);
    for (const body of bodies) {
      if (test(body)) {
        sessionBodyHit = 1;
        break;
      }
    }
  }
  return { recallAtK, sessionBodyHit };
}

export interface Aggregate {
  readonly n: number;
  readonly recallAtK: number;
  readonly sessionBodyHitRate: number;
}

/** Aggregate per-question scores into mean rates. */
export function aggregate(scores: ReadonlyArray<SingleScore>): Aggregate {
  const n = scores.length;
  if (n === 0) {
    return { n: 0, recallAtK: 0, sessionBodyHitRate: 0 };
  }
  let r = 0;
  let s = 0;
  for (const x of scores) {
    r += x.recallAtK;
    s += x.sessionBodyHit;
  }
  return {
    n,
    recallAtK: round3(r / n),
    sessionBodyHitRate: round3(s / n),
  };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

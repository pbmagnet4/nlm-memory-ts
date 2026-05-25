/**
 * LongMemEval dataset schema. Mirrors the published JSON shape from
 * huggingface.co/datasets/xiaowu0162/longmemeval-cleaned.
 *
 * Each instance: a question against a haystack of past chat sessions. The
 * gold session IDs are in `answer_session_ids` — that's what the retrieval
 * step is scored against (R@k: was any gold ID returned in the top k).
 */

export interface LongMemEvalTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly has_answer?: boolean;
}

export interface LongMemEvalInstance {
  readonly question_id: string;
  readonly question_type: string;
  readonly question: string;
  // LongMemEval answers are sometimes ints/booleans for counting and
  // temporal-reasoning questions — coerce at the call site.
  readonly answer: string | number | boolean;
  readonly question_date: string;
  readonly haystack_session_ids: ReadonlyArray<string>;
  readonly haystack_dates: ReadonlyArray<string>;
  readonly haystack_sessions: ReadonlyArray<ReadonlyArray<LongMemEvalTurn>>;
  readonly answer_session_ids: ReadonlyArray<string>;
}

/** Serialize a session's turn list to a single body string for NLM ingest. */
export function turnsToBody(turns: ReadonlyArray<LongMemEvalTurn>): string {
  return turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");
}

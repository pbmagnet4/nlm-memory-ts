/**
 * Classifier prompt + transcript helpers. Centralized so every LLMClient
 * implementation hits the same prompt (parity with the Python daemon).
 *
 * Hard cap at 15K chars matches `classifier.py` MAX_TRANSCRIPT_CHARS:
 * smaller models (phi4-mini, qwen) pattern-match JSON from the transcript
 * above that size. Long sessions get first-half + last-half with a
 * separator to preserve opening intent + closing decisions.
 *
 * Phase B.2: prompt now also asks for a `facts` array of normalized
 * (subject, predicate, value) triples for the FactStore. The closed
 * predicate vocabulary is embedded in the prompt so deterministic
 * supersedence (Phase B.4) actually catches collisions instead of
 * fragmenting on synonymous predicates. See docs/plans/factstore-design.md.
 */
/**
 * Closed predicate vocabulary. Approximately 25 high-leverage predicates
 * covering the most common (subject, predicate, value) shapes Edward
 * actually writes about in sessions.
 *
 * Vocab evolution (Phase B.5 backfill, 2026-05-19): the 168-session pilot
 * showed `other` getting used 43% of the time — it became a catch-all for
 * narrative observations that don't fit the (subject, predicate, value)
 * shape at all. Removed. The classifier prompt now instructs the model to
 * SKIP facts that don't fit (leave them in decisions[]/open[] instead).
 * Added `description`, `commit`, `cost` from observed high-frequency
 * patterns in the pilot batch's `other` bucket.
 *
 * Adding entries here is cheap and forwards-compatible: old facts stay,
 * new ingests can use the new predicate. Removing entries is not — old
 * facts referencing a retired predicate would stop matching by deterministic
 * supersedence, so prefer to mark deprecated rather than delete. (Existing
 * `other`-predicate facts from the pilot stay in the DB and are filterable
 * at query time; the coercer will drop new `other` writes.)
 */
export declare const PREDICATE_VOCABULARY: readonly ["framework", "endpoint", "model", "port", "host", "owner", "pricing", "cost", "deadline", "status", "stack", "runtime", "library", "version", "dependency", "schema", "integration", "deployment", "repo", "branch", "commit", "description", "decided-on", "assumption", "blocker"];
export type PredicateVocab = (typeof PREDICATE_VOCABULARY)[number];
export declare const CLASSIFIER_SYSTEM_PROMPT: string;
export declare const MAX_TRANSCRIPT_CHARS = 15000;
export declare function truncateTranscript(text: string, maxChars?: number): string;
export declare function stripJsonFences(text: string): string;
export declare function validateClassifierJson(data: unknown): data is Record<string, unknown>;
export declare function buildUserPrompt(transcript: string, priorContext: string): string;
interface CoercedFact {
    kind: "decision" | "open" | "attribute";
    subject: string;
    predicate: string;
    value: string;
    sourceQuote?: string;
}
export declare function coerceClassifyResult(data: Record<string, unknown>): {
    label: string;
    summary: string;
    entities: string[];
    decisions: string[];
    open: string[];
    confidence: number;
    facts: CoercedFact[];
};
export {};

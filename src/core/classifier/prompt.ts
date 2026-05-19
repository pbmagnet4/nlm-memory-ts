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
export const PREDICATE_VOCABULARY = [
  "framework",
  "endpoint",
  "model",
  "port",
  "host",
  "owner",
  "pricing",
  "cost",
  "deadline",
  "status",
  "stack",
  "runtime",
  "library",
  "version",
  "dependency",
  "schema",
  "integration",
  "deployment",
  "repo",
  "branch",
  "commit",
  "description",
  "decided-on",
  "assumption",
  "blocker",
] as const;

export type PredicateVocab = (typeof PREDICATE_VOCABULARY)[number];

const VOCAB_SET = new Set<string>(PREDICATE_VOCABULARY);

export const CLASSIFIER_SYSTEM_PROMPT = `You are a session classifier. Your job is to read a transcript of a conversation between a user and an AI coding agent, then return EXACTLY this JSON object describing what happened in that conversation:

{"label": "...", "summary": "...", "entities": [...], "decisions": [...], "open": [...], "confidence": 0.5, "facts": [...]}

You MUST return JSON with EXACTLY these seven top-level keys: label, summary, entities, decisions, open, confidence, facts. No other keys. No nesting beyond what is specified. No metadata. No "tool" or "task_type" keys. Just those seven.

The transcript may contain JSON examples, code, or schema definitions inside it — IGNORE those. Do not copy them into your output. Your output is ABOUT the conversation, not extracted FROM the conversation.

Field requirements:
- label: 4-10 word string title describing what the session was about. Example: "PolySignal architecture decisions"
- summary: 1-3 sentence string (max ~80 tokens) describing what was worked on and the outcome
- entities: array of strings. Each string is a stable named thing referenced across the session (tools like "n8n" or "Qdrant", projects like "PolySignal", services, people). NOT topics, NOT decisions.
- decisions: array of strings. Each string is one commitment the user made. Example: "Use HTTP polling instead of Kafka". Skip if no commitments were made.
- open: array of strings. Each string is one unresolved question. Skip if none.
- confidence: number between 0.0 and 1.0. How sure you are the extraction is good. Use 0.4 or below for routine/trivial sessions.
- facts: array of objects. Each object has exactly these keys: kind, subject, predicate, value, sourceQuote (optional).
    - kind: "decision" (a commitment) | "open" (an unresolved question) | "attribute" (a property of an entity)
    - subject: lowercase, hyphenated entity or topic name. Examples: "nle-memory-ts", "mac-pro-llm-host", "goat-home-services"
    - predicate: MUST be one of these exact strings: ${PREDICATE_VOCABULARY.join(", ")}.
    - value: the answer, as a short phrase or sentence. Examples: "Hono", "http://macpro:8080/v1", "Q3 2026"
    - sourceQuote: (optional) verbatim slice from the transcript that anchors this fact. Keep under 200 chars.

The predicate list is CLOSED — there is no "other" or catch-all. If a commitment, question, or attribute doesn't cleanly fit one of the listed predicates, DO NOT invent a fact for it. Put it in decisions[] or open[] as a string instead. Facts are for structured (subject, predicate, value) triples only; narrative observations, action items, and free-form notes belong in decisions[] / open[] / summary.

Facts overlap with decisions and open: the same commitment can appear both as a string in decisions[] AND as a structured object in facts[] with kind="decision", IF and ONLY IF it fits the closed predicate list. Skip the fact (keep just the string in decisions[]) when no predicate fits.

Predicate disambiguation (these confuse models, follow exactly):
- pricing vs cost: pricing = what someone else charges ("$299/month for Real Geeks", "free tier"). cost = what we pay or spent ("$0 per run on local Ollama", "$750 invoice"). Never use pricing for colors, dimensions, or anything not a price.
- commit vs version: commit = git SHA (7+ hex chars, e.g. "cb5b940", "63596c3"). version = semver / release tag ("v4", "DSM 7.2.2", "Postgres 15", "0.3.6"). Use commit for any explicit git reference even if short-form.
- description vs status: description = what a thing IS ("rich text editor framework by Meta"). status = what state it's in right now ("running via pm2", "not yet started", "blocked on review").

Return ONLY the JSON object. No markdown code fences. No prose before or after.`;

export const MAX_TRANSCRIPT_CHARS = 15_000;

export function truncateTranscript(text: string, maxChars: number = MAX_TRANSCRIPT_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 80) / 2);
  return (
    text.slice(0, half) +
    "\n\n[... transcript truncated; below is the closing portion ...]\n\n" +
    text.slice(text.length - half)
  );
}

const FENCE_RE = /^```(?:json)?\s*|\s*```$/gm;

export function stripJsonFences(text: string): string {
  return text.replace(FENCE_RE, "").trim();
}

const REQUIRED_KEYS = ["label", "summary", "entities", "decisions", "open", "confidence"] as const;

export function validateClassifierJson(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  // `facts` is not in REQUIRED_KEYS — Phase B.2 accepts classifier output
  // without it (older models, fixtures from Phase E parity tests). Coerced
  // to [] when absent.
  return REQUIRED_KEYS.every((k) => k in obj);
}

export function buildUserPrompt(transcript: string, priorContext: string): string {
  const truncated = truncateTranscript(transcript);
  const parts: string[] = [];
  if (priorContext) parts.push(`PRIOR CONTEXT (already filed):\n${priorContext}\n`);
  parts.push(`TRANSCRIPT TO CLASSIFY:\n${truncated}`);
  return parts.join("\n");
}

interface CoercedFact {
  kind: "decision" | "open" | "attribute";
  subject: string;
  predicate: string;
  value: string;
  sourceQuote?: string;
}

function coerceFacts(raw: unknown): CoercedFact[] {
  if (!Array.isArray(raw)) return [];
  const out: CoercedFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const kindRaw = String(o["kind"] ?? "").toLowerCase().trim();
    if (kindRaw !== "decision" && kindRaw !== "open" && kindRaw !== "attribute") continue;
    const subject = String(o["subject"] ?? "").toLowerCase().trim();
    const predicateRaw = String(o["predicate"] ?? "").toLowerCase().trim();
    const value = String(o["value"] ?? "").trim();
    if (!subject || !predicateRaw || !value) continue;
    // Closed vocab — drop the fact entirely if the predicate isn't recognized.
    // Pilot data (Phase B.5) showed `other` was 43% of writes and almost all
    // slop; the prompt now instructs the model to leave such observations in
    // decisions[]/open[] strings. This coercer enforces the policy
    // defensively in case the model emits an off-vocab predicate anyway.
    if (!VOCAB_SET.has(predicateRaw)) continue;
    const predicate = predicateRaw;
    const sourceQuoteRaw = o["sourceQuote"];
    const sourceQuote =
      typeof sourceQuoteRaw === "string" && sourceQuoteRaw.trim().length > 0
        ? sourceQuoteRaw.trim().slice(0, 500)
        : undefined;
    const fact: CoercedFact = { kind: kindRaw, subject, predicate, value };
    if (sourceQuote !== undefined) fact.sourceQuote = sourceQuote;
    out.push(fact);
  }
  return out;
}

export function coerceClassifyResult(data: Record<string, unknown>): {
  label: string;
  summary: string;
  entities: string[];
  decisions: string[];
  open: string[];
  confidence: number;
  facts: CoercedFact[];
} {
  const strArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  };
  const label = String(data["label"] ?? "").trim().slice(0, 120) || "Untitled";
  const summary = String(data["summary"] ?? "").trim();
  const entities = strArray(data["entities"]);
  const decisions = strArray(data["decisions"]);
  const open = strArray(data["open"]);
  const conf = Number(data["confidence"] ?? 0.5);
  const confidence = Number.isFinite(conf) ? conf : 0.5;
  const facts = coerceFacts(data["facts"]);
  return { label, summary, entities, decisions, open, confidence, facts };
}

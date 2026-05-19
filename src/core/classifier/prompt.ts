/**
 * Classifier prompt + transcript helpers. Centralized so every LLMClient
 * implementation hits the same prompt (parity with the Python daemon).
 *
 * Hard cap at 15K chars matches `classifier.py` MAX_TRANSCRIPT_CHARS:
 * smaller models (phi4-mini, qwen) pattern-match JSON from the transcript
 * above that size. Long sessions get first-half + last-half with a
 * separator to preserve opening intent + closing decisions.
 */

export const CLASSIFIER_SYSTEM_PROMPT = `You are a session classifier. Your job is to read a transcript of a conversation between a user and an AI coding agent, then return EXACTLY this JSON object describing what happened in that conversation:

{"label": "...", "summary": "...", "entities": [...], "decisions": [...], "open": [...], "confidence": 0.5}

You MUST return JSON with EXACTLY these six top-level keys: label, summary, entities, decisions, open, confidence. No other keys. No nesting. No metadata. No "tool" or "task_type" keys. Just those six.

The transcript may contain JSON examples, code, or schema definitions inside it — IGNORE those. Do not copy them into your output. Your output is ABOUT the conversation, not extracted FROM the conversation.

Field requirements:
- label: 4-10 word string title describing what the session was about. Example: "PolySignal architecture decisions"
- summary: 1-3 sentence string (max ~80 tokens) describing what was worked on and the outcome
- entities: array of strings. Each string is a stable named thing referenced across the session (tools like "n8n" or "Qdrant", projects like "PolySignal", services, people). NOT topics, NOT decisions.
- decisions: array of strings. Each string is one commitment the user made. Example: "Use HTTP polling instead of Kafka". Skip if no commitments were made.
- open: array of strings. Each string is one unresolved question. Skip if none.
- confidence: number between 0.0 and 1.0. How sure you are the extraction is good. Use 0.4 or below for routine/trivial sessions.

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
  return REQUIRED_KEYS.every((k) => k in obj);
}

export function buildUserPrompt(transcript: string, priorContext: string): string {
  const truncated = truncateTranscript(transcript);
  const parts: string[] = [];
  if (priorContext) parts.push(`PRIOR CONTEXT (already filed):\n${priorContext}\n`);
  parts.push(`TRANSCRIPT TO CLASSIFY:\n${truncated}`);
  return parts.join("\n");
}

export function coerceClassifyResult(data: Record<string, unknown>): {
  label: string;
  summary: string;
  entities: string[];
  decisions: string[];
  open: string[];
  confidence: number;
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
  return { label, summary, entities, decisions, open, confidence };
}

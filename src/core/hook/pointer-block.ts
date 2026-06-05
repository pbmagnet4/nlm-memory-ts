/**
 * Renders the pointer block injected by the recall hook in live mode. Pure.
 * Pointer-only by design: ids + labels, no session content. The footer
 * names all four NLM MCP tools because the pointer block is the only
 * cross-runtime distribution surface for teaching the tool inventory —
 * fresh-install users never edit a prompt or settings file, so anything
 * we want the agent to know about the tool surface ships here.
 *
 * Spec G.2: when `facts` is provided, a "Known facts" section is inserted
 * between the session list and the tool footer. Each fact renders as
 * `<subject> <predicate>: <value> [N sessions]` so the agent has structured
 * context alongside the session pointers.
 */

export interface PointerHit {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
}

export interface PointerFact {
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly corroborationCount: number;
}

export function formatPointerBlock(
  hits: ReadonlyArray<PointerHit>,
  facts: ReadonlyArray<PointerFact> = [],
): string {
  if (hits.length === 0 && facts.length === 0) return "";
  const out: string[] = [];
  if (hits.length > 0) {
    out.push("## Possibly-relevant prior sessions (nlm-memory)");
    for (const h of hits) {
      out.push(`- ${h.id} · ${h.label} (${h.startedAt.slice(0, 10)})`);
    }
  }
  if (facts.length > 0) {
    if (out.length > 0) out.push("");
    out.push("## Known facts about top entities");
    for (const f of facts) {
      const tag = f.corroborationCount > 1 ? ` [${f.corroborationCount} sessions]` : "";
      out.push(`- ${f.subject} ${f.predicate}: ${f.value}${tag}`);
    }
  }
  out.push(
    "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved).",
  );
  return out.join("\n");
}

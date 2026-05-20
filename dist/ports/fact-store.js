/**
 * FactStore — the only way core/ reads or writes the fact corpus.
 *
 * Companion to SessionStore. Sessions are the operator-recall unit; facts are
 * the agent-recall projection — normalized (subject, predicate, value) triples
 * derived from sessions, supersedence-aware. See
 * docs/plans/factstore-design.md.
 *
 * Phase B.1 ships the storage port + adapter only. No extraction wired yet
 * (B.2), no recall service (B.3), no MCP surface (B.3), no supersedence
 * autodetect (B.4). The surface here is the minimum needed by future phases:
 * insert one or many, look up by id, look up current (non-superseded) facts
 * by subject and optional predicate, mark a fact superseded.
 */
export {};
//# sourceMappingURL=fact-store.js.map
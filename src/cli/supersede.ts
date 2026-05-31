/**
 * `nlm supersede` — interactive operator path for post-hoc supersedence.
 *
 * Wraps `SessionStore.markSuperseded` with two search prompts (predecessor +
 * successor) and an optional reason. Reuses the recall layer so operators
 * pick by label/snippet, never by typing UUIDs. Idempotent: re-running on
 * the same pair returns `noop: true` rather than re-writing.
 *
 * The non-interactive path (both ids passed as args) exists for shell
 * scripts and the test suite — when both ids are present and `--yes` is
 * set, no prompts fire.
 *
 * I/O is injected so tests can drive the command without a TTY. The real
 * CLI wires this to @clack/prompts; tests pass a stub io.
 */

import { fileURLToPath } from "node:url";
import { cancel, confirm, isCancel, log, outro, select, text } from "@clack/prompts";
import type { SqliteSessionStore } from "../core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../core/storage/sqlite-storage.js";
import { RecallService } from "../core/recall/recall-service.js";
import { OllamaClient } from "../llm/ollama-client.js";
import { appendSupersedence } from "../core/storage/supersedence-log.js";
import type { RecallService as RecallServiceType } from "../core/recall/recall-service.js";
import type { SessionStore } from "@ports/session-store.js";

export interface SupersedeOptions {
  readonly predecessor?: string | undefined;
  readonly successor?: string | undefined;
  readonly reason?: string | undefined;
  readonly yes?: boolean;
}

export interface SupersedeIO {
  /** Prompt the user with a free-text query, returning the search term. */
  promptQuery(label: string): Promise<string | null>;
  /** Show ranked candidates, return the chosen session id or null on cancel. */
  promptCandidate(
    label: string,
    candidates: ReadonlyArray<SessionCandidate>,
  ): Promise<string | null>;
  /** Ask for the optional reason field. Empty string means none. */
  promptReason(): Promise<string | null>;
  /** Confirm the link before writing. */
  confirmLink(predecessor: SessionCandidate, successor: SessionCandidate): Promise<boolean>;
  /**
   * Confirm an overwrite of an existing supersedence link. Fires only when
   * the predecessor is already marked superseded by a *different* successor —
   * the user is about to silently stomp a prior decision. Default IO renders
   * a distinct prompt so the destructive nature is unmissable.
   */
  confirmOverwrite(
    predecessor: SessionCandidate,
    existingSuccessor: SessionCandidate,
    newSuccessor: SessionCandidate,
  ): Promise<boolean>;
  /** Emit a human-readable line. Stdout for results, stderr for narration. */
  info(line: string): void;
  warn(line: string): void;
}

export interface SessionCandidate {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string | null;
  readonly runtime: string;
}

export interface SupersedeDeps {
  readonly store: SessionStore;
  readonly recall: RecallServiceType;
  readonly io: SupersedeIO;
}

export type SupersedeOutcome =
  | { kind: "marked"; predecessor: string; successor: string; reason?: string }
  | { kind: "noop"; predecessor: string; successor: string }
  | { kind: "cancelled"; reason: string };

const CANDIDATE_LIMIT = 8;

export async function executeSupersede(
  deps: SupersedeDeps,
  opts: SupersedeOptions,
): Promise<SupersedeOutcome> {
  const predecessor = await resolveSession(deps, opts.predecessor, "predecessor");
  if (predecessor.kind === "cancelled") return predecessor;

  const successor = await resolveSession(deps, opts.successor, "successor");
  if (successor.kind === "cancelled") return successor;

  if (predecessor.session.id === successor.session.id) {
    deps.io.warn("Predecessor and successor are the same session — nothing to mark.");
    return { kind: "cancelled", reason: "same-session" };
  }

  // Read the existing supersedence state *before* any writes. Three cases:
  //   - none: this is a fresh link.
  //   - already points at successor: idempotent no-op, return without writing.
  //   - points at a different successor: the user is about to overwrite a
  //     prior decision. Require explicit overwrite confirmation so a typo or
  //     misclick can't silently stomp history.
  const existingSupersededBy = await readExistingSupersededBy(
    deps.store,
    predecessor.session.id,
  );

  if (existingSupersededBy === successor.session.id) {
    deps.io.info(
      `Link already existed (no-op): ${predecessor.session.id} ⇢ ${successor.session.id}`,
    );
    return {
      kind: "noop",
      predecessor: predecessor.session.id,
      successor: successor.session.id,
    };
  }

  if (existingSupersededBy !== null && !opts.yes) {
    const existingCandidate = await resolveCandidateById(deps.store, existingSupersededBy);
    const overwriteOk = await deps.io.confirmOverwrite(
      predecessor.session,
      existingCandidate,
      successor.session,
    );
    if (!overwriteOk) {
      return { kind: "cancelled", reason: "user-declined-overwrite" };
    }
  }

  let reason = opts.reason;
  if (reason === undefined && !opts.yes) {
    const entered = await deps.io.promptReason();
    if (entered === null) {
      return { kind: "cancelled", reason: "user-cancelled-reason" };
    }
    if (entered.length > 0) reason = entered;
  }

  if (!opts.yes) {
    const ok = await deps.io.confirmLink(predecessor.session, successor.session);
    if (!ok) return { kind: "cancelled", reason: "user-declined-confirm" };
  }

  try {
    await deps.store.markSuperseded(predecessor.session.id, successor.session.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.io.warn(`Failed to mark supersedence: ${msg}`);
    return { kind: "cancelled", reason: msg };
  }

  void appendSupersedence({
    predecessorId: predecessor.session.id,
    successorId: successor.session.id,
    source: "cli",
    ...(reason !== undefined ? { reason } : {}),
  });
  deps.io.info(`Marked superseded: ${predecessor.session.id} ⇢ ${successor.session.id}`);
  return {
    kind: "marked",
    predecessor: predecessor.session.id,
    successor: successor.session.id,
    ...(reason !== undefined ? { reason } : {}),
  };
}

type ResolveOutcome =
  | { kind: "resolved"; session: SessionCandidate }
  | { kind: "cancelled"; reason: string };

async function resolveSession(
  deps: SupersedeDeps,
  argValue: string | undefined,
  role: "predecessor" | "successor",
): Promise<ResolveOutcome> {
  if (argValue) {
    const session = await deps.store.getById(argValue);
    if (!session) {
      deps.io.warn(`Session ${argValue} not found.`);
      return { kind: "cancelled", reason: "unknown-id" };
    }
    return {
      kind: "resolved",
      session: {
        id: session.id,
        label: session.label,
        startedAt: session.startedAt ?? null,
        runtime: session.runtime,
      },
    };
  }

  const query = await deps.io.promptQuery(role);
  if (query === null) return { kind: "cancelled", reason: "user-cancelled-query" };
  if (query.length === 0) {
    deps.io.warn(`Empty ${role} query — nothing to search.`);
    return { kind: "cancelled", reason: "empty-query" };
  }

  const result = await deps.recall.search({
    query,
    mode: "hybrid",
    limit: CANDIDATE_LIMIT,
  });
  if (result.results.length === 0) {
    deps.io.warn(`No sessions matched "${query}".`);
    return { kind: "cancelled", reason: "no-matches" };
  }

  const enriched = await deps.store.getByIds(result.results.map((r) => r.id));
  const runtimeById = new Map(enriched.map((s) => [s.id, s.runtime]));
  const candidates: SessionCandidate[] = result.results.map((r) => ({
    id: r.id,
    label: r.label || "(unlabelled)",
    startedAt: r.startedAt ?? null,
    runtime: runtimeById.get(r.id) ?? "",
  }));

  const picked = await deps.io.promptCandidate(role, candidates);
  if (picked === null) return { kind: "cancelled", reason: "user-cancelled-pick" };
  const match = candidates.find((c) => c.id === picked);
  if (!match) {
    deps.io.warn(`Selection ${picked} not in candidate list.`);
    return { kind: "cancelled", reason: "stale-pick" };
  }
  return { kind: "resolved", session: match };
}

async function readExistingSupersededBy(
  store: SessionStore,
  predecessorId: string,
): Promise<string | null> {
  const session = await store.getById(predecessorId);
  return session?.supersededBy ?? null;
}

async function resolveCandidateById(
  store: SessionStore,
  id: string,
): Promise<SessionCandidate> {
  const session = await store.getById(id);
  if (!session) {
    return { id, label: "(unknown)", startedAt: null, runtime: "" };
  }
  return {
    id: session.id,
    label: session.label || "(unlabelled)",
    startedAt: session.startedAt ?? null,
    runtime: session.runtime,
  };
}

// ── CLI wiring ─────────────────────────────────────────────────────────

export function defaultIO(): SupersedeIO {
  return {
    async promptQuery(label) {
      const r = await text({
        message: `Search for the ${label} session`,
        placeholder: "e.g. pgvector setup",
      });
      if (isCancel(r)) return null;
      return String(r ?? "").trim();
    },
    async promptCandidate(label, candidates) {
      const r = await select({
        message: `Pick the ${label}`,
        options: candidates.map((c) => ({
          value: c.id,
          label: formatCandidate(c),
        })),
      });
      if (isCancel(r)) return null;
      return String(r);
    },
    async promptReason() {
      const r = await text({
        message: "Reason (optional)",
        placeholder: "press enter to skip",
      });
      if (isCancel(r)) return null;
      return String(r ?? "").trim();
    },
    async confirmLink(pred, succ) {
      const r = await confirm({
        message: `Mark ${formatHandle(pred)} as superseded by ${formatHandle(succ)}?`,
        initialValue: true,
      });
      if (isCancel(r)) return false;
      return Boolean(r);
    },
    async confirmOverwrite(pred, existing, replacement) {
      log.warn(
        `${formatHandle(pred)} is already marked superseded by ${formatHandle(existing)}.`,
      );
      const r = await confirm({
        message: `Overwrite that link and point to ${formatHandle(replacement)} instead?`,
        initialValue: false,
      });
      if (isCancel(r)) return false;
      return Boolean(r);
    },
    info(line) {
      log.success(line);
    },
    warn(line) {
      log.warn(line);
    },
  };
}

function formatCandidate(c: SessionCandidate): string {
  const date = c.startedAt ? c.startedAt.slice(0, 10) : "    -    ";
  const runtime = c.runtime.padEnd(14, " ").slice(0, 14);
  const label = c.label.length > 60 ? `${c.label.slice(0, 59)}…` : c.label;
  return `${date}  ${runtime}  ${label}  [${c.id}]`;
}

/** Compact, human-readable session reference for confirm prompts. */
function formatHandle(c: SessionCandidate): string {
  const label = c.label.length > 56 ? `${c.label.slice(0, 55)}…` : c.label;
  const date = c.startedAt ? ` (${c.startedAt.slice(0, 10)})` : "";
  return `“${label}”${date}`;
}

export interface RunSupersedeArgs extends SupersedeOptions {}

export async function runSupersedeCommand(
  args: RunSupersedeArgs,
  factory: () => SupersedeDeps = buildDefaultDeps,
): Promise<void> {
  const deps = factory();
  try {
    const outcome = await executeSupersede(deps, args);
    if (outcome.kind === "cancelled") {
      cancel(`Supersede cancelled: ${outcome.reason}`);
      process.exitCode = 1;
      return;
    }
    if (outcome.kind === "noop") {
      outro(`No change — link already recorded.`);
      return;
    }
    outro(`✓ ${outcome.predecessor} ⇢ ${outcome.successor}`);
  } finally {
    closeStoreIfPossible(deps.store);
  }
}

function buildDefaultDeps(): SupersedeDeps {
  const store = openDefaultStore();
  const embedder = new OllamaClient({ baseUrl: defaultOllamaUrl() });
  const recall = new RecallService({ store, llm: embedder });
  return { store, recall, io: defaultIO() };
}

function openDefaultStore(): SqliteSessionStore {
  // Resolved lazily so test paths that pass their own factory don't touch the
  // host ~/.nlm directory. Mirrors what the main CLI's buildStack() does.
  // Constructed via SqliteStorage so lifecycle goes through the canonical
  // adapter; closeStoreIfPossible(store) closes the shared connection.
  const { dbPath, migrationsDir } = resolveDefaultPaths();
  const storage = SqliteStorage.create({ dbPath, migrationsDir });
  return storage.sessions;
}

function resolveDefaultPaths(): { dbPath: string; migrationsDir: string } {
  const home = process.env["HOME"] ?? "~";
  const dbPath = process.env["NLM_DB_PATH"] ?? `${home}/.nlm/canonical.sqlite`;
  // fileURLToPath rather than `new URL(...).pathname` so paths containing
  // spaces (e.g. "/Coding Projects/") aren't left percent-encoded.
  const migrationsDir =
    process.env["NLM_MIGRATIONS_DIR"] ??
    fileURLToPath(new URL("../../migrations/", import.meta.url));
  return { dbPath, migrationsDir };
}

function defaultOllamaUrl(): string {
  return process.env["NLM_OLLAMA_URL"] ?? "http://127.0.0.1:11434";
}

function closeStoreIfPossible(store: SessionStore): void {
  const maybe = store as unknown as { close?: () => void };
  if (typeof maybe.close === "function") maybe.close();
}

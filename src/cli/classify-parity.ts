/**
 * `nle classify-parity` — Phase C parity verification harness.
 *
 * Reads N sessions from ~/.nle/canonical.sqlite (read-only by default),
 * runs the TS OllamaClient.classify on each body, diffs the result
 * against the persisted Python classifier output, and prints aggregate
 * metrics: Jaccard similarity on entities/decisions/open sets, label
 * exact match rate, summary length delta, schema-failure count.
 *
 * Safe: opens the live store in readonly mode. Does not write anything
 * back. Designed to be run interactively from a terminal during the
 * Phase C cutover-prep window.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { OllamaClient, ClassifierSchemaError } from "../llm/ollama-client.js";
import { LLMUnreachableError } from "../ports/llm-client.js";

interface CliOptions {
  readonly limit: number;
  readonly dbPath: string;
  readonly ollamaUrl: string;
  readonly classifyModel: string;
  readonly verbose: boolean;
}

interface SessionRow {
  id: string;
  label: string;
  summary: string;
  body: string | null;
}

interface PersistedClassification {
  label: string;
  summary: string;
  entities: string[];
  decisions: string[];
  open: string[];
}

interface DiffMetrics {
  sessionId: string;
  labelMatch: boolean;
  labelTs: string;
  labelPy: string;
  entityJaccard: number;
  decisionJaccard: number;
  openJaccard: number;
  summaryDeltaChars: number;
  schemaFailure: boolean;
  errorMessage?: string;
}

export interface ParityReport {
  attempted: number;
  succeeded: number;
  schemaFailures: number;
  networkFailures: number;
  labelExactMatchRate: number;
  meanEntityJaccard: number;
  meanDecisionJaccard: number;
  meanOpenJaccard: number;
  diffs: ReadonlyArray<DiffMetrics>;
}

function parseArgs(argv: string[]): CliOptions {
  const flag = (name: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i === -1) return fallback;
    return argv[i + 1] ?? fallback;
  };
  const limit = Number.parseInt(flag("--limit", "10") ?? "10", 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
    dbPath:
      flag("--db", process.env["NLE_DB_PATH"] ?? resolve(homedir(), ".nle/canonical.sqlite")) ??
      resolve(homedir(), ".nle/canonical.sqlite"),
    ollamaUrl: flag("--ollama", process.env["NLE_OLLAMA_URL"] ?? "http://localhost:11434") ?? "http://localhost:11434",
    classifyModel: flag("--model", "phi4-mini:latest") ?? "phi4-mini:latest",
    verbose: argv.includes("--verbose"),
  };
}

function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const setA = new Set(a.map((s) => s.toLowerCase().trim()));
  const setB = new Set(b.map((s) => s.toLowerCase().trim()));
  if (setA.size === 0 && setB.size === 0) return 1;
  const inter = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return inter.size / union.size;
}

export async function runParity(opts: CliOptions): Promise<ParityReport> {
  const db = new Database(opts.dbPath, { readonly: true });
  sqliteVec.load(db);

  const rows = db
    .prepare<[number], SessionRow>(
      `SELECT id, label, summary, body
       FROM sessions
       WHERE body IS NOT NULL AND body != ''
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(opts.limit);

  const persistedById = new Map<string, PersistedClassification>();
  for (const r of rows) {
    const entities = db
      .prepare<[string], { entity_canonical: string }>(
        "SELECT entity_canonical FROM session_entities WHERE session_id = ?",
      )
      .all(r.id)
      .map((x) => x.entity_canonical);
    const markers = db
      .prepare<[string], { kind: "decision" | "open"; text: string }>(
        "SELECT kind, text FROM markers WHERE session_id = ? ORDER BY position",
      )
      .all(r.id);
    persistedById.set(r.id, {
      label: r.label,
      summary: r.summary,
      entities,
      decisions: markers.filter((m) => m.kind === "decision").map((m) => m.text),
      open: markers.filter((m) => m.kind === "open").map((m) => m.text),
    });
  }
  db.close();

  const client = new OllamaClient({
    baseUrl: opts.ollamaUrl,
    classifyModel: opts.classifyModel,
  });

  const diffs: DiffMetrics[] = [];
  let schemaFailures = 0;
  let networkFailures = 0;

  for (const r of rows) {
    const py = persistedById.get(r.id);
    if (!py || !r.body) continue;

    try {
      const ts = await client.classify(r.body);
      const labelMatch = ts.label.toLowerCase().trim() === py.label.toLowerCase().trim();
      diffs.push({
        sessionId: r.id,
        labelMatch,
        labelTs: ts.label,
        labelPy: py.label,
        entityJaccard: jaccard(ts.entities, py.entities),
        decisionJaccard: jaccard(ts.decisions, py.decisions),
        openJaccard: jaccard(ts.open, py.open),
        summaryDeltaChars: ts.summary.length - py.summary.length,
        schemaFailure: false,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof ClassifierSchemaError) schemaFailures += 1;
      else if (e instanceof LLMUnreachableError) networkFailures += 1;
      diffs.push({
        sessionId: r.id,
        labelMatch: false,
        labelTs: "",
        labelPy: py.label,
        entityJaccard: 0,
        decisionJaccard: 0,
        openJaccard: 0,
        summaryDeltaChars: 0,
        schemaFailure: e instanceof ClassifierSchemaError,
        errorMessage: message,
      });
    }
  }

  const successes = diffs.filter((d) => !d.errorMessage);
  const mean = (xs: ReadonlyArray<number>): number =>
    xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000;

  return {
    attempted: diffs.length,
    succeeded: successes.length,
    schemaFailures,
    networkFailures,
    labelExactMatchRate: mean(successes.map((d) => (d.labelMatch ? 1 : 0))),
    meanEntityJaccard: mean(successes.map((d) => d.entityJaccard)),
    meanDecisionJaccard: mean(successes.map((d) => d.decisionJaccard)),
    meanOpenJaccard: mean(successes.map((d) => d.openJaccard)),
    diffs,
  };
}

export async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.error(`nle classify-parity: ${opts.limit} sessions from ${opts.dbPath}`);
  console.error(`  ollama: ${opts.ollamaUrl}  model: ${opts.classifyModel}`);
  const report = await runParity(opts);

  if (opts.verbose) {
    for (const d of report.diffs) {
      const tag = d.errorMessage ? "ERR" : d.labelMatch ? "EQ " : "DIFF";
      console.error(
        `  ${tag} ${d.sessionId}  ent=${d.entityJaccard.toFixed(2)} dec=${d.decisionJaccard.toFixed(2)} open=${d.openJaccard.toFixed(2)}` +
          (d.errorMessage ? ` :: ${d.errorMessage}` : ""),
      );
    }
  }

  console.error("");
  console.error(`attempted:           ${report.attempted}`);
  console.error(`succeeded:           ${report.succeeded}`);
  console.error(`schema failures:     ${report.schemaFailures}`);
  console.error(`network failures:    ${report.networkFailures}`);
  console.error(`label exact match:   ${(report.labelExactMatchRate * 100).toFixed(1)}%`);
  console.error(`mean Jaccard ents:   ${report.meanEntityJaccard.toFixed(3)}`);
  console.error(`mean Jaccard decs:   ${report.meanDecisionJaccard.toFixed(3)}`);
  console.error(`mean Jaccard open:   ${report.meanOpenJaccard.toFixed(3)}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error("classify-parity fatal:", e);
    process.exit(1);
  });
}

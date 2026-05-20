/**
 * backfill-facts — one-shot population of the FactStore from the existing
 * session corpus. Phase B.5, see docs/plans/factstore-design.md Section 7.
 *
 * For each session in `sessions` that has no facts yet (and was started
 * before the script's start timestamp, to avoid racing with live ingest),
 * runs the classifier over its body, extracts facts, and writes them via
 * SqliteSessionStore.insertFactsForSession.
 *
 * Resumable via a JSON state file (mirrors core/embedding/embed-backfill).
 * Interrupting and rerunning skips already-processed sessions. State path
 * defaults to ~/.nlm/backfill_facts.state.
 *
 * Layering: depends on the LLMClient + FactStore ports through the
 * SqliteSessionStore + SqliteFactStore composition. Lives under core/ but
 * is invoked from the CLI composition root, like embed-backfill.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { extractFacts } from "../facts/extract-facts.js";
import { LLMUnreachableError } from "../../ports/llm-client.js";
const DEFAULT_STATE_PATH = join(homedir(), ".nlm", "backfill_facts.state");
const SAVE_EVERY = 25;
function loadState(path) {
    if (!existsSync(path))
        return new Set();
    try {
        const data = JSON.parse(readFileSync(path, "utf8"));
        return new Set(data.done ?? []);
    }
    catch {
        return new Set();
    }
}
function saveState(path, done) {
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ done: Array.from(done) }, null, 0));
}
export async function backfillFacts(opts) {
    const startedAtCutoff = new Date().toISOString();
    const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
    const done = opts.dryRun ? new Set() : loadState(statePath);
    const db = opts.store.rawDb();
    // Eligible sessions: started strictly before this run's cutoff (don't
    // race with live ingest), with a non-empty body (the classifier needs
    // transcript text). When reprocess=false, exclude sessions that already
    // have facts attributed to them.
    const sql = opts.reprocess
        ? `
      SELECT id, started_at, body
      FROM sessions
      WHERE started_at < ?
        AND body IS NOT NULL AND length(body) > 0
        ${opts.from ? "AND id > ?" : ""}
      ORDER BY started_at ASC, id ASC
    `
        : `
      SELECT s.id, s.started_at, s.body
      FROM sessions s
      WHERE s.started_at < ?
        AND s.body IS NOT NULL AND length(s.body) > 0
        AND NOT EXISTS (
          SELECT 1 FROM facts f WHERE f.source_session_id = s.id
        )
        ${opts.from ? "AND s.id > ?" : ""}
      ORDER BY s.started_at ASC, s.id ASC
    `;
    const rows = opts.from
        ? db.prepare(sql).all(startedAtCutoff, opts.from)
        : db.prepare(sql).all(startedAtCutoff);
    // Filter state-file-known done ids BEFORE applying limit. Without this,
    // a dense cluster of previously-skipped (low-confidence) sessions would
    // burn the batch's --limit on no-op skips. With it, --limit N means
    // "N actually-processable sessions" — much more useful UX for repeated
    // small batches that walk forward through the corpus. The pre-filter
    // count gets reported as `skippedAlreadyDone` so the operator still sees
    // how big the skip region was.
    const skippedByStateFile = rows.filter((r) => done.has(r.id)).length;
    const candidates = rows.filter((r) => !done.has(r.id));
    const limit = opts.limit ?? candidates.length;
    const work = candidates.slice(0, limit);
    const total = work.length;
    let processed = 0;
    let factsWritten = 0;
    let skippedAlreadyDone = skippedByStateFile;
    let skippedExistingFacts = 0;
    let skippedNoBody = 0;
    let skippedLowConfidence = 0;
    let classifyFailures = 0;
    let storageFailures = 0;
    for (let i = 0; i < work.length; i++) {
        const row = work[i];
        const sid = row.id;
        // No per-iteration `done` check needed — `work` is already filtered
        // against the state file above.
        if (!row.body || row.body.length === 0) {
            skippedNoBody += 1;
            opts.onProgress?.(i + 1, total, sid, "skipped_no_body");
            continue;
        }
        let classification;
        try {
            classification = await opts.classifier.classify(row.body);
        }
        catch (err) {
            classifyFailures += 1;
            const detail = err instanceof LLMUnreachableError
                ? "ollama unreachable — stopping run"
                : err instanceof Error
                    ? err.message
                    : String(err);
            opts.onProgress?.(i + 1, total, sid, "classify_failed", detail);
            // Ollama-down is fatal: every subsequent classify will fail. Stop
            // here so the operator can fix and resume.
            if (err instanceof LLMUnreachableError)
                break;
            continue;
        }
        const facts = extractFacts(classification, sid, row.started_at);
        if (facts.length === 0) {
            skippedLowConfidence += 1;
            opts.onProgress?.(i + 1, total, sid, "skipped_low_confidence", `confidence=${classification.confidence}`);
            // Mark done so a re-run doesn't keep paying the classifier cost on
            // sessions the model can't extract anything from.
            done.add(sid);
            if (!opts.dryRun && processed % SAVE_EVERY === 0)
                saveState(statePath, done);
            continue;
        }
        if (opts.dryRun) {
            factsWritten += facts.length;
            processed += 1;
            opts.onProgress?.(i + 1, total, sid, "ok", `would-write=${facts.length}`);
            continue;
        }
        try {
            await opts.store.insertFactsForSession(sid, opts.factStore, facts, opts.embedder ?? null);
        }
        catch (err) {
            storageFailures += 1;
            const detail = err instanceof Error ? err.message : String(err);
            opts.onProgress?.(i + 1, total, sid, "storage_failed", detail);
            continue;
        }
        factsWritten += facts.length;
        processed += 1;
        done.add(sid);
        opts.onProgress?.(i + 1, total, sid, "ok", `wrote=${facts.length}`);
        if (processed % SAVE_EVERY === 0)
            saveState(statePath, done);
    }
    if (!opts.dryRun)
        saveState(statePath, done);
    return {
        total,
        processed,
        factsWritten,
        skippedAlreadyDone,
        skippedExistingFacts,
        skippedNoBody,
        skippedLowConfidence,
        classifyFailures,
        storageFailures,
    };
}
//# sourceMappingURL=backfill-facts.js.map
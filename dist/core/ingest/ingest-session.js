/**
 * ingestSession — push a single externally-supplied session through the
 * normal classifier → embedder → store pipeline.
 *
 * Shared by the webhook endpoint (POST /api/ingest) and anything else
 * that wants to push without going through a TranscriptAdapter. Mirrors
 * the inner loop of ScanScheduler.runOnce but accepts a pre-built chunk.
 */
import { createHash } from "node:crypto";
import { extractFacts } from "../facts/extract-facts.js";
const BODY_CAP = 200_000;
const CONFIDENCE_FLOOR = 0.3;
export function deriveSessionId(runtime, startedAt, text) {
    const hash = createHash("sha256")
        .update(runtime)
        .update("|")
        .update(startedAt)
        .update("|")
        .update(text.slice(0, 4_000))
        .digest("hex")
        .slice(0, 16);
    return `webhook_${hash}`;
}
export async function ingestSession(input, deps) {
    const startedAt = input.startedAt ?? new Date().toISOString();
    const id = input.id ?? deriveSessionId(input.runtime, startedAt, input.text);
    const log = deps.log ?? ((m) => console.error(m));
    const t0 = Date.now();
    let classification;
    try {
        classification = await deps.classifier.classify(input.text);
    }
    catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log(`[ingest] classifier failed for ${id}: ${error}`);
        return { id, status: "classifier_failed", latencyMs: Date.now() - t0, error };
    }
    if (classification.confidence < CONFIDENCE_FLOOR) {
        return {
            id,
            status: "low_confidence",
            latencyMs: Date.now() - t0,
            confidence: classification.confidence,
        };
    }
    const record = {
        id,
        runtime: input.runtime,
        runtimeSessionId: input.runtimeSessionId ?? null,
        startedAt,
        endedAt: input.endedAt ?? null,
        durationMin: null,
        label: classification.label,
        summary: classification.summary,
        body: input.text.slice(0, BODY_CAP),
        status: "closed",
        transcriptKind: "webhook",
        transcriptPath: input.transcriptPath ?? null,
        transcriptOffset: null,
        transcriptLength: null,
        entities: classification.entities,
        decisions: classification.decisions,
        openQuestions: classification.open,
    };
    const factSink = deps.factStore
        ? { factStore: deps.factStore, facts: extractFacts(classification, id, startedAt) }
        : null;
    await deps.store.insertSession(record, deps.embedder, null, factSink);
    return { id, status: "ingested", latencyMs: Date.now() - t0, confidence: classification.confidence };
}
//# sourceMappingURL=ingest-session.js.map
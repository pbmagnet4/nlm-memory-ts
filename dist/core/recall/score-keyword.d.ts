/**
 * Keyword scoring for a single session against query tokens.
 *
 * Field weights mirror recall.py:_WEIGHTS. The scorer is a pure function over
 * {session, query tokens} — no DB, no embedder, no I/O. This is the layer the
 * tests pin to byte-for-byte parity with the Python implementation.
 */
import type { Session, MatchField } from "../../shared/types.js";
export interface KeywordScore {
    readonly score: number;
    readonly matchedIn: ReadonlyArray<MatchField>;
}
export declare function scoreKeyword(session: Pick<Session, "label" | "summary" | "decisions" | "open">, queryTokens: ReadonlySet<string>): KeywordScore;

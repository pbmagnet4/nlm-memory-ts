/**
 * SourceRegistry — CRUD over the `sources` table.
 *
 * A "source" is any transcript origin the daemon scans (Claude Code's
 * projects dir, Hermes's sessions dir, pi.dev, a user-defined JSONL
 * directory, or a webhook).
 *
 * The three legacy adapters (claude-code, hermes, pi) seed as preset rows
 * pointing at fixed `path_or_url` values. The generic JSONL adapter and
 * webhook ingest piggy-back on this same table — the scheduler chooses
 * which adapter to dispatch by reading `kind`.
 *
 * See docs/plans/desktop-product.md (Phase 0).
 */
import type Database from "better-sqlite3";
export type SourceKind = "claude-code" | "hermes" | "pi" | "jsonl-generic" | "webhook";
export interface SourceRow {
    readonly id: number;
    readonly kind: SourceKind;
    readonly name: string;
    readonly pathOrUrl: string | null;
    readonly runtimeLabel: string;
    readonly parseConfig: Record<string, unknown>;
    readonly enabled: boolean;
    /** Only populated on the response from `insert()` for webhook sources.
     *  Always `null` from `list()` / `get()`. Use `getToken()` inside the daemon. */
    readonly token: string | null;
    readonly hasToken: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface SourceInsert {
    readonly kind: SourceKind;
    readonly name: string;
    readonly pathOrUrl?: string | null;
    readonly runtimeLabel: string;
    readonly parseConfig?: Record<string, unknown>;
    readonly enabled?: boolean;
}
export interface SourceUpdate {
    readonly name?: string;
    readonly pathOrUrl?: string | null;
    readonly runtimeLabel?: string;
    readonly parseConfig?: Record<string, unknown>;
    readonly enabled?: boolean;
}
export declare class SourceRegistry {
    private readonly db;
    constructor(db: Database.Database);
    list(): SourceRow[];
    get(id: number): SourceRow | null;
    getByName(name: string): SourceRow | null;
    insert(input: SourceInsert): SourceRow;
    /** Daemon-internal: resolve a bearer token to its owning source. */
    findByToken(token: string): SourceRow | null;
    /** Daemon-internal: returns the raw token. Never echo to HTTP responses. */
    getToken(id: number): string | null;
    /** Mint a fresh token, invalidating any previous one. */
    regenerateToken(id: number): string | null;
    update(id: number, patch: SourceUpdate): SourceRow | null;
    delete(id: number): boolean;
    /**
     * Seed the three legacy adapter presets on first boot of an empty
     * registry. Subsequent boots are no-ops. Respects per-runtime env
     * overrides so existing installs don't lose their custom paths.
     */
    seedDefaults(): void;
}

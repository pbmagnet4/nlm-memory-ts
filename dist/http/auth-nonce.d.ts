/**
 * In-memory single-use nonce store for the `nlm ui` bootstrap.
 *
 * Why this exists: opening /ui/auth?t=<NLM_MCP_TOKEN> puts the long-lived
 * shared secret directly in browser history and (depending on the
 * browser) crash logs, sync state, and shoulder-surf range. The nonce
 * pattern replaces that with a short-lived, single-use credential the
 * CLI requests over a Bearer-authenticated /api call, then redeems via
 * the browser. If the URL leaks, replay is bounded to a 60-second
 * window AND fails immediately once the legitimate browser redeems.
 *
 * Storage is in-process: daemon restart wipes outstanding nonces, which
 * is fine — the CLI mints a fresh one on every invocation.
 */
export interface NonceStore {
    mint(): {
        nonce: string;
        expiresInSec: number;
    };
    redeem(nonce: string): boolean;
    size(): number;
}
export interface NonceStoreOptions {
    readonly ttlMs?: number;
    readonly now?: () => number;
}
export declare function createNonceStore(opts?: NonceStoreOptions): NonceStore;

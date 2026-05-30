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

import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 60 * 1000;
const NONCE_BYTES = 24;

export interface NonceStore {
  mint(): { nonce: string; expiresInSec: number };
  redeem(nonce: string): boolean;
  size(): number;
}

export interface NonceStoreOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export function createNonceStore(opts: NonceStoreOptions = {}): NonceStore {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const store = new Map<string, number>();

  function purgeExpired(): void {
    const t = now();
    for (const [n, exp] of store) {
      if (exp <= t) store.delete(n);
    }
  }

  return {
    mint() {
      purgeExpired();
      const nonce = randomBytes(NONCE_BYTES).toString("base64url");
      store.set(nonce, now() + ttl);
      return { nonce, expiresInSec: Math.round(ttl / 1000) };
    },
    redeem(nonce: string): boolean {
      if (!nonce) return false;
      const exp = store.get(nonce);
      if (exp === undefined) return false;
      // Always remove on lookup — single-use, even if expired we don't
      // want it lingering for a second attempt.
      store.delete(nonce);
      return exp > now();
    },
    size() {
      purgeExpired();
      return store.size;
    },
  };
}

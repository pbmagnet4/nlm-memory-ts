import { describe, expect, it } from "vitest";
import { createNonceStore } from "../../../src/http/auth-nonce.js";

describe("createNonceStore", () => {
  it("mints unique nonces", () => {
    const store = createNonceStore();
    const a = store.mint().nonce;
    const b = store.mint().nonce;
    expect(a).not.toBe(b);
  });

  it("redeems a freshly-minted nonce exactly once", () => {
    const store = createNonceStore();
    const { nonce } = store.mint();
    expect(store.redeem(nonce)).toBe(true);
    expect(store.redeem(nonce)).toBe(false);
  });

  it("rejects an unknown nonce", () => {
    const store = createNonceStore();
    expect(store.redeem("not-real")).toBe(false);
  });

  it("rejects empty / undefined-shaped input", () => {
    const store = createNonceStore();
    expect(store.redeem("")).toBe(false);
  });

  it("rejects a nonce after TTL elapses", () => {
    let t = 1000;
    const store = createNonceStore({ ttlMs: 100, now: () => t });
    const { nonce } = store.mint();
    t = 1099;
    // Right before expiry
    const peekStore = createNonceStore({ ttlMs: 100, now: () => t });
    // (separate peek for clarity — actual store still has the nonce)
    t = 1101;
    expect(store.redeem(nonce)).toBe(false);
    expect(peekStore.size()).toBe(0);
  });

  it("returns expiresInSec roughly matching the configured TTL", () => {
    const store = createNonceStore({ ttlMs: 60_000 });
    expect(store.mint().expiresInSec).toBe(60);
  });

  it("does not allow a redeem-after-expiry to succeed even though it deletes the entry", () => {
    let t = 0;
    const store = createNonceStore({ ttlMs: 50, now: () => t });
    const { nonce } = store.mint();
    t = 100;
    expect(store.redeem(nonce)).toBe(false);
    // After the failed redeem, second attempt also fails (entry removed)
    expect(store.redeem(nonce)).toBe(false);
  });

  it("mints high-entropy nonces (≥ 32 chars of base64url)", () => {
    const { nonce } = createNonceStore().mint();
    expect(nonce.length).toBeGreaterThanOrEqual(32);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

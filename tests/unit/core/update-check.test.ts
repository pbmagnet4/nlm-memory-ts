/**
 * Update-check tests. Verifies the cache TTL, opt-out env var, semver
 * comparison, registry failure fallback, and the no-throw contract.
 *
 * No real network: every test injects a fetch stub. The cache path is
 * redirected into a per-test tmpdir so the host ~/.nlm/update-check.json
 * is never touched.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getUpdateStatus,
  isStrictlyNewer,
} from "../../../src/core/update-check/check.js";

describe("isStrictlyNewer", () => {
  it("returns true when major/minor/patch increments", () => {
    expect(isStrictlyNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isStrictlyNewer("0.6.0", "0.5.9")).toBe(true);
    expect(isStrictlyNewer("0.5.8", "0.5.7")).toBe(true);
  });

  it("returns false on equal versions", () => {
    expect(isStrictlyNewer("0.5.8", "0.5.8")).toBe(false);
  });

  it("returns false when candidate is older", () => {
    expect(isStrictlyNewer("0.5.7", "0.5.8")).toBe(false);
    expect(isStrictlyNewer("0.4.99", "0.5.0")).toBe(false);
  });

  it("treats v-prefix as equivalent", () => {
    expect(isStrictlyNewer("v0.5.8", "0.5.7")).toBe(true);
    expect(isStrictlyNewer("0.5.8", "v0.5.7")).toBe(true);
  });

  it("returns false on unparseable versions", () => {
    expect(isStrictlyNewer("garbage", "0.5.0")).toBe(false);
    expect(isStrictlyNewer("0.5.0", "also garbage")).toBe(false);
  });

  it("ranks stable releases above prereleases of the same triple", () => {
    expect(isStrictlyNewer("0.6.0", "0.6.0-rc.1")).toBe(true);
    expect(isStrictlyNewer("0.6.0-rc.1", "0.6.0")).toBe(false);
  });
});

describe("getUpdateStatus", () => {
  let tmp: string;
  let cachePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-upd-"));
    cachePath = join(tmp, "update-check.json");
    delete process.env["NLM_DISABLE_UPDATE_CHECK"];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env["NLM_DISABLE_UPDATE_CHECK"];
  });

  it("flags `behind: true` when the registry returns a newer version", async () => {
    const status = await getUpdateStatus({
      currentVersion: "0.5.7",
      cachePath,
      fetchImpl: stubFetch({ version: "0.5.8" }),
    });
    expect(status.current).toBe("0.5.7");
    expect(status.latest).toBe("0.5.8");
    expect(status.behind).toBe(true);
    expect(status.disabled).toBeUndefined();
  });

  it("flags `behind: false` when on the latest version", async () => {
    const status = await getUpdateStatus({
      currentVersion: "0.5.8",
      cachePath,
      fetchImpl: stubFetch({ version: "0.5.8" }),
    });
    expect(status.behind).toBe(false);
  });

  it("returns user-opt-out when NLM_DISABLE_UPDATE_CHECK=1 (no network call)", async () => {
    process.env["NLM_DISABLE_UPDATE_CHECK"] = "1";
    let called = false;
    const status = await getUpdateStatus({
      currentVersion: "0.5.7",
      cachePath,
      fetchImpl: (async () => {
        called = true;
        return new Response("nope", { status: 200 });
      }) as typeof fetch,
    });
    expect(status.disabled).toBe("user-opt-out");
    expect(status.behind).toBe(false);
    expect(called).toBe(false);
  });

  it("reuses the cached value within the 24h TTL (no second network call)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: "0.5.8" }), { status: 200 });
    }) as typeof fetch;

    const first = await getUpdateStatus({
      currentVersion: "0.5.7",
      cachePath,
      fetchImpl,
    });
    const second = await getUpdateStatus({
      currentVersion: "0.5.7",
      cachePath,
      fetchImpl,
    });

    expect(calls).toBe(1);
    expect(second.latest).toBe(first.latest);
  });

  it("refetches when the cache is older than 24h", async () => {
    // Pre-seed a cache from 48h ago with a stale value.
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
    writeFileSync(
      cachePath,
      JSON.stringify({
        current: "0.5.7",
        latest: "0.5.7",
        checkedAt: stale.toISOString(),
      }),
    );

    const status = await getUpdateStatus({
      currentVersion: "0.5.7",
      cachePath,
      fetchImpl: stubFetch({ version: "0.5.8" }),
    });
    expect(status.latest).toBe("0.5.8");
    expect(status.behind).toBe(true);

    const written = JSON.parse(readFileSync(cachePath, "utf8")) as {
      latest: string;
    };
    expect(written.latest).toBe("0.5.8");
  });

  it("marks the result as unknown-error when the registry returns non-OK", async () => {
    const status = await getUpdateStatus({
      currentVersion: "0.5.7",
      cachePath,
      fetchImpl: (async () =>
        new Response("server boom", { status: 503 })) as typeof fetch,
    });
    expect(status.latest).toBeNull();
    expect(status.behind).toBe(false);
    expect(status.disabled).toBe("unknown-error");
  });

  it("does not throw when fetch itself rejects (offline path)", async () => {
    const status = await getUpdateStatus({
      currentVersion: "0.5.7",
      cachePath,
      fetchImpl: (async () => {
        throw new TypeError("offline");
      }) as typeof fetch,
    });
    expect(status.latest).toBeNull();
    expect(status.behind).toBe(false);
    expect(status.disabled).toBe("unknown-error");
  });
});

function stubFetch(body: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

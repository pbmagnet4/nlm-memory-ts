import { describe, expect, it } from "vitest";
import {
  buildClearCookie,
  buildSessionCookie,
  deriveSessionValue,
  parseCookies,
  sanitizeNextPath,
  SESSION_COOKIE_NAME,
  verifySessionCookie,
} from "../../../src/http/ui-auth.js";

describe("deriveSessionValue", () => {
  it("is deterministic for a given token", () => {
    expect(deriveSessionValue("hunter2")).toBe(deriveSessionValue("hunter2"));
  });

  it("changes when the token changes (token rotation invalidates cookies)", () => {
    expect(deriveSessionValue("a")).not.toBe(deriveSessionValue("b"));
  });

  it("never reveals the raw token in its output", () => {
    const token = "very-secret-token-zz";
    expect(deriveSessionValue(token)).not.toContain(token);
  });

  it("emits a 64-char hex digest (SHA-256)", () => {
    expect(deriveSessionValue("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifySessionCookie", () => {
  const token = "test-token";
  const good = deriveSessionValue(token);

  it("accepts the cookie derived from the same token", () => {
    expect(verifySessionCookie(good, token)).toBe(true);
  });

  it("rejects a cookie minted under a different token", () => {
    expect(verifySessionCookie(deriveSessionValue("other"), token)).toBe(false);
  });

  it("rejects undefined / empty cookie", () => {
    expect(verifySessionCookie(undefined, token)).toBe(false);
    expect(verifySessionCookie("", token)).toBe(false);
  });

  it("rejects a cookie with length mismatch without crashing", () => {
    expect(verifySessionCookie("abc", token)).toBe(false);
  });

  it("rejects a same-length but wrong-byte cookie", () => {
    const wrong = "0".repeat(good.length);
    expect(verifySessionCookie(wrong, token)).toBe(false);
  });
});

describe("parseCookies", () => {
  it("returns empty for missing header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it("parses a single cookie", () => {
    expect(parseCookies("a=1")).toEqual({ a: "1" });
  });

  it("parses multiple cookies separated by '; '", () => {
    expect(parseCookies("a=1; b=2; nlm_ui_session=abc")).toEqual({
      a: "1",
      b: "2",
      nlm_ui_session: "abc",
    });
  });

  it("trims whitespace around names and values", () => {
    expect(parseCookies("  a = 1 ;  b=2")).toEqual({ a: "1", b: "2" });
  });

  it("ignores malformed segments without crashing", () => {
    expect(parseCookies("a=1; junk; b=2")).toEqual({ a: "1", b: "2" });
  });

  it("ignores entries with empty names", () => {
    expect(parseCookies("=v; a=1")).toEqual({ a: "1" });
  });
});

describe("buildSessionCookie / buildClearCookie", () => {
  it("session cookie carries HttpOnly, SameSite=Strict, long Max-Age", () => {
    const c = buildSessionCookie("v");
    expect(c).toMatch(/^nlm_ui_session=v/);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).toMatch(/Max-Age=\d{6,}/);
  });

  it("clear cookie sets Max-Age=0", () => {
    expect(buildClearCookie()).toContain("Max-Age=0");
  });

  it("SESSION_COOKIE_NAME export matches what builders emit", () => {
    expect(buildSessionCookie("v").startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  });
});

describe("sanitizeNextPath (open-redirect guard)", () => {
  it("passes a clean /ui/ path through", () => {
    expect(sanitizeNextPath("/ui/pulse")).toBe("/ui/pulse");
  });

  it("rejects absolute URLs", () => {
    expect(sanitizeNextPath("https://evil.com/")).toBe("/ui/");
  });

  it("rejects protocol-relative URLs", () => {
    expect(sanitizeNextPath("//evil.com/")).toBe("/ui/");
  });

  it("rejects paths outside /ui/", () => {
    expect(sanitizeNextPath("/api/admin")).toBe("/ui/");
    expect(sanitizeNextPath("/")).toBe("/ui/");
  });

  it("rejects path-traversal attempts", () => {
    expect(sanitizeNextPath("/ui/../etc/passwd")).toBe("/ui/");
  });

  it("falls back to /ui/ for empty input", () => {
    expect(sanitizeNextPath(undefined)).toBe("/ui/");
    expect(sanitizeNextPath("")).toBe("/ui/");
  });
});

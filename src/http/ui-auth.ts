/**
 * UI session-cookie auth.
 *
 * Closes the port-forward bypass that the existing /api/* gate couldn't
 * close on its own: any client reaching the local port can spoof Host +
 * Origin headers and walk past the Bearer check. By moving UI auth onto
 * a cookie, we get:
 *
 *   - HttpOnly: JS (including XSS payloads) can't read the cookie value
 *   - SameSite=Strict: cross-origin browser drive-bys can't carry it
 *   - Cookie value is HMAC(token, "ui-session.v1"), not the raw token —
 *     so a cookie leak doesn't compromise the underlying NLM_MCP_TOKEN
 *   - Token rotation invalidates every outstanding cookie automatically
 *
 * The cookie is bootstrapped via /ui/auth?t=<NLM_MCP_TOKEN>, which the
 * `nlm ui` CLI emits with the token already substituted. After bootstrap,
 * the cookie carries the SPA's `/api/*` calls too — no more Bearer needed
 * from the browser path.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "nlm_ui_session";

const HMAC_INFO = "ui-session.v1";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Derive the cookie value from the current NLM_MCP_TOKEN. Deterministic —
 * same token always yields the same HMAC, so cookies survive daemon
 * restarts as long as the token is unchanged.
 */
export function deriveSessionValue(token: string): string {
  return createHmac("sha256", token).update(HMAC_INFO).digest("hex");
}

/**
 * Constant-time check that a cookie value matches the current token's
 * expected HMAC. Returns false on length mismatch (no early-out leak).
 */
export function verifySessionCookie(cookieValue: string | undefined, token: string): boolean {
  if (!cookieValue) return false;
  const expected = deriveSessionValue(token);
  const got = Buffer.from(cookieValue, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/**
 * Minimal cookie-header parser. Skips malformed entries silently rather
 * than throwing — a single junk cookie in the jar shouldn't break auth.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out[name] = part.slice(idx + 1).trim();
  }
  return out;
}

export function buildSessionCookie(value: string): string {
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

export function buildClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Reject open-redirect attempts on the `next` param. We only redirect
 * back into our own /ui/ tree; anything else (absolute URLs, protocol-
 * relative, attempts to escape via ../) collapses to /ui/.
 */
export function sanitizeNextPath(next: string | undefined): string {
  if (!next) return "/ui/";
  if (!next.startsWith("/ui/") && next !== "/ui") return "/ui/";
  if (next.includes("//") || next.includes("..")) return "/ui/";
  return next;
}

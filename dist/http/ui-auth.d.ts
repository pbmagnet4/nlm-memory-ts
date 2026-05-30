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
export declare const SESSION_COOKIE_NAME = "nlm_ui_session";
/**
 * Derive the cookie value from the current NLM_MCP_TOKEN. Deterministic —
 * same token always yields the same HMAC, so cookies survive daemon
 * restarts as long as the token is unchanged.
 */
export declare function deriveSessionValue(token: string): string;
/**
 * Constant-time check that a cookie value matches the current token's
 * expected HMAC. Returns false on length mismatch (no early-out leak).
 */
export declare function verifySessionCookie(cookieValue: string | undefined, token: string): boolean;
/**
 * Minimal cookie-header parser. Skips malformed entries silently rather
 * than throwing — a single junk cookie in the jar shouldn't break auth.
 */
export declare function parseCookies(header: string | undefined): Record<string, string>;
export declare function buildSessionCookie(value: string): string;
export declare function buildClearCookie(): string;
/**
 * Reject open-redirect attempts on the `next` param. We only redirect
 * back into our own /ui/ tree; anything else (absolute URLs, protocol-
 * relative, attempts to escape via ../) collapses to /ui/.
 */
export declare function sanitizeNextPath(next: string | undefined): string;

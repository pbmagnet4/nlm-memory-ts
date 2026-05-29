/**
 * Shared helper: Bearer token for hook → /api/* HTTP calls.
 *
 * The HTTP daemon's /api/* gate requires either a same-origin browser
 * request (Origin header set by the browser) or a Bearer token. Hooks
 * are CLI processes with no Origin, so they need the token.
 *
 * Reads NLM_MCP_TOKEN from process.env (assumes autoloadEnv() has been
 * called first). Returns an empty headers object when no token is set
 * so legacy installs without a token still work — the daemon's gate
 * also accepts unauthenticated loopback requests when no token is set.
 */

export function hookAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env["NLM_MCP_TOKEN"];
  if (!token) return { ...extra };
  return { ...extra, authorization: `Bearer ${token}` };
}

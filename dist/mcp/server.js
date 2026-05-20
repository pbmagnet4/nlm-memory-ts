/**
 * MCP adapter. Binds the `recall_sessions` and `get_session` tools directly
 * to RecallService and SessionStore — no HTTP hop, no localhost loopback.
 *
 * The Python daemon's MCP server proxied through HTTP. This server runs in
 * the same process as the rest of nlm-memory, so a tool call is a function
 * call. Lower latency, simpler stack traces, one fewer thing to keep alive.
 *
 * Layering: this module knows about the inner ring (RecallService,
 * SessionStore); core/ does not know this module exists.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encode as toonEncode } from "@toon-format/toon";
import { z } from "zod";
const CHARACTER_LIMIT = 25_000;
const DEFAULT_LIMIT = 10;
const SERVER_NAME = "nlm-memory-mcp-server";
const SERVER_VERSION = "0.3.0";
/** TOON encoding cuts token usage on large recall payloads. Opt in via
 *  NLM_FORMAT=toon in the MCP server's env (see .mcp.json). Defaults to JSON. */
const USE_TOON = process.env.NLM_FORMAT === "toon";
function format(data) {
    if (USE_TOON) {
        try {
            return toonEncode(data);
        }
        catch {
            return JSON.stringify(data, null, 2);
        }
    }
    return JSON.stringify(data, null, 2);
}
function truncate(data) {
    const str = format(data);
    if (str.length <= CHARACTER_LIMIT)
        return str;
    return format({
        truncated: true,
        truncation_message: "Response too large. Lower limit or fetch fewer fields via get_session.",
    });
}
function ok(data) {
    return { content: [{ type: "text", text: truncate(data) }] };
}
function err(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        isError: true,
        content: [{ type: "text", text: `Error: ${message}` }],
    };
}
export async function recallSessionsHandler(deps, input) {
    try {
        const query = {
            query: input.query ?? "",
            mode: input.mode ?? "keyword",
            limit: input.limit ?? DEFAULT_LIMIT,
            ...(input.entity !== undefined ? { entity: input.entity } : {}),
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
        };
        const result = await deps.recall.search(query);
        return ok(result);
    }
    catch (e) {
        return err(e);
    }
}
export async function getSessionHandler(deps, input) {
    try {
        const session = await deps.store.getById(input.id);
        if (!session) {
            return err(new Error(`session ${input.id} not found`));
        }
        return ok(session);
    }
    catch (e) {
        return err(e);
    }
}
export async function recallFactsHandler(deps, input) {
    if (!deps.factRecall) {
        return err(new Error("fact recall not wired in this deployment"));
    }
    try {
        const query = {
            query: input.query ?? "",
            mode: input.mode ?? "keyword",
            limit: input.limit ?? DEFAULT_LIMIT,
            ...(input.subject !== undefined ? { subject: input.subject } : {}),
            ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
            ...(input.includeSuperseded !== undefined
                ? { includeSuperseded: input.includeSuperseded }
                : {}),
            ...(input.minConfidence !== undefined
                ? { minConfidence: input.minConfidence }
                : {}),
        };
        const result = await deps.factRecall.search(query);
        return ok(result);
    }
    catch (e) {
        return err(e);
    }
}
export async function getFactHistoryHandler(deps, input) {
    if (!deps.factStore) {
        return err(new Error("fact store not wired in this deployment"));
    }
    try {
        const chains = await deps.factStore.getHistory(input.subject, input.predicate);
        return ok({ subject: input.subject, predicate: input.predicate ?? null, chains });
    }
    catch (e) {
        return err(e);
    }
}
const RECALL_DESCRIPTION = `Search prior AI sessions from the local nlm-memory canonical store.
Use this whenever the user's question references past work, prior decisions,
unresolved questions, or anything that might already be answered in earlier
Claude Code, Hermes, or pi.dev sessions. Examples:

  - "what did we decide about pgvector?"
  - "what's still open on the pulse rewrite?"
  - "have I worked with this client before?"

Returns session digests (id, label, summary, entities, decisions, open
questions) ranked by match score. Use get_session for the full body.

Args:
  - query: keyword(s) to search. Token-weighted match against label,
           decisions, open questions, and summary. Optional if entity or
           kind is provided.
  - entity: filter to sessions tagged with this entity. Optional.
  - kind: "decision" or "open" — restrict to sessions containing that
          marker kind. Omit for any. Optional.
  - mode: "keyword" (default), "semantic", or "hybrid". Optional.
  - limit: max results (1-100, default 10).`;
const GET_SESSION_DESCRIPTION = `Fetch one session from nlm-memory by its canonical ID, including
the full body text. Use this when a recall_sessions result looks relevant
and you need the conversational context to answer accurately.

Args:
  - id: Canonical session ID (e.g. "sess_pgvector", "sess_abc123").`;
const RECALL_FACTS_DESCRIPTION = `Search the local nlm-memory FactStore for normalized
(subject, predicate, value) triples derived from prior sessions. Use this
when you need a single concrete fact rather than the prose of a whole
session — model aliases, framework choices, endpoints, ports, dates.

Examples:
  - "what model alias does the Mac Pro endpoint expose?"
    → recall_facts(subject="mac-pro-llm-host", predicate="model")
  - "what framework did we pick for nlm-memory-ts?"
    → recall_facts(subject="nlm-memory-ts", predicate="framework")
  - "anything we know about the GOAT engagement?"
    → recall_facts(subject="goat-home-services")
  - "decisions about routing in the last week?"
    → recall_facts(query="routing", kind="decision")

Returns the matching Fact records with provenance (source_session_id,
source_quote when available). Superseded facts are excluded by default —
use get_fact_history to walk the chain of how a value evolved.

Args:
  - query: free-text search against fact values. Optional if subject /
           predicate / kind is set.
  - subject: exact-match normalized (lowercase-kebab) entity or topic name.
  - predicate: exact-match predicate from the closed vocabulary (framework,
               endpoint, model, port, host, owner, pricing, cost, deadline,
               status, stack, runtime, library, version, dependency, schema,
               integration, deployment, repo, branch, commit, description,
               decided-on, assumption, blocker).
  - kind: "decision" | "open" | "attribute". Optional.
  - mode: "keyword" (default), "semantic", or "hybrid".
  - includeSuperseded: true to include outdated facts. Default false.
  - minConfidence: lower bound on classifier confidence. Default 0.6.
  - limit: max results (1-100, default 10).`;
const GET_FACT_HISTORY_DESCRIPTION = `Walk the supersedence chain for a (subject, predicate) pair, or
all chains for a subject. Use this when you need to understand how a value
changed over time — "wait, did we used to use Fastify, when did that flip
to Hono?".

Returns chains ordered newest → oldest. The head of each chain is the
current value; subsequent entries are predecessors, each pointing forward
via supersededBy.

Args:
  - subject: normalized entity or topic name.
  - predicate: (optional) narrow to a single (subject, predicate) chain.
               When omitted, returns one chain per predicate for this
               subject.`;
export function createMcpServer(deps) {
    const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
    });
    server.registerTool("recall_sessions", {
        title: "Recall Sessions from NLM",
        description: RECALL_DESCRIPTION,
        inputSchema: {
            query: z
                .string()
                .default("")
                .describe("Keyword(s) to search. Optional if entity or kind is set."),
            entity: z
                .string()
                .optional()
                .describe("Filter to sessions tagged with this entity name."),
            kind: z
                .enum(["decision", "open"])
                .optional()
                .describe("Filter to sessions with a decision or open marker."),
            mode: z
                .enum(["keyword", "semantic", "hybrid"])
                .optional()
                .describe("Search mode. Defaults to keyword."),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(DEFAULT_LIMIT)
                .describe("Max results to return."),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (args) => recallSessionsHandler(deps, args));
    server.registerTool("get_session", {
        title: "Get Full NLM Session",
        description: GET_SESSION_DESCRIPTION,
        inputSchema: {
            id: z.string().min(1).describe("Canonical session ID."),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (args) => getSessionHandler(deps, args));
    if (deps.factRecall && deps.factStore) {
        server.registerTool("recall_facts", {
            title: "Recall Facts from NLM",
            description: RECALL_FACTS_DESCRIPTION,
            inputSchema: {
                query: z
                    .string()
                    .default("")
                    .describe("Free-text search against fact values. Optional if subject/predicate/kind set."),
                subject: z
                    .string()
                    .optional()
                    .describe("Exact-match normalized entity/topic (lowercase-kebab)."),
                predicate: z
                    .string()
                    .optional()
                    .describe("Exact-match predicate from the closed vocabulary."),
                kind: z
                    .enum(["decision", "open", "attribute"])
                    .optional()
                    .describe("Filter to a single fact kind."),
                mode: z
                    .enum(["keyword", "semantic", "hybrid"])
                    .optional()
                    .describe("Search mode. Defaults to keyword."),
                includeSuperseded: z
                    .boolean()
                    .optional()
                    .describe("Include outdated facts. Default false."),
                minConfidence: z
                    .number()
                    .min(0)
                    .max(1)
                    .optional()
                    .describe("Lower bound on classifier confidence. Default 0.6."),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .default(DEFAULT_LIMIT)
                    .describe("Max results to return."),
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        }, async (args) => recallFactsHandler(deps, args));
        server.registerTool("get_fact_history", {
            title: "Get Fact Supersedence History",
            description: GET_FACT_HISTORY_DESCRIPTION,
            inputSchema: {
                subject: z.string().min(1).describe("Normalized entity/topic name."),
                predicate: z
                    .string()
                    .optional()
                    .describe("Narrow to one (subject, predicate) chain."),
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        }, async (args) => getFactHistoryHandler(deps, args));
    }
    return server;
}
//# sourceMappingURL=server.js.map
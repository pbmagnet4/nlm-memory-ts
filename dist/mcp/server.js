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
import { logQuery } from "../core/recall/query-log.js";
import { logFactQuery } from "../core/recall-facts/fact-query-log.js";
import { appendCitation } from "../core/recall/citation-log.js";
const CHARACTER_LIMIT = 25_000;
const DEFAULT_LIMIT = 10;
const SERVER_NAME = "nlm-memory-mcp-server";
const SERVER_VERSION = "0.4.0";
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
            mode: input.mode ?? "hybrid",
            limit: input.limit ?? DEFAULT_LIMIT,
            ...(input.entity !== undefined ? { entity: input.entity } : {}),
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
        };
        const result = await deps.recall.search(query);
        // Telemetry — the MCP path is the real agent-usage path; without this it
        // is invisible to query_log.jsonl and the Recall page. Fire-and-forget,
        // mirrors the HTTP /api/recall handler.
        void logQuery({
            source: "mcp",
            query: input.query ?? null,
            entity: input.entity ?? null,
            kind: input.kind ?? null,
            mode: input.mode ?? "hybrid",
            limit: input.limit ?? DEFAULT_LIMIT,
            nResults: result.total,
            returnedIds: result.results.map((r) => r.id),
        });
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
            mode: input.mode ?? "hybrid",
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
        // Telemetry — see recallSessionsHandler. Fire-and-forget.
        void logFactQuery({
            source: "mcp",
            query: input.query ?? null,
            subject: input.subject ?? null,
            predicate: input.predicate ?? null,
            kind: input.kind ?? null,
            mode: input.mode ?? "hybrid",
            limit: input.limit ?? DEFAULT_LIMIT,
            nResults: result.total,
            returnedIds: result.results.map((r) => r.id),
        });
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
const CITE_SESSION_DESCRIPTION = `Log that you used a previously-surfaced session in your response. Pass the session ID. This lets NLM learn which surfaced sessions are actually useful, training a per-operator reranker over time. Call after writing your response, with one cite per surfaced session you actually drew from.`;
const RECALL_DESCRIPTION = `Search prior AI sessions across every runtime the user has connected (Claude Code,
Hermes, pi, Codex, Gemini, Aider). Local-first, fast (~200-400ms warm), idempotent,
safe to call eagerly. No rate limit; no cost per call.

CALL THIS FIRST — before answering — whenever the user prompt contains any of:

  Decision / position questions
    "what did we decide about X" · "did we figure out X" · "what's our take on X"
    "have we tried X" · "where did we land on X" · "what was the conclusion"

  Status / open-thread questions
    "what's still open on X" · "where did we leave X" · "what's blocked on X"
    "what's the state of X" · "is X done"

  History / continuity questions
    "have I worked on X" · "when did we last X" · "did we already do X"
    "have I talked to <person>" · "what's the history with X"

  Implicit references to prior context (the dangerous case — easy to miss)
    "that pgvector thing" · "the X discussion" · "our auth approach"
    "the one we built for <client>" · "the issue we hit last week"

Not calling when the user references past work is the failure mode this tool exists
to prevent: re-derivation of already-solved problems, contradicting prior decisions,
re-litigating resolved open questions, ignoring the user's accumulated context.

Returns ranked session digests (id, label, summary, entities, decisions, open
questions). Call get_session for the full body when a digest looks relevant.

Skip ONLY when the request is purely forward-looking with no plausible prior
context — drafting wholly new content, naming something new, brainstorming
greenfield ideas. When in doubt, call.

When you reference a returned session in your response, call \`cite_session(id)\` to log it so the recall layer can learn what is useful.

Args:
  - query: keyword(s) to search. Token-weighted match against label, decisions,
           open questions, and summary. Optional if entity or kind is provided.
  - entity: filter to sessions tagged with this entity. Optional.
  - kind: "decision" or "open" — restrict to sessions containing that marker
          kind. Omit for any. Optional.
  - mode: "hybrid" (default — keyword BM25 + semantic embeddings), "keyword", or
          "semantic". Optional.
  - limit: max results (1-100, default 10).`;
const GET_SESSION_DESCRIPTION = `Fetch one full session by its canonical ID, including the conversational body.

Call this AFTER recall_sessions when a returned digest looks relevant and the
summary alone isn't enough to answer — e.g. you need the exact wording of a
decision, the full reasoning behind a pivot, the specific commands that were
run, or any quote you intend to reference verbatim.

The recall_sessions digest is optimized for ranking and scanning; the full body
contains the actual conversation transcript that produced the decision.

Args:
  - id: Canonical session ID returned by recall_sessions (e.g. "cc_abc123",
        "sess_pgvector"). Pass the id field from the recall_sessions result.`;
const RECALL_FACTS_DESCRIPTION = `Look up specific (subject, predicate, value) facts the user has established in
prior sessions — model aliases, framework choices, endpoints, ports, hosts,
deadlines, pricing, owners, dependencies, etc.

CALL THIS when the user asks for a concrete value rather than a prose summary:

  "what port is X on" · "what model does Y use" · "what's the endpoint for Z"
  "what framework did we pick for X" · "who owns the X project"
  "when's the X deadline" · "what did we set X to" · "where does X live"
  "what version of X are we on" · "what's our X account"

Prefer this over recall_sessions when the user wants the *answer*, not the
*conversation* — facts return the exact value with provenance (source session
+ source quote), no scanning required. recall_sessions is the right tool when
the user wants context, reasoning, or the full discussion.

Returns matching Fact records ordered by recency. Superseded facts are excluded
by default; call get_fact_history to walk the chain of how a value evolved
("when did X flip from Fastify to Hono?").

Examples:
  recall_facts(subject="mac-pro-llm-host", predicate="model")
    → the model alias currently exposed on the Mac Pro LLM endpoint
  recall_facts(subject="nlm-memory-ts", predicate="framework")
    → the web framework picked for nlm-memory-ts
  recall_facts(subject="goat-home-services")
    → all known facts about the GOAT engagement
  recall_facts(query="routing", kind="decision")
    → recent decision-kind facts mentioning routing

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
  - mode: "hybrid" (default — keyword BM25 + semantic embeddings), "keyword",
          or "semantic".
  - includeSuperseded: true to include outdated facts. Default false.
  - minConfidence: lower bound on classifier confidence. Default 0.6.
  - limit: max results (1-100, default 10).`;
const GET_FACT_HISTORY_DESCRIPTION = `Walk the supersedence chain for a (subject, predicate) pair to see how a value
changed over time. Call this when the user asks about evolution, history of a
choice, or wants to understand a prior decision that's since changed:

  "when did we switch from X to Y" · "what did we use before X"
  "wasn't X different a month ago" · "history of <X choice>"
  "why did we change from X to Y"

This is the editable-timeline feature: NLM preserves rejected/replaced decisions
as superseded entries rather than deleting them, so the reasoning trail survives.

Returns chains ordered newest → oldest. The head is the current value; subsequent
entries are predecessors, each linked forward via supersededBy.

Args:
  - subject: normalized (lowercase-kebab) entity or topic name.
  - predicate: optional — narrow to a single (subject, predicate) chain. When
               omitted, returns one chain per predicate for this subject.`;
// Minimum length for a session ID to be treated as valid.
const MIN_CITE_ID_LEN = 6;
export async function citeSessionHandler(input) {
    if (!input.id || input.id.length < MIN_CITE_ID_LEN) {
        return err(new Error(`id must be at least ${MIN_CITE_ID_LEN} characters`));
    }
    try {
        await appendCitation({
            conversationId: input.conversation_id ?? "mcp_tool",
            citedId: input.id,
            kind: "tool_use",
            ...(input.reason !== undefined ? { responsePreview: input.reason } : {}),
        });
        return ok({ logged: true, id: input.id });
    }
    catch (e) {
        return err(e);
    }
}
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
                .describe("Search mode. Defaults to hybrid (keyword BM25 + semantic embeddings)."),
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
                    .describe("Search mode. Defaults to hybrid (keyword BM25 + semantic embeddings)."),
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
    server.registerTool("cite_session", {
        title: "Cite NLM Session",
        description: CITE_SESSION_DESCRIPTION,
        inputSchema: {
            id: z.string().min(MIN_CITE_ID_LEN).describe("Session ID returned by recall_sessions that you referenced in your response."),
            conversation_id: z
                .string()
                .optional()
                .describe("Current conversation ID. Optional — NLM infers from context when absent."),
            reason: z
                .string()
                .optional()
                .describe("Why this session was useful. Optional but encouraged — articulating the reason is a weak training signal."),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    }, async (args) => citeSessionHandler(args));
    return server;
}
//# sourceMappingURL=server.js.map
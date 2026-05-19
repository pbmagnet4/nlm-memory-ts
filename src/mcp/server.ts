/**
 * MCP adapter. Binds the `recall_sessions` and `get_session` tools directly
 * to RecallService and SessionStore — no HTTP hop, no localhost loopback.
 *
 * The Python daemon's MCP server proxied through HTTP. This server runs in
 * the same process as the rest of nle-memory, so a tool call is a function
 * call. Lower latency, simpler stack traces, one fewer thing to keep alive.
 *
 * Layering: this module knows about the inner ring (RecallService,
 * SessionStore); core/ does not know this module exists.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RecallService } from "@core/recall/recall-service.js";
import type { SessionStore } from "@ports/session-store.js";
import type {
  RecallKindFilter,
  RecallMode,
  RecallQuery,
} from "@shared/types.js";

const CHARACTER_LIMIT = 25_000;
const DEFAULT_LIMIT = 10;
const SERVER_NAME = "nle-memory-mcp-server";
const SERVER_VERSION = "0.2.0-dev";

export interface McpDeps {
  readonly recall: RecallService;
  readonly store: SessionStore;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function truncate(data: unknown): string {
  const str = JSON.stringify(data, null, 2);
  if (str.length <= CHARACTER_LIMIT) return str;
  return JSON.stringify(
    {
      truncated: true,
      truncation_message:
        "Response too large. Lower limit or fetch fewer fields via get_session.",
      partial_data: JSON.parse(str.slice(0, CHARACTER_LIMIT - 100)),
    },
    null,
    2,
  );
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: truncate(data) }] };
}

function err(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

// Pure handler functions — exported so tests can exercise them without an
// MCP transport. The McpServer wrapper below just registers these.

export interface RecallToolInput {
  query: string | undefined;
  entity: string | undefined;
  kind: RecallKindFilter | undefined;
  mode: RecallMode | undefined;
  limit: number | undefined;
}

export async function recallSessionsHandler(
  deps: McpDeps,
  input: Partial<RecallToolInput>,
): Promise<ToolResult> {
  try {
    const query: RecallQuery = {
      query: input.query ?? "",
      mode: input.mode ?? "keyword",
      limit: input.limit ?? DEFAULT_LIMIT,
      ...(input.entity !== undefined ? { entity: input.entity } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    };
    const result = await deps.recall.search(query);
    return ok(result);
  } catch (e) {
    return err(e);
  }
}

export async function getSessionHandler(
  deps: McpDeps,
  input: { id: string },
): Promise<ToolResult> {
  try {
    const session = await deps.store.getById(input.id);
    if (!session) {
      return err(new Error(`session ${input.id} not found`));
    }
    return ok(session);
  } catch (e) {
    return err(e);
  }
}

const RECALL_DESCRIPTION = `Search prior AI sessions from the local nle-memory canonical store.
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

const GET_SESSION_DESCRIPTION = `Fetch one session from nle-memory by its canonical ID, including
the full body text. Use this when a recall_sessions result looks relevant
and you need the conversational context to answer accurately.

Args:
  - id: Canonical session ID (e.g. "sess_pgvector", "sess_abc123").`;

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "recall_sessions",
    {
      title: "Recall Sessions from NLE Memory",
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
    },
    async (args) => recallSessionsHandler(deps, args) as never,
  );

  server.registerTool(
    "get_session",
    {
      title: "Get Full NLE Memory Session",
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
    },
    async (args) => getSessionHandler(deps, args) as never,
  );

  return server;
}

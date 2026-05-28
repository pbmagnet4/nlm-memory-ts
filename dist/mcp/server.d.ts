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
import type { FactRecallService } from "../core/recall-facts/fact-recall-service.js";
import type { RecallService } from "../core/recall/recall-service.js";
import type { FactStore } from "../ports/fact-store.js";
import type { SessionStore } from "../ports/session-store.js";
import type { FactKind, RecallKindFilter, RecallMode } from "../shared/types.js";
export interface McpDeps {
    readonly recall: RecallService;
    readonly store: SessionStore;
    /** Optional — when absent, fact tools are not registered. */
    readonly factRecall?: FactRecallService;
    readonly factStore?: FactStore;
}
export interface ToolResult {
    content: {
        type: "text";
        text: string;
    }[];
    isError?: boolean;
}
export interface RecallToolInput {
    query: string | undefined;
    entity: string | undefined;
    kind: RecallKindFilter | undefined;
    mode: RecallMode | undefined;
    limit: number | undefined;
}
export declare function recallSessionsHandler(deps: McpDeps, input: Partial<RecallToolInput>): Promise<ToolResult>;
export declare function getSessionHandler(deps: McpDeps, input: {
    id: string;
}): Promise<ToolResult>;
export interface RecallFactsInput {
    query: string | undefined;
    subject: string | undefined;
    predicate: string | undefined;
    kind: FactKind | undefined;
    mode: RecallMode | undefined;
    includeSuperseded: boolean | undefined;
    minConfidence: number | undefined;
    limit: number | undefined;
}
export declare function recallFactsHandler(deps: McpDeps, input: Partial<RecallFactsInput>): Promise<ToolResult>;
export declare function getFactHistoryHandler(deps: McpDeps, input: {
    subject: string;
    predicate: string | undefined;
}): Promise<ToolResult>;
export interface CiteSessionInput {
    readonly id: string;
    readonly conversation_id?: string | undefined;
    readonly note?: string | undefined;
}
export declare function citeSessionHandler(input: CiteSessionInput): Promise<ToolResult>;
export declare function createMcpServer(deps: McpDeps): McpServer;

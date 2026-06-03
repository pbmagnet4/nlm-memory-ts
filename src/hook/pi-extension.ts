/**
 * pi.dev extension entrypoint for NLM recall.
 *
 * Pi exposes hooks as a TypeScript extension API, not config-file hooks like
 * Claude Code. Loaded via the `packages[]` array in `~/.pi/agent/settings.json`
 * pointing at `<path>/nlm/` (the extension root); wired automatically by
 * `nlm connect pi` or `nlm setup`.
 *
 * On every user input event we route through the shared runHook orchestration
 * used by the Claude Code script. Difference: instead of writing to stdout for
 * Claude to merge into the prompt, we return `{ action: "transform", text }`
 * with the pointer block prepended to the user's text — pi's input pipeline
 * substitutes our text in place of the original.
 *
 * Stop-hook equivalent is not needed. Pi sessions land in
 * `~/.pi/agent/sessions/**\/*.jsonl` and the passive pi adapter
 * (`src/core/adapters/pi.ts`) ingests them on its own schedule.
 *
 * Fail-open: any error in the hook returns `{ action: "continue" }` so a
 * recall failure can never block or alter a user's prompt.
 */

import { autoloadEnv } from "../llm/env-autoload.js";
import { recallOverHttp } from "./recall-over-http.js";
import { runHook, type HookMode } from "./prompt-recall-hook.js";

// Pi's ExtensionAPI types live in @earendil-works/pi-coding-agent. We type
// only what we touch to avoid a hard runtime dep on pi for the rest of the
// build — this file is only loaded inside a pi process where the types exist.
interface PiInputEvent {
  readonly type: "input";
  readonly text: string;
  readonly source: string;
}
interface PiSessionManager {
  getSessionId(): string;
}
interface PiExtensionContext {
  readonly sessionManager: PiSessionManager;
}
type PiInputResult =
  | { action: "continue" }
  | { action: "transform"; text: string }
  | { action: "handled" };
interface PiExtensionAPI {
  on(
    event: "input",
    handler: (
      event: PiInputEvent,
      ctx: PiExtensionContext,
    ) => Promise<PiInputResult> | PiInputResult,
  ): void;
}

let envLoaded = false;

export default function nlmExtension(pi: PiExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!event.text || !event.text.trim()) return { action: "continue" };

    if (!envLoaded) {
      // Pi is long-lived; load ~/.nlm/.env once per process so NLM_MCP_TOKEN
      // and NLM_HOOK_MODE are visible without requiring the user to export
      // them in the shell that launched pi.
      autoloadEnv();
      envLoaded = true;
    }

    try {
      const mode: HookMode =
        process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
      const conversationId = ctx.sessionManager.getSessionId() || "unknown";
      const block = await runHook(
        { prompt: event.text, conversationId },
        { mode, recall: (q) => recallOverHttp(q, "pi") },
      );
      if (!block) return { action: "continue" };
      return { action: "transform", text: `${block}\n\n${event.text}` };
    } catch {
      return { action: "continue" };
    }
  });
}

/**
 * Adapter factory — instantiates a TranscriptAdapter for a SourceRow.
 *
 * The three legacy preset kinds (claude-code, hermes, pi) stay as their
 * own classes; this factory just injects the path from the registry row.
 * The `jsonl-generic` kind delegates to JsonlGenericAdapter with the row's
 * parseConfig. `webhook` returns null — push-based ingest doesn't poll.
 */

import type { TranscriptAdapter } from "@ports/transcript-adapter.js";
import type { SourceRow } from "../sources/source-registry.js";
import { AiderAdapter } from "./aider.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CursorAdapter } from "./cursor.js";
import { HermesAdapter } from "./hermes.js";
import { HermesAgentAdapter } from "./hermes-agent.js";
import { JsonlGenericAdapter, type JsonlGenericConfig } from "./jsonl-generic.js";
import { OpenCodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";
import { WindsurfAdapter } from "./windsurf.js";

export function adapterFromSource(source: SourceRow): TranscriptAdapter | null {
  switch (source.kind) {
    case "aider":
      return source.pathOrUrl
        ? new AiderAdapter({ historyFile: source.pathOrUrl })
        : new AiderAdapter();
    case "claude-code":
      return source.pathOrUrl
        ? new ClaudeCodeAdapter({ projectsPath: source.pathOrUrl })
        : new ClaudeCodeAdapter();
    case "cursor":
      return source.pathOrUrl
        ? new CursorAdapter({ dbPath: source.pathOrUrl })
        : new CursorAdapter();
    case "hermes":
      return source.pathOrUrl
        ? new HermesAdapter({ sessionsPath: source.pathOrUrl })
        : new HermesAdapter();
    case "hermes-agent":
      return source.pathOrUrl
        ? new HermesAgentAdapter({ dbPath: source.pathOrUrl })
        : new HermesAgentAdapter();
    case "opencode":
      return source.pathOrUrl
        ? new OpenCodeAdapter({ dbPath: source.pathOrUrl })
        : new OpenCodeAdapter();
    case "pi":
      return source.pathOrUrl
        ? new PiAdapter({ sessionsPath: source.pathOrUrl })
        : new PiAdapter();
    case "windsurf":
      return source.pathOrUrl
        ? new WindsurfAdapter({ userDir: source.pathOrUrl })
        : new WindsurfAdapter();
    case "jsonl-generic":
      if (!source.pathOrUrl) return null;
      return new JsonlGenericAdapter({
        name: `jsonl:${source.name}`,
        path: source.pathOrUrl,
        runtime: source.runtimeLabel,
        config: source.parseConfig as JsonlGenericConfig,
      });
    case "webhook":
      return null;
  }
}

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
import { ClaudeCodeAdapter } from "./claude-code.js";
import { HermesAdapter } from "./hermes.js";
import { JsonlGenericAdapter, type JsonlGenericConfig } from "./jsonl-generic.js";
import { OpenCodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";

export function adapterFromSource(source: SourceRow): TranscriptAdapter | null {
  switch (source.kind) {
    case "claude-code":
      return source.pathOrUrl
        ? new ClaudeCodeAdapter({ projectsPath: source.pathOrUrl })
        : new ClaudeCodeAdapter();
    case "hermes":
      return source.pathOrUrl
        ? new HermesAdapter({ sessionsPath: source.pathOrUrl })
        : new HermesAdapter();
    case "opencode":
      return source.pathOrUrl
        ? new OpenCodeAdapter({ dbPath: source.pathOrUrl })
        : new OpenCodeAdapter();
    case "pi":
      return source.pathOrUrl
        ? new PiAdapter({ sessionsPath: source.pathOrUrl })
        : new PiAdapter();
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

/**
 * Adapter factory — instantiates a TranscriptAdapter for a SourceRow.
 *
 * The three legacy preset kinds (claude-code, hermes, pi) stay as their
 * own classes; this factory just injects the path from the registry row.
 * The `jsonl-generic` kind delegates to JsonlGenericAdapter with the row's
 * parseConfig. `webhook` returns null — push-based ingest doesn't poll.
 */
import { ClaudeCodeAdapter } from "./claude-code.js";
import { HermesAdapter } from "./hermes.js";
import { JsonlGenericAdapter } from "./jsonl-generic.js";
import { PiAdapter } from "./pi.js";
export function adapterFromSource(source) {
    switch (source.kind) {
        case "claude-code":
            return source.pathOrUrl
                ? new ClaudeCodeAdapter({ projectsPath: source.pathOrUrl })
                : new ClaudeCodeAdapter();
        case "hermes":
            return source.pathOrUrl
                ? new HermesAdapter({ sessionsPath: source.pathOrUrl })
                : new HermesAdapter();
        case "pi":
            return source.pathOrUrl
                ? new PiAdapter({ sessionsPath: source.pathOrUrl })
                : new PiAdapter();
        case "jsonl-generic":
            if (!source.pathOrUrl)
                return null;
            return new JsonlGenericAdapter({
                name: `jsonl:${source.name}`,
                path: source.pathOrUrl,
                runtime: source.runtimeLabel,
                config: source.parseConfig,
            });
        case "webhook":
            return null;
    }
}
//# sourceMappingURL=from-source.js.map
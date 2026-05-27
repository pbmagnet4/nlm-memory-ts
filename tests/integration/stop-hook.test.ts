import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStopHook } from "../../src/hook/stop-hook.js";
import { recordSurfaced } from "../../src/core/hook/memo.js";
import { loadCited } from "../../src/core/hook/cite-memo.js";
import {
  readAllAssistantTurns,
  readLastAssistantText,
  readLastAssistantTurn,
} from "../../src/core/hook/transcript.js";

function writeTranscript(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("readLastAssistantText", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-transcript-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the text of the last assistant turn with array content", () => {
    const path = join(tmp, "t.jsonl");
    writeTranscript(path, [
      { type: "user", message: { content: "hi" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "first reply" },
            { type: "tool_use", name: "x" },
          ],
        },
      },
      { type: "user", message: { content: "more" } },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "second reply" }] },
      },
    ]);
    expect(readLastAssistantText(path)).toBe("second reply");
  });

  it("returns null when no assistant turn is present", () => {
    const path = join(tmp, "t.jsonl");
    writeTranscript(path, [{ type: "user", message: { content: "hi" } }]);
    expect(readLastAssistantText(path)).toBeNull();
  });

  it("returns null when path is missing", () => {
    expect(readLastAssistantText(join(tmp, "nonexistent.jsonl"))).toBeNull();
  });

  it("readLastAssistantTurn extracts text + tool_use blocks together", () => {
    const path = join(tmp, "t.jsonl");
    writeTranscript(path, [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Searching..." },
            {
              type: "tool_use",
              name: "mcp__nlm-memory__get_session",
              input: { id: "cc_sub_abc123" },
            },
            { type: "text", text: "second prose chunk" },
          ],
        },
      },
    ]);
    const turn = readLastAssistantTurn(path);
    expect(turn.text).toBe("Searching...\nsecond prose chunk");
    expect(turn.toolUses).toEqual([
      {
        name: "mcp__nlm-memory__get_session",
        input: { id: "cc_sub_abc123" },
      },
    ]);
  });

  it("skips malformed JSON lines", () => {
    const path = join(tmp, "t.jsonl");
    writeFileSync(
      path,
      "not json\n" +
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "real reply" }] },
        }) +
        "\n",
    );
    expect(readLastAssistantText(path)).toBe("real reply");
  });
});

describe("runStopHook", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-stop-"));
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "state");
  });
  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("posts a citation for each surfaced ID found in the last assistant message", async () => {
    recordSurfaced("conv-1", [
      "cc_sub_a139f4ab7ca5aa909",
      "cc_ff88cd96-d1f9-428c-8a97-2e4ca431acbe",
      "hm_20260427_6ff562",
    ]);
    const transcript = join(tmp, "t.jsonl");
    writeTranscript(transcript, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Per cc_sub_a139f4ab7ca5aa909 and hm_20260427_6ff562 we chose FTS5.",
            },
          ],
        },
      },
    ]);
    const postCitation = vi.fn().mockResolvedValue(undefined);
    const result = await runStopHook(
      {
        conversationId: "conv-1",
        transcriptPath: transcript,
        stopHookActive: false,
      },
      { postCitation },
    );
    expect(result.skipped).toBe(false);
    expect(result.surfacedCount).toBe(3);
    expect(result.citations.map((c) => c.id).sort()).toEqual(
      ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"].sort(),
    );
    expect(result.citations.every((c) => c.kind === "prose")).toBe(true);
    expect(postCitation).toHaveBeenCalledTimes(2);
    expect(postCitation).toHaveBeenCalledWith(
      "conv-1",
      "cc_sub_a139f4ab7ca5aa909",
      "prose",
      expect.stringContaining("cc_sub_a139f4ab7ca5aa909"),
    );
  });

  it("posts a tool_use citation when the model invokes an NLM MCP tool referencing a surfaced ID", async () => {
    recordSurfaced("conv-mcp", [
      "cc_sub_a139f4ab7ca5aa909",
      "cc_ff88cd96-d1f9-428c-8a97-2e4ca431acbe",
    ]);
    const transcript = join(tmp, "t.jsonl");
    writeTranscript(transcript, [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me look at that prior session." },
            {
              type: "tool_use",
              name: "mcp__nlm-memory__get_session",
              input: { id: "cc_sub_a139f4ab7ca5aa909" },
            },
          ],
        },
      },
    ]);
    const postCitation = vi.fn().mockResolvedValue(undefined);
    const result = await runStopHook(
      {
        conversationId: "conv-mcp",
        transcriptPath: transcript,
        stopHookActive: false,
      },
      { postCitation },
    );
    expect(result.citations).toEqual([
      { id: "cc_sub_a139f4ab7ca5aa909", kind: "tool_use" },
    ]);
    expect(postCitation).toHaveBeenCalledWith(
      "conv-mcp",
      "cc_sub_a139f4ab7ca5aa909",
      "tool_use",
      expect.any(String),
    );
  });

  it("ignores tool_use blocks for non-NLM tools", async () => {
    recordSurfaced("conv-other", ["cc_sub_a139f4ab7ca5aa909"]);
    const transcript = join(tmp, "t.jsonl");
    writeTranscript(transcript, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "grep cc_sub_a139f4ab7ca5aa909 /tmp/log" },
            },
          ],
        },
      },
    ]);
    const postCitation = vi.fn();
    const result = await runStopHook(
      {
        conversationId: "conv-other",
        transcriptPath: transcript,
        stopHookActive: false,
      },
      { postCitation },
    );
    expect(result.citations).toEqual([]);
    expect(postCitation).not.toHaveBeenCalled();
  });

  it("skips when stop_hook_active is true", async () => {
    recordSurfaced("conv-2", ["cc_sub_a139f4ab7ca5aa909"]);
    const postCitation = vi.fn();
    const result = await runStopHook(
      {
        conversationId: "conv-2",
        transcriptPath: "ignored",
        stopHookActive: true,
      },
      { postCitation },
    );
    expect(result.skipped).toBe(true);
    expect(postCitation).not.toHaveBeenCalled();
  });

  it("returns empty cited when no IDs were surfaced for this conversation", async () => {
    const transcript = join(tmp, "t.jsonl");
    writeTranscript(transcript, [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "anything" }] },
      },
    ]);
    const postCitation = vi.fn();
    const result = await runStopHook(
      {
        conversationId: "conv-no-recall",
        transcriptPath: transcript,
        stopHookActive: false,
      },
      { postCitation },
    );
    expect(result.surfacedCount).toBe(0);
    expect(result.citations).toEqual([]);
    expect(postCitation).not.toHaveBeenCalled();
  });

  it("does not throw when postCitation rejects (daemon down)", async () => {
    recordSurfaced("conv-3", ["cc_sub_a139f4ab7ca5aa909"]);
    const transcript = join(tmp, "t.jsonl");
    writeTranscript(transcript, [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "cc_sub_a139f4ab7ca5aa909 cited" }],
        },
      },
    ]);
    const postCitation = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      runStopHook(
        {
          conversationId: "conv-3",
          transcriptPath: transcript,
          stopHookActive: false,
        },
        { postCitation },
      ),
    ).resolves.toBeDefined();
  });

  it("handles missing transcript path by returning no citations", async () => {
    recordSurfaced("conv-4", ["cc_sub_a139f4ab7ca5aa909"]);
    const postCitation = vi.fn();
    const result = await runStopHook(
      {
        conversationId: "conv-4",
        transcriptPath: join(tmp, "nonexistent.jsonl"),
        stopHookActive: false,
      },
      { postCitation },
    );
    expect(result.surfacedCount).toBe(1);
    expect(result.citations).toEqual([]);
    expect(postCitation).not.toHaveBeenCalled();
  });

  it("detects a tool_use citation when the model invoked the tool in an EARLIER turn and the last turn is prose-only", async () => {
    // Real-world pattern: model calls get_session → reads tool_result →
    // writes prose summary in a separate assistant turn. Stop fires after
    // the summary. The pre-fix detector scanned only the summary turn and
    // missed the get_session call entirely (348 stop firings in production
    // logged 0 citations despite 23 NLM tool_uses in transcripts).
    recordSurfaced("conv-multi", [
      "cc_7ff73609-9ac8-4851-891c-e958915bb7fa",
    ]);
    const transcript = join(tmp, "t.jsonl");
    writeTranscript(transcript, [
      { type: "user", message: { content: "what did we decide about FTS5?" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check the prior session." },
            {
              type: "tool_use",
              name: "mcp__nlm-memory__get_session",
              input: { id: "cc_7ff73609-9ac8-4851-891c-e958915bb7fa" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "session body..." }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "FTS5 was chosen because the keyword leg already ranks high.",
            },
          ],
        },
      },
    ]);
    const postCitation = vi.fn().mockResolvedValue(undefined);
    const result = await runStopHook(
      {
        conversationId: "conv-multi",
        transcriptPath: transcript,
        stopHookActive: false,
      },
      { postCitation },
    );
    expect(result.citations).toEqual([
      {
        id: "cc_7ff73609-9ac8-4851-891c-e958915bb7fa",
        kind: "tool_use",
      },
    ]);
    expect(postCitation).toHaveBeenCalledTimes(1);
    expect(postCitation).toHaveBeenCalledWith(
      "conv-multi",
      "cc_7ff73609-9ac8-4851-891c-e958915bb7fa",
      "tool_use",
      // preview is the LAST turn's prose, not the earlier prose.
      expect.stringContaining("FTS5 was chosen"),
    );
  });

  it("dedupes across repeated Stop firings — same tool_use citation is posted exactly once", async () => {
    recordSurfaced("conv-dedup", [
      "cc_sub_a139f4ab7ca5aa909",
    ]);
    const transcript = join(tmp, "t.jsonl");
    writeTranscript(transcript, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__nlm-memory__get_session",
              input: { id: "cc_sub_a139f4ab7ca5aa909" },
            },
          ],
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "first response" }] },
      },
    ]);
    const postCitation = vi.fn().mockResolvedValue(undefined);

    // First fire — citation detected and posted.
    const first = await runStopHook(
      {
        conversationId: "conv-dedup",
        transcriptPath: transcript,
        stopHookActive: false,
      },
      { postCitation },
    );
    expect(first.citations).toHaveLength(1);
    expect(postCitation).toHaveBeenCalledTimes(1);

    // Transcript grows with another assistant turn (typical conversation
    // continuation). The earlier tool_use is still in the file.
    writeTranscript(transcript, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__nlm-memory__get_session",
              input: { id: "cc_sub_a139f4ab7ca5aa909" },
            },
          ],
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "first response" }] },
      },
      {
        type: "user",
        message: { content: "follow up" },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "second response" }] },
      },
    ]);

    // Second fire — same id, must not post again.
    const second = await runStopHook(
      {
        conversationId: "conv-dedup",
        transcriptPath: transcript,
        stopHookActive: false,
      },
      { postCitation },
    );
    expect(second.citations).toEqual([]);
    expect(postCitation).toHaveBeenCalledTimes(1);

    // Cite-memo persisted the dedup state.
    expect(loadCited("conv-dedup")).toEqual(
      new Set(["cc_sub_a139f4ab7ca5aa909"]),
    );
  });

  it("records a citation locally even if postCitation fails — prevents reposting on next fire", async () => {
    recordSurfaced("conv-failopen", ["cc_sub_a139f4ab7ca5aa909"]);
    const transcript = join(tmp, "t.jsonl");
    writeTranscript(transcript, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__nlm-memory__get_session",
              input: { id: "cc_sub_a139f4ab7ca5aa909" },
            },
          ],
        },
      },
    ]);
    const postCitation = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(undefined);
    await runStopHook(
      {
        conversationId: "conv-failopen",
        transcriptPath: transcript,
        stopHookActive: false,
      },
      { postCitation },
    );
    // Second fire must NOT retry — the citation log carries an at-most-once
    // contract on the hook side; a missed daemon write is a known telemetry
    // gap, not a reason to double-count.
    await runStopHook(
      {
        conversationId: "conv-failopen",
        transcriptPath: transcript,
        stopHookActive: false,
      },
      { postCitation },
    );
    expect(postCitation).toHaveBeenCalledTimes(1);
  });
});

describe("readAllAssistantTurns", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-transcript-all-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns every assistant turn in order", () => {
    const path = join(tmp, "t.jsonl");
    writeTranscript(path, [
      { type: "user", message: { content: "hi" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "first" },
            {
              type: "tool_use",
              name: "mcp__nlm-memory__get_session",
              input: { id: "cc_x" },
            },
          ],
        },
      },
      { type: "user", message: { content: "more" } },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "second" }] },
      },
    ]);
    const turns = readAllAssistantTurns(path);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.text).toBe("first");
    expect(turns[0]?.toolUses[0]?.name).toBe("mcp__nlm-memory__get_session");
    expect(turns[1]?.text).toBe("second");
    expect(turns[1]?.toolUses).toEqual([]);
  });

  it("returns empty array for missing path", () => {
    expect(readAllAssistantTurns(join(tmp, "missing.jsonl"))).toEqual([]);
  });

  it("skips malformed lines without throwing", () => {
    const path = join(tmp, "t.jsonl");
    writeFileSync(
      path,
      "not json\n" +
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "real" }] },
        }) +
        "\n",
    );
    const turns = readAllAssistantTurns(path);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe("real");
  });
});

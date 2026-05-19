/**
 * JsonlGenericAdapter — generic JSONL parser driven by parseConfig.
 *
 * Covers: discover filtering by extension + mtime; parseSession handling
 * default field shapes, OpenAI-style content arrays, missing role field,
 * label/session_id fallback to filename, idle adapters returning [].
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlGenericAdapter } from "../../../../src/core/adapters/jsonl-generic.js";

function write(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("JsonlGenericAdapter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nle-jsonl-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns disabled when path is missing", () => {
    const a = new JsonlGenericAdapter({
      name: "custom",
      path: join(dir, "no-such-dir"),
      runtime: "custom/1.0",
      config: {},
    });
    expect(a.detect().enabled).toBe(false);
  });

  it("discovers .jsonl files only by default", async () => {
    writeFileSync(join(dir, "a.jsonl"), "{}\n");
    writeFileSync(join(dir, "b.json"), "{}\n");
    writeFileSync(join(dir, "c.jsonl"), "{}\n");
    const a = new JsonlGenericAdapter({
      name: "custom", path: dir, runtime: "custom/1.0", config: {},
    });
    const files = await a.discover();
    expect(files.map((f) => f.split("/").pop()).sort()).toEqual(["a.jsonl", "c.jsonl"]);
  });

  it("respects `since` mtime filter", async () => {
    const oldFile = join(dir, "old.jsonl");
    const newFile = join(dir, "new.jsonl");
    writeFileSync(oldFile, "{}\n");
    writeFileSync(newFile, "{}\n");
    const old = (Date.now() - 7 * 86_400_000) / 1000;
    utimesSync(oldFile, old, old);
    const a = new JsonlGenericAdapter({
      name: "custom", path: dir, runtime: "custom/1.0", config: {},
    });
    const files = await a.discover({ since: new Date(Date.now() - 86_400_000) });
    expect(files.length).toBe(1);
    expect(files[0]?.endsWith("new.jsonl")).toBe(true);
  });

  it("parses a session with default config (role + content fields)", async () => {
    const file = join(dir, "sess.jsonl");
    write(file, [
      { role: "user", content: "Help me debug this query", timestamp: "2026-05-19T10:00:00Z" },
      { role: "assistant", content: "Sure — what's the error?", timestamp: "2026-05-19T10:00:30Z" },
    ]);
    const a = new JsonlGenericAdapter({
      name: "custom", path: dir, runtime: "custom/1.0", config: {},
    });
    const session = await a.parseSession(file);
    expect(session).not.toBeNull();
    expect(session!.turnCount).toBe(2);
    expect(session!.text).toContain("User: Help me debug");
    expect(session!.text).toContain("Assistant: Sure");
    expect(session!.startedAt).toBe("2026-05-19T10:00:00Z");
    expect(session!.runtime).toBe("custom/1.0");
  });

  it("extracts text from OpenAI-style content arrays", async () => {
    const file = join(dir, "sess.jsonl");
    write(file, [
      { role: "user", content: [{ type: "text", text: "Hello there" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
    ]);
    const a = new JsonlGenericAdapter({
      name: "custom", path: dir, runtime: "custom/1.0", config: {},
    });
    const session = await a.parseSession(file);
    expect(session?.text).toContain("Hello there");
    expect(session?.text).toContain("Hi!");
  });

  it("falls back to filename when sessionIdField / labelField missing", async () => {
    const file = join(dir, "fallback-name.jsonl");
    write(file, [{ role: "user", content: "anything" }]);
    const a = new JsonlGenericAdapter({
      name: "custom", path: dir, runtime: "custom/1.0", config: {},
    });
    const session = await a.parseSession(file);
    expect(session?.label).toBe("fallback-name");
    expect(session?.runtimeSessionId).toBe("fallback-name");
  });

  it("honors custom field mapping", async () => {
    const file = join(dir, "weird.jsonl");
    write(file, [
      { who: "human", body: "ping", at: "2026-05-19T09:00:00Z", convo: "abc-123" },
      { who: "ai", body: "pong", at: "2026-05-19T09:00:05Z", convo: "abc-123" },
    ]);
    const a = new JsonlGenericAdapter({
      name: "weird", path: dir, runtime: "weird/1.0",
      config: {
        textField: "body",
        roleField: "who",
        userRole: "human",
        assistantRole: "ai",
        timestampField: "at",
        sessionIdField: "convo",
      },
    });
    const session = await a.parseSession(file);
    expect(session?.turnCount).toBe(2);
    expect(session?.runtimeSessionId).toBe("abc-123");
  });

  it("returns null for empty or all-garbage files", async () => {
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    const garbage = join(dir, "garbage.jsonl");
    writeFileSync(garbage, "not json\nstill not json\n");
    const a = new JsonlGenericAdapter({
      name: "custom", path: dir, runtime: "custom/1.0", config: {},
    });
    expect(await a.parseSession(empty)).toBeNull();
    expect(await a.parseSession(garbage)).toBeNull();
  });
});

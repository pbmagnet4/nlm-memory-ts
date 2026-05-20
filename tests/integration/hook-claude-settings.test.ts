import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addHook, removeHook } from "../../src/core/hook/claude-settings.js";

interface Settings {
  hooks?: {
    UserPromptSubmit?: Array<{ hooks: Array<{ type: string; command: string }> }>;
    PostToolUse?: Array<{ hooks: Array<{ type: string; command: string }> }>;
  };
}

describe("claude-settings hook editor", () => {
  let tmp: string;
  let settingsPath: string;
  const CMD = "NLM_HOOK_MODE=shadow node /abs/dist/hook/prompt-recall-hook.js";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-settings-"));
    settingsPath = join(tmp, "settings.json");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("creates settings.json with the hook entry when the file is absent", () => {
    addHook(settingsPath, CMD);
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    const entries = s.hooks?.UserPromptSubmit ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hooks[0]?.command).toBe(CMD);
  });

  it("preserves unrelated existing settings and hooks", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "sonnet",
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
      }),
      "utf8",
    );
    addHook(settingsPath, CMD);
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings & { model?: string };
    expect(s.model).toBe("sonnet");
    const cmds = (s.hooks?.UserPromptSubmit ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(cmds).toContain("other-tool");
    expect(cmds).toContain(CMD);
  });

  it("is idempotent — re-adding does not duplicate the nlm entry", () => {
    addHook(settingsPath, CMD);
    addHook(settingsPath, "NLM_HOOK_MODE=live node /abs/dist/hook/prompt-recall-hook.js");
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    const cmds = (s.hooks?.UserPromptSubmit ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    const nlmCmds = cmds.filter((c) => c.includes("prompt-recall-hook.js"));
    expect(nlmCmds).toHaveLength(1);
    expect(nlmCmds[0]).toContain("NLM_HOOK_MODE=live");
  });

  it("removeHook removes only the nlm entry and leaves others intact", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
      }),
      "utf8",
    );
    addHook(settingsPath, CMD);
    removeHook(settingsPath);
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    const cmds = (s.hooks?.UserPromptSubmit ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(cmds).toEqual(["other-tool"]);
  });

  it("removeHook is a no-op when settings.json does not exist", () => {
    expect(() => removeHook(settingsPath)).not.toThrow();
  });

  it("removeHook of the only nlm entry leaves no empty UserPromptSubmit litter", () => {
    addHook(settingsPath, CMD);
    removeHook(settingsPath);
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    expect(s.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it("addHook preserves an unrelated hook event key", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "other-event" }] }] },
      }),
      "utf8",
    );
    addHook(settingsPath, CMD);
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    expect(s.hooks?.PostToolUse).toHaveLength(1);
    const ups = s.hooks?.UserPromptSubmit ?? [];
    const cmds = ups.flatMap((e) => e.hooks.map((h) => h.command));
    expect(cmds).toContain(CMD);
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addHook,
  buildHookCommand,
  removeHook,
  shellQuote,
  smokeTestHookCommand,
} from "../../src/core/hook/claude-settings.js";

interface Settings {
  hooks?: {
    UserPromptSubmit?: Array<{ hooks: Array<{ type: string; command: string }> }>;
    PostToolUse?: Array<{ hooks: Array<{ type: string; command: string }> }>;
    SessionEnd?: Array<{ hooks: Array<{ type: string; command: string }> }>;
    [event: string]: Array<{ hooks: Array<{ type: string; command: string }> }> | undefined;
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

  function shEcho(s: string): string {
    return spawnSync("sh", ["-c", `echo ${s}`], { encoding: "utf8" }).stdout.trim();
  }

  it("shellQuote wraps paths with spaces so sh -c keeps them as one arg", () => {
    const pathWithSpace = "~/projects/foo/bar.js";
    expect(shEcho(shellQuote(pathWithSpace))).toBe(pathWithSpace);
  });

  it("shellQuote escapes embedded single quotes", () => {
    const tricky = "/path/with'quote/file.js";
    expect(shEcho(shellQuote(tricky))).toBe(tricky);
  });

  it("buildHookCommand quotes both paths (POSIX)", () => {
    const cmd = buildHookCommand(
      "/usr/local/bin/node",
      "~/projects/nlm/dist/hook/prompt-recall-hook.js",
      "shadow",
      "darwin",
    );
    expect(cmd).toBe(
      "NLM_HOOK_MODE=shadow '/usr/local/bin/node' '~/projects/nlm/dist/hook/prompt-recall-hook.js'",
    );
  });

  it("buildHookCommand emits cmd.exe format on Windows", () => {
    const cmd = buildHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\nlm-memory\\dist\\hook\\prompt-recall-hook.js",
      "live",
      "win32",
    );
    expect(cmd).toBe(
      'set NLM_HOOK_MODE=live && "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\nlm-memory\\dist\\hook\\prompt-recall-hook.js"',
    );
  });

  it("smokeTestHookCommand reports failure when command exits nonzero", () => {
    const logPath = join(tmp, "hook-log.jsonl");
    const result = smokeTestHookCommand("exit 1", logPath);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exit code 1");
  });

  it("smokeTestHookCommand reports failure when log does not gain an entry", () => {
    const logPath = join(tmp, "hook-log.jsonl");
    const result = smokeTestHookCommand("true", logPath);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no entry appended");
  });

  it("smokeTestHookCommand passes when command writes to the log", () => {
    const logPath = join(tmp, "hook-log.jsonl");
    const result = smokeTestHookCommand(
      `printf '{"ts":"x"}\\n' >> ${shellQuote(logPath)}`,
      logPath,
    );
    expect(result.ok).toBe(true);
    expect(statSync(logPath).size).toBeGreaterThan(0);
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

  it("addHook installs under a non-default event when specified", () => {
    const sessionEndCmd = "node /abs/dist/hook/session-end-hook.js";
    addHook(settingsPath, sessionEndCmd, "SessionEnd");
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings & {
      hooks?: { SessionEnd?: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(s.hooks?.UserPromptSubmit).toBeUndefined();
    expect(s.hooks?.SessionEnd).toHaveLength(1);
    expect(s.hooks?.SessionEnd?.[0]?.hooks[0]?.command).toBe(sessionEndCmd);
  });

  it("addHook can hold separate NLM entries on two event keys without collision", () => {
    addHook(settingsPath, CMD, "UserPromptSubmit");
    const sessionEndCmd = "node /abs/dist/hook/session-end-hook.js";
    addHook(settingsPath, sessionEndCmd, "SessionEnd");
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings & {
      hooks?: { SessionEnd?: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(s.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks?.SessionEnd).toHaveLength(1);
  });

  it("removeHook with event='*' clears the NLM entry from every event", () => {
    addHook(settingsPath, CMD, "UserPromptSubmit");
    const sessionEndCmd = "node /abs/dist/hook/session-end-hook.js";
    addHook(settingsPath, sessionEndCmd, "SessionEnd");
    // Also add an unrelated PostToolUse entry to confirm we don't touch it.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: CMD }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: sessionEndCmd }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: "other-tool" }] }],
        },
      }),
      "utf8",
    );
    removeHook(settingsPath, "*");
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    expect(s.hooks?.UserPromptSubmit).toBeUndefined();
    expect(s.hooks?.SessionEnd).toBeUndefined();
    expect(s.hooks?.PostToolUse).toHaveLength(1);
  });
});

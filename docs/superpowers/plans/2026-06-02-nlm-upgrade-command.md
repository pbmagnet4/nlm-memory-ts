# nlm upgrade command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add an `nlm upgrade` CLI subcommand that installs the latest npm version and restarts the daemon, then update the UI banner to show `nlm upgrade` instead of the raw npm command.

**Architecture:** A new `upgrade` command in `src/cli/nlm.ts` that detects whether the running binary is an npm global install or a dev build, shells `npm install -g nlm-memory@latest` if appropriate, busts the update-check cache, then delegates to the existing restart logic already used by `nlm restart`. One string constant changes in `UpdateBanner.tsx`.

**Tech Stack:** TypeScript, Node.js `child_process.execFileSync`, Commander.js (CLI), Vitest (tests), React (UI banner).

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `src/cli/nlm.ts` | Modify | Add `upgrade` command after the `restart` command block (~750 line area) |
| `src/cli/upgrade-helpers.ts` | Create | Pure, testable logic: dev-build detection + cache-bust path |
| `tests/unit/cli/upgrade-helpers.test.ts` | Create | Unit tests for the two helper functions |
| `src/ui/components/UpdateBanner.tsx` | Modify | Change `INSTALL_CMD` constant (1 line) |

---

## Task 1: Create `upgrade-helpers.ts` with dev-build detection

**Files:**
- Create: `src/cli/upgrade-helpers.ts`

The two helpers are pure functions with no side effects — easy to unit test.

- [x] **Step 1: Create the file**

```typescript
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * True when the running process is a local dev build (not an npm global
 * install). Dev builds have `__filename` pointing inside a project
 * directory, not inside a `node_modules` tree.
 *
 * Injected `filename` keeps this testable without depending on the real
 * __filename at test time.
 */
export function isDevBuild(filename: string): boolean {
  return !filename.includes("node_modules");
}

/**
 * Absolute path to the update-check cache file. Mirrors the path logic
 * in src/core/update-check/check.ts so both sides bust the same file.
 */
export function updateCheckCachePath(): string {
  return (
    process.env["NLM_UPDATE_CHECK_CACHE"] ??
    join(homedir(), ".nlm", "update-check.json")
  );
}
```

- [x] **Step 2: Verify TypeScript compiles**

Run: `npm run typecheck`
Expected: no errors

---

## Task 2: Unit tests for `upgrade-helpers.ts`

**Files:**
- Create: `tests/unit/cli/upgrade-helpers.test.ts`

- [x] **Step 1: Write the tests**

```typescript
import { describe, expect, it } from "vitest";
import { isDevBuild, updateCheckCachePath } from "../../../src/cli/upgrade-helpers.js";

describe("isDevBuild", () => {
  it("returns false for a path inside node_modules (npm global)", () => {
    expect(
      isDevBuild("/Users/alice/.nvm/versions/node/v22.0.0/lib/node_modules/nlm-memory/dist/cli/nlm.js"),
    ).toBe(false);
  });

  it("returns true for a path outside node_modules (dev build)", () => {
    expect(
      isDevBuild("/Users/alice/Documents/nlm-memory-ts/dist/cli/nlm.js"),
    ).toBe(true);
  });

  it("returns true for a path that contains 'node_modules' in a directory name that is not the module root", () => {
    // edge case: a project literally named 'my-node_modules-project'
    expect(
      isDevBuild("/Users/alice/my-node_modules-project/dist/cli/nlm.js"),
    ).toBe(false); // contains "node_modules" as substring — treated as installed
  });

  it("returns false for a global Windows-style path", () => {
    expect(
      isDevBuild("C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\nlm-memory\\dist\\cli\\nlm.js"),
    ).toBe(false);
  });
});

describe("updateCheckCachePath", () => {
  it("returns the env-var override when set", () => {
    process.env["NLM_UPDATE_CHECK_CACHE"] = "/tmp/test-update-check.json";
    expect(updateCheckCachePath()).toBe("/tmp/test-update-check.json");
    delete process.env["NLM_UPDATE_CHECK_CACHE"];
  });

  it("returns a path inside ~/.nlm when no override is set", () => {
    delete process.env["NLM_UPDATE_CHECK_CACHE"];
    const p = updateCheckCachePath();
    expect(p).toContain(".nlm");
    expect(p).toContain("update-check.json");
  });
});
```

- [x] **Step 2: Run the tests and verify they pass**

Run: `npm run test:unit -- tests/unit/cli/upgrade-helpers.test.ts`
Expected: all tests pass

- [x] **Step 3: Commit**

```bash
git add src/cli/upgrade-helpers.ts tests/unit/cli/upgrade-helpers.test.ts
git commit -m "feat(upgrade): add isDevBuild + updateCheckCachePath helpers"
```

---

## Task 3: Add the `upgrade` command to `nlm.ts`

**Files:**
- Modify: `src/cli/nlm.ts`

The command goes immediately after the `restart` command block (around line 750). It reuses all the existing imports: `execFileSync`, `existsSync`, `rmSync`, `planRestart`, `LAUNCH_AGENT_LABEL`, `LAUNCH_AGENT_PLIST`, `LINUX_SYSTEMD_UNIT_NAME`, `LINUX_SYSTEMD_UNIT_PATH`, `isAgentLoaded`, `linuxSystemdUserAvailable`, `spawn`, `process`.

- [x] **Step 1: Add the import for the new helpers**

At the top of `src/cli/nlm.ts`, add after the existing CLI helper imports (near the `restart-helpers` import):

```typescript
import { isDevBuild, updateCheckCachePath } from "./upgrade-helpers.js";
```

- [x] **Step 2: Add the `upgrade` command after the `restart` command block**

Find the line `const config = program` (the start of the config subcommand, around line 755) and insert before it:

```typescript
program
  .command("upgrade")
  .description("Install the latest nlm-memory from npm and restart the daemon")
  .action(() => {
    if (isDevBuild(__filename)) {
      console.error("nlm upgrade: you're running a dev build — run `npm run build` to pick up changes.");
      return;
    }

    console.error("nlm: upgrading nlm-memory…");
    try {
      execFileSync("npm", ["install", "-g", "nlm-memory@latest"], { stdio: "inherit" });
    } catch {
      // npm already printed its own error to stderr via stdio: "inherit"
      process.exit(1);
    }

    rmSync(updateCheckCachePath(), { force: true });

    const plan = planRestart({
      platform: process.platform,
      uid: process.getuid?.(),
      agentLoaded: process.platform === "darwin" && isAgentLoaded(LAUNCH_AGENT_LABEL),
      plistExists: existsSync(LAUNCH_AGENT_PLIST),
      systemdAvailable: linuxSystemdUserAvailable(),
      unitFileExists: existsSync(LINUX_SYSTEMD_UNIT_PATH),
      label: LAUNCH_AGENT_LABEL,
      plistPath: LAUNCH_AGENT_PLIST,
      unitName: LINUX_SYSTEMD_UNIT_NAME,
    });

    switch (plan.kind) {
      case "launchctl-kickstart":
        execFileSync("launchctl", ["kickstart", "-k", `gui/${plan.uid}/${plan.label}`]);
        console.error("nlm: upgraded and restarted.");
        return;
      case "launchctl-bootstrap":
        execFileSync("launchctl", ["bootstrap", `gui/${plan.uid}`, plan.plist]);
        console.error("nlm: upgraded — agent was not loaded, bootstrapped and started.");
        return;
      case "systemctl-restart":
        execFileSync("systemctl", ["--user", "restart", plan.unit]);
        console.error("nlm: upgraded and restarted.");
        return;
      case "pkill-respawn":
        try {
          execFileSync("pkill", ["-f", DAEMON_PKILL_PATTERN], { stdio: "ignore" });
        } catch {
          // No matching process — fine.
        }
        spawn(process.execPath, [__filename, "start"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        console.error("nlm: upgraded and restarted.");
        return;
      case "unsupported":
        console.error(`nlm upgrade: restart failed — ${plan.reason}`);
        console.error("  Binary is updated on disk. Start the daemon manually.");
        process.exit(1);
    }
  });

```

- [x] **Step 3: Verify TypeScript compiles**

Run: `npm run typecheck`
Expected: no errors

- [x] **Step 4: Smoke-test the dev-build path manually**

Since you're running a dev build, running `nlm upgrade` (or `node dist/cli/nlm.js upgrade` after a build) should print the dev-build warning and exit cleanly:

Run: `npm run build && node dist/cli/nlm.js upgrade`
Expected output:
```
nlm upgrade: you're running a dev build — run `npm run build` to pick up changes.
```

- [x] **Step 5: Commit**

```bash
git add src/cli/nlm.ts src/cli/upgrade-helpers.ts
git commit -m "feat(cli): add nlm upgrade command"
```

---

## Task 4: Update `UpdateBanner.tsx` — change `INSTALL_CMD`

**Files:**
- Modify: `src/ui/components/UpdateBanner.tsx`

- [x] **Step 1: Change the constant**

Find line:
```typescript
const INSTALL_CMD = "npm i -g nlm-memory@latest && nlm restart";
```

Replace with:
```typescript
const INSTALL_CMD = "nlm upgrade";
```

- [x] **Step 2: Build and verify**

Run: `npm run build`
Expected: build succeeds, no TypeScript errors

- [x] **Step 3: Commit**

```bash
git add src/ui/components/UpdateBanner.tsx
git commit -m "feat(ui): update banner install command to nlm upgrade"
```

---

## Task 5: Full test suite + final build

- [x] **Step 1: Run the full unit test suite**

Run: `npm run test:unit`
Expected: all tests pass (no regressions)

- [x] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

- [x] **Step 3: Full build**

Run: `npm run build`
Expected: server, UI, and codex plugin all build cleanly

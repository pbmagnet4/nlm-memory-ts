import { describe, expect, it } from "vitest";
import { DAEMON_PKILL_PATTERN, planRestart, type RestartContext } from "../../../src/cli/restart-helpers.js";

const base: RestartContext = {
  platform: "darwin",
  uid: 501,
  agentLoaded: true,
  plistExists: true,
  systemdAvailable: false,
  unitFileExists: false,
  label: "com.example.nlm",
  plistPath: "/Users/x/Library/LaunchAgents/com.example.nlm.plist",
  unitName: "nlm.service",
};

describe("planRestart — macOS", () => {
  it("kickstarts the running agent when it's loaded", () => {
    expect(planRestart({ ...base, agentLoaded: true })).toEqual({
      kind: "launchctl-kickstart",
      uid: 501,
      label: "com.example.nlm",
    });
  });

  it("bootstraps from the plist when the agent isn't loaded but is installed", () => {
    expect(planRestart({ ...base, agentLoaded: false, plistExists: true })).toEqual({
      kind: "launchctl-bootstrap",
      uid: 501,
      plist: base.plistPath,
    });
  });

  it("falls back to pkill+respawn when nothing is installed", () => {
    expect(planRestart({ ...base, agentLoaded: false, plistExists: false })).toEqual({
      kind: "pkill-respawn",
    });
  });

  it("refuses if UID can't be determined (sandboxed/odd env)", () => {
    const plan = planRestart({ ...base, uid: undefined });
    expect(plan.kind).toBe("unsupported");
  });
});

describe("planRestart — Linux", () => {
  const linux: RestartContext = {
    ...base,
    platform: "linux",
    systemdAvailable: true,
    unitFileExists: true,
    agentLoaded: false,
    plistExists: false,
  };

  it("uses systemctl --user restart when the unit is installed and systemd responds", () => {
    expect(planRestart(linux)).toEqual({
      kind: "systemctl-restart",
      unit: "nlm.service",
    });
  });

  it("falls back to pkill+respawn when systemd isn't available", () => {
    expect(planRestart({ ...linux, systemdAvailable: false })).toEqual({ kind: "pkill-respawn" });
  });

  it("falls back to pkill+respawn when the unit file is missing", () => {
    expect(planRestart({ ...linux, unitFileExists: false })).toEqual({ kind: "pkill-respawn" });
  });
});

describe("planRestart — other platforms", () => {
  it("flags Windows as unsupported", () => {
    const plan = planRestart({ ...base, platform: "win32" });
    expect(plan.kind).toBe("unsupported");
  });
});

describe("DAEMON_PKILL_PATTERN", () => {
  // pkill -f matches against the full argv joined by spaces. The pattern
  // must hit the daemon's entry point but miss the `nlm restart` command
  // that runs pkill, otherwise pkill kills its own caller.
  function matches(argv: string): boolean {
    return new RegExp(DAEMON_PKILL_PATTERN).test(argv);
  }

  it("matches a dist daemon invocation", () => {
    expect(matches("node /usr/local/lib/node_modules/nlm-memory/dist/cli/nlm.js start")).toBe(true);
  });

  it("matches a tsx dev daemon invocation", () => {
    expect(matches("node --import tsx/loader src/cli/nlm.ts start")).toBe(true);
  });

  it("does NOT match an `nlm restart` invocation", () => {
    expect(matches("node /usr/local/lib/node_modules/nlm-memory/dist/cli/nlm.js restart")).toBe(false);
  });

  it("does NOT match the pkill command line itself", () => {
    expect(matches("pkill -f nlm\\.(js|ts) start")).toBe(false);
  });
});

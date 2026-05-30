import { describe, expect, it } from "vitest";
import { planRestart, type RestartContext } from "../../../src/cli/restart-helpers.js";

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

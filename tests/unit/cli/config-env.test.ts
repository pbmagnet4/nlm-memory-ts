import { describe, expect, it } from "vitest";
import { applyEnvAssignment } from "../../../src/cli/config-env.js";

describe("applyEnvAssignment — insert", () => {
  it("appends a fresh key to an empty file", () => {
    expect(applyEnvAssignment("", "FOO", "bar")).toBe("FOO=bar\n");
  });

  it("appends a fresh key to a populated file", () => {
    const input = "A=1\nB=2\n";
    expect(applyEnvAssignment(input, "C", "3")).toBe("A=1\nB=2\nC=3\n");
  });

  it("doesn't grow empty trailing lines on repeated appends", () => {
    let s = "";
    s = applyEnvAssignment(s, "A", "1");
    s = applyEnvAssignment(s, "B", "2");
    s = applyEnvAssignment(s, "C", "3");
    expect(s).toBe("A=1\nB=2\nC=3\n");
  });
});

describe("applyEnvAssignment — update", () => {
  it("replaces an existing value in place, preserving line order", () => {
    const input = "A=1\nFOO=old\nB=2\n";
    expect(applyEnvAssignment(input, "FOO", "new")).toBe("A=1\nFOO=new\nB=2\n");
  });

  it("preserves surrounding comments", () => {
    const input = "# comment about FOO\nFOO=old\n# comment about B\nB=2\n";
    expect(applyEnvAssignment(input, "FOO", "new")).toBe(
      "# comment about FOO\nFOO=new\n# comment about B\nB=2\n",
    );
  });

  it("does NOT match commented-out lines", () => {
    const input = "#FOO=old\n";
    // The active assignment is missing → append rather than uncomment.
    expect(applyEnvAssignment(input, "FOO", "new")).toBe("#FOO=old\nFOO=new\n");
  });

  it("handles `export KEY=...` prefix", () => {
    const input = "export FOO=old\n";
    expect(applyEnvAssignment(input, "FOO", "new")).toBe("export FOO=new\n");
  });
});

describe("applyEnvAssignment — remove", () => {
  it("removes a matching line when value is null", () => {
    const input = "A=1\nFOO=stale\nB=2\n";
    expect(applyEnvAssignment(input, "FOO", null)).toBe("A=1\nB=2\n");
  });

  it("removing a non-existent key is a no-op", () => {
    const input = "A=1\n";
    expect(applyEnvAssignment(input, "FOO", null)).toBe("A=1\n");
  });
});

describe("applyEnvAssignment — value formatting", () => {
  it("quotes values containing whitespace", () => {
    expect(applyEnvAssignment("", "FOO", "a b")).toBe('FOO="a b"\n');
  });

  it("escapes embedded double quotes", () => {
    expect(applyEnvAssignment("", "FOO", 'a"b')).toContain('FOO="a\\"b"');
  });

  it("does not quote simple alphanumeric values", () => {
    expect(applyEnvAssignment("", "FOO", "cookie")).toBe("FOO=cookie\n");
  });
});

describe("applyEnvAssignment — special key names", () => {
  it("matches the exact key only, not a longer key with the same prefix", () => {
    const input = "FOO_BAR=keep\nFOO=replace\n";
    expect(applyEnvAssignment(input, "FOO", "new")).toBe("FOO_BAR=keep\nFOO=new\n");
  });
});

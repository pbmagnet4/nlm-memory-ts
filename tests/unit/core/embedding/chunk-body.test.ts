import { describe, expect, it } from "vitest";
import {
  chunkSessionText,
  MAX_CHUNK_CHARS,
  OVERLAP_CHARS,
} from "../../../../src/core/embedding/chunk-body.js";

describe("chunkSessionText", () => {
  it("returns empty array when label, summary, and body are all blank", () => {
    expect(chunkSessionText({})).toEqual([]);
    expect(chunkSessionText({ label: "", summary: "  ", body: "" })).toEqual([]);
  });

  it("returns a header-only chunk when body is empty", () => {
    const chunks = chunkSessionText({ label: "Meeting notes", summary: "Q4 plan" });
    expect(chunks).toEqual(["Meeting notes Q4 plan"]);
  });

  it("returns one chunk when header + body fits in maxChars", () => {
    const chunks = chunkSessionText(
      { label: "L", summary: "S", body: "hello world" },
      { maxChars: 100, overlap: 10 },
    );
    expect(chunks).toEqual(["L S hello world"]);
  });

  it("splits body into multiple chunks with overlap when over maxChars", () => {
    // body 250 chars, maxChars=100, overlap=20, no header → step=80
    // chunk 0: body[0..100], chunk 1: body[80..180], chunk 2: body[160..250]
    const body = "x".repeat(250);
    const chunks = chunkSessionText(
      { body },
      { maxChars: 100, overlap: 20 },
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.length).toBe(100);
    expect(chunks[1]!.length).toBe(100);
    expect(chunks[2]!.length).toBe(90);
  });

  it("preserves overlap content between adjacent chunks", () => {
    // Recognisable letters so we can confirm the boundary overlaps.
    const body =
      "A".repeat(50) +
      "B".repeat(50) +
      "C".repeat(50) +
      "D".repeat(50); // 200 chars
    const chunks = chunkSessionText(
      { body },
      { maxChars: 80, overlap: 20 },
    );
    // chunk 0: body[0..80] → AAA...AAA BBB...BBB BB (50 A + 30 B)
    // chunk 1: body[60..140] → 40 B + 40 C overlapping the last 20 B from chunk 0
    expect(chunks[0]!.slice(-10)).toBe("B".repeat(10));
    expect(chunks[1]!.slice(0, 20)).toBe("B".repeat(20)); // overlap
  });

  it("accounts for header in first-chunk budget", () => {
    const header = "h".repeat(20);
    const body = "b".repeat(200);
    const chunks = chunkSessionText(
      { label: header, body },
      { maxChars: 100, overlap: 10 },
    );
    // First chunk: 20-char header + space + body[0..79] = 100 chars total
    // Second chunk: body[69..169] (90 chars body budget - 10 overlap from start of body)
    expect(chunks[0]!.startsWith(header + " ")).toBe(true);
    expect(chunks[0]!.length).toBeLessThanOrEqual(100);
  });

  it("respects defaults (MAX_CHUNK_CHARS, OVERLAP_CHARS) when no opts passed", () => {
    const body = "y".repeat(MAX_CHUNK_CHARS * 2 + 1000);
    const chunks = chunkSessionText({ body });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    // Overlap default sanity: consecutive chunks should share OVERLAP_CHARS
    expect(OVERLAP_CHARS).toBeGreaterThan(0);
  });

  it("throws on invalid options", () => {
    expect(() => chunkSessionText({ body: "x" }, { maxChars: 0 })).toThrow();
    expect(() => chunkSessionText({ body: "x" }, { maxChars: 100, overlap: -1 })).toThrow();
    expect(() => chunkSessionText({ body: "x" }, { maxChars: 100, overlap: 100 })).toThrow();
  });

  it("trims whitespace at chunk boundaries", () => {
    const body = "alpha   " + "z".repeat(200);
    const chunks = chunkSessionText({ body }, { maxChars: 100, overlap: 20 });
    for (const c of chunks) {
      expect(c).toBe(c.trim());
    }
  });

  it("returns at least one chunk for tiny non-empty input", () => {
    expect(chunkSessionText({ body: "x" })).toEqual(["x"]);
    expect(chunkSessionText({ label: "x" })).toEqual(["x"]);
  });
});

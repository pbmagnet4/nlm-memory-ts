import { describe, expect, it } from "vitest";
import { detectQueryShape } from "../../../src/core/recall/query-shape.js";

describe("detectQueryShape", () => {
  it("returns false/false for empty query", () => {
    expect(detectQueryShape("")).toEqual({ hasTemporal: false, hasNamedEntity: false });
  });

  describe("Real LongMemEval temporal queries that should fire the boost", () => {
    const cases: ReadonlyArray<string> = [
      "How many days ago did I meet Emma?",
      "How many days ago did I watch the Super Bowl?",
      "How many months ago did I book the Airbnb in San Francisco?",
      "When did I book the Airbnb in Sacramento?",
      "How many days before I bought my iPad did I attend the Holiday Market?",
      "How many weeks ago did I attend the friends and family sale at Nordstrom?",
      "How many months ago did I attend the Seattle International Film Festival?",
      "How many days ago did I attend the Maundy Thursday service at the Episcopal Church?",
    ];
    for (const q of cases) {
      it(`fires on: ${q.slice(0, 50)}...`, () => {
        const shape = detectQueryShape(q);
        expect(shape.hasTemporal).toBe(true);
        expect(shape.hasNamedEntity).toBe(true);
      });
    }
  });

  describe("Temporal queries without named entities (must NOT fire)", () => {
    const cases: ReadonlyArray<string> = [
      "Which book did I finish a week ago?",
      "Who did I meet at lunch last Tuesday?",
      "sports event two weeks ago",
      "gardening-related activity two weeks ago",
      "art-related event two weeks ago",
      "order of three sports events past month",
    ];
    for (const q of cases) {
      it(`temporal=true, entity=false on: ${q.slice(0, 50)}...`, () => {
        const shape = detectQueryShape(q);
        expect(shape.hasNamedEntity).toBe(false);
      });
    }
  });

  describe("Non-temporal queries", () => {
    it("plain semantic query has no temporal trigger", () => {
      expect(detectQueryShape("what is my favorite color").hasTemporal).toBe(false);
    });

    it("named entity without temporal does not fire combined boost", () => {
      const shape = detectQueryShape("tell me about Nordstrom");
      expect(shape.hasTemporal).toBe(false);
      expect(shape.hasNamedEntity).toBe(true);
    });

    it("sentence-start capitalization alone is not a named entity", () => {
      const shape = detectQueryShape("Yesterday I went shopping");
      expect(shape.hasTemporal).toBe(true);
      expect(shape.hasNamedEntity).toBe(false);
    });

    it("day-of-week tokens are not named entities", () => {
      expect(detectQueryShape("did I meet last Tuesday with someone").hasNamedEntity).toBe(false);
    });

    it("month-name tokens are not named entities", () => {
      expect(detectQueryShape("in June I went to a thing").hasNamedEntity).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("ALL-CAPS acronyms count as named entities", () => {
      const shape = detectQueryShape("how many days ago did I visit NYC");
      expect(shape.hasNamedEntity).toBe(true);
      expect(shape.hasTemporal).toBe(true);
    });

    it("single capital letter does not count", () => {
      expect(detectQueryShape("yesterday I went out").hasNamedEntity).toBe(false);
    });

    it("hyphenated proper noun counts", () => {
      expect(detectQueryShape("two weeks ago I visited Coca-Cola").hasNamedEntity).toBe(true);
    });

    it("camelCase / PascalCase product names count (iPad, FarmFresh)", () => {
      expect(detectQueryShape("how many days ago did I buy my iPad").hasNamedEntity).toBe(true);
      expect(detectQueryShape("did I shop at FarmFresh last week").hasNamedEntity).toBe(true);
    });
  });
});

/**
 * Unit tests for OllamaClient.classify against an injected fake fetch.
 * No network. Verifies prompt construction, JSON-mode handling, schema
 * validation, fence stripping, and error mapping.
 */

import { describe, expect, it } from "vitest";
import { OllamaClient, ClassifierSchemaError } from "../../../src/llm/ollama-client.js";
import { LLMUnreachableError } from "../../../src/ports/llm-client.js";

type FakeFetch = typeof fetch;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(reply: (req: { url: string; body: unknown }) => Response | Promise<Response>): FakeFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body.toString()) : null;
    return reply({ url, body });
  }) as FakeFetch;
}

const VALID_PAYLOAD = {
  label: "Phase C classifier port",
  summary: "Built OllamaClient.classify with JSON-mode and schema validation against the shared prompt module.",
  entities: ["NLE Memory", "Ollama", "OllamaClient"],
  decisions: ["Map schema-invalid output to a typed ClassifierSchemaError instead of returning null"],
  open: ["Whether to retry once on schema failure or send to inbox immediately"],
  confidence: 0.85,
};

describe("OllamaClient.classify", () => {
  it("parses a valid JSON payload through the Ollama chat envelope", async () => {
    const fetchImpl = makeFetch(({ url, body }) => {
      expect(url).toContain("/api/chat");
      const b = body as { model: string; messages: { role: string; content: string }[]; format: string };
      expect(b.format).toBe("json");
      expect(b.messages[0]?.role).toBe("system");
      expect(b.messages[0]?.content).toContain("session classifier");
      expect(b.messages[1]?.content).toContain("TRANSCRIPT TO CLASSIFY");
      return jsonResponse({ message: { content: JSON.stringify(VALID_PAYLOAD) } });
    });
    const client = new OllamaClient({ fetchImpl });
    const result = await client.classify("user: build the classifier\nassistant: done");
    expect(result.label).toBe(VALID_PAYLOAD.label);
    expect(result.entities).toEqual(VALID_PAYLOAD.entities);
    expect(result.decisions).toHaveLength(1);
    expect(result.confidence).toBeCloseTo(0.85);
  });

  it("threads priorContext into the user prompt when supplied", async () => {
    let userContent = "";
    const fetchImpl = makeFetch(({ body }) => {
      const b = body as { messages: { role: string; content: string }[] };
      userContent = b.messages[1]?.content ?? "";
      return jsonResponse({ message: { content: JSON.stringify(VALID_PAYLOAD) } });
    });
    const client = new OllamaClient({ fetchImpl });
    await client.classify("...transcript...", "earlier session about Hono routing");
    expect(userContent).toContain("PRIOR CONTEXT (already filed):");
    expect(userContent).toContain("earlier session about Hono routing");
  });

  it("strips markdown fences before JSON parse", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_PAYLOAD) + "\n```";
    const fetchImpl = makeFetch(() =>
      jsonResponse({ message: { content: fenced } }),
    );
    const client = new OllamaClient({ fetchImpl });
    const result = await client.classify("transcript");
    expect(result.label).toBe(VALID_PAYLOAD.label);
  });

  it("throws ClassifierSchemaError when required keys are missing", async () => {
    const bad = { label: "x", summary: "y" };
    const fetchImpl = makeFetch(() =>
      jsonResponse({ message: { content: JSON.stringify(bad) } }),
    );
    const client = new OllamaClient({ fetchImpl });
    await expect(client.classify("transcript")).rejects.toBeInstanceOf(ClassifierSchemaError);
  });

  it("throws ClassifierSchemaError when the model returns non-JSON", async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({ message: { content: "not even close to json" } }),
    );
    const client = new OllamaClient({ fetchImpl });
    await expect(client.classify("transcript")).rejects.toBeInstanceOf(ClassifierSchemaError);
  });

  it("maps non-200 HTTP responses to LLMUnreachableError", async () => {
    const fetchImpl = makeFetch(() =>
      new Response("server down", { status: 503 }),
    );
    const client = new OllamaClient({ fetchImpl });
    await expect(client.classify("transcript")).rejects.toBeInstanceOf(LLMUnreachableError);
  });

  it("maps network throws to LLMUnreachableError", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("ECONNREFUSED");
    }) as FakeFetch;
    const client = new OllamaClient({ fetchImpl });
    await expect(client.classify("transcript")).rejects.toBeInstanceOf(LLMUnreachableError);
  });

  it("coerces non-string entities to strings and trims whitespace", async () => {
    const messy = {
      ...VALID_PAYLOAD,
      entities: ["  n8n  ", " ", "Qdrant", 42],
    };
    const fetchImpl = makeFetch(() =>
      jsonResponse({ message: { content: JSON.stringify(messy) } }),
    );
    const client = new OllamaClient({ fetchImpl });
    const result = await client.classify("transcript");
    expect(result.entities).toEqual(["n8n", "Qdrant", "42"]);
  });
});

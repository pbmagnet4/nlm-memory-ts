/**
 * LLM judge for the extraction-quality eval. Pluggable OpenAI-compatible
 * endpoint; the first audition runs it against the Mac Studio oMLX server.
 *
 * oMLX quirk (confirmed 2026-06): non-streaming requests return an empty 200
 * when the model errors mid-generation, and surface errors INSIDE the SSE
 * stream rather than as an HTTP status. So we always request stream:true and
 * reassemble the deltas, treating an empty assembled body as a hard failure.
 *
 * Every judge prompt demands a JSON-only verdict object. Verdicts cache on
 * disk keyed by sha256(model + ":" + prompt) so re-runs are free.
 */

import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface JudgeOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

/**
 * Reassemble an OpenAI-compatible streaming chat completion into one string.
 * Retries transient transport drops — oMLX blips the socket when it swaps the
 * resident model, which surfaces as ECONNREFUSED/fetch-failed mid-run.
 */
export async function streamChat(
  opts: JudgeOptions,
  system: string,
  user: string,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(15_000, 5_000 * attempt)));
    try {
      return await streamChatOnce(opts, system, user);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function streamChatOnce(
  opts: JudgeOptions,
  system: string,
  user: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`judge HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let evt: unknown;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        const obj = evt as {
          error?: { message?: string } | string;
          choices?: ReadonlyArray<{ delta?: { content?: string } }>;
        };
        if (obj.error) {
          const msg = typeof obj.error === "string" ? obj.error : obj.error.message;
          throw new Error(`judge stream error: ${msg ?? "unknown"}`);
        }
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string") out += delta;
      }
    }
    if (out.trim().length === 0) {
      throw new Error("judge returned empty stream (oMLX silent failure)");
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

const FENCE_RE = /^```(?:json)?\s*|\s*```$/gm;

/** Parse a JSON object out of a judge reply, tolerating fences and stray prose. */
export function parseJudgeJson(raw: string): Record<string, unknown> {
  const stripped = raw.replace(FENCE_RE, "").trim();
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error(`judge returned non-JSON: ${stripped.slice(0, 200)}`);
  }
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS verdicts (
  key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  reply TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** SHA256-keyed on-disk cache of judge replies. Mirrors ClassifierCache. */
export class JudgeCache {
  private readonly db: DB;
  private readonly opts: JudgeOptions;
  private readonly getStmt: ReturnType<DB["prepare"]>;
  private readonly putStmt: ReturnType<DB["prepare"]>;
  private hits = 0;
  private misses = 0;

  constructor(dbPath: string, opts: JudgeOptions) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.prepare(CREATE_SQL).run();
    this.getStmt = this.db.prepare("SELECT reply FROM verdicts WHERE key = @key");
    this.putStmt = this.db.prepare(
      "INSERT OR REPLACE INTO verdicts (key, model, reply) VALUES (@key, @model, @reply)",
    );
    this.opts = opts;
  }

  async judge(system: string, user: string): Promise<Record<string, unknown>> {
    const key = createHash("sha256")
      .update(`${this.opts.model}:${system}\n${user}`)
      .digest("hex");
    const row = this.getStmt.get({ key }) as { reply: string } | undefined;
    if (row) {
      this.hits++;
      return parseJudgeJson(row.reply);
    }
    this.misses++;
    // Parse BEFORE caching: a malformed verdict (oMLX occasionally emits a
    // truncated/doubled JSON object) must not poison the cache, or every re-run
    // replays the bad reply. Retry the call once on a parse failure; only a
    // parseable reply is cached.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await streamChat(this.opts, system, user);
      try {
        const parsed = parseJudgeJson(reply);
        this.putStmt.run({ key, model: this.opts.model, reply });
        return parsed;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  close(): void {
    this.db.close();
  }
}

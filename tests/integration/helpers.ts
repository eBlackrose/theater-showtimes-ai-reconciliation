import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest } from "~/server/agent/llm";
import { getActor, type Actor } from "~/server/auth/context";
import { createDb, type Db } from "~/server/db/client";
import { migrate } from "~/server/db/migrate";
import { seed } from "~/server/db/seed";

const TEST_SCHEMA = /^ronnie_test_[a-z0-9]+$/;

/** A throwaway schema on real Postgres: created, migrated and seeded for one test file. */
export async function createTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Set TEST_DATABASE_URL to run the integration tests.");
  const db = createDb(url, `ronnie_test_${randomBytes(6).toString("hex")}`, {
    max: 4,
    queryTimeout: 120,
  });
  await migrate(db);
  await seed(db);
  return db;
}

/** Drops the schema. Refuses anything that is not a test schema: this database is shared. */
export async function dropTestDb(db: Db): Promise<void> {
  if (!TEST_SCHEMA.test(db.schema)) {
    throw new Error(`Refusing to drop schema "${db.schema}".`);
  }
  await db.q.unsafe(`drop schema if exists "${db.schema}" cascade`);
  await db.q.end();
}

export const USERS = {
  avery: "user-admin-avery",
  casey: "user-admin-casey",
  riley: "user-viewer-riley",
  morgan: "user-viewer-morgan",
  jordan: "user-viewer-jordan",
} as const;

export const actorFor = (db: Db, userId: string): Promise<Actor> =>
  getActor(db, new Request("http://test.local", { headers: { "x-user-id": userId } }));

export const sample = (name: string) =>
  readFileSync(path.join(process.cwd(), "sample-data", name), "utf8");

type Scripted =
  | { tools: { name: string; input: unknown }[] }
  | { text: string }
  | { stop: Anthropic.Message["stop_reason"] }
  | { error: Error };

/**
 * A scripted model: each call returns the next step. A step can also be a function of the
 * request, to build a reply from what the loop sent.
 */
export function fakeLlm(
  steps: (Scripted | ((request: LlmRequest) => Scripted))[],
): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let call = 0;
  return {
    model: "fake-model",
    requests,
    create: async (request) => {
      // The loop mutates its message array; keep a snapshot of what was sent.
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const next = steps[call++];
      const step = typeof next === "function" ? next(request) : next;
      if (!step) throw new Error("The scripted model ran out of steps.");
      if ("error" in step) throw step.error;
      const content =
        "tools" in step
          ? step.tools.map((tool, index) => ({
              type: "tool_use",
              id: `toolu_${call}_${index}`,
              name: tool.name,
              input: tool.input,
            }))
          : "text" in step
            ? [{ type: "text", text: step.text }]
            : [];
      return {
        id: `msg_${call}`,
        type: "message",
        role: "assistant",
        model: "fake-model",
        content,
        stop_reason: "tools" in step ? "tool_use" : "text" in step ? "end_turn" : step.stop,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      } as unknown as Anthropic.Message;
    },
  };
}

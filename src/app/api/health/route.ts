import { NextResponse } from "next/server";
import { env } from "~/env";
import { getDb } from "~/server/db/app";
import { latestMigration } from "~/server/db/migrate";
import type { HealthResponse } from "~/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  let migration: string | null = null;
  let dbOk = false;
  try {
    migration = await latestMigration(db);
    dbOk = true;
  } catch (error) {
    console.error(error);
  }
  const body: HealthResponse = {
    ok: dbOk,
    db: { ok: dbOk, schema: db.schema, migration },
    llm: { configured: Boolean(env.ANTHROPIC_API_KEY), model: env.ANTHROPIC_MODEL },
    demoReset: env.DEMO_RESET_ENABLED,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  };
  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}

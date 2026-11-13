import "dotenv/config";
import { createDb, type Db } from "~/server/db/client";

/** Scripts use the session-mode pooler URL when it is set (DDL and long statements). */
export function scriptDb(): Db {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATION_DATABASE_URL or DATABASE_URL.");
  return createDb(url, process.env.DB_SCHEMA ?? "ronnie_takehome", {
    max: 1,
    queryTimeout: 120,
  });
}

export async function run(task: (db: Db) => Promise<void>): Promise<void> {
  const db = scriptDb();
  try {
    await task(db);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.q.end();
  }
}

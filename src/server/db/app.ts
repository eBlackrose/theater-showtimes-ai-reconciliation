import "server-only";
import { env } from "~/env";
import { createDb, type Db } from "./client";

const globalForDb = globalThis as unknown as { appDb?: Db };

/** The app's database handle. Kept on globalThis so hot reload does not leak pools. */
export function getDb(): Db {
  globalForDb.appDb ??= createDb(env.DATABASE_URL, env.DB_SCHEMA);
  return globalForDb.appDb;
}

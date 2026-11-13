import "server-only";
import postgres from "postgres";

export type Sql = postgres.Sql;

/**
 * A query handle plus the schema it works in. Repositories take a Db, so the same SQL runs
 * against the app schema, inside a transaction, or in a throwaway test schema.
 */
export interface Db {
  q: Sql;
  schema: string;
}

const SCHEMA_NAME = /^[a-z][a-z0-9_]*$/;

export function createDb(
  url: string,
  schema: string,
  options: { max?: number; queryTimeout?: number } = {},
): Db {
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(`Invalid schema name: ${schema}`);
  }
  const q = postgres(url, {
    prepare: false, // required behind a transaction-mode pooler
    max: options.max ?? 2,
    max_pipeline: 1, // Supabase's pooler before 2.10 hangs on pipelined queries in transaction mode
    idle_timeout: 20,
    connect_timeout: 15,
    query_timeout: options.queryTimeout ?? 30,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
    onnotice: () => undefined,
  });
  return { q, schema };
}

/**
 * Schema-qualified table identifier: tbl(db, "showtimes") -> "ronnie_takehome"."showtimes".
 * Always qualify: behind a transaction-mode pooler, search_path does not survive between statements.
 */
export const tbl = (db: Db, table: string) => db.q(`${db.schema}.${table}`);

/**
 * Run fn in one transaction. The Db passed to fn wraps the transaction handle; inside fn use
 * only that handle, because a call on the outer pool can deadlock a small pool.
 */
export function withTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.q.begin((tx) =>
    fn({ q: tx as unknown as Sql, schema: db.schema }),
  ) as Promise<T>;
}

/** One advisory lock per theater, transaction-scoped, so it is safe behind the pooler. */
export async function lockTheater(tx: Db, theaterId: string): Promise<void> {
  await tx.q`select pg_advisory_xact_lock(hashtextextended(${tx.schema + ":" + theaterId}, 0))`;
}

import "server-only";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tbl, type Db } from "./client";

/**
 * Apply db/migrations/*.sql in name order. Each file is idempotent (`if not exists`) and is
 * recorded in schema_migrations, so running this twice is harmless.
 */
export async function migrate(
  db: Db,
  directory = path.join(process.cwd(), "db", "migrations"),
): Promise<string[]> {
  const files = (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const text = (await readFile(path.join(directory, file), "utf8")).replaceAll(
      "__SCHEMA__",
      db.schema, // validated against ^[a-z][a-z0-9_]*$ by createDb
    );
    await db.q.unsafe(text);
    const inserted = await db.q`
      insert into ${tbl(db, "schema_migrations")} (version) values (${version})
      on conflict do nothing returning version`;
    if (inserted.length > 0) applied.push(version);
  }
  return applied;
}

export async function latestMigration(db: Db): Promise<string | null> {
  const rows = await db.q<{ version: string }[]>`
    select version from ${tbl(db, "schema_migrations")} order by version desc limit 1`;
  return rows[0]?.version ?? null;
}

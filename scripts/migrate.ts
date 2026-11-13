import { latestMigration, migrate } from "~/server/db/migrate";
import { run } from "./_db";

await run(async (db) => {
  const applied = await migrate(db);
  console.log(
    `schema ${db.schema}: ${applied.length ? `applied ${applied.join(", ")}` : "already up to date"} (latest ${await latestMigration(db)})`,
  );
});

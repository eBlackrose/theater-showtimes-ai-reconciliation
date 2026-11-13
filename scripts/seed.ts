import { tbl } from "~/server/db/client";
import { seed } from "~/server/db/seed";
import { run } from "./_db";

await run(async (db) => {
  await seed(db);
  const [counts] = await db.q`
    select (select count(*)::int from ${tbl(db, "theaters")}) as theaters,
           (select count(*)::int from ${tbl(db, "users")}) as users,
           (select count(*)::int from ${tbl(db, "movies")}) as movies,
           (select count(*)::int from ${tbl(db, "auditoriums")}) as auditoriums,
           (select count(*)::int from ${tbl(db, "showtimes")}) as showtimes`;
  console.log(`schema ${db.schema}: seeded`, counts);
});

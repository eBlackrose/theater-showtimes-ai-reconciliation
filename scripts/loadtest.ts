/**
 * Search at scale, with numbers:
 *   npm run loadtest -- --rows 300000
 * Creates a throwaway schema, loads N showtimes over 20,000 movies, times the list queries
 * the console uses, prints the timings, and drops the schema.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { getActor } from "~/server/auth/context";
import { createDb, tbl } from "~/server/db/client";
import { migrate } from "~/server/db/migrate";
import { seed } from "~/server/db/seed";
import { listShowtimes, showtimeListQuery } from "~/server/showtimes/query";

const index = process.argv.indexOf("--rows");
const rows = index >= 0 ? Number(process.argv[index + 1]) : 300_000;
const MOVIES = 20_000;
const url = process.env.TEST_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to run the load test.");

const db = createDb(url, `ronnie_test_${randomBytes(6).toString("hex")}`, { max: 2, queryTimeout: 300 });
try {
  await migrate(db);
  await seed(db);
  const words = ["Night", "River", "Last", "Summer", "Iron", "Secret", "Garden", "Star", "Winter", "Road"];
  await db.q`
    insert into ${tbl(db, "movies")} (id, title, normalized_title)
    select 'mv-load-' || i,
           (${words}::text[])[1 + i % 10] || ' ' || (${words}::text[])[1 + (i / 10) % 10] || ' ' || i,
           lower((${words}::text[])[1 + i % 10] || ' ' || (${words}::text[])[1 + (i / 10) % 10] || ' ' || i)
    from generate_series(1, ${MOVIES}) as i`;
  // Spread over three theaters and 400 days; identity (theater, movie, start) stays unique.
  await db.q`
    insert into ${tbl(db, "showtimes")}
      (id, theater_id, movie_id, auditorium_id, start_time, end_time, language, format, rating, last_updated)
    select 'st-load-' || i,
           (array['theater-downtown', 'theater-riverside', 'theater-uptown'])[1 + i % 3],
           'mv-load-' || (1 + i % ${MOVIES}),
           (array['aud-downtown-auditorium-1', 'aud-riverside-auditorium-a', 'aud-uptown-screen-1'])[1 + i % 3],
           timestamptz '2025-01-01T00:00:00Z' + (i % 576000) * interval '1 minute',
           timestamptz '2025-01-01T02:00:00Z' + (i % 576000) * interval '1 minute',
           'EN', (array['2D', '3D', 'IMAX'])[1 + i % 3], 'PG-13', now()
    from generate_series(1, ${rows}) as i`;
  await db.q.unsafe(`analyze "${db.schema}".showtimes; analyze "${db.schema}".movies`);

  const actor = await getActor(
    db,
    new Request("http://load.local", { headers: { "x-user-id": "user-admin-casey" } }),
  );
  const scenarios: [string, Record<string, string>][] = [
    ["first page, default sort", {}],
    ["one theater, active, page 50", { theaterId: "theater-downtown", status: "active", page: "50" }],
    ["title search 'secret garden'", { q: "secret garden" }],
    ["title search + format filter", { q: "iron", format: "IMAX" }],
    ["one local day", { startDate: "2025-03-01", endDate: "2025-03-01" }],
    ["sort by movie title", { sortBy: "movieTitle", theaterId: "theater-uptown" }],
    ["sort by last updated, descending", { sortBy: "lastUpdated", sortOrder: "desc" }],
  ];
  console.log(`${rows.toLocaleString("en-US")} showtimes, ${MOVIES.toLocaleString("en-US")} movies`);
  for (const [label, query] of scenarios) {
    const parsed = showtimeListQuery.parse(query);
    await listShowtimes(db, actor, parsed); // warm
    const timings: number[] = [];
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      total = (await listShowtimes(db, actor, parsed)).total;
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    console.log(
      `  ${label.padEnd(36)} ${String(Math.round(timings[2] ?? 0)).padStart(5)} ms median  (${total.toLocaleString("en-US")} matches)`,
    );
  }
} finally {
  if (/^ronnie_test_[a-z0-9]+$/.test(db.schema)) {
    await db.q.unsafe(`drop schema if exists "${db.schema}" cascade`);
  }
  await db.q.end();
}

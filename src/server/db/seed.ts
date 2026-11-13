import "server-only";
import { normalizeKey } from "~/server/domain/normalize";
import { tbl, withTx, type Db } from "./client";
import {
  seedCatalogTitles,
  seedShowtimes,
  seedTheaters,
  seedUsers,
} from "./seed-data";

const slug = (value: string) => normalizeKey(value).replace(/ /g, "-");
export const seedMovieId = (title: string) => `mv-${slug(title)}`;
export const seedAuditoriumId = (theaterId: string, name: string) =>
  `aud-${theaterId.replace(/^theater-/, "")}-${slug(name)}`;

const DATA_TABLES = [
  "audit_log",
  "llm_usage_daily",
  "import_events",
  "import_actions",
  "import_resolutions",
  "import_theaters",
  "import_files",
  "imports",
  "showtimes",
  "auditorium_aliases",
  "auditoriums",
  "movie_aliases",
  "movies",
  "user_theaters",
  "users",
  "theaters",
];

/** Load the demo data into the normalized model. Safe to run twice: existing rows are kept. */
export const seed = (db: Db): Promise<void> => withTx(db, seedInto);

async function seedInto(tx: Db): Promise<void> {
  const movies = [
    ...new Set([...seedShowtimes.map((s) => s.movieTitle), ...seedCatalogTitles]),
  ].map((title) => ({
    id: seedMovieId(title),
    title,
    normalized_title: normalizeKey(title),
  }));
  const auditoriums = [
    ...new Map(
      seedShowtimes.map((s) => [
        seedAuditoriumId(s.theaterId, s.auditorium),
        {
          id: seedAuditoriumId(s.theaterId, s.auditorium),
          theater_id: s.theaterId,
          name: s.auditorium,
          normalized_name: normalizeKey(s.auditorium),
        },
      ]),
    ).values(),
  ];
  const showtimes = seedShowtimes.map((s) => ({
    id: s.id,
    theater_id: s.theaterId,
    movie_id: seedMovieId(s.movieTitle),
    auditorium_id: seedAuditoriumId(s.theaterId, s.auditorium),
    start_time: s.startTime,
    end_time: s.endTime,
    language: s.language,
    format: s.format,
    rating: s.rating,
    movie_status: s.movieStatus,
    status: s.status,
    last_updated: s.lastUpdated,
  }));

  const { q } = tx;
  await q`
      insert into ${tbl(tx, "theaters")} (id, name, normalized_name, location, timezone)
      select id, name, normalized_name, location, timezone
      from jsonb_to_recordset(${q.json(
        seedTheaters.map((t) => ({ ...t, normalized_name: normalizeKey(t.name) })),
      )}::jsonb) as x(id text, name text, normalized_name text, location text, timezone text)
      on conflict do nothing`;
    await q`
      insert into ${tbl(tx, "users")} (id, name, email, role)
      select id, name, email, role
      from jsonb_to_recordset(${q.json(
        seedUsers.map(({ id, name, email, role }) => ({ id, name, email, role })),
      )}::jsonb) as x(id text, name text, email text, role text)
      on conflict do nothing`;
    await q`
      insert into ${tbl(tx, "user_theaters")} (user_id, theater_id)
      select user_id, theater_id
      from jsonb_to_recordset(${q.json(
        seedUsers.flatMap((u) =>
          u.theaterIds.map((theater_id) => ({ user_id: u.id, theater_id })),
        ),
      )}::jsonb) as x(user_id text, theater_id text)
      on conflict do nothing`;
    await q`
      insert into ${tbl(tx, "movies")} (id, title, normalized_title)
      select id, title, normalized_title
      from jsonb_to_recordset(${q.json(movies)}::jsonb)
        as x(id text, title text, normalized_title text)
      on conflict do nothing`;
    await q`
      insert into ${tbl(tx, "auditoriums")} (id, theater_id, name, normalized_name)
      select id, theater_id, name, normalized_name
      from jsonb_to_recordset(${q.json(auditoriums)}::jsonb)
        as x(id text, theater_id text, name text, normalized_name text)
      on conflict do nothing`;
    await q`
      insert into ${tbl(tx, "showtimes")}
        (id, theater_id, movie_id, auditorium_id, start_time, end_time, language, format,
         rating, movie_status, status, last_updated)
      select id, theater_id, movie_id, auditorium_id, start_time, end_time, language, format,
             rating, movie_status, status, last_updated
      from jsonb_to_recordset(${q.json(showtimes)}::jsonb) as x(
        id text, theater_id text, movie_id text, auditorium_id text, start_time timestamptz,
        end_time timestamptz, language text, format text, rating text, movie_status text,
        status text, last_updated timestamptz)
      on conflict do nothing`;
}

/**
 * Empty every table of the schema and re-seed. Refuses to run on `public` or on any schema
 * other than the one the caller says it expects, because this database is shared.
 */
export async function resetDemo(db: Db, expectedSchema: string): Promise<void> {
  if (db.schema === "public" || db.schema !== expectedSchema) {
    throw new Error(
      `Refusing to reset schema "${db.schema}": it is not the configured schema "${expectedSchema}".`,
    );
  }
  const tables = DATA_TABLES.map((t) => `"${db.schema}"."${t}"`).join(", ");
  await withTx(db, async (tx) => {
    await tx.q.unsafe(`truncate table ${tables} restart identity`);
    await seedInto(tx);
  });
}

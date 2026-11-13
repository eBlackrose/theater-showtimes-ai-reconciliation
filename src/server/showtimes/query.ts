import "server-only";
import { z } from "zod";
import type { Actor } from "~/server/auth/context";
import { lockTheater, tbl, withTx, type Db } from "~/server/db/client";
import { normalizeKey } from "~/server/domain/normalize";
import { notFound } from "~/server/http/errors";
import type { MovieStatus, Showtime, ShowtimeStatus } from "~/types/assessment";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

export const MAX_PAGE_SIZE = 100;

export const showtimeListQuery = z.object({
  theaterId: optional(z.string()),
  q: optional(z.string().max(200)),
  status: optional(z.enum(["active", "inactive", "archived"])),
  format: optional(z.string().max(50)),
  language: optional(z.string().max(50)),
  rating: optional(z.string().max(50)),
  auditorium: optional(z.string().max(200)),
  movieStatus: optional(z.enum(["approved", "draft", "flagged", "needs-review"])),
  startDate: optional(day),
  endDate: optional(day),
  sortBy: z
    .enum(["startTime", "endTime", "lastUpdated", "movieTitle", "theaterName", "movieStatus"])
    .default("startTime"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});
export type ShowtimeListQuery = z.infer<typeof showtimeListQuery>;

interface ShowtimeRow {
  id: string;
  theater_id: string;
  movie_title: string;
  movie_status: MovieStatus;
  auditorium: string;
  start_time: Date;
  end_time: Date;
  language: string;
  format: string;
  rating: string;
  last_updated: Date;
  status: ShowtimeStatus;
}

const toShowtime = (row: ShowtimeRow): Showtime => ({
  id: row.id,
  theaterId: row.theater_id,
  movieTitle: row.movie_title,
  movieStatus: row.movie_status,
  auditorium: row.auditorium,
  startTime: row.start_time.toISOString(),
  endTime: row.end_time.toISOString(),
  language: row.language,
  format: row.format,
  rating: row.rating,
  lastUpdated: row.last_updated.toISOString(),
  status: row.status,
});

/** The theaters a list request covers: the requested one, or all of the actor's. */
function scopeTheaters(actor: Actor, theaterId: string | undefined): string[] {
  if (!theaterId) return actor.theaterIds;
  // 403 is thrown by the route for a theater outside the actor's set; here it is just a filter.
  return actor.theaterIds.includes(theaterId) ? [theaterId] : [];
}

function filters(db: Db, theaterIds: string[], query: Partial<ShowtimeListQuery>) {
  const { q } = db;
  const parts = [q`s.theater_id = any(${theaterIds}::text[])`];
  const key = normalizeKey(query.q);
  if (key) {
    // Contains-search runs on the small movies table (and its aliases); trigram indexes serve it.
    const pattern = `%${key}%`;
    parts.push(q`s.movie_id in (
      select id from ${tbl(db, "movies")} where normalized_title like ${pattern}
      union
      select movie_id from ${tbl(db, "movie_aliases")} where normalized_alias like ${pattern})`);
  }
  if (query.status) parts.push(q`s.status = ${query.status}`);
  if (query.format) parts.push(q`s.format = ${query.format}`);
  if (query.language) parts.push(q`s.language = ${query.language}`);
  if (query.rating) parts.push(q`s.rating = ${query.rating}`);
  if (query.movieStatus) parts.push(q`s.movie_status = ${query.movieStatus}`);
  if (query.auditorium) parts.push(q`a.name = ${query.auditorium}`);
  // Date filters mean theater-local days. The UTC bounds are a superset that lets the
  // (theater_id, start_time) index narrow the scan before the exact local-day check.
  if (query.startDate) {
    parts.push(q`s.start_time >= ${query.startDate}::date - 1
      and (s.start_time at time zone t.timezone)::date >= ${query.startDate}::date`);
  }
  if (query.endDate) {
    parts.push(q`s.start_time < ${query.endDate}::date + 2
      and (s.start_time at time zone t.timezone)::date <= ${query.endDate}::date`);
  }
  return parts.reduce((all, part) => q`${all} and ${part}`);
}

export async function listShowtimes(db: Db, actor: Actor, query: ShowtimeListQuery) {
  const { q } = db;
  const theaterIds = scopeTheaters(actor, query.theaterId);
  if (theaterIds.length === 0) {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }
  const where = filters(db, theaterIds, query);
  const from = q`
    from ${tbl(db, "showtimes")} s
    join ${tbl(db, "movies")} m on m.id = s.movie_id
    join ${tbl(db, "auditoriums")} a on a.id = s.auditorium_id
    join ${tbl(db, "theaters")} t on t.id = s.theater_id
    where ${where}`;

  // Sort columns come from a fixed map, never from the request text.
  const sortColumn = {
    startTime: q`s.start_time`,
    endTime: q`s.end_time`,
    lastUpdated: q`s.last_updated`,
    movieTitle: q`m.title`,
    theaterName: q`t.name`,
    movieStatus: q`s.movie_status`,
  }[query.sortBy];
  const direction = query.sortOrder === "desc" ? q`desc` : q`asc`;

  const [rows, count] = await Promise.all([
    q<ShowtimeRow[]>`
      select s.id, s.theater_id, m.title as movie_title, s.movie_status, a.name as auditorium,
             s.start_time, s.end_time, s.language, s.format, s.rating, s.last_updated, s.status
      ${from}
      order by ${sortColumn} ${direction}, s.id ${direction}
      limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`,
    q<{ total: number }[]>`select count(*)::int as total ${from}`,
  ]);
  return {
    items: rows.map(toShowtime),
    total: count[0]?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function filterOptions(db: Db, actor: Actor, theaterId?: string) {
  const { q } = db;
  const theaterIds = scopeTheaters(actor, theaterId);
  const empty = { formats: [], languages: [], ratings: [], auditoriums: [], movieStatuses: [] };
  if (theaterIds.length === 0) return empty;
  const rows = await q<{ kind: keyof typeof empty; value: string }[]>`
    select distinct 'formats' as kind, format as value from ${tbl(db, "showtimes")}
      where theater_id = any(${theaterIds}::text[]) and format <> ''
    union all
    select distinct 'languages', language from ${tbl(db, "showtimes")}
      where theater_id = any(${theaterIds}::text[]) and language <> ''
    union all
    select distinct 'ratings', rating from ${tbl(db, "showtimes")}
      where theater_id = any(${theaterIds}::text[]) and rating <> ''
    union all
    select distinct 'movieStatuses', movie_status from ${tbl(db, "showtimes")}
      where theater_id = any(${theaterIds}::text[])
    union all
    select distinct 'auditoriums', name from ${tbl(db, "auditoriums")}
      where theater_id = any(${theaterIds}::text[])
    order by 1, 2`;
  const options: Record<keyof typeof empty, string[]> = { ...empty };
  for (const row of rows) options[row.kind] = [...options[row.kind], row.value];
  return options;
}

export const showtimePatch = z
  .object({
    movieStatus: z.enum(["approved", "draft", "flagged", "needs-review"]).optional(),
    status: z.enum(["active", "inactive", "archived"]).optional(),
  })
  .refine((value) => value.movieStatus ?? value.status, {
    message: "Provide movieStatus or status.",
  });

async function getShowtime(db: Db, actor: Actor, id: string): Promise<Showtime> {
  const rows = await db.q<ShowtimeRow[]>`
    select s.id, s.theater_id, m.title as movie_title, s.movie_status, a.name as auditorium,
           s.start_time, s.end_time, s.language, s.format, s.rating, s.last_updated, s.status
    from ${tbl(db, "showtimes")} s
    join ${tbl(db, "movies")} m on m.id = s.movie_id
    join ${tbl(db, "auditoriums")} a on a.id = s.auditorium_id
    where s.id = ${id} and s.theater_id = any(${actor.theaterIds}::text[])`;
  // A showtime in someone else's theater looks exactly like one that does not exist.
  if (!rows[0]) throw notFound("Showtime");
  return toShowtime(rows[0]);
}

export async function updateShowtime(
  db: Db,
  actor: Actor,
  id: string,
  patch: z.infer<typeof showtimePatch>,
): Promise<Showtime> {
  const current = await getShowtime(db, actor, id);
  return withTx(db, async (tx) => {
    const { q } = tx;
    // A status change is a schedule write: same lock and version bump as an import.
    if (patch.status) await lockTheater(tx, current.theaterId);
    await q`
      update ${tbl(tx, "showtimes")} set
        movie_status = coalesce(${patch.movieStatus ?? null}, movie_status),
        status = coalesce(${patch.status ?? null}, status),
        row_version = row_version + 1, updated_at = now()
      where id = ${id}`;
    if (patch.status) {
      await q`update ${tbl(tx, "theaters")}
        set schedule_version = schedule_version + 1, updated_at = now()
        where id = ${current.theaterId}`;
    }
    await q`
      insert into ${tbl(tx, "audit_log")} (actor_user_id, action, theater_id, entity_id, details)
      values (${actor.id}, 'showtime.update', ${current.theaterId}, ${id}, ${q.json({
        from: { movieStatus: current.movieStatus, status: current.status },
        to: patch,
      })})`;
    return getShowtime(tx, actor, id);
  });
}

export async function clearSchedule(db: Db, actor: Actor, theaterId: string) {
  return withTx(db, async (tx) => {
    const { q } = tx;
    await lockTheater(tx, theaterId);
    const archived = await q`
      update ${tbl(tx, "showtimes")}
      set status = 'archived', row_version = row_version + 1, updated_at = now()
      where theater_id = ${theaterId} and status <> 'archived'`;
    await q`update ${tbl(tx, "theaters")}
      set schedule_version = schedule_version + 1, updated_at = now()
      where id = ${theaterId}`;
    await q`
      insert into ${tbl(tx, "audit_log")} (actor_user_id, action, theater_id, details)
      values (${actor.id}, 'schedule.clear', ${theaterId}, ${q.json({ archived: archived.count })})`;
    return { archived: archived.count };
  });
}

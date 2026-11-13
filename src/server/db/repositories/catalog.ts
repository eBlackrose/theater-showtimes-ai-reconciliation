import "server-only";
import { DateTime } from "luxon";
import type {
  AgentBackend,
  MovieSearchHit,
  ScheduleRow,
  TheaterContext,
} from "~/server/agent/types";
import { tbl, type Db } from "~/server/db/client";
import { normalizeKey } from "~/server/domain/normalize";
import type {
  CatalogSnapshot,
  ExistingShowtime,
  TimeWindow,
} from "~/server/domain/types";
import type { MovieStatus, ShowtimeStatus } from "~/types/assessment";

/** The part of the catalog one file needs: movies by key or id, and the rooms of its theaters. */
export async function loadCatalog(
  db: Db,
  input: {
    titleKeys: string[];
    movieIds: string[];
    theaterIds: string[];
    /**
     * At apply: movies this import created in an earlier theater's transaction still count
     * as "new", so the plan (and its hash) for the next theater is what the admin approved.
     */
    createdByImportId?: string;
  },
): Promise<CatalogSnapshot> {
  const { q } = db;
  const catalog: CatalogSnapshot = {
    movieTitles: new Map(),
    movieByKey: new Map(),
    movieAliasByKey: new Map(),
    rooms: new Map(),
  };

  const movies = await q<
    { id: string; title: string; normalized_title: string; created_by_import_id: string | null }[]
  >`
    select id, title, normalized_title, created_by_import_id from ${tbl(db, "movies")}
    where normalized_title = any(${input.titleKeys}::text[]) or id = any(${input.movieIds}::text[])`;
  for (const movie of movies) {
    catalog.movieTitles.set(movie.id, movie.title);
    if (!input.createdByImportId || movie.created_by_import_id !== input.createdByImportId) {
      catalog.movieByKey.set(movie.normalized_title, movie.id);
    }
  }
  const aliases = await q<{ movie_id: string; normalized_alias: string; title: string }[]>`
    select a.movie_id, a.normalized_alias, m.title
    from ${tbl(db, "movie_aliases")} a join ${tbl(db, "movies")} m on m.id = a.movie_id
    where a.normalized_alias = any(${input.titleKeys}::text[])`;
  for (const alias of aliases) {
    catalog.movieAliasByKey.set(alias.normalized_alias, alias.movie_id);
    catalog.movieTitles.set(alias.movie_id, alias.title);
  }

  for (const theaterId of input.theaterIds) {
    catalog.rooms.set(theaterId, { byId: new Map(), byKey: new Map(), aliasByKey: new Map() });
  }
  const rooms = await q<
    { id: string; theater_id: string; name: string; normalized_name: string }[]
  >`
    select id, theater_id, name, normalized_name from ${tbl(db, "auditoriums")}
    where theater_id = any(${input.theaterIds}::text[])`;
  for (const room of rooms) {
    const theater = catalog.rooms.get(room.theater_id)!;
    theater.byId.set(room.id, room.name);
    theater.byKey.set(room.normalized_name, room.id);
  }
  const roomAliases = await q<
    { auditorium_id: string; theater_id: string; normalized_alias: string }[]
  >`
    select auditorium_id, theater_id, normalized_alias from ${tbl(db, "auditorium_aliases")}
    where theater_id = any(${input.theaterIds}::text[])`;
  for (const alias of roomAliases) {
    catalog.rooms.get(alias.theater_id)?.aliasByKey.set(alias.normalized_alias, alias.auditorium_id);
  }
  return catalog;
}

/** A theater's stored showtimes inside the window (or all of them), in any status. */
export async function loadSchedule(
  db: Db,
  theaterId: string,
  window: TimeWindow | null,
): Promise<ExistingShowtime[]> {
  const { q } = db;
  const rows = await q<
    {
      id: string;
      movie_id: string;
      auditorium_id: string;
      start_time: Date;
      end_time: Date;
      language: string;
      format: string;
      rating: string;
      status: ShowtimeStatus;
      movie_status: MovieStatus;
      last_updated: Date;
    }[]
  >`
    select id, movie_id, auditorium_id, start_time, end_time, language, format, rating,
           status, movie_status, last_updated
    from ${tbl(db, "showtimes")}
    where theater_id = ${theaterId}
      ${window ? q`and start_time >= ${window.start} and start_time < ${window.end}` : q``}`;
  return rows.map((row) => ({
    id: row.id,
    movieId: row.movie_id,
    auditoriumId: row.auditorium_id,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    language: row.language,
    format: row.format,
    rating: row.rating,
    status: row.status,
    movieStatus: row.movie_status,
    lastUpdated: row.last_updated.toISOString(),
  }));
}

export async function findMovie(
  db: Db,
  by: { id: string } | { key: string },
): Promise<{ id: string; title: string } | null> {
  const { q } = db;
  const rows = await q<{ id: string; title: string }[]>`
    select id, title from ${tbl(db, "movies")}
    where ${"id" in by ? q`id = ${by.id}` : q`normalized_title = ${by.key}`}`;
  return rows[0] ?? null;
}

/**
 * Closest catalog movies by trigram similarity over titles and saved aliases. This scans the
 * movies table, which is small (one row per film, not per showtime); the trigram indexes
 * are there for the `%` operator when the catalog grows.
 */
export async function searchMovies(
  db: Db,
  query: string,
  limit: number,
  theaterIds: string[],
): Promise<MovieSearchHit[]> {
  const { q } = db;
  const key = normalizeKey(query);
  if (!key) return [];
  const rows = await q<
    { id: string; title: string; aliases: string[]; score: number; showing_at: string[] }[]
  >`
    select * from (
      select m.id, m.title,
             coalesce(array_agg(a.alias order by a.alias) filter (where a.alias is not null), '{}') as aliases,
             round(greatest(similarity(m.normalized_title, ${key}),
                            coalesce(max(similarity(a.normalized_alias, ${key})), 0))::numeric, 2)::float8 as score,
             coalesce((select array_agg(distinct t.name)
                       from ${tbl(db, "showtimes")} s join ${tbl(db, "theaters")} t on t.id = s.theater_id
                       where s.movie_id = m.id and s.status = 'active'
                         and s.theater_id = any(${theaterIds}::text[])), '{}') as showing_at
      from ${tbl(db, "movies")} m
      left join ${tbl(db, "movie_aliases")} a on a.movie_id = m.id
      group by m.id
    ) ranked
    where score >= 0.12
    order by score desc, title
    limit ${limit}`;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    aliases: row.aliases,
    score: row.score,
    showingAt: row.showing_at,
  }));
}

async function theaterContext(db: Db, theaterId: string): Promise<TheaterContext | null> {
  const { q } = db;
  const [theater] = await q<
    {
      id: string;
      name: string;
      timezone: string;
      live: number;
      first_date: string | null;
      last_date: string | null;
    }[]
  >`
    select t.id, t.name, t.timezone,
           count(s.id)::int as live,
           min((s.start_time at time zone t.timezone)::date)::text as first_date,
           max((s.start_time at time zone t.timezone)::date)::text as last_date
    from ${tbl(db, "theaters")} t
    left join ${tbl(db, "showtimes")} s on s.theater_id = t.id and s.status = 'active'
    where t.id = ${theaterId}
    group by t.id`;
  if (!theater) return null;
  const rooms = await q<{ id: string; name: string; aliases: string[] }[]>`
    select r.id, r.name,
           coalesce(array_agg(a.alias order by a.alias) filter (where a.alias is not null), '{}') as aliases
    from ${tbl(db, "auditoriums")} r
    left join ${tbl(db, "auditorium_aliases")} a on a.auditorium_id = r.id
    where r.theater_id = ${theaterId}
    group by r.id order by r.name`;
  return {
    id: theater.id,
    name: theater.name,
    timezone: theater.timezone,
    rooms: rooms.map((room) => ({ id: room.id, name: room.name, aliases: room.aliases })),
    liveShowtimes: theater.live,
    firstDate: theater.first_date,
    lastDate: theater.last_date,
  };
}

const SCHEDULE_LIMIT = 200;

async function scheduleRange(
  db: Db,
  input: { theaterId: string; fromDate: string; toDate: string; movieId: string | null },
): Promise<{ rows: ScheduleRow[]; truncated: boolean }> {
  const { q } = db;
  const rows = await q<
    {
      id: string;
      movie_id: string;
      title: string;
      auditorium: string;
      start_time: Date;
      end_time: Date;
      format: string;
      language: string;
      rating: string;
      status: string;
      timezone: string;
    }[]
  >`
    select s.id, s.movie_id, m.title, a.name as auditorium, s.start_time, s.end_time,
           s.format, s.language, s.rating, s.status, t.timezone
    from ${tbl(db, "showtimes")} s
    join ${tbl(db, "movies")} m on m.id = s.movie_id
    join ${tbl(db, "auditoriums")} a on a.id = s.auditorium_id
    join ${tbl(db, "theaters")} t on t.id = s.theater_id
    where s.theater_id = ${input.theaterId}
      and s.start_time >= ${input.fromDate}::date - 1
      and s.start_time < ${input.toDate}::date + 2
      and (s.start_time at time zone t.timezone)::date
          between ${input.fromDate}::date and ${input.toDate}::date
      ${input.movieId ? q`and s.movie_id = ${input.movieId}` : q``}
    order by s.start_time, s.id
    limit ${SCHEDULE_LIMIT + 1}`;
  const local = (date: Date, zone: string) =>
    DateTime.fromJSDate(date).setZone(zone).toFormat("yyyy-LL-dd HH:mm");
  return {
    truncated: rows.length > SCHEDULE_LIMIT,
    rows: rows.slice(0, SCHEDULE_LIMIT).map((row) => ({
      id: row.id,
      movieId: row.movie_id,
      movieTitle: row.title,
      auditorium: row.auditorium,
      start: local(row.start_time, row.timezone),
      end: local(row.end_time, row.timezone),
      format: row.format,
      language: row.language,
      rating: row.rating,
      status: row.status,
    })),
  };
}

/** The agent's read-only tools, limited to the theaters in scope of one import. */
export function agentBackend(db: Db, theaterIds: string[]): AgentBackend {
  return {
    searchMovies: (query, limit) => searchMovies(db, query, limit, theaterIds),
    theaterContext: (theaterId) =>
      theaterIds.includes(theaterId) ? theaterContext(db, theaterId) : Promise.resolve(null),
    schedule: (input) =>
      theaterIds.includes(input.theaterId)
        ? scheduleRange(db, input)
        : Promise.resolve({ rows: [], truncated: false }),
  };
}

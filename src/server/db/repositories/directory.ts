import "server-only";
import { tbl, type Db } from "~/server/db/client";
import type { TheaterInfo } from "~/server/domain/types";
import type { AssessmentUser, Theater } from "~/types/assessment";

/** Users with their theater ids, built from the membership table on read. */
export async function listUsers(db: Db): Promise<AssessmentUser[]> {
  return db.q<AssessmentUser[]>`
    select u.id, u.name, u.email, u.role,
           coalesce(array_agg(ut.theater_id order by ut.theater_id)
                    filter (where ut.theater_id is not null), '{}') as "theaterIds"
    from ${tbl(db, "users")} u
    left join ${tbl(db, "user_theaters")} ut on ut.user_id = u.id
    group by u.id
    order by u.role, u.name`;
}

export async function listTheaters(db: Db, ids: string[]): Promise<Theater[]> {
  if (ids.length === 0) return [];
  return db.q<Theater[]>`
    select id, name, location, timezone from ${tbl(db, "theaters")}
    where id = any(${ids}::text[]) order by name`;
}

/** Every theater, for matching theater names in an uploaded file. */
export async function allTheaterInfo(db: Db): Promise<TheaterInfo[]> {
  return db.q<TheaterInfo[]>`
    select id, name, normalized_name as "normalizedName", timezone
    from ${tbl(db, "theaters")} order by id`;
}

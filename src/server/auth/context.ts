import "server-only";
import { tbl, type Db } from "~/server/db/client";
import { forbidden, unauthorized } from "~/server/http/errors";
import type { UserRole } from "~/types/assessment";

export interface Actor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** From the membership table. Every query is limited to these. */
  theaterIds: string[];
}

export const USER_HEADER = "x-user-id";

/**
 * Who is calling. Identity is mocked with an X-User-Id header (the assignment needs no login);
 * role and theater scope always come from the database. Replace this one function for real auth.
 */
export async function getActor(db: Db, request: Request): Promise<Actor> {
  const userId = request.headers.get(USER_HEADER)?.trim();
  if (!userId) throw unauthorized("Select a user first (missing X-User-Id header).");
  const rows = await db.q<Actor[]>`
    select u.id, u.name, u.email, u.role,
           coalesce(array_agg(ut.theater_id order by ut.theater_id)
                    filter (where ut.theater_id is not null), '{}') as "theaterIds"
    from ${tbl(db, "users")} u
    left join ${tbl(db, "user_theaters")} ut on ut.user_id = u.id
    where u.id = ${userId}
    group by u.id`;
  const actor = rows[0];
  if (!actor) throw unauthorized("Unknown user.");
  return actor;
}

export function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw forbidden("This action needs an admin.");
  }
}

/** A theater the actor asked for by id must be one of theirs. */
export function requireTheater(actor: Actor, theaterId: string): void {
  if (!actor.theaterIds.includes(theaterId)) {
    throw forbidden("You do not have access to this theater.");
  }
}

import { requireTheater } from "~/server/auth/context";
import { route } from "~/server/http/handler";
import { listShowtimes, showtimeListQuery } from "~/server/showtimes/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(
  { auth: "user", query: showtimeListQuery },
  async ({ db, actor, query }) => {
    if (query.theaterId) requireTheater(actor, query.theaterId);
    return listShowtimes(db, actor, query);
  },
);

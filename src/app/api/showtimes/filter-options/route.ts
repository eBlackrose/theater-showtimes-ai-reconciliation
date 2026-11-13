import { z } from "zod";
import { requireTheater } from "~/server/auth/context";
import { route } from "~/server/http/handler";
import { filterOptions } from "~/server/showtimes/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(
  { auth: "user", query: z.object({ theaterId: z.string().optional() }) },
  async ({ db, actor, query }) => {
    if (query.theaterId) requireTheater(actor, query.theaterId);
    return filterOptions(db, actor, query.theaterId);
  },
);

import { z } from "zod";
import { route } from "~/server/http/handler";
import { actionPage } from "~/server/imports/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pageQuery = z.object({
  theaterId: z.string(),
  action: z.enum(["add", "restore", "update", "reschedule", "archive", "unchanged", "duplicate"]),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** One page of one action group. Plans are never returned as one unbounded list. */
export const GET = route(
  { auth: "admin", query: pageQuery },
  async ({ db, actor, params, query }) => actionPage(db, actor, params.id ?? "", query),
);

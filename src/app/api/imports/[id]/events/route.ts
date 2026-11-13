import { z } from "zod";
import { route } from "~/server/http/handler";
import { importEvents } from "~/server/imports/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(
  { auth: "admin", query: z.object({ after: z.coerce.number().int().min(0).default(0) }) },
  async ({ db, actor, params, query }) =>
    importEvents(db, actor, params.id ?? "", query.after),
);

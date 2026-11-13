import { z } from "zod";
import { route } from "~/server/http/handler";
import { setArchiveScope } from "~/server/imports/service";
import { importDetail } from "~/server/imports/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ auth: "admin" }, async ({ db, actor, params }) =>
  importDetail(db, actor, params.id ?? ""),
);

export const PATCH = route(
  {
    auth: "admin",
    body: z.object({ archiveScope: z.enum(["file_window", "full_schedule"]) }),
  },
  async ({ db, actor, params, body }) => {
    await setArchiveScope(db, actor, params.id ?? "", body.archiveScope);
    return importDetail(db, actor, params.id ?? "");
  },
);

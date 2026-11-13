import { route } from "~/server/http/handler";
import { overrideResolution, resolutionOverrideBody } from "~/server/imports/service";
import { importDetail } from "~/server/imports/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(
  { auth: "admin", body: resolutionOverrideBody },
  async ({ db, actor, params, body }) => {
    await overrideResolution(db, actor, params.id ?? "", params.rid ?? "", body);
    return importDetail(db, actor, params.id ?? "");
  },
);

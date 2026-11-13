import { route } from "~/server/http/handler";
import { applyBody, applyImport } from "~/server/imports/apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const maxDuration = 120;

export const POST = route(
  { auth: "admin", body: applyBody },
  async ({ db, actor, params, body }) => applyImport(db, actor, params.id ?? "", body),
);

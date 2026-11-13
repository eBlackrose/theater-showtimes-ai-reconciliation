import { route } from "~/server/http/handler";
import { decisionsBody, setDecisions } from "~/server/imports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(
  { auth: "admin", body: decisionsBody },
  async ({ db, actor, params, body }) => setDecisions(db, actor, params.id ?? "", body),
);

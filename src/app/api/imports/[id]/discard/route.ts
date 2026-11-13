import { route } from "~/server/http/handler";
import { discardImport } from "~/server/imports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route({ auth: "admin" }, async ({ db, actor, params }) => {
  await discardImport(db, actor, params.id ?? "");
  return { status: "discarded" };
});

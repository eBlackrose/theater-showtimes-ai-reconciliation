import { requireTheater } from "~/server/auth/context";
import { route } from "~/server/http/handler";
import { clearSchedule } from "~/server/showtimes/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route({ auth: "admin" }, async ({ db, actor, params }) => {
  requireTheater(actor, params.id ?? "");
  return clearSchedule(db, actor, params.id ?? "");
});

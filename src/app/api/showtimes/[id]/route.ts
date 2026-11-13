import { route } from "~/server/http/handler";
import { showtimePatch, updateShowtime } from "~/server/showtimes/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(
  { auth: "admin", body: showtimePatch },
  async ({ db, actor, params, body }) => updateShowtime(db, actor, params.id ?? "", body),
);

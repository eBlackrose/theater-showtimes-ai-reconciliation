import { listTheaters } from "~/server/db/repositories/directory";
import { route } from "~/server/http/handler";
import type { MeResponse } from "~/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ auth: "user" }, async ({ db, actor }): Promise<MeResponse> => ({
  user: actor,
  theaters: await listTheaters(db, actor.theaterIds),
}));

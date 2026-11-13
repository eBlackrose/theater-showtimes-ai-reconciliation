import { listUsers } from "~/server/db/repositories/directory";
import { route } from "~/server/http/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Users for the mock session selector. Public because choosing a user is the "login". */
export const GET = route({ auth: "public" }, async ({ db }) => ({
  users: await listUsers(db),
}));

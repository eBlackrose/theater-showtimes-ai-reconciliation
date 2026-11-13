import { env } from "~/env";
import { resetDemo } from "~/server/db/seed";
import { forbidden } from "~/server/http/errors";
import { route } from "~/server/http/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Restore the demo seed. Only ever touches the configured schema; see resetDemo. */
export const POST = route({ auth: "admin" }, async ({ db }) => {
  if (!env.DEMO_RESET_ENABLED) throw forbidden("Demo reset is disabled on this server.");
  await resetDemo(db, env.DB_SCHEMA);
  return { ok: true };
});

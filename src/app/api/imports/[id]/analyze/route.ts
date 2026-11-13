import { analyzeDeps } from "~/server/agent/config";
import { route } from "~/server/http/handler";
import { analyzeImport } from "~/server/imports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The agent's own budget is about 100 seconds; this leaves room for the database work around it.
export const maxDuration = 300;

export const POST = route({ auth: "admin" }, async ({ db, actor, params }) =>
  analyzeImport(db, actor, params.id ?? "", analyzeDeps()),
);

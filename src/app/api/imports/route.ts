import { MAX_FILE_BYTES } from "~/server/domain/csv";
import { ApiError, badRequest } from "~/server/http/errors";
import { route } from "~/server/http/handler";
import { createImport } from "~/server/imports/service";
import { listImports } from "~/server/imports/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Partner files are usually UTF-8; fall back to Windows-1252 instead of rejecting the file. */
function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export const GET = route({ auth: "admin" }, async ({ db, actor }) => ({
  items: await listImports(db, actor),
}));

export const POST = route({ auth: "admin" }, async ({ db, actor, request }) => {
  const form = await request.formData().catch(() => {
    throw badRequest('Send the CSV as multipart form data with a "file" field.');
  });
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest('The "file" field is missing.');
  if (file.size > MAX_FILE_BYTES) {
    throw new ApiError(413, "too_large", "The file is larger than the 1 MB limit.");
  }
  const scope = form.get("scopeTheaterId");
  return createImport(db, actor, {
    filename: file.name || "upload.csv",
    content: decode(await file.arrayBuffer()),
    scopeTheaterId: typeof scope === "string" && scope ? scope : null,
  });
});

import "server-only";
import { NextResponse } from "next/server";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { getActor, requireAdmin, type Actor } from "~/server/auth/context";
import { getDb } from "~/server/db/app";
import type { Db } from "~/server/db/client";
import { ApiError } from "./errors";

const ANONYMOUS: Actor = { id: "", name: "", email: "", role: "viewer", theaterIds: [] };

interface RouteOptions<Q extends ZodTypeAny, B extends ZodTypeAny> {
  /** public: no identity. user: any known user. admin: admins only. */
  auth: "public" | "user" | "admin";
  query?: Q;
  body?: B;
}

interface RouteContext<Q extends ZodTypeAny, B extends ZodTypeAny> {
  request: Request;
  db: Db;
  actor: Actor;
  params: Record<string, string>;
  query: z.infer<Q>;
  body: z.infer<B>;
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "bad_request",
          message: error.issues
            .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
            .join("; "),
          details: error.issues,
        },
      },
      { status: 400 },
    );
  }
  console.error(error);
  return NextResponse.json(
    { error: { code: "internal", message: "Something went wrong on the server." } },
    { status: 500 },
  );
}

/**
 * The one wrapper every route uses: loads the actor, enforces the role, parses the query and
 * body with zod, and maps errors to `{ error: { code, message, details? } }`.
 */
export function route<Q extends ZodTypeAny = ZodTypeAny, B extends ZodTypeAny = ZodTypeAny>(
  options: RouteOptions<Q, B>,
  handler: (context: RouteContext<Q, B>) => Promise<unknown>,
) {
  return async (
    request: Request,
    segment: { params: Promise<Record<string, string>> },
  ): Promise<Response> => {
    try {
      const db = getDb();
      const actor =
        options.auth === "public" ? ANONYMOUS : await getActor(db, request);
      if (options.auth === "admin") requireAdmin(actor);

      const query: unknown = options.query
        ? options.query.parse(
            Object.fromEntries(new URL(request.url).searchParams.entries()),
          )
        : undefined;
      let body: unknown = undefined;
      if (options.body) {
        const json: unknown = await request.json().catch(() => {
          throw new ApiError(400, "bad_request", "The request body is not valid JSON.");
        });
        body = options.body.parse(json);
      }

      const result = await handler({
        request,
        db,
        actor,
        params: await segment.params,
        query: query as z.infer<Q>,
        body: body as z.infer<B>,
      });
      return result instanceof Response ? result : NextResponse.json(result);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

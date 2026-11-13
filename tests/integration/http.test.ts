import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tbl, type Db } from "~/server/db/client";
import type { ImportDetail, ShowtimeListResponse } from "~/types/api";
import { createTestDb, dropTestDb, sample, USERS } from "./helpers";

/**
 * Route handlers called directly with Request objects, against a throwaway schema: this
 * covers the real wrapper (identity, roles, zod, error mapping) without a running server.
 */
type Handler = (
  request: Request,
  segment: { params: Promise<Record<string, string>> },
) => Promise<Response>;

let db: Db;
const routes: Record<string, Handler> = {};

beforeAll(async () => {
  db = await createTestDb();
  // The app reads its database and schema from the environment when first imported.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DB_SCHEMA = db.schema;
  process.env.ANTHROPIC_API_KEY = ""; // never call the real model from tests
  process.env.DEMO_RESET_ENABLED = "true";
  const load = async (name: string, module: Promise<Record<string, unknown>>) => {
    for (const [method, handler] of Object.entries(await module)) {
      if (typeof handler === "function") routes[`${method} ${name}`] = handler as Handler;
    }
  };
  await load("health", import("~/app/api/health/route"));
  await load("users", import("~/app/api/users/route"));
  await load("me", import("~/app/api/me/route"));
  await load("showtimes", import("~/app/api/showtimes/route"));
  await load("filter-options", import("~/app/api/showtimes/filter-options/route"));
  await load("showtime", import("~/app/api/showtimes/[id]/route"));
  await load("clear", import("~/app/api/theaters/[id]/clear/route"));
  await load("imports", import("~/app/api/imports/route"));
  await load("import", import("~/app/api/imports/[id]/route"));
  await load("analyze", import("~/app/api/imports/[id]/analyze/route"));
  await load("events", import("~/app/api/imports/[id]/events/route"));
  await load("actions", import("~/app/api/imports/[id]/actions/route"));
  await load("decisions", import("~/app/api/imports/[id]/decisions/route"));
  await load("resolution", import("~/app/api/imports/[id]/resolutions/[rid]/route"));
  await load("apply", import("~/app/api/imports/[id]/apply/route"));
  await load("discard", import("~/app/api/imports/[id]/discard/route"));
  await load("reset", import("~/app/api/admin/reset-demo/route"));
});
afterAll(async () => {
  const { getDb } = await import("~/server/db/app");
  await getDb().q.end();
  await dropTestDb(db);
});

async function call<T = Record<string, unknown>>(
  route: string,
  options: {
    user?: string;
    query?: Record<string, string | number>;
    params?: Record<string, string>;
    body?: unknown;
    form?: FormData;
  } = {},
): Promise<{ status: number; body: T; error?: { code: string; message: string; details?: unknown } }> {
  const handler = routes[route];
  if (!handler) throw new Error(`No handler for ${route}`);
  const url = new URL("http://test.local/api");
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {};
  if (options.user) headers["x-user-id"] = options.user;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await handler(
    new Request(url, {
      method: route.split(" ")[0],
      headers,
      body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    }),
    { params: Promise.resolve(options.params ?? {}) },
  );
  const body = (await response.json()) as T & { error?: { code: string; message: string } };
  return { status: response.status, body, error: body.error };
}

const list = (user: string, query: Record<string, string | number> = {}) =>
  call<ShowtimeListResponse>("GET showtimes", { user, query });

describe("identity and scope", () => {
  it("reports health without identity", async () => {
    const { status, body } = await call("GET health");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      db: { ok: true, schema: db.schema, migration: "0003_apply_claim" },
      llm: { configured: false, model: "claude-sonnet-5-5" },
    });
  });

  it("lists users with theater ids built from the membership table", async () => {
    const { body } = await call<{ users: { id: string; theaterIds: string[] }[] }>("GET users");
    expect(body.users).toHaveLength(5);
    expect(body.users.find((u) => u.id === USERS.jordan)?.theaterIds).toEqual([]);
    expect(body.users.find((u) => u.id === USERS.casey)?.theaterIds).toHaveLength(3);
  });

  it("returns 401 without a user or with an unknown one", async () => {
    expect((await call("GET showtimes")).status).toBe(401);
    expect((await call("GET me", { user: "user-nobody" })).status).toBe(401);
  });

  it.each([
    [USERS.avery, 12],
    [USERS.casey, 15],
    [USERS.riley, 7],
    [USERS.morgan, 10],
    [USERS.jordan, 0],
  ])("shows %s only their theaters' showtimes (%i)", async (user, total) => {
    const { status, body } = await list(user);
    expect(status).toBe(200);
    expect(body.total).toBe(total);
    const me = await call<{ user: { theaterIds: string[] } }>("GET me", { user });
    expect(body.items.every((s) => me.body.user.theaterIds.includes(s.theaterId))).toBe(true);
  });

  it("returns 403 for a theater outside the user's set and 404 for a showtime in one", async () => {
    expect((await list(USERS.riley, { theaterId: "theater-riverside" })).status).toBe(403);
    expect((await call("GET filter-options", { user: USERS.riley, query: { theaterId: "theater-uptown" } })).status).toBe(403);
    const hidden = await call("PATCH showtime", {
      user: USERS.avery,
      params: { id: "st-up-001" },
      body: { movieStatus: "flagged" },
    });
    expect(hidden.status).toBe(404);
    const missing = await call("PATCH showtime", {
      user: USERS.avery,
      params: { id: "st-nope" },
      body: { movieStatus: "flagged" },
    });
    expect(missing.body).toEqual(hidden.body); // indistinguishable from "does not exist"
    expect((await call("POST clear", { user: USERS.avery, params: { id: "theater-uptown" } })).status).toBe(403);
  });
});

describe("showtime list", () => {
  it("searches titles and saved aliases through the normalizer", async () => {
    expect((await list(USERS.avery, { q: "  DUNE " })).body.total).toBe(2);
    expect((await list(USERS.avery, { q: "spider-man" })).body.items[0]?.movieTitle).toBe("Spider-Man: Homecoming");
    expect((await list(USERS.avery, { q: "zzz" })).body.total).toBe(0);
    await db.q`insert into ${tbl(db, "movie_aliases")} (movie_id, alias, normalized_alias, source)
               values ('mv-dune-part-2', 'Sandworm Saga', 'sandworm saga', 'human')`;
    expect((await list(USERS.avery, { q: "sandworm" })).body.total).toBe(2);
  });

  it("filters by each column", async () => {
    const total = async (query: Record<string, string>) => (await list(USERS.avery, query)).body.total;
    expect(await total({ status: "archived" })).toBe(3);
    expect(await total({ format: "IMAX" })).toBe(3);
    expect(await total({ language: "KO" })).toBe(1);
    expect(await total({ rating: "R" })).toBe(3);
    expect(await total({ movieStatus: "draft" })).toBe(2);
    expect(await total({ auditorium: "Auditorium 1" })).toBe(3);
    expect(await total({ theaterId: "theater-riverside", status: "active" })).toBe(4);
  });

  it("filters dates by the theater's local day, not the UTC day", async () => {
    const { body } = await list(USERS.avery, { startDate: "2025-03-15", endDate: "2025-03-15" });
    const titles = body.items.map((s) => s.movieTitle);
    expect(body.total).toBe(10);
    expect(titles).toContain("Past Lives"); // 01:00Z on March 16 is 6 PM on March 15 in Portland
    expect(titles).not.toContain("Kung Fu Panda 4");
    expect(titles).not.toContain("The Holdovers");
    expect((await list(USERS.avery, { startDate: "2025-03-16" })).body.total).toBe(1);
  });

  it("sorts by whitelisted columns only, with a stable tiebreaker, and pages with a cap", async () => {
    const first = async (query: Record<string, string | number>) =>
      (await list(USERS.avery, query)).body.items[0];
    expect((await first({ sortBy: "movieTitle" }))?.movieTitle).toBe("Civil War");
    expect((await first({ sortBy: "movieTitle", sortOrder: "desc" }))?.movieTitle).toBe("Wonka");
    expect((await first({ sortBy: "startTime", sortOrder: "desc" }))?.id).toBe("st-dt-007");
    expect((await first({ sortBy: "theaterName", sortOrder: "desc" }))?.theaterId).toBe("theater-riverside");
    expect((await first({ sortBy: "lastUpdated" }))?.id).toBe("st-rv-005");
    expect((await first({ sortBy: "endTime" }))?.id).toBe("st-rv-005");
    expect((await first({ sortBy: "movieStatus" }))?.movieStatus).toBe("approved");
    expect((await list(USERS.avery, { sortBy: "id; drop table showtimes" })).status).toBe(400);

    const page2 = await list(USERS.avery, { pageSize: 5, page: 2 });
    expect(page2.body).toMatchObject({ total: 12, page: 2, pageSize: 5 });
    const page1 = await list(USERS.avery, { pageSize: 5 });
    expect(page2.body.items).toHaveLength(5);
    expect(page2.body.items.map((s) => s.id)).not.toEqual(expect.arrayContaining(page1.body.items.map((s) => s.id)));
    expect((await list(USERS.avery, { pageSize: 101 })).status).toBe(400);
  });

  it("returns distinct filter options in scope", async () => {
    const { body } = await call<{ formats: string[]; auditoriums: string[] }>("GET filter-options", {
      user: USERS.riley,
    });
    expect(body.formats).toEqual(["2D", "3D", "IMAX"]);
    expect(body.auditoriums).toEqual(["Auditorium 1", "Auditorium 2", "Auditorium 3", "Auditorium 4"]);
  });

  it("lets an admin change movie status and status, and audits it", async () => {
    const { status, body } = await call<{ movieStatus: string }>("PATCH showtime", {
      user: USERS.avery,
      params: { id: "st-dt-007" },
      body: { movieStatus: "approved" },
    });
    expect(status).toBe(200);
    expect(body.movieStatus).toBe("approved");
    expect((await call("PATCH showtime", { user: USERS.avery, params: { id: "st-dt-007" }, body: {} })).status).toBe(400);
    const audit = await db.q`select action from ${tbl(db, "audit_log")} where entity_id = 'st-dt-007'`;
    expect(audit).toHaveLength(1);
  });
});

describe("imports over HTTP", () => {
  const form = (file: string, scope?: string) => {
    const data = new FormData();
    data.set("file", new File([sample(file)], file, { type: "text/csv" }));
    if (scope) data.set("scopeTheaterId", scope);
    return data;
  };
  let importId = "";

  it("rejects an invalid file with 422 and every row error", async () => {
    const { status, error } = await call("POST imports", {
      user: USERS.avery,
      form: form("invalid-drop.csv", "theater-downtown"),
    });
    expect(status).toBe(422);
    expect(error?.code).toBe("invalid_csv");
    expect((error?.details as { errors: unknown[] }).errors).toHaveLength(3);
  });

  it("rejects a file with nothing in scope, a missing file and an oversized file", async () => {
    const uptownOnly = await call("POST imports", {
      user: USERS.avery,
      form: form("multi-theater-drop.csv", "theater-uptown"),
    });
    expect(uptownOnly.status).toBe(403);
    const viewerOnly = new FormData();
    viewerOnly.set(
      "file",
      new File(
        [
          "theater_name,movie_title,auditorium,start_time,end_time\nUptown Arts Theater,Wonka,Screen 1,2025-03-17T20:00:00Z,2025-03-17T21:56:00Z\n",
        ],
        "uptown.csv",
      ),
    );
    const nothing = await call("POST imports", { user: USERS.avery, form: viewerOnly });
    expect(nothing.status).toBe(422);
    expect(nothing.error?.code).toBe("nothing_in_scope");
    expect(nothing.error?.message).toContain("You do not manage Uptown Arts Theater");
    expect((await call("POST imports", { user: USERS.avery, form: new FormData() })).status).toBe(400);
    const big = new FormData();
    big.set("file", new File(["x".repeat(1_000_001)], "big.csv"));
    expect((await call("POST imports", { user: USERS.avery, form: big })).status).toBe(413);
  });

  it("uploads, analyzes without a model, and returns a bounded plan", async () => {
    const created = await call<{ importId: string; rowCount: number }>("POST imports", {
      user: USERS.avery,
      form: form("multi-theater-drop.csv"),
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ rowCount: 6, skipped: { noAccess: 1, unknownTheater: 1 } });
    importId = created.body.importId;

    const analyzed = await call("POST analyze", { user: USERS.avery, params: { id: importId } });
    expect(analyzed.body).toEqual({ status: "ready" });
    const detail = await call<ImportDetail>("GET import", { user: USERS.avery, params: { id: importId } });
    expect(detail.body.counts).toMatchObject({ add: 4, skippedRows: 2 });
    expect(detail.body.theaterSections).toHaveLength(2);

    const events = await call<{ events: { id: number; type: string }[] }>("GET events", {
      user: USERS.avery,
      params: { id: importId },
    });
    expect(events.body.events.filter((e) => e.type === "stage").length).toBeGreaterThanOrEqual(4);
    const later = await call<{ events: unknown[] }>("GET events", {
      user: USERS.avery,
      params: { id: importId },
      query: { after: events.body.events.at(-1)?.id ?? 0 },
    });
    expect(later.body.events).toEqual([]);

    const page = await call<{ items: unknown[]; total: number }>("GET actions", {
      user: USERS.avery,
      params: { id: importId },
      query: { theaterId: "theater-downtown", action: "add", limit: 1 },
    });
    expect(page.body).toMatchObject({ total: 2 });
    expect(page.body.items).toHaveLength(1);
  });

  it("blocks every write and every import route for a viewer", async () => {
    const id = { id: importId };
    const attempts: [string, Parameters<typeof call>[1]][] = [
      ["POST imports", { form: form("new-drop.csv", "theater-downtown") }],
      ["GET imports", {}],
      ["GET import", { params: id }],
      ["PATCH import", { params: id, body: { archiveScope: "full_schedule" } }],
      ["POST analyze", { params: id }],
      ["GET events", { params: id }],
      ["GET actions", { params: id, query: { theaterId: "theater-downtown", action: "add" } }],
      ["PATCH decisions", { params: id, body: { bulk: { theaterId: "theater-downtown", action: "add", decision: "rejected" } } }],
      ["PATCH resolution", { params: { ...id, rid: "res_x" }, body: { outcome: "new" } }],
      ["POST apply", { params: id, body: { planHash: "x" } }],
      ["POST discard", { params: id }],
      ["POST clear", { params: { id: "theater-downtown" } }],
      ["POST reset", {}],
      ["PATCH showtime", { params: { id: "st-dt-001" }, body: { movieStatus: "flagged" } }],
    ];
    for (const [route, options] of attempts) {
      const { status } = await call(route, { ...options, user: USERS.riley });
      expect(status, route).toBe(403);
    }
    const [imp] = await db.q`select status from ${tbl(db, "imports")} where id = ${importId}`;
    expect(imp?.status).toBe("ready");
  });

  it("applies over HTTP, lists history, and resets the demo data", async () => {
    const detail = await call<ImportDetail>("GET import", { user: USERS.avery, params: { id: importId } });
    const stale = await call("POST apply", { user: USERS.avery, params: { id: importId }, body: { planHash: "stale" } });
    expect(stale.status).toBe(409);
    expect(stale.error?.code).toBe("plan_changed");
    const applied = await call<{ status: string }>("POST apply", {
      user: USERS.avery,
      params: { id: importId },
      body: { planHash: detail.body.planHash },
    });
    expect(applied.body.status).toBe("applied");
    expect((await list(USERS.avery)).body.total).toBe(16);

    const history = await call<{ items: { id: string; status: string; createdBy: string }[] }>("GET imports", {
      user: USERS.avery,
    });
    expect(history.body.items[0]).toMatchObject({ id: importId, status: "applied", createdBy: "Avery Admin" });

    expect((await call("POST reset", { user: USERS.avery })).status).toBe(200);
    expect((await list(USERS.avery)).body.total).toBe(12);
    expect((await call<{ items: unknown[] }>("GET imports", { user: USERS.avery })).body.items).toEqual([]);
  });
});

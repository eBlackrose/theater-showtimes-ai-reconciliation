import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tbl, type Db } from "~/server/db/client";
import { applyImport } from "~/server/imports/apply";
import { analyzeImport, createImport } from "~/server/imports/service";
import { actionPage, importDetail } from "~/server/imports/view";
import { actorFor, createTestDb, dropTestDb, USERS } from "./helpers";

const ROWS = 70_000;
const DOWNTOWN = "theater-downtown";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await dropTestDb(db);
});

describe("scale", () => {
  /**
   * Regression test for the prototype's crash: it sent archived ids as `id IN ($1, $2, ...)`
   * and hit Postgres's 65,535 bind-parameter limit. Every write here uses one array or one
   * JSON parameter, and the plan is returned as counts plus pages.
   */
  it(`archives ${ROWS.toLocaleString("en-US")} showtimes in one apply`, async () => {
    // One showtime per minute for about 49 days.
    await db.q`
      insert into ${tbl(db, "showtimes")}
        (id, theater_id, movie_id, auditorium_id, start_time, end_time, last_updated)
      select 'st-bulk-' || i, ${DOWNTOWN}, 'mv-dune', 'aud-downtown-auditorium-1',
             timestamptz '2026-01-01T08:00:00Z' + i * interval '1 minute',
             timestamptz '2026-01-01T10:00:00Z' + i * interval '1 minute', now()
      from generate_series(0, ${ROWS - 1}) as i`;

    // A file with one row on the first day and one on the last: its window covers them all.
    const content = [
      "theater_name,movie_title,auditorium,start_time,end_time",
      "Downtown Cinema 7,Wonka,Auditorium 2,2026-01-01T09:00:30Z,2026-01-01T11:00:00Z",
      "Downtown Cinema 7,Wonka,Auditorium 2,2026-02-18T20:00:30Z,2026-02-18T22:00:00Z",
    ].join("\n");
    const avery = await actorFor(db, USERS.avery);
    const started = Date.now();
    const created = await createImport(db, avery, {
      filename: "big-archive.csv",
      content,
      scopeTheaterId: DOWNTOWN,
    });
    await analyzeImport(db, avery, created.importId, { llm: null, dailyRunLimit: 0 });
    const detail = await importDetail(db, avery, created.importId);
    const analyzedMs = Date.now() - started;

    expect(detail.counts).toMatchObject({ archive: ROWS, add: 2 });
    expect(detail.warnings.find((w) => w.code === "mass_archive")?.requiresAck).toBe(true);
    // The response stays small no matter how big the plan is.
    expect(JSON.stringify(detail).length).toBeLessThan(100_000);
    const archives = detail.theaterSections[0]?.groups.find((g) => g.action === "archive");
    expect(archives).toMatchObject({ total: ROWS });
    expect(archives?.items).toHaveLength(25);
    const page = await actionPage(db, avery, created.importId, {
      theaterId: DOWNTOWN,
      action: "archive",
      offset: 69_990,
      limit: 50,
    });
    expect(page.items).toHaveLength(10);

    // Without the tick the loud warning blocks the apply.
    await expect(
      applyImport(db, avery, created.importId, { planHash: detail.planHash ?? "" }),
    ).rejects.toMatchObject({ status: 400 });

    const applyStarted = Date.now();
    const result = await applyImport(db, avery, created.importId, {
      planHash: detail.planHash ?? "",
      acknowledgeWarnings: true,
    });
    const applyMs = Date.now() - applyStarted;
    expect(result.theaters[0]?.applied).toEqual({ add: 2, archive: ROWS });

    const [counts] = await db.q`
      select (count(*) filter (where status = 'archived' and id like 'st-bulk-%'))::int as archived,
             (count(*) filter (where status = 'active' and id like 'st-bulk-%'))::int as live
      from ${tbl(db, "showtimes")} where theater_id = ${DOWNTOWN}`;
    expect(counts).toEqual({ archived: ROWS, live: 0 });
    console.info(`70k archive: analyze ${analyzedMs} ms, apply ${applyMs} ms`);
  });
});

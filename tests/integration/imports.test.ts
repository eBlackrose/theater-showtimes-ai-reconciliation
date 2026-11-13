import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "~/server/auth/context";
import { tbl, type Db } from "~/server/db/client";
import { migrate } from "~/server/db/migrate";
import { resetDemo } from "~/server/db/seed";
import { ApiError } from "~/server/http/errors";
import { applyImport } from "~/server/imports/apply";
import {
  analyzeImport,
  createImport,
  discardImport,
  overrideResolution,
  setArchiveScope,
  setDecisions,
} from "~/server/imports/service";
import { importDetail, importEvents, listImports } from "~/server/imports/view";
import { clearSchedule, updateShowtime } from "~/server/showtimes/query";
import type { ImportDetail } from "~/types/api";
import { actorFor, createTestDb, dropTestDb, fakeLlm, sample, USERS } from "./helpers";

let db: Db;
let avery: Actor;
let casey: Actor;
let riley: Actor;

beforeAll(async () => {
  db = await createTestDb();
  avery = await actorFor(db, USERS.avery);
  casey = await actorFor(db, USERS.casey);
  riley = await actorFor(db, USERS.riley);
});
afterAll(async () => {
  await dropTestDb(db);
});
beforeEach(async () => {
  await resetDemo(db, db.schema);
});

const DOWNTOWN = "theater-downtown";
const room = (
  subjectKey: string,
  targetId: string | null,
  confidence: "high" | "medium" | "low" = "high",
) => ({
  kind: "auditorium",
  subjectKey,
  theaterId: DOWNTOWN,
  decision: targetId ? "existing" : "new",
  targetId,
  canonicalName: null,
  confidence,
  explanation: "Same room, written differently.",
});
/** The four room names in new-drop.csv that only the agent can resolve. */
const newDropRooms = () =>
  fakeLlm([
    {
      tools: [
        {
          name: "submit_resolutions",
          input: {
            resolutions: [
              room("aud 1", "aud-downtown-auditorium-1"),
              room("auditorium two", "aud-downtown-auditorium-2"),
              room("auditorium 1 laser", "aud-downtown-auditorium-1", "medium"),
              room("auditorium 5", null),
            ],
          },
        },
      ],
    },
    { text: "Four room names were matched. Auditorium 5 is new." },
  ]);

async function upload(
  actor: Actor,
  file: string,
  llm: ReturnType<typeof fakeLlm> | null,
  scopeTheaterId: string | null = DOWNTOWN,
): Promise<ImportDetail> {
  const created = await createImport(db, actor, {
    filename: file,
    content: sample(file),
    scopeTheaterId,
  });
  await analyzeImport(db, actor, created.importId, { llm, dailyRunLimit: 100 });
  return importDetail(db, actor, created.importId);
}

const apply = (actor: Actor, detail: ImportDetail, acknowledgeWarnings = false) =>
  applyImport(db, actor, detail.id, { planHash: detail.planHash ?? "", acknowledgeWarnings });

const showtimes = (theaterId: string) =>
  db.q<{ id: string; title: string; room: string; status: string; format: string; start: Date }[]>`
    select s.id, m.title, a.name as room, s.status, s.format, s.start_time as start
    from ${tbl(db, "showtimes")} s
    join ${tbl(db, "movies")} m on m.id = s.movie_id
    join ${tbl(db, "auditoriums")} a on a.id = s.auditorium_id
    where s.theater_id = ${theaterId} order by s.start_time, s.id`;

const expectStatus = async (promise: Promise<unknown>, status: number, code?: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
  if (code) expect((error as ApiError).code).toBe(code);
  return error as ApiError;
};

describe("migrations and reset", () => {
  it("runs the migrations twice without error", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("reset-demo restores the seed and refuses other schemas", async () => {
    await clearSchedule(db, avery, DOWNTOWN);
    await resetDemo(db, db.schema);
    const rows = await showtimes(DOWNTOWN);
    expect(rows).toHaveLength(7);
    expect(rows.filter((r) => r.status === "archived")).toHaveLength(2);
    await expect(resetDemo(db, "ronnie_takehome")).rejects.toThrow(/Refusing/);
    await expect(resetDemo({ ...db, schema: "public" }, "public")).rejects.toThrow(/Refusing/);
  });
});

describe("import lifecycle", () => {
  it("new-drop.csv on a fresh seed: agent resolves rooms, apply persists, second upload needs no model", async () => {
    const llm = newDropRooms();
    const detail = await upload(avery, "new-drop.csv", llm);
    expect(detail.status).toBe("ready");
    expect(detail.mode).toBe("ai");
    expect(detail.counts).toMatchObject({
      unchanged: 4,
      add: 1,
      duplicate: 1,
      archive: 0,
      update: 0,
      pending: 0,
    });
    expect(detail.resolutions.filter((r) => r.method === "agent")).toHaveLength(4);
    expect(detail.agentSummary).toContain("Auditorium 5");
    expect(detail.warnings.map((w) => w.code)).toContain("new_auditorium");
    expect(detail.usage).toMatchObject({ turns: 2, toolCalls: 1, subjects: 4 });

    const events = await importEvents(db, avery, detail.id, 0);
    expect(events.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["stage", "llm_turn", "tool_call", "resolution"]),
    );

    const result = await apply(avery, detail);
    expect(result.status).toBe("applied");
    expect(result.theaters[0]?.applied).toEqual({ add: 1 });
    const after = await showtimes(DOWNTOWN);
    expect(after).toHaveLength(8);
    const added = after.find((r) => r.room === "Auditorium 5");
    expect(added).toMatchObject({ title: "Kung Fu Panda 4", status: "active" });
    // The clean title and room names were not overwritten by the partner's spellings.
    expect(after.map((r) => r.title)).not.toContain("DUNE PART 2");
    expect(after.map((r) => r.room)).not.toContain("Aud 1");

    // Second upload: aliases were learned, so the model is never called and nothing changes.
    const silent = fakeLlm([]);
    const second = await upload(avery, "new-drop.csv", silent);
    expect(silent.requests).toHaveLength(0);
    expect(second.mode).toBe("ai");
    expect(second.usage).toBeNull();
    expect(second.counts).toMatchObject({ unchanged: 5, duplicate: 1, add: 0, update: 0, archive: 0 });
    expect(second.resolutions.every((r) => r.method === "alias")).toBe(true);
    const before = await db.q`select id, row_version, updated_at from ${tbl(db, "showtimes")} order by id`;
    expect((await apply(avery, second)).status).toBe("applied");
    const afterSecond = await db.q`select id, row_version, updated_at from ${tbl(db, "showtimes")} order by id`;
    expect(afterSecond).toEqual(before);

    await expectStatus(apply(avery, second), 409);
    const history = await listImports(db, avery);
    expect(history.map((h) => h.status)).toEqual(["applied", "applied"]);
  });

  it("the base README scenario: clear, existing.csv, new-drop.csv", async () => {
    await clearSchedule(db, avery, DOWNTOWN);
    const first = await upload(avery, "existing.csv", fakeLlm([]));
    expect(first.counts).toMatchObject({ restore: 6, add: 0, archive: 0, unchanged: 0 });
    await apply(avery, first);
    const restored = await showtimes(DOWNTOWN);
    expect(restored.filter((r) => r.status === "active")).toHaveLength(6);
    // Restored rows keep their ids; the March 16 showtime is outside the file's dates.
    expect(restored.find((r) => r.id === "st-dt-007")?.status).toBe("archived");
    expect(restored.find((r) => r.id === "st-dt-003")?.format).toBe("2D");

    const second = await upload(avery, "new-drop.csv", newDropRooms());
    expect(second.counts).toMatchObject({
      add: 1,
      update: 1,
      archive: 2,
      duplicate: 1,
      unchanged: 3,
      restore: 0,
    });
    const update = second.theaterSections[0]?.groups.find((g) => g.action === "update")?.items[0];
    expect(update?.diffs).toEqual([{ field: "format", oldValue: "2D", newValue: "IMAX" }]);
    await apply(avery, second);
    const final = await showtimes(DOWNTOWN);
    expect(final.filter((r) => r.status === "archived").map((r) => r.title).sort()).toEqual([
      "Kung Fu Panda 4",
      "Oppenheimer",
      "Wonka",
    ]);
    expect(final.find((r) => r.id === "st-dt-003")?.format).toBe("IMAX");
  });

  it("without a model: rules only, fallbacks wait for a decision, apply is blocked until decided", async () => {
    const detail = await upload(avery, "new-drop.csv", null);
    expect(detail.mode).toBe("rules_only");
    expect(detail.aiNotice).toMatch(/not configured/);
    expect(detail.resolutions.filter((r) => r.method === "fallback")).toHaveLength(4);
    expect(detail.counts.pending).toBeGreaterThan(0);
    await expectStatus(apply(avery, detail), 400);

    // The admin says what "Aud 1" is; the plan is re-derived with no model call.
    const aud1 = detail.resolutions.find((r) => r.subjectRaw === "Aud 1");
    await overrideResolution(db, avery, detail.id, aud1?.id ?? "", {
      outcome: "existing",
      targetId: "aud-downtown-auditorium-1",
    });
    const after = await importDetail(db, avery, detail.id);
    expect(after.resolutions.find((r) => r.subjectRaw === "Aud 1")?.method).toBe("human");
    expect(after.counts.pending).toBeLessThan(detail.counts.pending);
  });

  it("rejects an invalid file with every row error and stores nothing", async () => {
    const error = await expectStatus(
      createImport(db, avery, {
        filename: "invalid-drop.csv",
        content: sample("invalid-drop.csv"),
        scopeTheaterId: DOWNTOWN,
      }),
      422,
      "invalid_csv",
    );
    const errors = (error.details as { errors: { row: number }[] }).errors;
    expect(errors.map((e) => e.row)).toEqual([3, 4, 5]);
    const [count] = await db.q`select count(*)::int as n from ${tbl(db, "imports")}`;
    expect(count?.n).toBe(0);
  });

  it("multi-theater file: one section per theater, no-access and unknown rows skipped, others untouched", async () => {
    const asAvery = await upload(avery, "multi-theater-drop.csv", fakeLlm([]), null);
    expect(asAvery.theaterSections.map((s) => s.theaterId)).toEqual([
      "theater-downtown",
      "theater-riverside",
    ]);
    expect(asAvery.counts).toMatchObject({ add: 4, archive: 0, skippedRows: 2 });
    expect(asAvery.skipped.map((s) => s.reason).sort()).toEqual([
      "skipped_no_access",
      "skipped_unknown_theater",
    ]);
    const uptownBefore = await showtimes("theater-uptown");
    await apply(avery, asAvery);
    expect(await showtimes("theater-uptown")).toEqual(uptownBefore);
    expect(await showtimes("theater-riverside")).toHaveLength(7);

    await resetDemo(db, db.schema);
    const asCasey = await upload(casey, "multi-theater-drop.csv", fakeLlm([]), null);
    expect(asCasey.counts).toMatchObject({ add: 5, skippedRows: 1 });
    expect(asCasey.theaterSections).toHaveLength(3);
  });

  it("returns 409 and a fresh plan when the schedule changed between review and apply", async () => {
    const detail = await upload(avery, "new-drop.csv", newDropRooms());
    // Someone archives a showtime the plan called "unchanged".
    await updateShowtime(db, casey, "st-dt-001", { status: "archived" });
    const error = await expectStatus(apply(avery, detail), 409, "plan_changed");
    expect((error.details as { status: string }).status).toBe("ready");
    const fresh = await importDetail(db, avery, detail.id);
    expect(fresh.status).toBe("ready");
    expect(fresh.planHash).not.toBe(detail.planHash);
    expect(fresh.counts.restore).toBe(1);
    expect((await showtimes(DOWNTOWN)).filter((r) => r.room === "Auditorium 5")).toHaveLength(0);
    expect((await apply(avery, fresh)).status).toBe("applied");
  });

  it("two applies for the same theater at once: both finish and the result is consistent", async () => {
    const a = await upload(avery, "new-drop.csv", newDropRooms());
    const b = await upload(casey, "new-drop.csv", newDropRooms());
    const outcomes = await Promise.allSettled([apply(avery, a), apply(casey, b)]);
    // One wins. The other either sees the changed schedule (409) or, if it took the lock
    // second with an identical plan, would have conflicted on its hash.
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const rows = await showtimes(DOWNTOWN);
    expect(rows.filter((r) => r.title === "Kung Fu Panda 4" && r.room === "Auditorium 5")).toHaveLength(1);
    expect(rows).toHaveLength(8);
    const rooms = await db.q`select id from ${tbl(db, "auditoriums")}
                             where theater_id = ${DOWNTOWN} and normalized_name = 'auditorium 5'`;
    expect(rooms).toHaveLength(1);
  });

  it("decisions: rejecting an action keeps it out of the apply and changes the plan hash", async () => {
    const detail = await upload(avery, "new-drop.csv", newDropRooms());
    const add = detail.theaterSections[0]?.groups.find((g) => g.action === "add")?.items[0];
    const changed = await setDecisions(db, avery, detail.id, {
      decisions: [{ actionKey: add?.actionKey ?? "", decision: "rejected" }],
    });
    expect(changed.planHash).not.toBe(detail.planHash);
    await expectStatus(apply(avery, detail), 409, "plan_changed");
    const result = await applyImport(db, avery, detail.id, { planHash: changed.planHash });
    expect(result.theaters[0]).toMatchObject({ applied: {}, skipped: 1 });
    expect(await showtimes(DOWNTOWN)).toHaveLength(7);
  });

  it("archive scope: full schedule archives showtimes on other dates, behind a warning", async () => {
    const detail = await upload(avery, "new-drop.csv", newDropRooms());
    expect(detail.counts.archive).toBe(0);
    await setArchiveScope(db, avery, detail.id, "full_schedule");
    const full = await importDetail(db, avery, detail.id);
    expect(full.counts.archive).toBe(1); // the March 16 showtime
    expect(full.theaterSections[0]?.windowStart).toBeNull();
  });

  it("an inactive showtime is a manual hold: an import updates it but never reactivates it", async () => {
    await updateShowtime(db, avery, "st-dt-003", { status: "inactive" });
    await clearSchedule(db, avery, "theater-riverside");
    const detail = await upload(avery, "existing.csv", fakeLlm([]));
    await apply(avery, detail);
    const held = (await showtimes(DOWNTOWN)).find((r) => r.id === "st-dt-003");
    expect(held).toMatchObject({ status: "inactive", format: "2D" });
  });

  it("discard marks the import and blocks apply", async () => {
    const detail = await upload(avery, "new-drop.csv", newDropRooms());
    await discardImport(db, avery, detail.id);
    await expectStatus(apply(avery, detail), 409);
  });

  it("imports are admin-scoped: another admin without the theater gets 404", async () => {
    const detail = await upload(casey, "multi-theater-drop.csv", fakeLlm([]), null);
    // Avery does not manage Uptown, which this import includes.
    await expectStatus(importDetail(db, avery, detail.id), 404);
    await expectStatus(importDetail(db, riley, detail.id), 404);
  });
});

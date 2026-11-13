import "server-only";
import { z } from "zod";
import type { Actor } from "~/server/auth/context";
import { lockTheater, tbl, withTx, type Db } from "~/server/db/client";
import { normalizeKey } from "~/server/domain/normalize";
import type { PlanResult } from "~/server/domain/plan";
import { isNewRef, NEW_PREFIX } from "~/server/domain/resolve";
import {
  resolutionKey,
  type ActionType,
  type PlannedAction,
  type Resolution,
} from "~/server/domain/types";
import { ApiError, badRequest, conflict } from "~/server/http/errors";
import type { ApplyResponse, ApplyTheaterResult } from "~/types/api";
import { openFile, replan } from "./service";
import {
  audit,
  loadDecisions,
  loadImportTheaters,
  loadResolutions,
  newId,
  refreshSummary,
  requireImport,
  type ImportRow,
} from "./store";
import { loadPlanState, planTheater, type ImportFile } from "./workspace";

export const applyBody = z.object({
  planHash: z.string().min(1),
  acknowledgeWarnings: z.boolean().optional(),
});

const STALE_APPLY = "5 minutes";
const PLAN_CHANGED = "The schedule changed since this proposal was made. Review the updated proposal.";

/** Thrown inside a theater's transaction to roll it back when the re-derived plan differs. */
class PlanChanged extends Error {}

/**
 * Step 4. Apply does not trust the preview: for each theater, in id order and in its own
 * transaction, it takes the theater's advisory lock, re-derives the plan from the stored
 * file, resolutions and decisions, and writes only if the hash equals what the admin saw.
 */
export async function applyImport(
  db: Db,
  actor: Actor,
  importId: string,
  body: z.infer<typeof applyBody>,
): Promise<ApplyResponse> {
  const imp = await requireImport(db, actor, importId);

  // Claim atomically. A second click, or a second admin, gets a 409.
  const claimed = await db.q`
    update ${tbl(db, "imports")} set status = 'applying', apply_started_at = now()
    where id = ${importId}
      and (status in ('ready', 'partially_applied')
           or (status = 'applying' and apply_started_at < now() - ${STALE_APPLY}::interval))
    returning id`;
  if (claimed.length === 0) {
    throw conflict(
      imp.status === "applied"
        ? "This import was already applied."
        : `This import is ${imp.status} and cannot be applied.`,
    );
  }

  const release = (status: string) =>
    db.q`update ${tbl(db, "imports")} set status = ${status} where id = ${importId}`;
  const previous = imp.status === "partially_applied" ? "partially_applied" : "ready";

  let file: ImportFile;
  let resolutions: Resolution[];
  let pending: Awaited<ReturnType<typeof loadImportTheaters>>;
  try {
    if (body.planHash !== imp.plan_hash) {
      throw new ApiError(409, "plan_changed", PLAN_CHANGED);
    }
    if (imp.warnings.some((w) => w.requiresAck) && !body.acknowledgeWarnings) {
      throw badRequest("Confirm the warning about archived showtimes before applying.");
    }
    if ((imp.summary.pending ?? 0) > 0) {
      throw badRequest(
        `${imp.summary.pending} change${imp.summary.pending === 1 ? "" : "s"} still need a decision before this can be applied.`,
      );
    }
    // Permissions are re-checked from the stored file, for whoever is applying now.
    file = await openFile(db, actor, imp);
    resolutions = await loadResolutions(db, importId);
    pending = (await loadImportTheaters(db, importId)).filter((t) => t.status !== "applied");
  } catch (error) {
    await release(previous);
    throw error;
  }

  const results: ApplyTheaterResult[] = [];
  const notes = new Map<string, string>();
  for (const theater of pending) {
    const theaterId = theater.theater_id;
    const name = file.theaters.get(theaterId)?.name ?? theaterId;
    try {
      if (!file.theaters.has(theaterId)) throw new PlanChanged();
      const applied = await withTx(db, (tx) =>
        applyTheater(tx, actor, imp, file, resolutions, theaterId, theater.plan_hash),
      );
      results.push({ theaterId, theaterName: name, status: "applied", ...applied, message: null });
    } catch (error) {
      const changed = error instanceof PlanChanged;
      if (!changed) console.error(error);
      const message = changed
        ? PLAN_CHANGED
        : "Applying this theater failed. Nothing was written for it.";
      results.push({
        theaterId,
        theaterName: name,
        status: changed ? "conflict" : "failed",
        applied: {},
        skipped: 0,
        message,
      });
      notes.set(theaterId, message);
      await db.q`
        update ${tbl(db, "import_theaters")}
        set status = ${changed ? "conflict" : "failed"}, error = ${message}
        where import_id = ${importId} and theater_id = ${theaterId}`;
    }
  }

  const appliedCount = results.filter((r) => r.status === "applied").length;
  const allApplied = appliedCount === results.length;
  const everApplied = appliedCount > 0 || previous === "partially_applied";
  const status = allApplied ? "applied" : everApplied ? "partially_applied" : "ready";
  await db.q`
    update ${tbl(db, "imports")} set status = ${status},
      applied_at = case when ${appliedCount > 0} then now() else applied_at end,
      applied_by = case when ${appliedCount > 0} then ${actor.id} else applied_by end
    where id = ${importId}`;

  if (!allApplied) {
    // Show the admin a fresh proposal for whatever did not go through.
    await replan(db, actor, { ...imp, status }, notes);
    throw new ApiError(409, "plan_changed", PLAN_CHANGED, { status, theaters: results });
  }
  await withTx(db, (tx) => refreshSummary(tx, importId));
  return { status, theaters: results };
}

async function applyTheater(
  tx: Db,
  actor: Actor,
  imp: ImportRow,
  file: ImportFile,
  resolutions: Resolution[],
  theaterId: string,
  expectedHash: string | null,
): Promise<Pick<ApplyTheaterResult, "applied" | "skipped">> {
  const { q } = tx;
  await lockTheater(tx, theaterId);

  // Everything below runs under the theater lock, on the transaction handle only.
  const state = await loadPlanState(tx, file, resolutions, [theaterId]);
  const decisions = await loadDecisions(tx, imp.id, theaterId);
  const plan: PlanResult = planTheater(file, state, resolutions, theaterId, decisions);
  if (plan.planHash !== expectedHash) throw new PlanChanged();

  const accepted = plan.actions.filter((a) => a.decision === "accepted");
  const writes = accepted.filter((a) =>
    ["add", "restore", "update", "reschedule"].includes(a.action),
  );

  // Movies are shared between theaters, so there is no lock: insert-if-absent, then read.
  const movieIds = await ensureMovies(tx, imp.id, writes);
  const roomIds = await ensureRooms(tx, imp.id, theaterId, writes);
  const movieId = (ref: string) => (isNewRef(ref) ? movieIds.get(ref) : ref);
  const roomId = (ref: string) => (isNewRef(ref) ? roomIds.get(ref) : ref);
  const row = (a: PlannedAction) => ({
    id: a.targetShowtimeId ?? newId("st"),
    theater_id: theaterId,
    movie_id: movieId(a.payload.movieRef),
    auditorium_id: roomId(a.payload.auditoriumRef),
    start_time: a.payload.startTime,
    end_time: a.payload.endTime,
    language: a.payload.language,
    format: a.payload.format,
    rating: a.payload.rating,
    last_updated: a.payload.lastUpdated,
    source_title: a.payload.sourceTitle,
    source_auditorium: a.payload.sourceAuditorium,
  });
  const of = (...types: ActionType[]) => accepted.filter((a) => types.includes(a.action));
  let written = 0;

  // Add and restore in one statement. A restored showtime keeps its id and movie_status,
  // and a manual hold (inactive) is never switched back on by an import.
  const upserts = of("add", "restore").map(row);
  if (upserts.length > 0) {
    const result = await q`
      insert into ${tbl(tx, "showtimes")} as s
        (id, theater_id, movie_id, auditorium_id, start_time, end_time, language, format,
         rating, last_updated, source_title, source_auditorium, last_import_id)
      select id, theater_id, movie_id, auditorium_id, start_time, end_time, language, format,
             rating, last_updated, source_title, source_auditorium, ${imp.id}
      from jsonb_to_recordset(${q.json(upserts as never)}::jsonb) as x(
        id text, theater_id text, movie_id text, auditorium_id text, start_time timestamptz,
        end_time timestamptz, language text, format text, rating text,
        last_updated timestamptz, source_title text, source_auditorium text)
      on conflict on constraint showtimes_identity do update set
        auditorium_id = excluded.auditorium_id, end_time = excluded.end_time,
        language = excluded.language, format = excluded.format, rating = excluded.rating,
        last_updated = excluded.last_updated, source_title = excluded.source_title,
        source_auditorium = excluded.source_auditorium, last_import_id = excluded.last_import_id,
        status = case when s.status = 'inactive' then 'inactive' else 'active' end,
        row_version = s.row_version + 1, updated_at = now()`;
    written += result.count;
  }

  // Update and reschedule: same row, same id, same movie_status.
  const updates = of("update", "reschedule").map(row);
  if (updates.length > 0) {
    const result = await q`
      update ${tbl(tx, "showtimes")} s set
        auditorium_id = x.auditorium_id, start_time = x.start_time, end_time = x.end_time,
        language = x.language, format = x.format, rating = x.rating,
        last_updated = x.last_updated, source_title = x.source_title,
        source_auditorium = x.source_auditorium, last_import_id = ${imp.id},
        row_version = s.row_version + 1, updated_at = now()
      from jsonb_to_recordset(${q.json(updates as never)}::jsonb) as x(
        id text, auditorium_id text, start_time timestamptz, end_time timestamptz,
        language text, format text, rating text, last_updated timestamptz,
        source_title text, source_auditorium text)
      where s.id = x.id and s.theater_id = ${theaterId}`;
    written += result.count;
  }

  // Unchanged rows only refresh the partner's last_updated stamp, when it moved.
  const touches = of("unchanged").map((a) => ({
    id: a.targetShowtimeId,
    last_updated: a.payload.lastUpdated,
    source_title: a.payload.sourceTitle,
    source_auditorium: a.payload.sourceAuditorium,
  }));
  if (touches.length > 0) {
    const result = await q`
      update ${tbl(tx, "showtimes")} s set
        last_updated = x.last_updated, source_title = x.source_title,
        source_auditorium = x.source_auditorium, last_import_id = ${imp.id}, updated_at = now()
      from jsonb_to_recordset(${q.json(touches as never)}::jsonb) as x(
        id text, last_updated timestamptz, source_title text, source_auditorium text)
      where s.id = x.id and s.theater_id = ${theaterId}
        and s.last_updated is distinct from x.last_updated`;
    written += result.count;
  }

  // Archive with ONE array parameter. `id in ($1, $2, ...)` breaks at 65,535 binds.
  const archiveIds = of("archive").map((a) => a.targetShowtimeId);
  if (archiveIds.length > 0) {
    const result = await q`
      update ${tbl(tx, "showtimes")}
      set status = 'archived', last_import_id = ${imp.id},
          row_version = row_version + 1, updated_at = now()
      where id = any(${archiveIds}::text[]) and theater_id = ${theaterId}
        and status <> 'archived'`;
    written += result.count;
  }

  await learnAliases(tx, imp.id, theaterId, resolutions, accepted, movieIds, roomIds);

  if (written > 0) {
    await q`update ${tbl(tx, "theaters")}
            set schedule_version = schedule_version + 1, updated_at = now()
            where id = ${theaterId}`;
  }
  await q`
    update ${tbl(tx, "import_actions")} set
      result = case when decision = 'accepted' and action not in ('unchanged', 'duplicate')
                    then 'applied' else 'skipped' end
    where import_id = ${imp.id} and theater_id = ${theaterId}`;

  const applied: Partial<Record<ActionType, number>> = {};
  for (const action of accepted) {
    if (action.action === "unchanged" || action.action === "duplicate") continue;
    applied[action.action] = (applied[action.action] ?? 0) + 1;
  }
  const skipped = plan.actions.filter((a) => a.decision === "rejected").length;
  await q`
    update ${tbl(tx, "import_theaters")}
    set status = 'applied', error = null,
        counts = ${q.json({ ...plan.counts, applied, rejected: skipped } as never)}
    where import_id = ${imp.id} and theater_id = ${theaterId}`;
  await audit(tx, actor, "import.apply", theaterId, imp.id, { applied, rejected: skipped });
  return { applied, skipped };
}

/** Create the movies that accepted actions need. Returns `new:<key>` -> id. */
async function ensureMovies(tx: Db, importId: string, writes: PlannedAction[]) {
  const { q } = tx;
  const wanted = new Map<string, string>();
  for (const action of writes) {
    if (isNewRef(action.payload.movieRef)) {
      wanted.set(action.payload.movieRef, action.payload.movieTitle);
    }
  }
  if (wanted.size === 0) return new Map<string, string>();
  const rows = [...wanted].map(([ref, title]) => ({
    id: newId("mv"),
    title,
    normalized_title: ref.slice(NEW_PREFIX.length),
  }));
  await q`
    insert into ${tbl(tx, "movies")} (id, title, normalized_title, created_by_import_id)
    select id, title, normalized_title, ${importId}
    from jsonb_to_recordset(${q.json(rows)}::jsonb)
      as x(id text, title text, normalized_title text)
    on conflict (normalized_title) do nothing`;
  const found = await q<{ id: string; normalized_title: string }[]>`
    select id, normalized_title from ${tbl(tx, "movies")}
    where normalized_title = any(${rows.map((r) => r.normalized_title)}::text[])`;
  return new Map(found.map((r) => [NEW_PREFIX + r.normalized_title, r.id]));
}

async function ensureRooms(tx: Db, importId: string, theaterId: string, writes: PlannedAction[]) {
  const { q } = tx;
  const wanted = new Map<string, string>();
  for (const action of writes) {
    if (isNewRef(action.payload.auditoriumRef)) {
      wanted.set(action.payload.auditoriumRef, action.payload.auditoriumName);
    }
  }
  if (wanted.size === 0) return new Map<string, string>();
  const rows = [...wanted].map(([ref, name]) => ({
    id: newId("aud"),
    name,
    normalized_name: ref.slice(NEW_PREFIX.length),
  }));
  await q`
    insert into ${tbl(tx, "auditoriums")}
      (id, theater_id, name, normalized_name, created_by_import_id)
    select id, ${theaterId}, name, normalized_name, ${importId}
    from jsonb_to_recordset(${q.json(rows)}::jsonb)
      as x(id text, name text, normalized_name text)
    on conflict (theater_id, normalized_name) do nothing`;
  const found = await q<{ id: string; normalized_name: string }[]>`
    select id, normalized_name from ${tbl(tx, "auditoriums")}
    where theater_id = ${theaterId}
      and normalized_name = any(${rows.map((r) => r.normalized_name)}::text[])`;
  return new Map(found.map((r) => [NEW_PREFIX + r.normalized_name, r.id]));
}

/**
 * Save what was confirmed, so the next file matches with no model call: an agent decision
 * (medium or high confidence) or a human decision becomes an alias once an accepted action
 * that depends on it has been applied.
 */
async function learnAliases(
  tx: Db,
  importId: string,
  theaterId: string,
  resolutions: Resolution[],
  accepted: PlannedAction[],
  movieIds: Map<string, string>,
  roomIds: Map<string, string>,
) {
  const { q } = tx;
  const used = new Set(accepted.flatMap((a) => a.payload.resolutionKeys));
  const movieAliases: { target: string; alias: string; key: string; source: string }[] = [];
  const roomAliases: typeof movieAliases = [];
  for (const r of resolutions) {
    if (r.kind === "reschedule") continue;
    if (r.kind === "auditorium" && r.theaterId !== theaterId) continue;
    if (!used.has(resolutionKey(r.kind, r.theaterId, r.subjectKey))) continue;
    const trusted = r.method === "human" || (r.method === "agent" && r.confidence !== "low");
    if (!trusted) continue;
    let target: string | undefined;
    if (r.outcome.type === "existing") {
      target = r.outcome.id;
    } else if (r.outcome.type === "new") {
      // A new entry created under a cleaned-up name: remember the file's spelling too.
      const key = normalizeKey(r.outcome.name);
      if (key === r.subjectKey) continue;
      target = (r.kind === "movie" ? movieIds : roomIds).get(NEW_PREFIX + key);
    }
    if (!target) continue;
    (r.kind === "movie" ? movieAliases : roomAliases).push({
      target,
      alias: r.subjectRaw,
      key: r.subjectKey,
      source: r.method,
    });
  }
  if (movieAliases.length > 0) {
    await q`
      insert into ${tbl(tx, "movie_aliases")} (movie_id, alias, normalized_alias, source, import_id)
      select x.target, x.alias, x.key, x.source, ${importId}
      from jsonb_to_recordset(${q.json(movieAliases)}::jsonb)
        as x(target text, alias text, key text, source text)
      where exists (select 1 from ${tbl(tx, "movies")} m where m.id = x.target)
        and not exists (select 1 from ${tbl(tx, "movies")} m where m.normalized_title = x.key)
      on conflict (normalized_alias) do nothing`;
  }
  if (roomAliases.length > 0) {
    await q`
      insert into ${tbl(tx, "auditorium_aliases")}
        (auditorium_id, theater_id, alias, normalized_alias, source, import_id)
      select x.target, ${theaterId}, x.alias, x.key, x.source, ${importId}
      from jsonb_to_recordset(${q.json(roomAliases)}::jsonb)
        as x(target text, alias text, key text, source text)
      where exists (select 1 from ${tbl(tx, "auditoriums")} a
                    where a.id = x.target and a.theater_id = ${theaterId})
      on conflict (theater_id, normalized_alias) do nothing`;
  }
}

import "server-only";
import type { Actor } from "~/server/auth/context";
import { tbl, type Db } from "~/server/db/client";
import { allTheaterInfo } from "~/server/db/repositories/directory";
import { resolutionKey, type ActionType } from "~/server/domain/types";
import { notFound } from "~/server/http/errors";
import type {
  ActionPageResponse,
  AgentUsage,
  ImportCounts,
  ImportDetail,
  ImportEventsResponse,
  ImportListItem,
  PlanAction,
  PlanActionGroup,
  PlanResolution,
  SkippedRowGroup,
} from "~/types/api";
import { openFile } from "./service";
import {
  loadImportTheaters,
  loadResolutions,
  requireImport,
  type ActionRow,
  type ImportRow,
  type StoredResolution,
} from "./store";

const GROUP_PAGE = 25;
const GROUP_ORDER: ActionType[] = [
  "add",
  "update",
  "reschedule",
  "restore",
  "archive",
  "duplicate",
  "unchanged",
];

const counts = (summary: Partial<ImportCounts>): ImportCounts => ({
  add: 0,
  restore: 0,
  update: 0,
  reschedule: 0,
  archive: 0,
  unchanged: 0,
  duplicate: 0,
  pending: 0,
  skippedRows: 0,
  ...summary,
});

function toAction(row: ActionRow, methods: Map<string, string>): PlanAction {
  const p = row.payload;
  const viaAlias = p.resolutionKeys.some((key) => methods.get(key) === "alias");
  return {
    actionKey: row.action_key,
    theaterId: row.theater_id,
    action: row.action,
    targetShowtimeId: row.target_showtime_id,
    sourceRows: row.source_rows,
    movieTitle: p.movieTitle,
    auditorium: p.auditoriumName,
    startTime: p.startTime,
    endTime: p.endTime,
    language: p.language,
    format: p.format,
    rating: p.rating,
    sourceTitle: p.sourceTitle,
    sourceAuditorium: p.sourceAuditorium,
    diffs: row.diffs,
    explanation: row.explanation,
    confidence: row.confidence,
    source:
      row.decided_by === "agent"
        ? "ai"
        : row.decided_by === "human"
          ? "human"
          : viaAlias
            ? "alias"
            : "rule",
    decision: row.decision,
    result: row.result,
    resultDetail: row.result_detail,
  };
}

const methodMap = (resolutions: StoredResolution[]) =>
  new Map(
    resolutions.map((r) => [resolutionKey(r.kind, r.theaterId, r.subjectKey), r.method]),
  );

const ACTION_COLUMNS = [
  "action_key",
  "theater_id",
  "seq",
  "action",
  "target_showtime_id",
  "source_rows",
  "payload",
  "diffs",
  "explanation",
  "confidence",
  "decided_by",
  "decision",
  "result",
  "result_detail",
];

type ListedImport = ImportRow & { created_by_name: string | null; theater_names: string[] };

/** Imports the actor created, or whose theaters are all theirs, with display names joined in. */
function selectImports(db: Db, actor: Actor, id: string | null, limit: number) {
  const { q } = db;
  return q<ListedImport[]>`
    select i.*, u.name as created_by_name,
           coalesce((select array_agg(t.name order by t.name)
                     from ${tbl(db, "import_theaters")} it
                     join ${tbl(db, "theaters")} t on t.id = it.theater_id
                     where it.import_id = i.id), '{}') as theater_names
    from ${tbl(db, "imports")} i
    left join ${tbl(db, "users")} u on u.id = i.created_by
    where ${id ? q`i.id = ${id}` : q`true`}
      and (i.created_by = ${actor.id}
           or (exists (select 1 from ${tbl(db, "import_theaters")} it where it.import_id = i.id)
               and not exists (select 1 from ${tbl(db, "import_theaters")} it
                               where it.import_id = i.id
                                 and it.theater_id <> all(${actor.theaterIds}::text[]))))
    order by i.created_at desc limit ${limit}`;
}

const listItem = (imp: ListedImport): ImportListItem => ({
  id: imp.id,
  filename: imp.filename,
  status: imp.status,
  mode: imp.mode,
  model: imp.model,
  rowCount: imp.row_count,
  createdAt: imp.created_at.toISOString(),
  createdBy: imp.created_by_name ?? imp.created_by,
  appliedAt: imp.applied_at?.toISOString() ?? null,
  theaters: imp.theater_names,
  counts: counts(imp.summary),
});

/** The full proposal: per-theater sections, the first page of each action group, resolutions, skipped rows. */
export async function importDetail(
  db: Db,
  actor: Actor,
  importId: string,
): Promise<ImportDetail> {
  const { q } = db;
  const [imp] = await selectImports(db, actor, importId, 1);
  if (!imp) throw notFound("Import");
  const [base, theaters, resolutions, allTheaters] = [
    listItem(imp),
    await loadImportTheaters(db, importId),
    await loadResolutions(db, importId),
    await allTheaterInfo(db),
  ];
  const methods = methodMap(resolutions);

  const totals = await q<
    { theater_id: string; action: ActionType; decision: string; n: number }[]
  >`
    select theater_id, action, decision, count(*)::int as n
    from ${tbl(db, "import_actions")} where import_id = ${importId}
    group by theater_id, action, decision`;
  // First page of every group in one query, so the response stays small for any plan size.
  const firstPages = await q<ActionRow[]>`
    select ${q(ACTION_COLUMNS)} from (
      select *, row_number() over (partition by theater_id, action order by seq) as rn
      from ${tbl(db, "import_actions")} where import_id = ${importId}
    ) ranked where rn <= ${GROUP_PAGE} order by theater_id, action, seq`;

  const theaterById = new Map(allTheaters.map((t) => [t.id, t]));
  const theaterSections = theaters.map((t) => {
    const groups: PlanActionGroup[] = [];
    for (const action of GROUP_ORDER) {
      const rows = totals.filter((r) => r.theater_id === t.theater_id && r.action === action);
      if (rows.length === 0) continue;
      const n = (decision: string) => rows.find((r) => r.decision === decision)?.n ?? 0;
      groups.push({
        action,
        total: rows.reduce((sum, r) => sum + r.n, 0),
        pending: n("pending"),
        accepted: n("accepted"),
        rejected: n("rejected"),
        items: firstPages
          .filter((r) => r.theater_id === t.theater_id && r.action === action)
          .map((r) => toAction(r, methods)),
      });
    }
    return {
      theaterId: t.theater_id,
      theaterName: theaterById.get(t.theater_id)?.name ?? t.theater_id,
      timezone: theaterById.get(t.theater_id)?.timezone ?? "UTC",
      status: t.status,
      windowStart: t.window_start?.toISOString() ?? null,
      windowEnd: t.window_end?.toISOString() ?? null,
      error: t.error,
      groups,
    };
  });

  // Skipped rows depend on who is looking, so they are computed from the stored file.
  const skipped: SkippedRowGroup[] = [];
  try {
    const file = await openFile(db, actor, imp);
    for (const row of file.rows) {
      if (row.disposition === "in_scope") continue;
      const group = skipped.find(
        (g) => g.reason === row.disposition && g.theaterName === row.theaterName,
      );
      if (group) group.rowNumbers.push(row.rowNumber);
      else {
        skipped.push({
          reason: row.disposition,
          theaterName: row.theaterName,
          note: row.note ?? "",
          rowNumbers: [row.rowNumber],
        });
      }
    }
  } catch {
    // The viewer manages none of the file's theaters any more; the plan is still readable.
  }

  const { notice, ...usage } = imp.usage as Partial<AgentUsage> & { notice?: string | null };
  return {
    ...base,
    scopeTheaterId: imp.scope_theater_id,
    archiveScope: imp.archive_scope,
    agentSummary: imp.agent_summary,
    aiNotice: notice ?? null,
    usage: usage.turns === undefined ? null : (usage as AgentUsage),
    error: imp.error?.message ?? null,
    planHash: imp.plan_hash,
    warnings: imp.warnings,
    theaterSections,
    resolutions: await describeResolutions(db, resolutions),
    skipped,
  };
}

async function describeResolutions(
  db: Db,
  resolutions: StoredResolution[],
): Promise<PlanResolution[]> {
  const ids = resolutions.flatMap((r) => (r.outcome.type === "existing" ? [r.outcome.id] : []));
  const names = await db.q<{ id: string; name: string }[]>`
    select id, title as name from ${tbl(db, "movies")} where id = any(${ids}::text[])
    union all
    select id, name from ${tbl(db, "auditoriums")} where id = any(${ids}::text[])`;
  const nameById = new Map(names.map((row) => [row.id, row.name]));
  return resolutions.map((r) => ({
    id: r.id,
    kind: r.kind,
    theaterId: r.theaterId,
    subjectRaw: r.subjectRaw,
    rowNumbers: r.rowNumbers,
    outcome: r.outcome.type,
    targetId: r.outcome.type === "existing" ? r.outcome.id : null,
    targetName:
      r.outcome.type === "existing"
        ? (nameById.get(r.outcome.id) ?? r.outcome.id)
        : r.outcome.type === "new"
          ? r.outcome.name
          : "",
    method: r.method,
    confidence: r.confidence,
    explanation: r.explanation,
    candidates: r.candidates,
  }));
}

export async function actionPage(
  db: Db,
  actor: Actor,
  importId: string,
  query: { theaterId: string; action: ActionType; offset: number; limit: number },
): Promise<ActionPageResponse> {
  const { q } = db;
  await requireImport(db, actor, importId);
  const where = q`import_id = ${importId} and theater_id = ${query.theaterId}
                  and action = ${query.action}`;
  const rows = await q<ActionRow[]>`
    select ${q(ACTION_COLUMNS)} from ${tbl(db, "import_actions")}
    where ${where} order by seq limit ${query.limit} offset ${query.offset}`;
  const [total] = await q<{ n: number }[]>`
    select count(*)::int as n from ${tbl(db, "import_actions")} where ${where}`;
  const methods = methodMap(await loadResolutions(db, importId));
  return { items: rows.map((r) => toAction(r, methods)), total: total?.n ?? 0 };
}

/** History, newest first. */
export async function listImports(db: Db, actor: Actor, limit = 50): Promise<ImportListItem[]> {
  return (await selectImports(db, actor, null, limit)).map(listItem);
}

export async function importEvents(
  db: Db,
  actor: Actor,
  importId: string,
  after: number,
): Promise<ImportEventsResponse> {
  const imp = await requireImport(db, actor, importId);
  const rows = await db.q<
    { id: string; type: string; message: string; data: Record<string, unknown>; created_at: Date }[]
  >`
    select id, type, message, data, created_at from ${tbl(db, "import_events")}
    where import_id = ${importId} and id > ${after} order by id limit 500`;
  return {
    status: imp.status,
    events: rows.map((row) => ({
      id: Number(row.id),
      type: row.type,
      message: row.message,
      data: row.data,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

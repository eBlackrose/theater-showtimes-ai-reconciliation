import "server-only";
import { randomUUID } from "node:crypto";
import type { Actor } from "~/server/auth/context";
import { tbl, type Db } from "~/server/db/client";
import { combineHashes, type PlanResult } from "~/server/domain/plan";
import type {
  ActionPayload,
  ActionType,
  ArchiveScope,
  Candidate,
  Confidence,
  DecidedBy,
  Decision,
  FieldChange,
  Outcome,
  PlannedAction,
  PlanWarning,
  Resolution,
  ResolutionKind,
  ResolutionMethod,
  TimeWindow,
} from "~/server/domain/types";
import { notFound } from "~/server/http/errors";
import type { ImportCounts, ImportMode, ImportStatus } from "~/types/api";

export const newId = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;

export interface ImportRow {
  id: string;
  created_by: string;
  filename: string;
  file_bytes: number;
  row_count: number;
  scope_theater_id: string | null;
  archive_scope: ArchiveScope;
  status: ImportStatus;
  mode: ImportMode | null;
  model: string | null;
  agent_summary: string | null;
  summary: Partial<ImportCounts>;
  warnings: PlanWarning[];
  usage: Record<string, unknown>;
  error: { message: string } | null;
  plan_hash: string | null;
  created_at: Date;
  analyzed_at: Date | null;
  applied_at: Date | null;
  applied_by: string | null;
}

export interface ImportTheaterRow {
  theater_id: string;
  base_schedule_version: string;
  window_start: Date | null;
  window_end: Date | null;
  plan_hash: string | null;
  status: "ready" | "applied" | "conflict" | "failed";
  counts: Record<string, number>;
  error: string | null;
}

export interface StoredResolution extends Resolution {
  id: string;
}

export interface ActionRow {
  action_key: string;
  theater_id: string;
  seq: number;
  action: ActionType;
  target_showtime_id: string | null;
  source_rows: number[];
  payload: ActionPayload;
  diffs: FieldChange[];
  explanation: string;
  confidence: Confidence;
  decided_by: DecidedBy;
  decision: Decision;
  result: "applied" | "skipped" | "conflict" | "failed" | null;
  result_detail: string | null;
}

/**
 * Load an import the actor may see: one they created, or one whose theaters are all theirs.
 * Anything else is a 404, so the existence of other theaters' imports is not revealed.
 */
export async function requireImport(db: Db, actor: Actor, id: string): Promise<ImportRow> {
  const rows = await db.q<ImportRow[]>`
    select i.* from ${tbl(db, "imports")} i
    where i.id = ${id}
      and (i.created_by = ${actor.id}
           or (exists (select 1 from ${tbl(db, "import_theaters")} it where it.import_id = i.id)
               and not exists (select 1 from ${tbl(db, "import_theaters")} it
                               where it.import_id = i.id
                                 and it.theater_id <> all(${actor.theaterIds}::text[]))))`;
  if (!rows[0]) throw notFound("Import");
  return rows[0];
}

export async function getFileContent(db: Db, importId: string): Promise<string> {
  const rows = await db.q<{ content: string }[]>`
    select content from ${tbl(db, "import_files")} where import_id = ${importId}`;
  if (!rows[0]) throw notFound("Import file");
  return rows[0].content;
}

export async function addEvent(
  db: Db,
  importId: string,
  type: string,
  message: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.q`
    insert into ${tbl(db, "import_events")} (import_id, type, message, data)
    values (${importId}, ${type}, ${message}, ${db.q.json(data as never)})`;
}

export async function audit(
  db: Db,
  actor: Actor,
  action: string,
  theaterId: string | null,
  entityId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await db.q`
    insert into ${tbl(db, "audit_log")} (actor_user_id, action, theater_id, entity_id, details)
    values (${actor.id}, ${action}, ${theaterId}, ${entityId}, ${db.q.json(details as never)})`;
}

export async function loadResolutions(db: Db, importId: string): Promise<StoredResolution[]> {
  const rows = await db.q<
    {
      id: string;
      kind: ResolutionKind;
      theater_id: string | null;
      subject_key: string;
      subject_raw: string;
      row_numbers: number[];
      outcome: Outcome;
      method: ResolutionMethod;
      confidence: Confidence;
      explanation: string;
      candidates: Candidate[];
    }[]
  >`
    select id, kind, theater_id, subject_key, subject_raw, row_numbers, outcome, method,
           confidence, explanation, candidates
    from ${tbl(db, "import_resolutions")}
    where import_id = ${importId}
    order by kind, subject_raw`;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    theaterId: row.theater_id,
    subjectKey: row.subject_key,
    subjectRaw: row.subject_raw,
    rowNumbers: row.row_numbers,
    outcome: row.outcome,
    method: row.method,
    confidence: row.confidence,
    explanation: row.explanation,
    candidates: row.candidates,
  }));
}

/** Replace the machine-made resolutions of an import. Human overrides are kept. */
export async function saveResolutions(
  tx: Db,
  importId: string,
  resolutions: Resolution[],
): Promise<void> {
  const { q } = tx;
  await q`delete from ${tbl(tx, "import_resolutions")}
          where import_id = ${importId} and method <> 'human'`;
  const rows = resolutions
    .filter((r) => r.method !== "human")
    .map((r) => ({
      id: newId("res"),
      kind: r.kind,
      theater_id: r.theaterId,
      subject_key: r.subjectKey,
      subject_raw: r.subjectRaw,
      row_numbers: r.rowNumbers,
      outcome: r.outcome,
      method: r.method,
      confidence: r.confidence,
      explanation: r.explanation,
      candidates: r.candidates,
    }));
  if (rows.length === 0) return;
  await q`
    insert into ${tbl(tx, "import_resolutions")}
      (id, import_id, kind, theater_id, subject_key, subject_raw, row_numbers, outcome,
       method, confidence, explanation, candidates)
    select x.id, ${importId}, x.kind, x.theater_id, x.subject_key, x.subject_raw,
           array(select jsonb_array_elements_text(x.row_numbers)::int), x.outcome,
           x.method, x.confidence, x.explanation, x.candidates
    from jsonb_to_recordset(${q.json(rows as never)}::jsonb) as x(
      id text, kind text, theater_id text, subject_key text, subject_raw text,
      row_numbers jsonb, outcome jsonb, method text, confidence text, explanation text,
      candidates jsonb)
    on conflict do nothing`;
}

export async function loadDecisions(
  db: Db,
  importId: string,
  theaterId?: string,
): Promise<Map<string, Decision>> {
  const { q } = db;
  const rows = await q<{ action_key: string; decision: Decision }[]>`
    select action_key, decision from ${tbl(db, "import_actions")}
    where import_id = ${importId}
      and action not in ('unchanged', 'duplicate')
      ${theaterId ? q`and theater_id = ${theaterId}` : q``}`;
  return new Map(rows.map((row) => [row.action_key, row.decision]));
}

const ACTION_CHUNK = 2000;

/** Replace one theater's plan. Rows go in as one JSON parameter per chunk, never one bind per value. */
export async function savePlan(
  tx: Db,
  importId: string,
  theaterId: string,
  plan: PlanResult,
  meta: { baseVersion: number; window: TimeWindow | null; error?: string | null },
): Promise<void> {
  const { q } = tx;
  await q`delete from ${tbl(tx, "import_actions")}
          where import_id = ${importId} and theater_id = ${theaterId}`;
  for (let i = 0; i < plan.actions.length; i += ACTION_CHUNK) {
    const rows = plan.actions.slice(i, i + ACTION_CHUNK).map((a: PlannedAction) => ({
      action_key: a.actionKey,
      seq: a.seq,
      action: a.action,
      target_showtime_id: a.targetShowtimeId,
      source_rows: a.sourceRows,
      payload: a.payload,
      diffs: a.diffs,
      explanation: a.explanation,
      confidence: a.confidence,
      decided_by: a.decidedBy,
      decision: a.decision,
    }));
    await q`
      insert into ${tbl(tx, "import_actions")}
        (import_id, action_key, theater_id, seq, action, target_showtime_id, source_rows,
         payload, diffs, explanation, confidence, decided_by, decision)
      select ${importId}, x.action_key, ${theaterId}, x.seq, x.action, x.target_showtime_id,
             array(select jsonb_array_elements_text(x.source_rows)::int), x.payload, x.diffs,
             x.explanation, x.confidence, x.decided_by, x.decision
      from jsonb_to_recordset(${q.json(rows as never)}::jsonb) as x(
        action_key text, seq int, action text, target_showtime_id text, source_rows jsonb,
        payload jsonb, diffs jsonb, explanation text, confidence text, decided_by text,
        decision text)`;
  }
  await q`
    insert into ${tbl(tx, "import_theaters")} as it
      (import_id, theater_id, base_schedule_version, window_start, window_end, plan_hash,
       status, counts, error)
    values (${importId}, ${theaterId}, ${meta.baseVersion}, ${meta.window?.start ?? null},
            ${meta.window?.end ?? null}, ${plan.planHash}, 'ready',
            ${q.json(plan.counts as never)}, ${meta.error ?? null})
    on conflict (import_id, theater_id) do update set
      base_schedule_version = excluded.base_schedule_version,
      window_start = excluded.window_start, window_end = excluded.window_end,
      plan_hash = excluded.plan_hash, status = 'ready', counts = excluded.counts,
      error = excluded.error`;
}

export async function loadImportTheaters(db: Db, importId: string): Promise<ImportTheaterRow[]> {
  return db.q<ImportTheaterRow[]>`
    select theater_id, base_schedule_version, window_start, window_end, plan_hash, status,
           counts, error
    from ${tbl(db, "import_theaters")} where import_id = ${importId} order by theater_id`;
}

/**
 * Recompute the import's counts and its overall plan hash from the stored actions.
 * Called after every change to the plan or to a decision.
 */
export async function refreshSummary(
  tx: Db,
  importId: string,
  extra: { skippedRows?: number; warnings?: PlanWarning[] } = {},
): Promise<{ planHash: string | null; counts: ImportCounts }> {
  const { q } = tx;
  const rows = await q<{ action: ActionType; total: number; pending: number }[]>`
    select action, count(*)::int as total,
           (count(*) filter (where decision = 'pending'))::int as pending
    from ${tbl(tx, "import_actions")} where import_id = ${importId} group by action`;
  const [current] = await q<{ summary: Partial<ImportCounts> }[]>`
    select summary from ${tbl(tx, "imports")} where id = ${importId}`;
  const counts: ImportCounts = {
    add: 0,
    restore: 0,
    update: 0,
    reschedule: 0,
    archive: 0,
    unchanged: 0,
    duplicate: 0,
    pending: 0,
    skippedRows: extra.skippedRows ?? current?.summary.skippedRows ?? 0,
  };
  for (const row of rows) {
    counts[row.action] = row.total;
    counts.pending += row.pending;
  }
  const theaters = await loadImportTheaters(tx, importId);
  const open = theaters.filter((t) => t.status !== "applied" && t.plan_hash);
  const planHash =
    open.length > 0
      ? combineHashes(new Map(open.map((t) => [t.theater_id, t.plan_hash ?? ""])))
      : null;
  await q`
    update ${tbl(tx, "imports")} set
      summary = ${q.json(counts as never)},
      plan_hash = ${planHash}
      ${extra.warnings ? q`, warnings = ${q.json(extra.warnings as never)}` : q``}
    where id = ${importId}`;
  return { planHash, counts };
}

import "server-only";
import { tbl, type Db } from "~/server/db/client";
import { loadCatalog, loadSchedule } from "~/server/db/repositories/catalog";
import { parseCsv } from "~/server/domain/csv";
import { normalizeKey } from "~/server/domain/normalize";
import { derivePlan, type PlanResult } from "~/server/domain/plan";
import { Resolver } from "~/server/domain/resolve";
import { scopeRows, type ScopeActor } from "~/server/domain/scope";
import type {
  ArchiveScope,
  CatalogSnapshot,
  CsvIssue,
  Decision,
  ExistingShowtime,
  Resolution,
  ScopedRow,
  TheaterInfo,
  TimeWindow,
} from "~/server/domain/types";
import { coveredWindow } from "~/server/domain/window";

/** An uploaded file, parsed and scoped for one actor. No database state in here. */
export interface ImportFile {
  rows: ScopedRow[];
  /** Theaters with at least one in-scope row, in id order (the lock order at apply). */
  theaterIds: string[];
  theaters: Map<string, TheaterInfo>;
  rowsByTheater: Map<string, ScopedRow[]>;
  /** null = the whole schedule (archive scope "full_schedule"). */
  windows: Map<string, TimeWindow | null>;
  defaultLastUpdated: string;
}

export type PrepareResult =
  | { ok: true; file: ImportFile }
  | { ok: false; code: "too_large" | "invalid" | "nothing_in_scope"; errors: CsvIssue[] };

/**
 * Parse and scope a file. Used at upload and again at analyze and apply, from the stored
 * content, so permissions are always re-checked against the current actor.
 */
export function prepareFile(input: {
  content: string;
  actor: ScopeActor;
  scopeTheaterId: string | null;
  archiveScope: ArchiveScope;
  allTheaters: TheaterInfo[];
  uploadedAt: string;
}): PrepareResult {
  const parsed = parseCsv(input.content, { requireTheater: !input.scopeTheaterId });
  if (!parsed.ok) return parsed;

  const rows = scopeRows(parsed.rows, input.actor, input.scopeTheaterId, input.allTheaters);
  const rowsByTheater = new Map<string, ScopedRow[]>();
  for (const row of rows) {
    if (row.disposition !== "in_scope" || !row.theaterId) continue;
    const list = rowsByTheater.get(row.theaterId);
    if (list) list.push(row);
    else rowsByTheater.set(row.theaterId, [row]);
  }
  if (rowsByTheater.size === 0) {
    const notes = [...new Set(rows.map((row) => row.note).filter(Boolean))].slice(0, 3);
    return {
      ok: false,
      code: "nothing_in_scope",
      errors: [
        {
          row: 0,
          field: "theater_name",
          message: `No row in this file is for a theater you can manage here. ${notes.join(" ")}`,
        },
      ],
    };
  }

  const theaterIds = [...rowsByTheater.keys()].sort();
  const byId = new Map(input.allTheaters.map((theater) => [theater.id, theater]));
  const theaters = new Map<string, TheaterInfo>();
  const windows = new Map<string, TimeWindow | null>();
  for (const id of theaterIds) {
    const theater = byId.get(id)!;
    theaters.set(id, theater);
    windows.set(
      id,
      input.archiveScope === "full_schedule"
        ? null
        : coveredWindow(
            (rowsByTheater.get(id) ?? []).map((row) => row.startTime),
            theater.timezone,
          ),
    );
  }
  return {
    ok: true,
    file: {
      rows,
      theaterIds,
      theaters,
      rowsByTheater,
      windows,
      defaultLastUpdated: input.uploadedAt,
    },
  };
}

/** Database state a plan is derived from. Loaded outside transactions, except at apply. */
export interface PlanState {
  catalog: CatalogSnapshot;
  schedules: Map<string, ExistingShowtime[]>;
  versions: Map<string, number>;
}

export async function loadPlanState(
  db: Db,
  file: ImportFile,
  resolutions: Resolution[],
  theaterIds: string[] = file.theaterIds,
  createdByImportId?: string,
): Promise<PlanState> {
  const schedules = new Map<string, ExistingShowtime[]>();
  const titleKeys = new Set<string>();
  const movieIds = new Set<string>();
  for (const theaterId of theaterIds) {
    const schedule = await loadSchedule(db, theaterId, file.windows.get(theaterId) ?? null);
    schedules.set(theaterId, schedule);
    for (const showtime of schedule) movieIds.add(showtime.movieId);
    for (const row of file.rowsByTheater.get(theaterId) ?? []) {
      titleKeys.add(normalizeKey(row.title));
    }
  }
  for (const resolution of resolutions) {
    if (resolution.kind !== "movie") continue;
    if (resolution.outcome.type === "existing") movieIds.add(resolution.outcome.id);
    if (resolution.outcome.type === "new") titleKeys.add(normalizeKey(resolution.outcome.name));
  }
  const catalog = await loadCatalog(db, {
    titleKeys: [...titleKeys],
    movieIds: [...movieIds],
    theaterIds,
    createdByImportId,
  });
  const rows = await db.q<{ id: string; schedule_version: string }[]>`
    select id, schedule_version from ${tbl(db, "theaters")}
    where id = any(${theaterIds}::text[])`;
  return {
    catalog,
    schedules,
    versions: new Map(rows.map((row) => [row.id, Number(row.schedule_version)])),
  };
}

export function planTheater(
  file: ImportFile,
  state: PlanState,
  resolutions: Resolution[],
  theaterId: string,
  decisions: ReadonlyMap<string, Decision>,
): PlanResult {
  return derivePlan({
    theater: file.theaters.get(theaterId)!,
    rows: file.rowsByTheater.get(theaterId) ?? [],
    resolver: new Resolver(state.catalog, resolutions),
    schedule: state.schedules.get(theaterId) ?? [],
    window: file.windows.get(theaterId) ?? null,
    decisions,
    defaultLastUpdated: file.defaultLastUpdated,
  });
}

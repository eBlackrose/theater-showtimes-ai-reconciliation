import { readFileSync } from "node:fs";
import path from "node:path";
import { seedAuditoriumId, seedMovieId } from "~/server/db/seed";
import { seedCatalogTitles, seedShowtimes, seedTheaters } from "~/server/db/seed-data";
import { parseCsv } from "~/server/domain/csv";
import { normalizeKey } from "~/server/domain/normalize";
import { derivePlan, type PlanResult } from "~/server/domain/plan";
import { Resolver } from "~/server/domain/resolve";
import { scopeRows, type ScopeActor } from "~/server/domain/scope";
import type {
  CatalogSnapshot,
  Decision,
  ExistingShowtime,
  Resolution,
  ScopedRow,
  TheaterInfo,
  TimeWindow,
} from "~/server/domain/types";
import { coveredWindow } from "~/server/domain/window";

export const theaters: TheaterInfo[] = seedTheaters.map((t) => ({
  id: t.id,
  name: t.name,
  normalizedName: normalizeKey(t.name),
  timezone: t.timezone,
}));
export const downtown = theaters[0]!;
export const DOWNTOWN = "theater-downtown";

export const avery: ScopeActor = {
  role: "admin",
  theaterIds: ["theater-downtown", "theater-riverside"],
};
export const casey: ScopeActor = { role: "admin", theaterIds: theaters.map((t) => t.id) };
export const riley: ScopeActor = { role: "viewer", theaterIds: ["theater-downtown"] };

/** The seeded catalog as the resolver sees it. */
export function seedCatalog(): CatalogSnapshot {
  const catalog: CatalogSnapshot = {
    movieTitles: new Map(),
    movieByKey: new Map(),
    movieAliasByKey: new Map(),
    rooms: new Map(),
  };
  for (const title of [...seedShowtimes.map((s) => s.movieTitle), ...seedCatalogTitles]) {
    catalog.movieTitles.set(seedMovieId(title), title);
    catalog.movieByKey.set(normalizeKey(title), seedMovieId(title));
  }
  for (const theater of theaters) {
    catalog.rooms.set(theater.id, { byId: new Map(), byKey: new Map(), aliasByKey: new Map() });
  }
  for (const s of seedShowtimes) {
    const rooms = catalog.rooms.get(s.theaterId);
    const id = seedAuditoriumId(s.theaterId, s.auditorium);
    rooms?.byId.set(id, s.auditorium);
    rooms?.byKey.set(normalizeKey(s.auditorium), id);
  }
  return catalog;
}

export function seedSchedule(theaterId = DOWNTOWN): ExistingShowtime[] {
  return seedShowtimes
    .filter((s) => s.theaterId === theaterId)
    .map((s) => ({
      id: s.id,
      movieId: seedMovieId(s.movieTitle),
      auditoriumId: seedAuditoriumId(s.theaterId, s.auditorium),
      startTime: new Date(s.startTime).toISOString(),
      endTime: new Date(s.endTime).toISOString(),
      language: s.language,
      format: s.format,
      rating: s.rating,
      status: s.status,
      movieStatus: s.movieStatus,
      lastUpdated: new Date(s.lastUpdated).toISOString(),
    }));
}

export const sample = (name: string) =>
  readFileSync(path.join(process.cwd(), "sample-data", name), "utf8");

export function rowsOf(
  csv: string,
  actor: ScopeActor = avery,
  scopeTheaterId: string | null = DOWNTOWN,
): ScopedRow[] {
  const parsed = parseCsv(csv, { requireTheater: !scopeTheaterId });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return scopeRows(parsed.rows, actor, scopeTheaterId, theaters);
}

const aud = (n: string) => `aud-downtown-auditorium-${n}`;
const roomResolution = (
  subjectKey: string,
  subjectRaw: string,
  outcome: Resolution["outcome"],
  confidence: Resolution["confidence"] = "high",
): Resolution => ({
  kind: "auditorium",
  theaterId: DOWNTOWN,
  subjectKey,
  subjectRaw,
  rowNumbers: [],
  outcome,
  method: "agent",
  confidence,
  explanation: "Same room, written differently.",
  candidates: [],
});

/** What a correct agent decides for the four room names in new-drop.csv. */
export const newDropResolutions = (): Resolution[] => [
  roomResolution("aud 1", "Aud 1", { type: "existing", id: aud("1") }),
  roomResolution("auditorium two", "Auditorium Two", { type: "existing", id: aud("2") }),
  roomResolution("auditorium 1 laser", "Auditorium 1 (Laser)", { type: "existing", id: aud("1") }, "medium"),
  roomResolution("auditorium 5", "Auditorium 5", { type: "new", name: "Auditorium 5" }),
];

export function plan(input: {
  rows: ScopedRow[];
  resolutions?: Resolution[];
  schedule?: ExistingShowtime[];
  catalog?: CatalogSnapshot;
  window?: TimeWindow | null;
  decisions?: Map<string, Decision>;
}): PlanResult {
  const rows = input.rows.filter((r) => r.disposition === "in_scope");
  return derivePlan({
    theater: downtown,
    rows,
    resolver: new Resolver(input.catalog ?? seedCatalog(), input.resolutions ?? []),
    schedule: input.schedule ?? seedSchedule(),
    window:
      input.window === undefined
        ? coveredWindow(
            rows.map((r) => r.startTime),
            downtown.timezone,
          )
        : input.window,
    decisions: input.decisions ?? new Map(),
    defaultLastUpdated: "2025-03-15T12:00:00.000Z",
  });
}

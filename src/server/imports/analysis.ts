import "server-only";
import { DateTime } from "luxon";
import type {
  AgentSession,
  SubmitResult,
  SubmittedResolution,
  WorkItem,
} from "~/server/agent/types";
import { cleanText, normalizeKey } from "~/server/domain/normalize";
import { Resolver, surveyRows } from "~/server/domain/resolve";
import {
  resolutionKey,
  type Candidate,
  type Resolution,
  type ScopedRow,
} from "~/server/domain/types";
import { planTheater, type ImportFile, type PlanState } from "./workspace";

/** Beyond this many subjects the rest go to the admin instead of the model. */
export const MAX_AGENT_SUBJECTS = 80;
const MAX_FILE_ROWS_IN_PROMPT = 150;

const NO_DECISIONS = new Map<string, never>();

export interface MovieLookup {
  byId(id: string): Promise<{ id: string; title: string } | null>;
  byKey(key: string): Promise<{ id: string; title: string } | null>;
}

/**
 * The in-memory state of one analysis: the file, the schedule snapshot, and the resolutions
 * made so far. It is the agent's "session": it computes what is still unresolved and
 * validates every decision the model submits before it counts.
 */
export class Analysis implements AgentSession {
  readonly resolutions = new Map<string, Resolution>();
  readonly theaters: { id: string; name: string; timezone: string }[];
  /** Subjects left out of the agent's worklist because of the cap. */
  overflow = 0;
  private cache: WorkItem[] | null = null;
  private readonly initialKeys = new Set<string>();

  constructor(
    private readonly file: ImportFile,
    private readonly state: PlanState,
    initial: Resolution[],
    private readonly movieCandidates: Map<string, Candidate[]>,
    private readonly movies: MovieLookup,
  ) {
    for (const resolution of initial) this.record(resolution);
    this.theaters = file.theaterIds.map((id) => {
      const theater = file.theaters.get(id);
      return { id, name: theater?.name ?? id, timezone: theater?.timezone ?? "UTC" };
    });
    for (const item of this.remaining()) {
      this.initialKeys.add(resolutionKey(item.kind, item.theaterId, item.subjectKey));
    }
  }

  private record(resolution: Resolution) {
    this.resolutions.set(
      resolutionKey(resolution.kind, resolution.theaterId, resolution.subjectKey),
      resolution,
    );
    this.cache = null;
  }

  private inScopeRows(): ScopedRow[] {
    return this.file.theaterIds.flatMap((id) => this.file.rowsByTheater.get(id) ?? []);
  }

  private local(iso: string, theaterId: string) {
    const zone = this.file.theaters.get(theaterId)?.timezone ?? "UTC";
    return DateTime.fromISO(iso, { zone: "utc" }).setZone(zone).toFormat("yyyy-LL-dd HH:mm");
  }

  /** Titles and rooms nobody has resolved yet, without the cap. */
  unresolvedSubjects() {
    const resolver = new Resolver(this.state.catalog, [...this.resolutions.values()]);
    return surveyRows(this.inScopeRows(), resolver);
  }

  remaining(): WorkItem[] {
    if (this.cache) return this.cache;
    const all = [...this.resolutions.values()];
    const { unresolved } = this.unresolvedSubjects();
    const rowsByNumber = new Map(this.inScopeRows().map((row) => [row.rowNumber, row]));
    const items: WorkItem[] = [];

    for (const subject of unresolved.slice(0, MAX_AGENT_SUBJECTS)) {
      if (subject.kind === "movie") {
        items.push({
          kind: "movie",
          theaterId: null,
          subjectKey: subject.subjectKey,
          spellings: subject.raws,
          rowNumbers: subject.rowNumbers,
          examples: subject.rowNumbers.slice(0, 3).flatMap((n) => {
            const row = rowsByNumber.get(n);
            return row?.theaterId
              ? [
                  {
                    theater: this.file.theaters.get(row.theaterId)?.name ?? "",
                    startTime: this.local(row.startTime, row.theaterId),
                    auditorium: row.auditorium,
                  },
                ]
              : [];
          }),
          candidates: this.movieCandidates.get(subject.subjectKey) ?? [],
        });
      } else if (subject.theaterId) {
        const rooms = this.state.catalog.rooms.get(subject.theaterId);
        const aliases = new Map<string, string[]>();
        for (const [alias, id] of rooms?.aliasByKey ?? []) {
          aliases.set(id, [...(aliases.get(id) ?? []), alias]);
        }
        items.push({
          kind: "auditorium",
          theaterId: subject.theaterId,
          theaterName: this.file.theaters.get(subject.theaterId)?.name ?? "",
          subjectKey: subject.subjectKey,
          spellings: subject.raws,
          rowNumbers: subject.rowNumbers,
          rooms: [...(rooms?.byId ?? [])].map(([id, name]) => ({
            id,
            name,
            aliases: aliases.get(id) ?? [],
          })),
        });
      }
    }
    this.overflow = Math.max(0, unresolved.length - MAX_AGENT_SUBJECTS);

    // Possible reschedules only exist once the titles involved are resolved.
    for (const theaterId of this.file.theaterIds) {
      const plan = planTheater(this.file, this.state, all, theaterId, NO_DECISIONS);
      for (const candidate of plan.rescheduleCandidates) {
        items.push({
          kind: "reschedule",
          theaterId,
          theaterName: this.file.theaters.get(theaterId)?.name ?? "",
          subjectKey: candidate.subjectKey,
          movieTitle: candidate.movieTitle,
          storedShowtime: {
            startTime: this.local(candidate.oldStartTime, theaterId),
            auditorium: candidate.oldAuditorium,
          },
          fileRow: {
            rowNumber: candidate.rowNumber,
            startTime: this.local(candidate.newStartTime, theaterId),
            auditorium: candidate.newAuditorium,
          },
        });
      }
    }
    this.cache = items;
    return items;
  }

  fileRows(): Record<string, unknown>[] {
    const wanted = new Set<number>();
    for (const item of this.remaining()) {
      if (item.kind === "reschedule") wanted.add(item.fileRow.rowNumber);
      else for (const n of item.rowNumbers) wanted.add(n);
    }
    return this.inScopeRows()
      .filter((row) => wanted.has(row.rowNumber))
      .slice(0, MAX_FILE_ROWS_IN_PROMPT)
      .map((row) => ({
        row: row.rowNumber,
        theater: row.theaterId ? this.file.theaters.get(row.theaterId)?.name : null,
        movie_title: row.title,
        auditorium: row.auditorium,
        start: row.theaterId ? this.local(row.startTime, row.theaterId) : row.startTime,
        end: row.theaterId ? this.local(row.endTime, row.theaterId) : row.endTime,
        language: row.language,
        format: row.format,
        rating: row.rating,
      }));
  }

  async submit(items: SubmittedResolution[]): Promise<SubmitResult[]> {
    const results: SubmitResult[] = [];
    for (const item of items) results.push(await this.submitOne(item));
    return results;
  }

  private async submitOne(item: SubmittedResolution): Promise<SubmitResult> {
    const theaterId = item.kind === "movie" ? null : item.theaterId;
    const work = this.remaining().find(
      (w) =>
        w.kind === item.kind && w.subjectKey === item.subjectKey && w.theaterId === theaterId,
    );
    const label = work && "spellings" in work ? work.spellings[0] : item.subjectKey;
    const reject = (reason: string): SubmitResult => ({
      kind: item.kind,
      subjectKey: item.subjectKey,
      status: "rejected",
      reason,
      summary: `Rejected a decision for "${label}": ${reason}`,
    });
    if (!work) {
      return reject(
        "This subject is not on the worklist. Use kind, subjectKey and theaterId exactly as listed in stillUnresolved.",
      );
    }
    const explanation = cleanText(item.explanation);
    if (!explanation) return reject("An explanation is required.");
    const base = {
      kind: work.kind,
      theaterId: work.theaterId,
      subjectKey: work.subjectKey,
      method: "agent" as const,
      confidence: item.confidence,
      explanation,
    };
    const accepted = (summary: string): SubmitResult => ({
      kind: item.kind,
      subjectKey: item.subjectKey,
      status: "accepted",
      summary: `Decided: ${summary} (${item.confidence} confidence)`,
    });

    if (work.kind === "reschedule") {
      if (item.decision !== "moved" && item.decision !== "separate") {
        return reject('A reschedule decision must be "moved" or "separate".');
      }
      this.record({
        ...base,
        subjectRaw: `${work.movieTitle}: ${work.storedShowtime.startTime} → ${work.fileRow.startTime}`,
        rowNumbers: [work.fileRow.rowNumber],
        outcome: { type: item.decision },
        candidates: [],
      });
      return accepted(
        item.decision === "moved"
          ? `the ${work.storedShowtime.startTime} showing of "${work.movieTitle}" moved to ${work.fileRow.startTime}`
          : `the ${work.storedShowtime.startTime} and ${work.fileRow.startTime} showings of "${work.movieTitle}" are separate`,
      );
    }

    if (item.decision !== "existing" && item.decision !== "new") {
      return reject(`A ${work.kind} decision must be "existing" or "new".`);
    }
    const raw = work.spellings[0] ?? work.subjectKey;
    const shared = { ...base, subjectRaw: raw, rowNumbers: work.rowNumbers };

    if (work.kind === "movie") {
      if (item.decision === "existing") {
        if (!item.targetId) return reject('"existing" needs the targetId of a catalog movie.');
        const known = this.state.catalog.movieTitles.get(item.targetId);
        const movie = known
          ? { id: item.targetId, title: known }
          : await this.movies.byId(item.targetId);
        if (!movie) {
          return reject(
            `No movie has the id "${item.targetId}". Use an id from catalogCandidates or search_movies.`,
          );
        }
        this.state.catalog.movieTitles.set(movie.id, movie.title);
        this.record({
          ...shared,
          outcome: { type: "existing", id: movie.id },
          candidates: work.candidates,
        });
        return accepted(`"${raw}" is "${movie.title}"`);
      }
      const name = cleanText(item.canonicalName) || raw;
      const existing = await this.movies.byKey(normalizeKey(name));
      if (existing) {
        return reject(
          `"${name}" already exists in the catalog as "${existing.title}" (id ${existing.id}). Decide "existing" with that id, or keep the spelling from the file.`,
        );
      }
      this.record({ ...shared, outcome: { type: "new", name }, candidates: work.candidates });
      return accepted(`"${raw}" is a new movie${name !== raw ? ` ("${name}")` : ""}`);
    }

    const rooms = this.state.catalog.rooms.get(work.theaterId);
    const candidates = work.rooms.map((room) => ({ id: room.id, name: room.name }));
    if (item.decision === "existing") {
      const name = item.targetId ? rooms?.byId.get(item.targetId) : undefined;
      if (!item.targetId || !name) {
        return reject(
          `"${item.targetId ?? ""}" is not a room of ${work.theaterName}. Its rooms are: ${work.rooms.map((room) => `${room.name} (id ${room.id})`).join(", ")}.`,
        );
      }
      this.record({ ...shared, outcome: { type: "existing", id: item.targetId }, candidates });
      return accepted(`"${raw}" is ${name} at ${work.theaterName}`);
    }
    const name = cleanText(item.canonicalName) || raw;
    const existingId = rooms?.byKey.get(normalizeKey(name));
    if (existingId) {
      return reject(
        `${work.theaterName} already has a room named "${name}" (id ${existingId}). Decide "existing" with that id.`,
      );
    }
    this.record({ ...shared, outcome: { type: "new", name }, candidates });
    return accepted(`"${raw}" is a new room at ${work.theaterName}`);
  }

  /**
   * Whatever is still open becomes a low-confidence "new" for the admin to decide, so an
   * import always reaches a usable plan. Open reschedule questions simply stay add + archive.
   */
  applyFallbacks(reason: string): number {
    const { unresolved } = this.unresolvedSubjects();
    for (const subject of unresolved) {
      const raw = subject.raws[0] ?? subject.subjectKey;
      this.record({
        kind: subject.kind,
        theaterId: subject.theaterId,
        subjectKey: subject.subjectKey,
        subjectRaw: raw,
        rowNumbers: subject.rowNumbers,
        outcome: { type: "new", name: raw },
        method: "fallback",
        confidence: "low",
        explanation: `${reason} "${raw}" is treated as a new ${subject.kind === "movie" ? "movie" : "room"} until you decide.`,
        candidates:
          subject.kind === "movie"
            ? (this.movieCandidates.get(subject.subjectKey) ?? [])
            : [...(this.state.catalog.rooms.get(subject.theaterId ?? "")?.byId ?? [])].map(
                ([id, name]) => ({ id, name }),
              ),
      });
    }
    return unresolved.length;
  }

  /** Subjects handed to the agent at the start. */
  initialSubjects(): number {
    return this.initialKeys.size;
  }
}

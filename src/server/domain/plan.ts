import { createHash } from "node:crypto";
import { isNewRef, type RefResult, type Resolver } from "./resolve";
import {
  emptyCounts,
  resolutionKey,
  type ActionCounts,
  type ActionPayload,
  type ActionType,
  type Confidence,
  type DecidedBy,
  type Decision,
  type ExistingShowtime,
  type FieldChange,
  type PlannedAction,
  type PlanWarning,
  type RescheduleCandidate,
  type Resolution,
  type ScopedRow,
  type TheaterInfo,
  type TimeWindow,
} from "./types";
import { formatLocal, inWindow, localDay } from "./window";

export interface PlanInput {
  theater: TheaterInfo;
  /** In-scope rows of this theater. */
  rows: ScopedRow[];
  resolver: Resolver;
  /** Stored showtimes of the theater inside the window, in any status. */
  schedule: ExistingShowtime[];
  /** null means the file is a full snapshot of the schedule. */
  window: TimeWindow | null;
  /** Decisions from an earlier derivation, by action key. */
  decisions: ReadonlyMap<string, Decision>;
  /** Used when a row has no last_updated: the upload time. */
  defaultLastUpdated: string;
}

export interface PlanResult {
  actions: PlannedAction[];
  warnings: PlanWarning[];
  counts: ActionCounts;
  /** Possible moves that no resolution has decided yet: work for the agent. */
  rescheduleCandidates: RescheduleCandidate[];
  planHash: string;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const ACTION_ORDER: ActionType[] = [
  "add",
  "restore",
  "update",
  "reschedule",
  "archive",
  "duplicate",
  "unchanged",
];
const NEEDS_DECISION = new Set<ActionType>([
  "add",
  "restore",
  "update",
  "reschedule",
  "archive",
]);
const ARCHIVE_WARNING_RATIO = 0.5;

interface Incoming {
  row: ScopedRow;
  movie: RefResult;
  room: RefResult;
}

interface Draft {
  actionKey: string;
  action: ActionType;
  targetShowtimeId: string | null;
  sourceRows: number[];
  payload: ActionPayload;
  diffs: FieldChange[];
  explanation: string;
  resolutions: Resolution[];
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** SHA-256 over the sorted (key, action, payload, decision) list: what the admin approved. */
export function hashPlan(
  actions: Pick<PlannedAction, "actionKey" | "action" | "payload" | "decision">[],
): string {
  const lines = actions
    .map((a) => stableJson([a.actionKey, a.action, a.payload, a.decision]))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Import-level hash: the per-theater hashes in theater-id order. */
export function combineHashes(byTheater: Map<string, string>): string {
  const lines = [...byTheater.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, hash]) => `${id}:${hash}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function describeResolution(resolution: Resolution): string {
  switch (resolution.method) {
    case "agent":
      return `AI: ${resolution.explanation}`;
    case "fallback":
      return resolution.explanation;
    case "human":
      return `Your decision: ${resolution.explanation}`;
    case "alias":
      return resolution.explanation;
  }
}

function summarize(resolutions: Resolution[]): {
  confidence: Confidence;
  decidedBy: DecidedBy;
  needsReview: boolean;
} {
  let confidence: Confidence = "high";
  let decidedBy: DecidedBy = "rule";
  let needsReview = false;
  for (const r of resolutions) {
    if (CONFIDENCE_RANK[r.confidence] < CONFIDENCE_RANK[confidence]) {
      confidence = r.confidence;
    }
    if (r.method === "agent" || r.method === "fallback") decidedBy = "agent";
    else if (r.method === "human" && decidedBy === "rule") decidedBy = "human";
    // A human decision is final; anything the AI guessed at needs an explicit yes or no.
    if (r.method === "fallback" || (r.method === "agent" && r.confidence === "low")) {
      needsReview = true;
    }
  }
  return { confidence, decidedBy, needsReview };
}

/**
 * Actions are a pure function of (file rows, resolutions, current schedule). The model never
 * produces actions; it only supplies resolutions. Apply re-runs this inside its transaction.
 */
export function derivePlan(input: PlanInput): PlanResult {
  const { theater, resolver, window } = input;
  const tz = theater.timezone;
  const at = (iso: string) => formatLocal(iso, tz);

  const usedResolutions = (item: Incoming) =>
    [item.movie.resolution, item.room.resolution].filter(
      (r): r is Resolution => r !== null,
    );
  const payloadOf = (item: Incoming): ActionPayload => ({
    movieRef: item.movie.ref,
    movieTitle: item.movie.name,
    auditoriumRef: item.room.ref,
    auditoriumName: item.room.name,
    startTime: item.row.startTime,
    endTime: item.row.endTime,
    language: item.row.language,
    format: item.row.format,
    rating: item.row.rating,
    lastUpdated: item.row.lastUpdated ?? input.defaultLastUpdated,
    sourceTitle: item.row.title,
    sourceAuditorium: item.row.auditorium,
    resolutionKeys: usedResolutions(item).map((r) =>
      resolutionKey(r.kind, r.theaterId, r.subjectKey),
    ),
  });
  const existingPayload = (s: ExistingShowtime): ActionPayload => ({
    movieRef: s.movieId,
    movieTitle: resolver.movieName(s.movieId),
    auditoriumRef: s.auditoriumId,
    auditoriumName: resolver.roomName(theater.id, s.auditoriumId),
    startTime: s.startTime,
    endTime: s.endTime,
    language: s.language,
    format: s.format,
    rating: s.rating,
    lastUpdated: s.lastUpdated,
    sourceTitle: null,
    sourceAuditorium: null,
    resolutionKeys: [],
  });
  const fieldDiffs = (existing: ExistingShowtime, item: Incoming): FieldChange[] => {
    const diffs: FieldChange[] = [];
    if (existing.auditoriumId !== item.room.ref) {
      diffs.push({
        field: "auditorium",
        oldValue: resolver.roomName(theater.id, existing.auditoriumId),
        newValue: item.room.name,
      });
    }
    if (existing.endTime !== item.row.endTime) {
      diffs.push({ field: "endTime", oldValue: existing.endTime, newValue: item.row.endTime });
    }
    for (const field of ["language", "format", "rating"] as const) {
      if (existing[field] !== item.row[field]) {
        diffs.push({ field, oldValue: existing[field], newValue: item.row[field] });
      }
    }
    return diffs;
  };
  const describeDiffs = (diffs: FieldChange[]) =>
    diffs
      .map((d) =>
        d.field === "endTime" || d.field === "startTime"
          ? `${d.field === "endTime" ? "end time" : "start time"} ${at(d.oldValue)} → ${at(d.newValue)}`
          : `${d.field} ${d.oldValue || "(empty)"} → ${d.newValue || "(empty)"}`,
      )
      .join(", ");
  /** Tell the admin when a rule, not the AI, matched a different spelling. */
  const spellingNote = (item: Incoming) => {
    const notes: string[] = [];
    if (item.movie.via === "exact" && item.row.title !== item.movie.name) {
      notes.push(`"${item.row.title}" is "${item.movie.name}"`);
    }
    if (item.room.via === "exact" && item.row.auditorium !== item.room.name) {
      notes.push(`"${item.row.auditorium}" is "${item.room.name}"`);
    }
    return notes.length ? ` The file's spelling ${notes.join(" and ")}.` : "";
  };

  // 1. Resolve every row, then group by identity (movie, start time).
  const groups = new Map<string, Incoming[]>();
  for (const row of input.rows) {
    const item: Incoming = {
      row,
      movie: resolver.movie(row.title),
      room: resolver.auditorium(theater.id, row.auditorium),
    };
    const identity = `${item.movie.ref}|${row.startTime}`;
    const group = groups.get(identity);
    if (group) group.push(item);
    else groups.set(identity, [item]);
  }

  const drafts: Draft[] = [];
  const winners: Incoming[] = [];

  // 2. One winner per identity: newest last_updated, then the later row.
  for (const group of groups.values()) {
    const stamp = (item: Incoming) =>
      Date.parse(item.row.lastUpdated ?? input.defaultLastUpdated);
    const winner = group.reduce((best, item) =>
      stamp(item) > stamp(best) ||
      (stamp(item) === stamp(best) && item.row.rowNumber > best.row.rowNumber)
        ? item
        : best,
    );
    winners.push(winner);
    for (const item of group) {
      if (item === winner) continue;
      const exactCopy =
        item.room.ref === winner.room.ref &&
        item.row.endTime === winner.row.endTime &&
        item.row.language === winner.row.language &&
        item.row.format === winner.row.format &&
        item.row.rating === winner.row.rating;
      drafts.push({
        actionKey: `duplicate|row:${item.row.rowNumber}`,
        action: "duplicate",
        targetShowtimeId: null,
        sourceRows: [item.row.rowNumber],
        payload: {
          ...payloadOf(item),
          duplicateOfRow: winner.row.rowNumber,
          exactCopy,
        },
        diffs: [],
        explanation: exactCopy
          ? `Row ${item.row.rowNumber} is a copy of row ${winner.row.rowNumber}: same movie and start time, same details. Only one showtime is kept.`
          : `Row ${item.row.rowNumber} has the same movie and start time as row ${winner.row.rowNumber} but different details. Row ${winner.row.rowNumber} wins because it is newer or later in the file.`,
        resolutions: [...usedResolutions(item), ...usedResolutions(winner)],
      });
    }
  }

  // 3. Match winners against stored showtimes by (movie, start time), in any status.
  const existingByIdentity = new Map(
    input.schedule.map((s) => [`${s.movieId}|${s.startTime}`, s]),
  );
  const matched = new Set<string>();
  const addItems = new Map<string, Incoming>();

  for (const item of winners) {
    const existing = existingByIdentity.get(`${item.movie.ref}|${item.row.startTime}`);
    const base = {
      sourceRows: [item.row.rowNumber],
      payload: payloadOf(item),
      resolutions: usedResolutions(item),
    };
    if (!existing) {
      const key = `add|${theater.id}|${item.movie.ref}|${item.row.startTime}`;
      const notes: string[] = [];
      if (isNewRef(item.movie.ref)) {
        notes.push(`"${item.movie.name}" is not in the catalog and will be created.`);
      }
      if (isNewRef(item.room.ref)) {
        notes.push(`Room "${item.room.name}" is new for ${theater.name} and will be created.`);
      }
      drafts.push({
        ...base,
        actionKey: key,
        action: "add",
        targetShowtimeId: null,
        diffs: [],
        explanation:
          `New showtime: nothing is stored for this movie at this start time.${spellingNote(item)}` +
          (notes.length ? ` ${notes.join(" ")}` : ""),
      });
      addItems.set(key, item);
      continue;
    }
    matched.add(existing.id);
    const diffs = fieldDiffs(existing, item);
    if (existing.status === "archived") {
      drafts.push({
        ...base,
        actionKey: `restore|${existing.id}`,
        action: "restore",
        targetShowtimeId: existing.id,
        diffs,
        explanation:
          `This showtime was archived and is in the file again, so it is restored with its id and movie status.` +
          (diffs.length ? ` Changed: ${describeDiffs(diffs)}.` : "") +
          spellingNote(item),
      });
    } else if (diffs.length > 0) {
      const held = existing.status === "inactive";
      drafts.push({
        ...base,
        payload: { ...base.payload, ...(held ? { heldInactive: true } : {}) },
        actionKey: `update|${existing.id}`,
        action: "update",
        targetShowtimeId: existing.id,
        diffs,
        explanation:
          `Same movie and start time. Changed: ${describeDiffs(diffs)}.` +
          (held ? " It is on manual hold and stays inactive." : "") +
          spellingNote(item),
      });
    } else {
      drafts.push({
        ...base,
        actionKey: `unchanged|${existing.id}`,
        action: "unchanged",
        targetShowtimeId: existing.id,
        diffs: [],
        explanation: `Same movie and start time, no data changes.${spellingNote(item)}`,
      });
    }
  }

  // 4. Possible reschedules: a stored showtime with no row, and a new row, for the same
  //    movie on the same local day. Only a resolution ("moved") turns the pair into one action.
  const orphans = input.schedule.filter(
    (s) => s.status !== "archived" && !matched.has(s.id) && inWindow(s.startTime, window),
  );
  const pairs: { orphan: ExistingShowtime; key: string; item: Incoming; delta: number }[] = [];
  for (const [key, item] of addItems) {
    if (isNewRef(item.movie.ref)) continue;
    for (const orphan of orphans) {
      if (
        orphan.movieId === item.movie.ref &&
        localDay(orphan.startTime, tz) === localDay(item.row.startTime, tz)
      ) {
        pairs.push({
          orphan,
          key,
          item,
          delta: Math.abs(Date.parse(orphan.startTime) - Date.parse(item.row.startTime)),
        });
      }
    }
  }
  pairs.sort(
    (a, b) =>
      a.delta - b.delta ||
      a.orphan.id.localeCompare(b.orphan.id) ||
      a.key.localeCompare(b.key),
  );
  const pairedOrphans = new Set<string>();
  const pairedAdds = new Set<string>();
  const rescheduled = new Set<string>();
  const rescheduleCandidates: RescheduleCandidate[] = [];
  for (const { orphan, key, item } of pairs) {
    // Each stored showtime and each new row is offered in at most one pair.
    if (pairedOrphans.has(orphan.id) || pairedAdds.has(key)) continue;
    pairedOrphans.add(orphan.id);
    pairedAdds.add(key);
    const subjectKey = `${orphan.id}|${item.row.startTime}`;
    const resolution = resolver.reschedule(theater.id, subjectKey);
    if (!resolution) {
      rescheduleCandidates.push({
        theaterId: theater.id,
        subjectKey,
        showtimeId: orphan.id,
        movieId: orphan.movieId,
        movieTitle: resolver.movieName(orphan.movieId),
        oldStartTime: orphan.startTime,
        oldAuditorium: resolver.roomName(theater.id, orphan.auditoriumId),
        newStartTime: item.row.startTime,
        newAuditorium: item.room.name,
        rowNumber: item.row.rowNumber,
      });
    }
    if (resolution?.outcome.type !== "moved") continue;
    rescheduled.add(orphan.id);
    const index = drafts.findIndex((d) => d.actionKey === key);
    const add = drafts[index];
    if (!add) continue;
    const diffs: FieldChange[] = [
      { field: "startTime", oldValue: orphan.startTime, newValue: item.row.startTime },
      ...fieldDiffs(orphan, item),
    ];
    drafts[index] = {
      actionKey: `reschedule|${orphan.id}`,
      action: "reschedule",
      targetShowtimeId: orphan.id,
      sourceRows: add.sourceRows,
      payload: {
        ...add.payload,
        previousStartTime: orphan.startTime,
        resolutionKeys: [
          ...add.payload.resolutionKeys,
          resolutionKey("reschedule", theater.id, subjectKey),
        ],
        ...(orphan.status === "inactive" ? { heldInactive: true } : {}),
      },
      diffs,
      explanation: `The stored ${at(orphan.startTime)} showing moved to ${at(item.row.startTime)}. It keeps its id and movie status. Changed: ${describeDiffs(diffs)}.`,
      resolutions: [...add.resolutions, resolution],
    };
  }

  // 5. Everything live inside the window that no row matched is archived.
  for (const orphan of orphans) {
    if (rescheduled.has(orphan.id)) continue;
    drafts.push({
      actionKey: `archive|${orphan.id}`,
      action: "archive",
      targetShowtimeId: orphan.id,
      sourceRows: [],
      payload: existingPayload(orphan),
      diffs: [],
      explanation: window
        ? "On a date this file covers, but missing from the file."
        : "Missing from the file, which is treated as the full schedule.",
      resolutions: [],
    });
  }

  drafts.sort(
    (a, b) =>
      ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) ||
      a.payload.startTime.localeCompare(b.payload.startTime) ||
      a.actionKey.localeCompare(b.actionKey),
  );

  const counts = emptyCounts();
  const actions = drafts.map((draft, seq): PlannedAction => {
    const unique = [
      ...new Map(
        draft.resolutions.map((r) => [
          resolutionKey(r.kind, r.theaterId, r.subjectKey),
          r,
        ]),
      ).values(),
    ];
    const { confidence, decidedBy, needsReview } = summarize(unique);
    const notes = unique.map(describeResolution);
    let decision: Decision = "accepted";
    if (NEEDS_DECISION.has(draft.action)) {
      const previous = input.decisions.get(draft.actionKey);
      decision =
        previous && previous !== "pending"
          ? previous
          : needsReview
            ? "pending"
            : "accepted";
      if (decision === "pending") counts.pending += 1;
    }
    counts[draft.action] += 1;
    return {
      actionKey: draft.actionKey,
      theaterId: theater.id,
      seq,
      action: draft.action,
      targetShowtimeId: draft.targetShowtimeId,
      sourceRows: draft.sourceRows,
      payload: draft.payload,
      diffs: draft.diffs,
      explanation: [draft.explanation, ...notes].join(" "),
      confidence,
      decidedBy,
      decision,
    };
  });

  return {
    actions,
    warnings: buildWarnings(input, actions, orphans.length + matchedLive(input, matched)),
    counts,
    rescheduleCandidates,
    planHash: hashPlan(actions),
  };
}

/** Live (not archived) stored showtimes that a row matched. */
function matchedLive(input: PlanInput, matched: Set<string>): number {
  return input.schedule.filter((s) => matched.has(s.id) && s.status !== "archived")
    .length;
}

function buildWarnings(
  input: PlanInput,
  actions: PlannedAction[],
  liveInWindow: number,
): PlanWarning[] {
  const { theater, window } = input;
  const warnings: PlanWarning[] = [];
  const at = (iso: string) => formatLocal(iso, theater.timezone);

  const archives = actions.filter((a) => a.action === "archive").length;
  if (archives > 0 && archives / liveInWindow > ARCHIVE_WARNING_RATIO) {
    warnings.push({
      code: "mass_archive",
      theaterId: theater.id,
      message: `This file would archive ${archives} of ${liveInWindow} live showtimes at ${theater.name} ${window ? "on the dates it covers" : "across the whole schedule"}. Confirm that the file is complete before applying.`,
      requiresAck: true,
    });
  }

  const newMovies = new Map<string, string>();
  const newRooms = new Map<string, string>();
  for (const action of actions) {
    if (!["add", "restore", "update", "reschedule"].includes(action.action)) continue;
    if (isNewRef(action.payload.movieRef)) {
      newMovies.set(action.payload.movieRef, action.payload.movieTitle);
    }
    if (isNewRef(action.payload.auditoriumRef)) {
      newRooms.set(action.payload.auditoriumRef, action.payload.auditoriumName);
    }
  }
  const quoted = (names: Iterable<string>) =>
    [...names].map((name) => `"${name}"`).join(", ");
  if (newMovies.size > 0) {
    warnings.push({
      code: "new_movie",
      theaterId: theater.id,
      message: `${newMovies.size === 1 ? "A new movie" : `${newMovies.size} new movies`} would be added to the catalog: ${quoted(newMovies.values())}.`,
      requiresAck: false,
    });
  }
  if (newRooms.size > 0) {
    warnings.push({
      code: "new_auditorium",
      theaterId: theater.id,
      message: `${newRooms.size === 1 ? "A new room" : `${newRooms.size} new rooms`} would be created at ${theater.name}: ${quoted(newRooms.values())}.`,
      requiresAck: false,
    });
  }

  // Overlaps in the schedule as it would be after this plan. Reported, never blocking.
  const replaced = new Map<string, PlannedAction>();
  for (const action of actions) {
    if (action.targetShowtimeId) replaced.set(action.targetShowtimeId, action);
  }
  const live: { room: string; roomName: string; title: string; start: string; end: string }[] = [];
  const pushPayload = (p: ActionPayload) =>
    live.push({
      room: p.auditoriumRef,
      roomName: p.auditoriumName,
      title: p.movieTitle,
      start: p.startTime,
      end: p.endTime,
    });
  for (const showtime of input.schedule) {
    const action = replaced.get(showtime.id);
    if (action?.action === "archive") continue;
    if (action && action.action !== "unchanged") {
      if (!action.payload.heldInactive) pushPayload(action.payload);
    } else if (showtime.status === "active") {
      live.push({
        room: showtime.auditoriumId,
        roomName: input.resolver.roomName(theater.id, showtime.auditoriumId),
        title: input.resolver.movieName(showtime.movieId),
        start: showtime.startTime,
        end: showtime.endTime,
      });
    }
  }
  for (const action of actions) {
    if (action.action === "add") pushPayload(action.payload);
  }
  live.sort((a, b) => a.room.localeCompare(b.room) || a.start.localeCompare(b.start));
  const overlaps: string[] = [];
  let previous: (typeof live)[number] | undefined;
  for (const current of live) {
    if (previous && previous.room === current.room && previous.end > current.start) {
      overlaps.push(
        `${current.roomName}: "${previous.title}" ends ${at(previous.end)}, "${current.title}" starts ${at(current.start)}`,
      );
    }
    if (!previous || previous.room !== current.room || current.end > previous.end) {
      previous = current;
    }
  }
  if (overlaps.length > 0) {
    const shown = overlaps.slice(0, 3).join("; ");
    warnings.push({
      code: "overlap",
      theaterId: theater.id,
      message: `${overlaps.length === 1 ? "Two showtimes overlap" : `${overlaps.length} pairs of showtimes overlap`} in the same room after this import. ${shown}${overlaps.length > 3 ? `; and ${overlaps.length - 3} more` : ""}.`,
      requiresAck: false,
    });
  }
  return warnings;
}

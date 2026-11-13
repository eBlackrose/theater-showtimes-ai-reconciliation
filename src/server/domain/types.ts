/**
 * Domain types for CSV reconciliation. Everything in src/server/domain is pure:
 * no database, no network, no clock. That is what lets apply re-derive the plan safely.
 */
import type { MovieStatus, ShowtimeStatus } from "~/types/assessment";

export type Confidence = "high" | "medium" | "low";
export type ActionType =
  | "add"
  | "restore"
  | "update"
  | "reschedule"
  | "archive"
  | "unchanged"
  | "duplicate";
export type Decision = "pending" | "accepted" | "rejected";
export type DecidedBy = "rule" | "agent" | "human";
export type ResolutionKind = "movie" | "auditorium" | "reschedule";
export type ResolutionMethod = "alias" | "agent" | "human" | "fallback";
export type ArchiveScope = "file_window" | "full_schedule";

export type Outcome =
  | { type: "existing"; id: string }
  | { type: "new"; name: string }
  | { type: "moved" }
  | { type: "separate" };

export interface ParsedRow {
  /** Line number in the uploaded file. The header is row 1. */
  rowNumber: number;
  theaterName: string;
  title: string;
  auditorium: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  rating: string;
  lastUpdated: string | null;
}

export interface CsvIssue {
  row: number;
  field: string | null;
  message: string;
}

export type Disposition =
  | "in_scope"
  | "skipped_out_of_scope"
  | "skipped_no_access"
  | "skipped_unknown_theater";

export interface ScopedRow extends ParsedRow {
  disposition: Disposition;
  theaterId: string | null;
  note: string | null;
}

export interface TheaterInfo {
  id: string;
  name: string;
  normalizedName: string;
  timezone: string;
}

export interface Candidate {
  id: string;
  name: string;
  score?: number;
  aliases?: string[];
}

export interface Resolution {
  kind: ResolutionKind;
  /** null for movies: the catalog is shared by all theaters. */
  theaterId: string | null;
  subjectKey: string;
  subjectRaw: string;
  rowNumbers: number[];
  outcome: Outcome;
  method: ResolutionMethod;
  confidence: Confidence;
  explanation: string;
  candidates: Candidate[];
}

export const resolutionKey = (
  kind: ResolutionKind,
  theaterId: string | null,
  subjectKey: string,
) => `${kind}|${theaterId ?? ""}|${subjectKey}`;

export interface TheaterRooms {
  /** id -> canonical name */
  byId: Map<string, string>;
  /** normalized canonical name -> id */
  byKey: Map<string, string>;
  /** normalized saved alias -> id */
  aliasByKey: Map<string, string>;
}

/** The slice of the catalog needed to resolve one file. */
export interface CatalogSnapshot {
  /** id -> canonical title */
  movieTitles: Map<string, string>;
  /** normalized canonical title -> id */
  movieByKey: Map<string, string>;
  /** normalized saved alias -> id */
  movieAliasByKey: Map<string, string>;
  /** theater id -> its rooms */
  rooms: Map<string, TheaterRooms>;
}

export interface ExistingShowtime {
  id: string;
  movieId: string;
  auditoriumId: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  rating: string;
  status: ShowtimeStatus;
  movieStatus: MovieStatus;
  lastUpdated: string;
}

export interface TimeWindow {
  start: string;
  end: string;
}

export interface FieldChange {
  field: string;
  oldValue: string;
  newValue: string;
}

export interface ActionPayload {
  /** An existing id, or `new:<normalized key>` for something apply will create. */
  movieRef: string;
  movieTitle: string;
  auditoriumRef: string;
  auditoriumName: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  rating: string;
  lastUpdated: string;
  sourceTitle: string | null;
  sourceAuditorium: string | null;
  /** Keys of the resolutions this action depends on (see resolutionKey). */
  resolutionKeys: string[];
  previousStartTime?: string;
  duplicateOfRow?: number;
  exactCopy?: boolean;
  heldInactive?: boolean;
}

export interface PlannedAction {
  /** Stable across re-derivation, so decisions survive a re-plan. */
  actionKey: string;
  theaterId: string;
  seq: number;
  action: ActionType;
  targetShowtimeId: string | null;
  sourceRows: number[];
  payload: ActionPayload;
  diffs: FieldChange[];
  explanation: string;
  confidence: Confidence;
  decidedBy: DecidedBy;
  decision: Decision;
}

export interface PlanWarning {
  code:
    | "mass_archive"
    | "new_movie"
    | "new_auditorium"
    | "overlap"
    | "agent_incomplete";
  theaterId: string | null;
  message: string;
  requiresAck: boolean;
}

export interface RescheduleCandidate {
  theaterId: string;
  subjectKey: string;
  showtimeId: string;
  movieId: string;
  movieTitle: string;
  oldStartTime: string;
  oldAuditorium: string;
  newStartTime: string;
  newAuditorium: string;
  rowNumber: number;
}

export type ActionCounts = Record<ActionType, number> & { pending: number };

export const emptyCounts = (): ActionCounts => ({
  add: 0,
  restore: 0,
  update: 0,
  reschedule: 0,
  archive: 0,
  unchanged: 0,
  duplicate: 0,
  pending: 0,
});

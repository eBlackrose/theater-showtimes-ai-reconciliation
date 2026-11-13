/** Shapes of the JSON the API returns. Shared by route handlers and the browser client. */
import type { AssessmentUser, Showtime, Theater } from "./assessment";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface HealthResponse {
  ok: boolean;
  db: { ok: boolean; schema: string; migration: string | null };
  llm: { configured: boolean; model: string };
  demoReset: boolean;
  commit: string | null;
}

export interface MeResponse {
  user: AssessmentUser;
  theaters: Theater[];
}

export interface ShowtimeListResponse {
  items: Showtime[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FilterOptions {
  formats: string[];
  languages: string[];
  ratings: string[];
  auditoriums: string[];
  movieStatuses: string[];
}

export type ImportStatus =
  | "uploaded"
  | "analyzing"
  | "ready"
  | "applying"
  | "applied"
  | "partially_applied"
  | "discarded"
  | "failed";
export type ImportMode = "ai" | "rules_only";
export type ArchiveScope = "file_window" | "full_schedule";
export type Confidence = "high" | "medium" | "low";
export type PlanActionType =
  | "add"
  | "restore"
  | "update"
  | "reschedule"
  | "archive"
  | "unchanged"
  | "duplicate";
export type ActionDecision = "pending" | "accepted" | "rejected";

export interface CsvRowError {
  row: number;
  field: string | null;
  message: string;
}

export interface SkippedCounts {
  outOfScope: number;
  noAccess: number;
  unknownTheater: number;
}

export interface ImportCreatedResponse {
  importId: string;
  rowCount: number;
  skipped: SkippedCounts;
}

export interface ImportEvent {
  id: number;
  /** stage | llm_turn | tool_call | resolution | note | warning | error */
  type: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ImportEventsResponse {
  status: ImportStatus;
  events: ImportEvent[];
}

export interface ImportCounts {
  add: number;
  restore: number;
  update: number;
  reschedule: number;
  archive: number;
  unchanged: number;
  duplicate: number;
  pending: number;
  skippedRows: number;
}

export interface AgentUsage {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Subjects the agent was asked to resolve, and how many it resolved itself. */
  subjects: number;
  resolvedByAgent: number;
  stopReason: string | null;
}

export interface PlanWarning {
  code: string;
  theaterId: string | null;
  message: string;
  requiresAck: boolean;
}

export interface PlanAction {
  actionKey: string;
  theaterId: string;
  action: PlanActionType;
  targetShowtimeId: string | null;
  sourceRows: number[];
  movieTitle: string;
  auditorium: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  rating: string;
  /** Spellings as they appeared in the file, when a file row is behind this action. */
  sourceTitle: string | null;
  sourceAuditorium: string | null;
  diffs: { field: string; oldValue: string; newValue: string }[];
  explanation: string;
  confidence: Confidence;
  /** Where the match came from: a rule, a saved alias, the AI, or a human override. */
  source: "rule" | "alias" | "ai" | "human";
  decision: ActionDecision;
  result: "applied" | "skipped" | "conflict" | "failed" | null;
  resultDetail: string | null;
}

export interface PlanActionGroup {
  action: PlanActionType;
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  /** First page only. Fetch more from /api/imports/:id/actions. */
  items: PlanAction[];
}

export interface PlanTheaterSection {
  theaterId: string;
  theaterName: string;
  timezone: string;
  status: "ready" | "applied" | "conflict" | "failed";
  windowStart: string | null;
  windowEnd: string | null;
  error: string | null;
  groups: PlanActionGroup[];
}

export interface PlanCandidate {
  id: string;
  name: string;
  score?: number;
  aliases?: string[];
}

export interface PlanResolution {
  id: string;
  kind: "movie" | "auditorium" | "reschedule";
  theaterId: string | null;
  subjectRaw: string;
  rowNumbers: number[];
  outcome: "existing" | "new" | "moved" | "separate";
  /** Canonical name of the matched or new movie or room. Empty for reschedules. */
  targetId: string | null;
  targetName: string;
  method: "alias" | "agent" | "human" | "fallback";
  confidence: Confidence;
  explanation: string;
  candidates: PlanCandidate[];
}

export interface SkippedRowGroup {
  reason: "skipped_out_of_scope" | "skipped_no_access" | "skipped_unknown_theater";
  theaterName: string;
  note: string;
  rowNumbers: number[];
}

export interface ImportListItem {
  id: string;
  filename: string;
  status: ImportStatus;
  mode: ImportMode | null;
  model: string | null;
  rowCount: number;
  createdAt: string;
  createdBy: string;
  appliedAt: string | null;
  theaters: string[];
  counts: ImportCounts;
}

export interface ImportDetail extends ImportListItem {
  scopeTheaterId: string | null;
  archiveScope: ArchiveScope;
  agentSummary: string | null;
  /** Why the import ran without the model, when it did. */
  aiNotice: string | null;
  usage: AgentUsage | null;
  error: string | null;
  planHash: string | null;
  warnings: PlanWarning[];
  theaterSections: PlanTheaterSection[];
  resolutions: PlanResolution[];
  skipped: SkippedRowGroup[];
}

export interface ActionPageResponse {
  items: PlanAction[];
  total: number;
}

export interface DecisionsResponse {
  planHash: string;
  counts: ImportCounts;
}

export interface ApplyTheaterResult {
  theaterId: string;
  theaterName: string;
  status: "applied" | "conflict" | "failed";
  applied: Partial<Record<PlanActionType, number>>;
  skipped: number;
  message: string | null;
}

export interface ApplyResponse {
  status: ImportStatus;
  theaters: ApplyTheaterResult[];
}

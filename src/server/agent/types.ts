import type { Candidate, Confidence } from "~/server/domain/types";

/** One thing the agent must decide. The worklist is rebuilt after every submission. */
export type WorkItem =
  | {
      kind: "movie";
      theaterId: null;
      subjectKey: string;
      spellings: string[];
      rowNumbers: number[];
      examples: { theater: string; startTime: string; auditorium: string }[];
      candidates: Candidate[];
    }
  | {
      kind: "auditorium";
      theaterId: string;
      theaterName: string;
      subjectKey: string;
      spellings: string[];
      rowNumbers: number[];
      rooms: { id: string; name: string; aliases: string[] }[];
    }
  | {
      kind: "reschedule";
      theaterId: string;
      theaterName: string;
      subjectKey: string;
      movieTitle: string;
      storedShowtime: { startTime: string; auditorium: string };
      fileRow: { rowNumber: number; startTime: string; auditorium: string };
    };

export interface SubmittedResolution {
  kind: "movie" | "auditorium" | "reschedule";
  subjectKey: string;
  theaterId: string | null;
  decision: "existing" | "new" | "moved" | "separate";
  targetId: string | null;
  canonicalName: string | null;
  confidence: Confidence;
  explanation: string;
}

export interface SubmitResult {
  kind: string;
  subjectKey: string;
  status: "accepted" | "rejected";
  reason?: string;
  /** Plain-language line for the activity feed. */
  summary: string;
}

/** What the loop needs from the import being analyzed. Implemented in imports/analysis.ts. */
export interface AgentSession {
  theaters: { id: string; name: string; timezone: string }[];
  remaining(): WorkItem[];
  submit(items: SubmittedResolution[]): Promise<SubmitResult[]>;
  /** File rows relevant to the worklist, for the first message. */
  fileRows(): Record<string, unknown>[];
}

export interface MovieSearchHit {
  id: string;
  title: string;
  aliases: string[];
  score: number;
  showingAt: string[];
}

export interface TheaterContext {
  id: string;
  name: string;
  timezone: string;
  rooms: { id: string; name: string; aliases: string[] }[];
  liveShowtimes: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface ScheduleRow {
  id: string;
  movieId: string;
  movieTitle: string;
  auditorium: string;
  /** Theater-local time, e.g. "2025-03-15 18:00". */
  start: string;
  end: string;
  format: string;
  language: string;
  rating: string;
  status: string;
}

/** Read-only lookups behind the agent's tools. Database-backed in the app, faked in tests. */
export interface AgentBackend {
  searchMovies(query: string, limit: number): Promise<MovieSearchHit[]>;
  theaterContext(theaterId: string): Promise<TheaterContext | null>;
  schedule(input: {
    theaterId: string;
    fromDate: string;
    toDate: string;
    movieId: string | null;
  }): Promise<{ rows: ScheduleRow[]; truncated: boolean }>;
}

export interface AgentEvent {
  type: "llm_turn" | "tool_call" | "resolution" | "note" | "warning" | "error";
  message: string;
  data?: Record<string, unknown>;
}
export type Emit = (event: AgentEvent) => Promise<void>;

export interface AgentUsageTotals {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  stopReason: string | null;
}

export interface AgentOutcome {
  /** True when the worklist was empty at the end. */
  complete: boolean;
  summary: string | null;
  usage: AgentUsageTotals;
}

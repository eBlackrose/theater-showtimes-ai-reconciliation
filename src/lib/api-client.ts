import type {
  ActionPageResponse,
  ApiErrorBody,
  ApplyResponse,
  ArchiveScope,
  CsvRowError,
  DecisionsResponse,
  FilterOptions,
  HealthResponse,
  ImportCreatedResponse,
  ImportDetail,
  ImportEventsResponse,
  ImportListItem,
  MeResponse,
  PlanActionType,
  PlanResolution,
  ShowtimeListResponse,
} from "~/types/api";
import type { AssessmentUser, MovieStatus, Showtime, ShowtimeStatus } from "~/types/assessment";

/** A non-2xx answer from the API, carrying the server's own code and sentence. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** A sentence that is safe to show: the server's message, or a network fallback. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiClientError
    ? error.message
    : "Could not reach the server. Check your connection and try again.";
}

/** The per-row problems of a rejected CSV, when that is what the error is. */
export function csvRowErrors(error: unknown): CsvRowError[] {
  if (!(error instanceof ApiClientError) || error.code !== "invalid_csv") return [];
  const errors = (error.details as { errors?: CsvRowError[] } | undefined)?.errors;
  return Array.isArray(errors) ? errors : [];
}

type Query = Record<string, string | number | undefined>;

function withQuery(path: string, query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

async function request<T>(
  userId: string | null,
  path: string,
  init: { method?: string; json?: unknown; form?: FormData } = {},
): Promise<T> {
  const headers = new Headers();
  if (userId) headers.set("X-User-Id", userId);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
    cache: "no-store",
  });
  // A proxy timeout or crash page is not JSON; it still has to become a readable error.
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as Partial<ApiErrorBody> | null)?.error;
    throw new ApiClientError(
      response.status,
      error?.code ?? "http_error",
      error?.message ?? `The server returned an unexpected response (${response.status}).`,
      error?.details,
    );
  }
  return payload as T;
}

export type ShowtimeListParams = {
  theaterId?: string;
  q?: string;
  status?: string;
  format?: string;
  language?: string;
  rating?: string;
  auditorium?: string;
  movieStatus?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: string;
  sortOrder?: string;
  page?: number;
  pageSize?: number;
};

export type DecisionsRequest =
  | { decisions: { actionKey: string; decision: "accepted" | "rejected" }[] }
  | { bulk: { theaterId: string; action: PlanActionType; decision: "accepted" | "rejected" } };

export const fetchUsers = () =>
  request<{ users: AssessmentUser[] }>(null, "/api/users").then((body) => body.users);

export const fetchHealth = () => request<HealthResponse>(null, "/api/health");

/** Every call the console makes, bound to the user chosen in the session selector. */
export function createApiClient(userId: string) {
  const call = <T>(path: string, init?: Parameters<typeof request>[2]) =>
    request<T>(userId, path, init);
  const imp = (id: string, rest = "") => `/api/imports/${encodeURIComponent(id)}${rest}`;

  return {
    me: () => call<MeResponse>("/api/me"),
    listShowtimes: (params: ShowtimeListParams) =>
      call<ShowtimeListResponse>(withQuery("/api/showtimes", params)),
    filterOptions: (theaterId?: string) =>
      call<FilterOptions>(withQuery("/api/showtimes/filter-options", { theaterId })),
    updateShowtime: (id: string, patch: { movieStatus?: MovieStatus; status?: ShowtimeStatus }) =>
      call<Showtime>(`/api/showtimes/${encodeURIComponent(id)}`, { method: "PATCH", json: patch }),
    clearSchedule: (theaterId: string) =>
      call<{ archived: number }>(`/api/theaters/${encodeURIComponent(theaterId)}/clear`, {
        method: "POST",
      }),
    resetDemo: () => call<{ ok: boolean }>("/api/admin/reset-demo", { method: "POST" }),

    listImports: () => call<{ items: ImportListItem[] }>("/api/imports").then((b) => b.items),
    createImport: (file: File, scopeTheaterId: string | null) => {
      const form = new FormData();
      form.set("file", file);
      if (scopeTheaterId) form.set("scopeTheaterId", scopeTheaterId);
      return call<ImportCreatedResponse>("/api/imports", { method: "POST", form });
    },
    analyzeImport: (id: string) =>
      call<{ status: "ready" }>(imp(id, "/analyze"), { method: "POST" }),
    importEvents: (id: string, after: number) =>
      call<ImportEventsResponse>(withQuery(imp(id, "/events"), { after })),
    getImport: (id: string) => call<ImportDetail>(imp(id)),
    importActions: (
      id: string,
      query: { theaterId: string; action: PlanActionType; offset: number; limit: number },
    ) => call<ActionPageResponse>(withQuery(imp(id, "/actions"), query)),
    setDecisions: (id: string, body: DecisionsRequest) =>
      call<DecisionsResponse>(imp(id, "/decisions"), { method: "PATCH", json: body }),
    overrideResolution: (
      id: string,
      resolutionId: string,
      body: { outcome: PlanResolution["outcome"]; targetId?: string },
    ) =>
      call<ImportDetail>(imp(id, `/resolutions/${encodeURIComponent(resolutionId)}`), {
        method: "PATCH",
        json: body,
      }),
    setArchiveScope: (id: string, archiveScope: ArchiveScope) =>
      call<ImportDetail>(imp(id), { method: "PATCH", json: { archiveScope } }),
    applyImport: (id: string, body: { planHash: string; acknowledgeWarnings?: boolean }) =>
      call<ApplyResponse>(imp(id, "/apply"), { method: "POST", json: body }),
    discardImport: (id: string) =>
      call<{ status: string }>(imp(id, "/discard"), { method: "POST" }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

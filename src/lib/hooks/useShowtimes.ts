import { useCallback, useEffect, useState } from "react";
import { errorMessage, type ApiClient } from "~/lib/api-client";
import { useDebounce } from "~/lib/hooks/useDebounce";
import type { FilterOptions, ShowtimeListResponse } from "~/types/api";
import type { MovieStatus, Showtime, ShowtimeStatus } from "~/types/assessment";

export type SortField =
  | "movieTitle"
  | "startTime"
  | "endTime"
  | "lastUpdated"
  | "theaterName"
  | "movieStatus";

export interface ShowtimeFilters {
  status: ShowtimeStatus | "all";
  format: string;
  language: string;
  rating: string;
  auditorium: string;
  movieStatus: string;
  startDate: string;
  endDate: string;
}

export const emptyFilters: ShowtimeFilters = {
  status: "all",
  format: "",
  language: "",
  rating: "",
  auditorium: "",
  movieStatus: "",
  startDate: "",
  endDate: "",
};

export interface TableQuery {
  /** A theater id, or "all" for every theater the user can see. */
  theaterId: string;
  filters: ShowtimeFilters;
  sortBy: SortField;
  sortOrder: "asc" | "desc";
  page: number;
  pageSize: number;
}

const initialQuery: TableQuery = {
  theaterId: "all",
  filters: emptyFilters,
  sortBy: "startTime",
  sortOrder: "asc",
  page: 1,
  pageSize: 50,
};

const noOptions: FilterOptions = {
  formats: [],
  languages: [],
  ratings: [],
  auditoriums: [],
  movieStatuses: [],
};

/** The showtimes table's state. Search, sort, filters and paging all happen on the server. */
export function useShowtimes(api: ApiClient) {
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearchText] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [reloadKey, setReloadKey] = useState(0);
  const [list, setList] = useState<ShowtimeListResponse | null>(null);
  const [options, setOptions] = useState(noOptions);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const theaterId = query.theaterId === "all" ? undefined : query.theaterId;

  useEffect(() => {
    // Only the newest request may write state; an older, slower answer is dropped.
    let cancelled = false;
    setLoading(true);
    const { status, ...filters } = query.filters;
    api
      .listShowtimes({
        ...filters,
        theaterId,
        q: debouncedSearch.trim(),
        status: status === "all" ? undefined : status,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        page: query.page,
        pageSize: query.pageSize,
      })
      .then(
        (response) => {
          if (cancelled) return;
          setList(response);
          setError(null);
          setLoading(false);
        },
        (cause: unknown) => {
          if (cancelled) return;
          setError(errorMessage(cause));
          setLoading(false);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [api, query, theaterId, debouncedSearch, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    api.filterOptions(theaterId).then(
      (response) => {
        if (!cancelled) setOptions(response);
      },
      () => {
        // The filters are a convenience; the table reports the real error if the API is down.
        if (!cancelled) setOptions(noOptions);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, theaterId, reloadKey]);

  /** Change part of the query. Anything but a page change goes back to the first page. */
  const update = useCallback((change: Partial<TableQuery>) => {
    setQuery((current) => ({ ...current, page: 1, ...change }));
  }, []);

  const setSearch = useCallback((text: string) => {
    setSearchText(text);
    setQuery((current) => (current.page === 1 ? current : { ...current, page: 1 }));
  }, []);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  /** Optimistic inline edit: the row changes at once and is put back if the server refuses. */
  const edit = useCallback(
    async (showtime: Showtime, patch: { movieStatus?: MovieStatus; status?: ShowtimeStatus }) => {
      const replace = (next: Showtime) =>
        setList(
          (current) =>
            current && {
              ...current,
              items: current.items.map((item) => (item.id === next.id ? next : item)),
            },
        );
      replace({ ...showtime, ...patch });
      setEditError(null);
      try {
        replace(await api.updateShowtime(showtime.id, patch));
      } catch (cause) {
        replace(showtime);
        setEditError(
          `"${showtime.movieTitle}" was not changed. ${errorMessage(cause)}`,
        );
      }
    },
    [api],
  );

  return {
    query,
    search,
    list,
    options,
    loading,
    error,
    editError,
    update,
    setSearch,
    reload,
    edit,
    dismissEditError: useCallback(() => setEditError(null), []),
  };
}

export type ShowtimesTableState = ReturnType<typeof useShowtimes>;

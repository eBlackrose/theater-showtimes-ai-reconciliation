"use client";

import { formatDateTime, zoneLabel } from "~/lib/format";
import type { ShowtimesTableState, SortField } from "~/lib/hooks/useShowtimes";
import type { MovieStatus, ShowtimeStatus, Theater } from "~/types/assessment";
import { Banner, secondaryButton, selectInput } from "./ui";

const MOVIE_STATUSES: MovieStatus[] = ["approved", "draft", "flagged", "needs-review"];
const SHOWTIME_STATUSES: ShowtimeStatus[] = ["active", "inactive", "archived"];
const PAGE_SIZES = [25, 50, 100];

const STATUS_CHIP: Record<ShowtimeStatus, string> = {
  active: "bg-green-900 text-green-300",
  inactive: "bg-amber-900 text-amber-300",
  archived: "bg-gray-700 text-gray-400",
};

interface ShowtimesTableProps {
  table: ShowtimesTableState;
  theaters: Theater[];
  isAdmin: boolean;
}

export function ShowtimesTable({ table, theaters, isAdmin }: ShowtimesTableProps) {
  const { query, list, loading, error } = table;
  const showTheaterColumn = query.theaterId === "all";
  const theatersById = new Map(theaters.map((theater) => [theater.id, theater]));
  const scopedTheater = theatersById.get(query.theaterId);
  const items = list?.items ?? [];
  const total = list?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
  const firstRow = total === 0 ? 0 : (query.page - 1) * query.pageSize + 1;
  const lastRow = Math.min(total, query.page * query.pageSize);

  const sortBy = (field: SortField) =>
    table.update({
      sortBy: field,
      sortOrder: query.sortBy === field && query.sortOrder === "asc" ? "desc" : "asc",
    });

  const sortableHeader = (field: SortField, label: string) => {
    const active = query.sortBy === field;
    return (
      <th
        className="px-4 py-3"
        aria-sort={active ? (query.sortOrder === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          onClick={() => sortBy(field)}
          className="flex items-center whitespace-nowrap uppercase hover:text-white"
        >
          {label}
          <span className={`ml-1 ${active ? "" : "text-gray-500"}`}>
            {active ? (query.sortOrder === "asc" ? "↑" : "↓") : "↕"}
          </span>
        </button>
      </th>
    );
  };

  // With every theater in view each time carries its own zone; one theater names it once below.
  const time = (value: string, theaterId: string) =>
    formatDateTime(value, theatersById.get(theaterId)?.timezone, showTheaterColumn);
  const inlineSelect =
    "rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500";
  const columnCount = 10 + (showTheaterColumn ? 1 : 0);

  return (
    <div className="w-full">
      <div className="mb-4">
        <input
          type="search"
          aria-label="Search by movie title"
          placeholder="Search by movie title..."
          value={table.search}
          onChange={(e) => table.setSearch(e.target.value)}
          className="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-white placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
      </div>

      {table.editError && (
        <div className="mb-4">
          <Banner tone="error" onDismiss={table.dismissEditError}>
            {table.editError}
          </Banner>
        </div>
      )}

      {error && (
        <div className="mb-4">
          <Banner tone="error">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>Showtimes could not be loaded. {error}</span>
              <button type="button" onClick={table.reload} className={secondaryButton}>
                Try again
              </button>
            </div>
          </Banner>
        </div>
      )}

      <div
        className={`overflow-x-auto rounded-lg border border-gray-700 transition-opacity ${
          loading && list ? "opacity-60" : ""
        }`}
        aria-busy={loading}
      >
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-800 text-xs uppercase text-gray-400">
            <tr>
              {showTheaterColumn && sortableHeader("theaterName", "Theater")}
              {sortableHeader("movieTitle", "Movie Title")}
              {sortableHeader("movieStatus", "Movie Status")}
              <th className="px-4 py-3">Auditorium</th>
              {sortableHeader("startTime", "Start Time")}
              {sortableHeader("endTime", "End Time")}
              <th className="px-4 py-3">Language</th>
              <th className="px-4 py-3">Format</th>
              <th className="px-4 py-3">Rating</th>
              <th className="px-4 py-3">Status</th>
              {sortableHeader("lastUpdated", "Last Updated")}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-4 py-8 text-center text-gray-400">
                  {loading
                    ? "Loading showtimes..."
                    : error
                      ? "No showtimes to show."
                      : "No showtimes found"}
                </td>
              </tr>
            ) : (
              items.map((showtime) => (
                <tr
                  key={showtime.id}
                  className={`border-b border-gray-700 hover:bg-gray-800 ${
                    showtime.status === "archived" ? "opacity-50" : ""
                  }`}
                >
                  {showTheaterColumn && (
                    <td className="px-4 py-3 text-gray-300">
                      {theatersById.get(showtime.theaterId)?.name ?? "Unknown"}
                    </td>
                  )}
                  <td className="px-4 py-3 font-medium text-white">{showtime.movieTitle}</td>
                  <td className="px-4 py-3 text-gray-300">
                    {isAdmin ? (
                      <select
                        aria-label={`Movie status of ${showtime.movieTitle}`}
                        value={showtime.movieStatus}
                        onChange={(e) =>
                          void table.edit(showtime, {
                            movieStatus: e.target.value as MovieStatus,
                          })
                        }
                        className={inlineSelect}
                      >
                        {MOVIE_STATUSES.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="rounded-full bg-gray-700 px-2 py-1 text-xs text-gray-200">
                        {showtime.movieStatus}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-300">{showtime.auditorium}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-300">
                    {time(showtime.startTime, showtime.theaterId)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-300">
                    {time(showtime.endTime, showtime.theaterId)}
                  </td>
                  <td className="px-4 py-3 text-gray-300">{showtime.language}</td>
                  <td className="px-4 py-3 text-gray-300">{showtime.format}</td>
                  <td className="px-4 py-3 text-gray-300">{showtime.rating}</td>
                  <td className="px-4 py-3">
                    {isAdmin ? (
                      <select
                        aria-label={`Status of ${showtime.movieTitle}`}
                        value={showtime.status}
                        onChange={(e) =>
                          void table.edit(showtime, { status: e.target.value as ShowtimeStatus })
                        }
                        className={inlineSelect}
                      >
                        {SHOWTIME_STATUSES.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_CHIP[showtime.status]}`}
                      >
                        {showtime.status}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-300">
                    {time(showtime.lastUpdated, showtime.theaterId)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-400">
        <div>
          {total > 0 ? `Showing ${firstRow}–${lastRow} of ${total} showtimes` : "0 showtimes"}
          {loading && list ? " · Updating..." : ""}
          <span className="block text-xs text-gray-500">
            {scopedTheater
              ? `Times are in the theater's time zone: ${zoneLabel(scopedTheater.timezone, items[0]?.startTime)}`
              : "Times are in each theater's own time zone"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="page-size" className="text-xs">
            Rows per page
          </label>
          <select
            id="page-size"
            value={query.pageSize}
            onChange={(e) => table.update({ pageSize: Number(e.target.value) })}
            className={selectInput}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => table.update({ page: query.page - 1 })}
            disabled={query.page <= 1 || loading}
            className={secondaryButton}
          >
            Previous
          </button>
          <span className="whitespace-nowrap">
            Page {query.page} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => table.update({ page: query.page + 1 })}
            disabled={query.page >= pageCount || loading}
            className={secondaryButton}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

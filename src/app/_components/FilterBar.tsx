"use client";

import { emptyFilters, type ShowtimeFilters } from "~/lib/hooks/useShowtimes";
import type { FilterOptions } from "~/types/api";
import { selectInput } from "./ui";

interface FilterBarProps {
  filters: ShowtimeFilters;
  options: FilterOptions;
  onChange: (filters: ShowtimeFilters) => void;
}

const SELECTS: {
  field: "format" | "language" | "rating" | "movieStatus" | "auditorium";
  label: string;
  all: string;
  options: keyof FilterOptions;
}[] = [
  { field: "format", label: "Format", all: "All Formats", options: "formats" },
  { field: "language", label: "Language", all: "All Languages", options: "languages" },
  { field: "rating", label: "Rating", all: "All Ratings", options: "ratings" },
  { field: "movieStatus", label: "Movie Status", all: "All Statuses", options: "movieStatuses" },
  { field: "auditorium", label: "Auditorium", all: "All Auditoriums", options: "auditoriums" },
];

export function FilterBar({ filters, options, onChange }: FilterBarProps) {
  const set = (change: Partial<ShowtimeFilters>) => onChange({ ...filters, ...change });
  const labelClass = "mb-1 block text-xs text-gray-400";
  const inputClass = `w-full ${selectInput}`;

  return (
    <div className="mb-6 rounded-lg border border-gray-700 bg-gray-900 p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase text-gray-400">Filters</h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="filter-status" className={labelClass}>
            Status
          </label>
          <select
            id="filter-status"
            value={filters.status}
            onChange={(e) => set({ status: e.target.value as ShowtimeFilters["status"] })}
            className={inputClass}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        {SELECTS.map((select) => (
          <div key={select.field}>
            <label htmlFor={`filter-${select.field}`} className={labelClass}>
              {select.label}
            </label>
            <select
              id={`filter-${select.field}`}
              value={filters[select.field]}
              onChange={(e) => set({ [select.field]: e.target.value })}
              className={inputClass}
            >
              <option value="">{select.all}</option>
              {options[select.options].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        ))}

        <div>
          <label htmlFor="filter-start-date" className={labelClass}>
            Start Date
          </label>
          <input
            id="filter-start-date"
            type="date"
            value={filters.startDate}
            onChange={(e) => set({ startDate: e.target.value })}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="filter-end-date" className={labelClass}>
            End Date
          </label>
          <input
            id="filter-end-date"
            type="date"
            value={filters.endDate}
            onChange={(e) => set({ endDate: e.target.value })}
            className={inputClass}
          />
        </div>

        <div className="flex items-end">
          <button
            type="button"
            onClick={() => onChange(emptyFilters)}
            className="w-full rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-800"
          >
            Clear Filters
          </button>
        </div>
      </div>
    </div>
  );
}

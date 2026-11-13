import { parse } from "csv-parse/sync";
import { cleanText } from "./normalize";
import type { CsvIssue, ParsedRow } from "./types";

export const MAX_FILE_BYTES = 1_000_000;
export const MAX_DATA_ROWS = 5_000;
const MAX_DURATION_MS = 12 * 60 * 60 * 1000;

const HEADER_ALIASES: Record<string, string[]> = {
  theaterName: ["theater_name", "theater", "cinema"],
  title: ["movie_title", "title", "movie", "film"],
  auditorium: ["auditorium", "screen", "room", "hall"],
  startTime: ["start_time", "start", "starts_at"],
  endTime: ["end_time", "end", "ends_at"],
  language: ["language"],
  format: ["format"],
  rating: ["rating"],
  lastUpdated: ["last_updated", "updated_at"],
};
const REQUIRED = ["title", "auditorium", "startTime", "endTime"] as const;
const COLUMN_NAME: Record<string, string> = {
  theaterName: "theater_name",
  title: "movie_title",
  auditorium: "auditorium",
  startTime: "start_time",
  endTime: "end_time",
  lastUpdated: "last_updated",
};

// ISO 8601 with an explicit offset or Z. Local times are rejected: we never guess a zone.
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})$/;

function parseInstant(value: string): string | null {
  if (!ISO_WITH_OFFSET.test(value)) return null;
  const ms = Date.parse(value.replace(" ", "T"));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export type CsvResult =
  | { ok: true; rows: ParsedRow[] }
  | { ok: false; code: "too_large" | "invalid"; errors: CsvIssue[] };

interface RawRecord {
  record: string[];
  info: { lines: number };
}

const fail = (
  errors: CsvIssue[],
  code: "too_large" | "invalid" = "invalid",
): CsvResult => ({ ok: false, code, errors });

/**
 * Flexible on format, strict on meaning. Collects every problem with its row number;
 * one bad row rejects the whole file.
 */
export function parseCsv(
  text: string,
  options: { requireTheater: boolean },
): CsvResult {
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    return fail(
      [{ row: 0, field: null, message: "The file is larger than the 1 MB limit." }],
      "too_large",
    );
  }

  let records: RawRecord[];
  try {
    records = parse(text, {
      bom: true,
      info: true,
      relax_column_count: true,
      skip_empty_lines: true,
      skip_records_with_empty_values: true,
    }) as unknown as RawRecord[];
  } catch (error) {
    return fail([
      {
        row: (error as { lines?: number }).lines ?? 0,
        field: null,
        message: `The file is not valid CSV: ${(error as Error).message}`,
      },
    ]);
  }

  const header = records[0];
  if (!header) {
    return fail([{ row: 0, field: null, message: "The file is empty." }]);
  }

  const columns = new Map<string, number>();
  const errors: CsvIssue[] = [];
  header.record.forEach((cell, index) => {
    const name = cleanText(cell).toLowerCase().replace(/[\s-]+/g, "_");
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (!aliases.includes(name)) continue;
      if (columns.has(field)) {
        errors.push({
          row: 1,
          field: COLUMN_NAME[field] ?? field,
          message: `The header has more than one column for ${COLUMN_NAME[field] ?? field}.`,
        });
      } else {
        columns.set(field, index);
      }
    }
  });
  for (const field of REQUIRED) {
    if (!columns.has(field)) {
      errors.push({
        row: 1,
        field: COLUMN_NAME[field] ?? field,
        message: `Missing required column: ${COLUMN_NAME[field]} (accepted names: ${HEADER_ALIASES[field]?.join(", ")}).`,
      });
    }
  }
  if (options.requireTheater && !columns.has("theaterName")) {
    errors.push({
      row: 1,
      field: "theater_name",
      message:
        "Missing required column: theater_name. Add it, or select a single theater before uploading.",
    });
  }
  if (errors.length > 0) return fail(errors);

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    return fail([
      { row: 1, field: null, message: "The file has a header but no data rows." },
    ]);
  }
  if (dataRecords.length > MAX_DATA_ROWS) {
    return fail(
      [
        {
          row: 0,
          field: null,
          message: `The file has ${dataRecords.length} rows. The limit is ${MAX_DATA_ROWS}.`,
        },
      ],
      "too_large",
    );
  }

  const rows: ParsedRow[] = [];
  for (const { record, info } of dataRecords) {
    const row = info.lines;
    const cell = (field: string) => {
      const index = columns.get(field);
      return index === undefined ? "" : cleanText(record[index]);
    };
    const before = errors.length;

    const theaterName = cell("theaterName");
    if (options.requireTheater && !theaterName) {
      errors.push({ row, field: "theater_name", message: "The theater name is empty." });
    }
    const title = cell("title");
    if (!title) {
      errors.push({ row, field: "movie_title", message: "The movie title is empty." });
    }
    const auditorium = cell("auditorium");
    if (!auditorium) {
      errors.push({ row, field: "auditorium", message: "The auditorium is empty." });
    }

    const instant = (field: "startTime" | "endTime" | "lastUpdated") => {
      const raw = cell(field);
      const value = parseInstant(raw);
      if (!value) {
        errors.push({
          row,
          field: COLUMN_NAME[field] ?? field,
          message: `${COLUMN_NAME[field]} "${raw}" is not an ISO 8601 time with a time zone (for example 2025-03-15T18:00:00Z).`,
        });
      }
      return value;
    };
    const startTime = instant("startTime");
    const endTime = instant("endTime");
    const lastUpdated = cell("lastUpdated") ? instant("lastUpdated") : null;

    if (startTime && endTime) {
      const duration = Date.parse(endTime) - Date.parse(startTime);
      if (duration <= 0) {
        errors.push({
          row,
          field: "end_time",
          message: "end_time must be after start_time.",
        });
      } else if (duration > MAX_DURATION_MS) {
        errors.push({
          row,
          field: "end_time",
          message: "The showtime is longer than 12 hours.",
        });
      }
    }

    if (errors.length === before && startTime && endTime) {
      rows.push({
        rowNumber: row,
        theaterName,
        title,
        auditorium,
        startTime,
        endTime,
        language: cell("language").toUpperCase(),
        format: cell("format").toUpperCase(),
        rating: cell("rating"),
        lastUpdated,
      });
    }
  }

  return errors.length > 0 ? fail(errors) : { ok: true, rows };
}

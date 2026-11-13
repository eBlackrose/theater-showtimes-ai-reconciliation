import { describe, expect, it } from "vitest";
import { MAX_DATA_ROWS, parseCsv } from "~/server/domain/csv";
import { cleanText, normalizeKey } from "~/server/domain/normalize";
import { scopeRows } from "~/server/domain/scope";
import { coveredWindow, inWindow, localDay } from "~/server/domain/window";
import { avery, casey, DOWNTOWN, riley, rowsOf, sample, theaters } from "./fixtures";

describe("normalizeKey", () => {
  it.each([
    ["Spider‑Man: Homecoming", "  Spider Man - Homecoming  "], // U+2011 non-breaking hyphen
    ["Inside Out 2", "Inside   Out  2"],
    ["Dune: Part Two", "DUNE PART 2"],
    ["Amélie", "Amelie"],
    ["WALL·E", "Wall-E"],
    ["Kill Bill: Vol. Two", "kill bill volume 2"],
    ["Ｄｕｎｅ", "dune"], // full-width letters fold under NFKC
  ])("treats %j and %j as the same", (a, b) => {
    expect(normalizeKey(a)).toBe(normalizeKey(b));
  });

  it.each([
    ["Dune: Part Two", "Dune"],
    ["Inside Out 2", "Inside Out"],
    ["Spider-Man: Homecoming", "Spiderman Homecomming"],
    ["Dune: Part Two", "Dune Part II"],
    ["Auditorium 1", "Aud 1"],
    ["Auditorium 2", "Auditorium Two"], // a number word only folds after a sequel marker
    ["Auditorium 1", "Auditorium 1 (Laser)"],
    ["Se7en", "Seven"],
  ])("keeps %j and %j apart (left to the agent)", (a, b) => {
    expect(normalizeKey(a)).not.toBe(normalizeKey(b));
  });

  it("cleans text for storage without changing its meaning", () => {
    expect(cleanText("  Dune:  Part   Two ")).toBe("Dune: Part Two");
    expect(cleanText(null)).toBe("");
    expect(normalizeKey("!!!")).toBe("");
  });

  it("gives the keys the sample files need", () => {
    const keys = (file: string) =>
      rowsOf(sample(file)).map((row) => normalizeKey(row.title));
    expect(new Set(keys("existing.csv"))).toEqual(
      new Set(["spider man homecoming", "inside out 2", "dune part 2", "wonka", "oppenheimer"]),
    );
    expect(new Set(keys("new-drop.csv"))).toEqual(
      new Set(["spider man homecoming", "inside out 2", "dune part 2", "kung fu panda 4"]),
    );
  });
});

const HEADER = "theater_name,movie_title,auditorium,start_time,end_time,language,format,rating,last_updated";
const GOOD = "Downtown Cinema 7,Dune,Auditorium 1,2025-03-15T18:00:00Z,2025-03-15T20:00:00Z,en,2d,PG-13,2025-03-15T09:00:00Z";
const parse = (text: string, requireTheater = true) => parseCsv(text, { requireTheater });
const errorsOf = (text: string, requireTheater = true) => {
  const result = parse(text, requireTheater);
  if (result.ok) throw new Error("expected the file to be rejected");
  return result.errors;
};

describe("parseCsv: flexible on format", () => {
  it("handles a BOM, CRLF, blank lines, quoted commas and extra spaces", () => {
    const text = `﻿${HEADER}\r\n\r\n${GOOD}\r\n , , \r\nDowntown Cinema 7,"Dune,  Part Two",  Aud 1 ,2025-03-15T21:00:00+00:00,2025-03-15T23:00:00Z,EN,IMAX,PG-13,\r\n`;
    const result = parse(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ rowNumber: 3, language: "EN", format: "2D" });
    expect(result.rows[1]).toMatchObject({
      rowNumber: 5,
      title: "Dune, Part Two",
      auditorium: "Aud 1",
      startTime: "2025-03-15T21:00:00.000Z",
      lastUpdated: null,
    });
  });

  it("accepts header aliases, any column order, any case, and ignores unknown columns", () => {
    const result = parse(
      "Ends_At, FILM ,Screen,notes,starts at,Cinema\n2025-03-15T20:00:00Z,Dune,Screen 1,hello,2025-03-15T18:00:00Z,Uptown Arts Theater\n",
    );
    expect(result.ok && result.rows[0]).toMatchObject({
      theaterName: "Uptown Arts Theater",
      title: "Dune",
      auditorium: "Screen 1",
      language: "",
      format: "",
      rating: "",
    });
  });

  it("converts offsets to UTC instants", () => {
    const result = parse(
      `${HEADER}\nDowntown Cinema 7,Dune,Auditorium 1,2025-03-15T11:00:00-07:00,2025-03-15T13:00:00-07:00,,,,\n`,
    );
    expect(result.ok && result.rows[0]?.startTime).toBe("2025-03-15T18:00:00.000Z");
  });
});

describe("parseCsv: strict on meaning", () => {
  it("reports every problem with its row number and rejects the whole file", () => {
    const errors = errorsOf(sample("invalid-drop.csv"));
    expect(errors.map((e) => [e.row, e.field])).toEqual([
      [3, "start_time"],
      [4, "end_time"],
      [5, "movie_title"],
    ]);
    expect(errors[0]?.message).toContain("15/03/2025 6pm");
  });

  it("rejects times without a zone, zero or negative durations, and showtimes over 12 hours", () => {
    const row = (start: string, end: string) =>
      `${HEADER}\nDowntown Cinema 7,Dune,Auditorium 1,${start},${end},,,,\n`;
    expect(errorsOf(row("2025-03-15T18:00:00", "2025-03-15T20:00:00Z"))[0]?.field).toBe("start_time");
    expect(errorsOf(row("2025-03-15T18:00:00Z", "2025-03-15T18:00:00Z"))[0]?.message).toMatch(/after/);
    expect(errorsOf(row("2025-03-15T18:00:00Z", "2025-03-16T07:00:00Z"))[0]?.message).toMatch(/12 hours/);
    expect(errorsOf(row("2025-02-30T18:00:00Z", "2025-03-01T07:00:00Z"))).not.toHaveLength(0);
  });

  it("reports missing required columns, and theater only when no theater is selected", () => {
    const text = "movie_title,start_time\nDune,2025-03-15T18:00:00Z\n";
    expect(errorsOf(text).map((e) => e.field)).toEqual(["auditorium", "end_time", "theater_name"]);
    expect(errorsOf(text, false).map((e) => e.field)).toEqual(["auditorium", "end_time"]);
  });

  it("requires a theater per row when none is selected, but not otherwise", () => {
    const text = `${HEADER}\n,Dune,Auditorium 1,2025-03-15T18:00:00Z,2025-03-15T20:00:00Z,,,,\n`;
    expect(errorsOf(text)[0]).toMatchObject({ row: 2, field: "theater_name" });
    expect(parse(text, false).ok).toBe(true);
  });

  it("rejects empty files, header-only files, duplicate columns and broken quoting", () => {
    expect(errorsOf("")[0]?.message).toMatch(/empty/);
    expect(errorsOf(`${HEADER}\n\n`)[0]?.message).toMatch(/no data rows/);
    expect(errorsOf(`title,film,auditorium,start,end,theater\n`)[0]?.message).toMatch(/more than one column/);
    expect(errorsOf(`${HEADER}\nDowntown Cinema 7,"Dune,Auditorium 1\n`)[0]?.message).toMatch(/not valid CSV/);
  });

  it("enforces the size and row limits", () => {
    const big = parse(`${HEADER}\n${`${GOOD}\n`.repeat(MAX_DATA_ROWS + 1)}`);
    expect(big).toMatchObject({ ok: false, code: "too_large" });
    const huge = parse(`${HEADER}\n${"x".repeat(1_000_001)}`);
    expect(huge).toMatchObject({ ok: false, code: "too_large" });
  });
});

describe("scopeRows", () => {
  const multi = () => sample("multi-theater-drop.csv");
  const dispositions = (rows: ReturnType<typeof rowsOf>) => rows.map((r) => r.disposition);

  it("gives each row a disposition for an admin of some theaters", () => {
    expect(dispositions(rowsOf(multi(), avery, null))).toEqual([
      "in_scope",
      "in_scope",
      "in_scope",
      "in_scope",
      "skipped_no_access",
      "skipped_unknown_theater",
    ]);
  });

  it("limits rows to the selected theater", () => {
    expect(dispositions(rowsOf(multi(), casey, DOWNTOWN))).toEqual([
      "in_scope",
      "in_scope",
      "skipped_out_of_scope",
      "skipped_out_of_scope",
      "skipped_out_of_scope",
      "skipped_unknown_theater",
    ]);
  });

  it("never puts a viewer's rows in scope", () => {
    expect(new Set(dispositions(rowsOf(multi(), riley, null)))).toEqual(
      new Set(["skipped_no_access", "skipped_unknown_theater"]),
    );
  });

  it("matches theater names through the normalizer and suggests the nearest name", () => {
    const parsed = parse(
      `${HEADER}\n  downtown   CINEMA 7,Dune,Auditorium 1,2025-03-15T18:00:00Z,2025-03-15T20:00:00Z,,,,\nDowntown Cinema,Dune,Auditorium 1,2025-03-15T18:00:00Z,2025-03-15T20:00:00Z,,,,\n`,
    );
    if (!parsed.ok) throw new Error("unexpected");
    const [exact, near] = scopeRows(parsed.rows, avery, null, theaters);
    expect(exact).toMatchObject({ disposition: "in_scope", theaterId: DOWNTOWN });
    expect(near?.disposition).toBe("skipped_unknown_theater");
    expect(near?.note).toContain('Did you mean "Downtown Cinema 7"');
  });

  it("uses the selected theater for a blank theater cell", () => {
    const parsed = parse(
      `${HEADER}\n,Dune,Auditorium 1,2025-03-15T18:00:00Z,2025-03-15T20:00:00Z,,,,\n`,
      false,
    );
    if (!parsed.ok) throw new Error("unexpected");
    expect(scopeRows(parsed.rows, avery, DOWNTOWN, theaters)[0]).toMatchObject({
      disposition: "in_scope",
      theaterId: DOWNTOWN,
    });
    expect(scopeRows(parsed.rows, avery, "theater-uptown", theaters)[0]?.disposition).toBe(
      "skipped_no_access",
    );
  });
});

describe("coveredWindow", () => {
  const LA = "America/Los_Angeles";

  it("covers theater-local days, half-open", () => {
    // 16:00Z is 9 AM and 01:00Z the next day is 6 PM, both on March 15 in Los Angeles.
    const window = coveredWindow(["2025-03-15T16:00:00Z", "2025-03-16T01:00:00Z"], LA);
    expect(window).toEqual({ start: "2025-03-15T07:00:00.000Z", end: "2025-03-16T07:00:00.000Z" });
    expect(inWindow("2025-03-16T06:59:59Z", window)).toBe(true);
    expect(inWindow("2025-03-16T07:00:00Z", window)).toBe(false);
    // The seeded March 16 "Kung Fu Panda 4" is outside a March 15 file.
    expect(inWindow("2025-03-16T17:30:00Z", window)).toBe(false);
  });

  it("places an instant on its local day, not its UTC day", () => {
    expect(localDay("2025-03-16T01:00:00Z", LA)).toBe("2025-03-15"); // "Past Lives"
    expect(localDay("2025-03-16T01:00:00Z", "UTC")).toBe("2025-03-16");
  });

  it("spans multi-day files", () => {
    expect(coveredWindow(["2025-03-17T20:00:00Z", "2025-03-15T20:00:00Z"], LA)).toEqual({
      start: "2025-03-15T07:00:00.000Z",
      end: "2025-03-18T07:00:00.000Z",
    });
  });

  it("handles a daylight-saving boundary: March 9, 2025 has 23 hours in Los Angeles", () => {
    const window = coveredWindow(["2025-03-09T20:00:00Z"], LA);
    expect(window).toEqual({ start: "2025-03-09T08:00:00.000Z", end: "2025-03-10T07:00:00.000Z" });
  });

  it("returns null for no rows, and null means everything is in the window", () => {
    expect(coveredWindow([], LA)).toBeNull();
    expect(inWindow("1999-01-01T00:00:00Z", null)).toBe(true);
  });
});

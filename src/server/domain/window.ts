import { DateTime } from "luxon";
import type { TimeWindow } from "./types";

/** Theater-local calendar day (YYYY-MM-DD) of an instant. */
export const localDay = (iso: string, timezone: string) =>
  DateTime.fromISO(iso, { zone: "utc" }).setZone(timezone).toISODate() ?? "";

/**
 * The range of theater-local days a file covers, half-open:
 * [00:00 local on the first day, 00:00 local after the last day).
 * Only showtimes inside it can be proposed for archive.
 */
export function coveredWindow(
  startTimes: string[],
  timezone: string,
): TimeWindow | null {
  if (startTimes.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const iso of startTimes) {
    const ms = Date.parse(iso);
    if (ms < lo) lo = ms;
    if (ms > hi) hi = ms;
  }
  const start = DateTime.fromMillis(lo, { zone: timezone }).startOf("day");
  const end = DateTime.fromMillis(hi, { zone: timezone })
    .startOf("day")
    .plus({ days: 1 });
  return {
    start: start.toUTC().toISO() ?? "",
    end: end.toUTC().toISO() ?? "",
  };
}

export const inWindow = (iso: string, window: TimeWindow | null) => {
  if (!window) return true;
  const ms = Date.parse(iso);
  return ms >= Date.parse(window.start) && ms < Date.parse(window.end);
};

/** "Mar 15, 6:00 PM" in the theater's zone, for explanations and warnings. */
export const formatLocal = (iso: string, timezone: string) =>
  DateTime.fromISO(iso, { zone: "utc" })
    .setZone(timezone)
    .toFormat("LLL d, h:mm a");

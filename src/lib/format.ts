import type { ImportCounts, ImportStatus, PlanActionType } from "~/types/api";

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(timeZone: string | undefined, withZone: boolean) {
  const key = `${timeZone ?? ""}|${withZone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
      timeZoneName: withZone ? "short" : undefined,
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * A date and time in the given IANA zone (the browser's zone when omitted). Text that is
 * not a date, or a zone the browser does not know, comes back unchanged rather than throwing.
 */
export function formatDateTime(value: string, timeZone?: string, withZone = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return dateTimeFormatter(timeZone, withZone).format(date);
  } catch {
    return dateTimeFormatter(undefined, withZone).format(date);
  }
}

/** "America/Chicago (CDT)": the zone named once, with the abbreviation valid at `at`. */
export function zoneLabel(timeZone: string, at?: string | null): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(at ? new Date(at) : new Date())
      .find((p) => p.type === "timeZoneName");
    return part ? `${timeZone} (${part.value})` : timeZone;
  } catch {
    return timeZone;
  }
}

export const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

export const ACTION_LABELS: Record<PlanActionType, string> = {
  add: "New",
  restore: "Restore",
  update: "Update",
  reschedule: "Reschedule",
  archive: "Archive",
  unchanged: "No change",
  duplicate: "Duplicate",
};

/** The actions an admin accepts or rejects; the other two are informational. */
export const DECIDABLE_ACTIONS: readonly PlanActionType[] = [
  "add",
  "restore",
  "update",
  "reschedule",
  "archive",
];

export const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = {
  uploaded: "Uploaded",
  analyzing: "Analyzing",
  ready: "Ready for review",
  applying: "Applying",
  applied: "Applied",
  partially_applied: "Partially applied",
  discarded: "Discarded",
  failed: "Failed",
};

/** "2 new, 1 update, 2 archive": the non-zero changes of a plan or an apply result. */
export function describeChanges(
  counts: Partial<Record<PlanActionType, number>> | ImportCounts,
): string {
  const parts = DECIDABLE_ACTIONS.flatMap((action) => {
    const count = counts[action] ?? 0;
    return count > 0 ? [`${count} ${ACTION_LABELS[action].toLowerCase()}`] : [];
  });
  return parts.length > 0 ? parts.join(", ") : "No schedule changes";
}

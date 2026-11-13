"use client";

import { useState } from "react";
import { ACTION_LABELS, DECIDABLE_ACTIONS, formatDateTime, zoneLabel } from "~/lib/format";
import type {
  Confidence,
  PlanAction,
  PlanActionGroup,
  PlanActionType,
  PlanTheaterSection,
} from "~/types/api";
import { Chip, secondaryButton, type Tone } from "./ui";

type Decision = "accepted" | "rejected";

const GROUP_TITLES: Record<PlanActionType, string> = {
  add: "New showtimes",
  restore: "Restored showtimes",
  update: "Updated showtimes",
  reschedule: "Rescheduled showtimes",
  archive: "Showtimes to archive",
  duplicate: "Duplicate rows in the file",
  unchanged: "Matched, no change",
};

const ACTION_TONES: Record<PlanActionType, Tone> = {
  add: "green",
  restore: "green",
  update: "yellow",
  reschedule: "yellow",
  archive: "red",
  duplicate: "gray",
  unchanged: "gray",
};

export const CONFIDENCE_TONES: Record<Confidence, Tone> = {
  high: "green",
  medium: "yellow",
  low: "red",
};

const SOURCE_LABELS: Record<PlanAction["source"], string> = {
  rule: "Rule",
  ai: "AI",
  alias: "Saved alias",
  human: "You",
};

const SECTION_STATUS: Record<PlanTheaterSection["status"], { label: string; tone: Tone }> = {
  ready: { label: "Ready", tone: "gray" },
  applied: { label: "Applied", tone: "green" },
  conflict: { label: "Schedule changed", tone: "amber" },
  failed: { label: "Failed", tone: "red" },
};

const RESULT_TONES: Record<NonNullable<PlanAction["result"]>, Tone> = {
  applied: "green",
  skipped: "gray",
  conflict: "amber",
  failed: "red",
};

const FIELD_LABELS: Record<string, string> = {
  auditorium: "Room",
  startTime: "Start",
  endTime: "End",
  language: "Language",
  format: "Format",
  rating: "Rating",
};
const TIME_FIELDS = new Set(["startTime", "endTime"]);

interface SectionHandlers {
  onDecide: (item: PlanAction, decision: Decision) => void;
  onBulk: (theaterId: string, action: PlanActionType, decision: Decision) => void;
  onLoadMore: (theaterId: string, action: PlanActionType, offset: number) => Promise<void>;
}

interface PlanSectionProps extends SectionHandlers {
  section: PlanTheaterSection;
  /** False for history and for theaters that are already applied: decisions are shown, not editable. */
  editable: boolean;
}

export function PlanSection({ section, editable, ...handlers }: PlanSectionProps) {
  const status = SECTION_STATUS[section.status];
  const canEdit = editable && section.status !== "applied";

  return (
    <section className="rounded-lg border border-gray-700 bg-gray-900">
      <header className="border-b border-gray-700 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-semibold text-white">{section.theaterName}</h3>
          {section.status !== "ready" && <Chip tone={status.tone}>{status.label}</Chip>}
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Times are in {zoneLabel(section.timezone, section.windowStart)}
          {section.windowStart && section.windowEnd
            ? ` · This file covers ${formatDateTime(section.windowStart, section.timezone)} to ${formatDateTime(section.windowEnd, section.timezone)}`
            : ""}
        </p>
        {section.error && <p className="mt-2 text-sm text-amber-300">{section.error}</p>}
      </header>
      <div className="space-y-3 p-4">
        {section.groups.length === 0 ? (
          <p className="text-sm text-gray-400">This file proposes nothing for this theater.</p>
        ) : (
          section.groups.map((group) => (
            <ActionGroup
              key={group.action}
              group={group}
              section={section}
              editable={canEdit}
              {...handlers}
            />
          ))
        )}
      </div>
    </section>
  );
}

interface ActionGroupProps extends SectionHandlers {
  group: PlanActionGroup;
  section: PlanTheaterSection;
  editable: boolean;
}

function ActionGroup({ group, section, editable, onDecide, onBulk, onLoadMore }: ActionGroupProps) {
  const [loadingMore, setLoadingMore] = useState(false);
  const decidable = DECIDABLE_ACTIONS.includes(group.action);
  const remaining = group.total - group.items.length;

  const loadMore = async () => {
    setLoadingMore(true);
    await onLoadMore(section.theaterId, group.action, group.items.length);
    setLoadingMore(false);
  };

  return (
    <details open={decidable} className="rounded-lg border border-gray-700 bg-gray-800/40">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm font-semibold text-white">
        <Chip tone={ACTION_TONES[group.action]}>{group.total}</Chip>
        {GROUP_TITLES[group.action]}
        {decidable && (
          <span className="text-xs font-normal text-gray-400">
            {group.accepted} accepted · {group.rejected} rejected
          </span>
        )}
        {group.pending > 0 && (
          <Chip tone="amber">
            {group.pending} need{group.pending === 1 ? "s" : ""} your decision
          </Chip>
        )}
      </summary>
      <div className="space-y-2 border-t border-gray-700 p-3">
        {decidable && editable && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-xs text-gray-400">All {group.total} in this group:</span>
            <button
              type="button"
              onClick={() => onBulk(section.theaterId, group.action, "accepted")}
              className={`${secondaryButton} px-3 py-1 text-xs`}
            >
              Accept all
            </button>
            <button
              type="button"
              onClick={() => onBulk(section.theaterId, group.action, "rejected")}
              className={`${secondaryButton} px-3 py-1 text-xs`}
            >
              Reject all
            </button>
          </div>
        )}
        <ul className="space-y-2">
          {group.items.map((item) => (
            <ActionItem
              key={item.actionKey}
              item={item}
              timezone={section.timezone}
              editable={editable && decidable && item.result === null}
              onDecide={onDecide}
            />
          ))}
        </ul>
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className={`${secondaryButton} w-full`}
          >
            {loadingMore ? "Loading..." : `Show more (${remaining} not shown)`}
          </button>
        )}
      </div>
    </details>
  );
}

interface ActionItemProps {
  item: PlanAction;
  timezone: string;
  editable: boolean;
  onDecide: (item: PlanAction, decision: Decision) => void;
}

function ActionItem({ item, timezone, editable, onDecide }: ActionItemProps) {
  const decidable = DECIDABLE_ACTIONS.includes(item.action);
  const pending = decidable && item.decision === "pending";
  const diffValue = (field: string, value: string) =>
    TIME_FIELDS.has(field) ? formatDateTime(value, timezone) : value || "(empty)";

  return (
    <li
      className={`rounded-lg border p-3 ${
        pending ? "border-amber-500 bg-amber-950/30" : "border-gray-700 bg-gray-900/60"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={ACTION_TONES[item.action]}>{ACTION_LABELS[item.action]}</Chip>
            <span className="break-words font-semibold text-white">{item.movieTitle}</span>
            {item.sourceTitle && item.sourceTitle !== item.movieTitle && (
              <span className="break-words text-xs text-gray-400">
                {`written in the file as "${item.sourceTitle}"`}
              </span>
            )}
            {pending && <Chip tone="amber">Needs your decision</Chip>}
          </div>
          <p className="mt-1 break-words text-sm text-gray-300">
            {item.auditorium}
            {item.sourceAuditorium && item.sourceAuditorium !== item.auditorium
              ? ` (in the file: "${item.sourceAuditorium}")`
              : ""}
            {" · "}
            {formatDateTime(item.startTime, timezone)} – {formatDateTime(item.endTime, timezone)}
            {" · "}
            {[item.language, item.format, item.rating].filter(Boolean).join(" · ")}
          </p>
          {item.diffs.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {item.diffs.map((diff) => (
                <li key={diff.field}>
                  <span className="text-gray-400">{FIELD_LABELS[diff.field] ?? diff.field}:</span>{" "}
                  <span className="text-red-400 line-through">
                    {diffValue(diff.field, diff.oldValue)}
                  </span>{" "}
                  → <span className="text-green-400">{diffValue(diff.field, diff.newValue)}</span>
                </li>
              ))}
            </ul>
          )}
          {item.explanation && (
            <p className="mt-2 whitespace-pre-line break-words text-sm text-gray-400">
              {item.explanation}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Chip tone={CONFIDENCE_TONES[item.confidence]}>{item.confidence} confidence</Chip>
            <Chip tone={item.source === "ai" ? "purple" : "gray"}>{SOURCE_LABELS[item.source]}</Chip>
            {item.sourceRows.length > 0 && (
              <span className="text-xs text-gray-500">
                File {item.sourceRows.length === 1 ? "row" : "rows"}{" "}
                {item.sourceRows.join(", ")}
              </span>
            )}
            {item.result && (
              <>
                <Chip tone={RESULT_TONES[item.result]}>Result: {item.result}</Chip>
                {item.resultDetail && (
                  <span className="text-xs text-gray-400">{item.resultDetail}</span>
                )}
              </>
            )}
          </div>
        </div>

        {decidable &&
          (editable ? (
            <div className="flex shrink-0 gap-1" role="group" aria-label="Decision">
              {(["accepted", "rejected"] as const).map((decision) => {
                const selected = item.decision === decision;
                const selectedTone =
                  decision === "accepted"
                    ? "border-green-600 bg-green-900 text-green-200"
                    : "border-red-600 bg-red-950 text-red-300";
                return (
                  <button
                    key={decision}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onDecide(item, decision)}
                    className={`rounded-lg border px-3 py-1 text-xs font-semibold transition ${
                      selected ? selectedTone : "border-gray-600 text-gray-300 hover:bg-gray-800"
                    }`}
                  >
                    {decision === "accepted" ? "Accept" : "Reject"}
                  </button>
                );
              })}
            </div>
          ) : (
            <Chip
              tone={
                item.decision === "accepted" ? "green" : item.decision === "rejected" ? "red" : "amber"
              }
            >
              {item.decision === "pending" ? "Not decided" : item.decision}
            </Chip>
          ))}
      </div>
    </li>
  );
}

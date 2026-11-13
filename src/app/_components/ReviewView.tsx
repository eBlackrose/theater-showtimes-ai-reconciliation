"use client";

import { useRef, useState } from "react";
import { ApiClientError, errorMessage, type ApiClient } from "~/lib/api-client";
import { DECIDABLE_ACTIONS, IMPORT_STATUS_LABELS, formatDateTime, plural } from "~/lib/format";
import type {
  ApplyResponse,
  ArchiveScope,
  ImportDetail,
  ImportEvent,
  PlanAction,
  PlanActionGroup,
  PlanActionType,
  PlanWarning,
  SkippedRowGroup,
} from "~/types/api";
import { usageLine } from "./AnalysisView";
import { EventFeed } from "./EventFeed";
import { PlanSection } from "./PlanSection";
import { ResolutionList, type ResolutionOverride } from "./ResolutionList";
import {
  Banner,
  Chip,
  ModalBody,
  ModalFooter,
  dangerButton,
  primaryButton,
  secondaryButton,
  type Tone,
} from "./ui";

type Decision = "accepted" | "rejected";

const SKIP_REASONS: Record<SkippedRowGroup["reason"], string> = {
  skipped_out_of_scope: "Outside the selected theater",
  skipped_no_access: "A theater you do not manage",
  skipped_unknown_theater: "Unknown theater",
};

const ARCHIVE_SCOPES: { value: ArchiveScope; label: string; hint: string }[] = [
  {
    value: "file_window",
    label: "Only the dates in this file",
    hint: "Stored showtimes on the days this file covers, and missing from it, are archived.",
  },
  {
    value: "full_schedule",
    label: "Treat file as the full schedule",
    hint: "Every stored showtime missing from this file is archived, on any date.",
  },
];

const warningKey = (warning: PlanWarning) => `${warning.code}|${warning.theaterId ?? ""}`;

/** Replace one action group of one theater, and keep the import's pending total in step. */
function mapGroup(
  detail: ImportDetail,
  theaterId: string,
  action: PlanActionType,
  change: (group: PlanActionGroup) => PlanActionGroup,
): ImportDetail {
  const theaterSections = detail.theaterSections.map((section) =>
    section.theaterId !== theaterId
      ? section
      : {
          ...section,
          groups: section.groups.map((group) => (group.action === action ? change(group) : group)),
        },
  );
  const pending = theaterSections
    .flatMap((section) => section.groups)
    .reduce((sum, group) => sum + group.pending, 0);
  return { ...detail, theaterSections, counts: { ...detail.counts, pending } };
}

function withDecision(detail: ImportDetail, item: PlanAction, decision: Decision): ImportDetail {
  return mapGroup(detail, item.theaterId, item.action, (group) => {
    const current = group.items.find((candidate) => candidate.actionKey === item.actionKey);
    if (!current || current.decision === decision) return group;
    return {
      ...group,
      [current.decision]: group[current.decision] - 1,
      [decision]: group[decision] + 1,
      items: group.items.map((candidate) =>
        candidate === current ? { ...candidate, decision } : candidate,
      ),
    };
  });
}

interface ReviewViewProps {
  api: ApiClient;
  detail: ImportDetail;
  /** The analysis trace of this import. */
  events: ImportEvent[];
  onDetail: (change: (current: ImportDetail) => ImportDetail) => void;
  onApplied: (result: ApplyResponse) => void;
  /** Something was written to the schedule, even if the apply as a whole did not go through. */
  onScheduleChanged: () => void;
  onRetryAnalysis: () => void;
  onClose: () => void;
}

export function ReviewView({
  api,
  detail,
  events,
  onDetail,
  onApplied,
  onScheduleChanged,
  onRetryAnalysis,
  onClose,
}: ReviewViewProps) {
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(0);
  const [busy, setBusy] = useState<"apply" | "discard" | "replan" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Decisions are sent one at a time so the last answer always carries the current plan hash.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const editable = detail.status === "ready" || detail.status === "partially_applied";
  const counts = detail.counts;
  const openSections = detail.theaterSections.filter((section) => section.status !== "applied");
  const acceptedChanges = openSections
    .flatMap((section) => section.groups)
    .filter((group) => DECIDABLE_ACTIONS.includes(group.action))
    .reduce((sum, group) => sum + group.accepted, 0);
  const ackWarnings = detail.warnings.filter((warning) => warning.requiresAck);
  const unacknowledged = ackWarnings.some((warning) => !acknowledged[warningKey(warning)]);
  const hasFallbacks = detail.resolutions.some((resolution) => resolution.method === "fallback");
  const theaterNames = new Map(
    detail.theaterSections.map((section) => [section.theaterId, section.theaterName]),
  );

  const blockedReason = !detail.planHash
    ? "Nothing is left to apply."
    : counts.pending > 0
      ? `${plural(counts.pending, "change")} still need${counts.pending === 1 ? "s" : ""} your decision.`
      : unacknowledged
        ? "Tick the warning confirmation above before applying."
        : saving > 0
          ? "Saving your decisions..."
          : null;

  /** Swap in a plan the server re-derived. Its warnings are new, so they need a new tick. */
  const replace = (next: ImportDetail) => {
    onDetail(() => next);
    setAcknowledged({});
  };

  const refresh = async () => {
    try {
      replace(await api.getImport(detail.id));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const saveDecision = (
    send: () => Promise<{ planHash: string; counts: ImportDetail["counts"] }>,
    apply: (current: ImportDetail) => ImportDetail,
  ) => {
    setSaving((count) => count + 1);
    setError(null);
    queue.current = queue.current
      .then(send)
      .then(
        (saved) =>
          onDetail((current) => ({ ...apply(current), planHash: saved.planHash, counts: saved.counts })),
        async (cause: unknown) => {
          setError(`That decision was not saved. ${errorMessage(cause)}`);
          // The optimistic change is undone by reloading what the server actually holds.
          await refresh();
        },
      )
      .finally(() => setSaving((count) => count - 1));
  };

  const decide = (item: PlanAction, decision: Decision) => {
    if (item.decision === decision) return;
    onDetail((current) => withDecision(current, item, decision));
    saveDecision(
      () =>
        api.setDecisions(detail.id, { decisions: [{ actionKey: item.actionKey, decision }] }),
      (current) => current,
    );
  };

  const decideGroup = (theaterId: string, action: PlanActionType, decision: Decision) => {
    saveDecision(
      () => api.setDecisions(detail.id, { bulk: { theaterId, action, decision } }),
      (current) =>
        mapGroup(current, theaterId, action, (group) => ({
          ...group,
          pending: 0,
          accepted: decision === "accepted" ? group.total : 0,
          rejected: decision === "rejected" ? group.total : 0,
          items: group.items.map((item) => ({ ...item, decision })),
        })),
    );
  };

  const loadMore = async (theaterId: string, action: PlanActionType, offset: number) => {
    try {
      const page = await api.importActions(detail.id, { theaterId, action, offset, limit: 50 });
      onDetail((current) =>
        mapGroup(current, theaterId, action, (group) => {
          const known = new Set(group.items.map((item) => item.actionKey));
          return {
            ...group,
            items: [...group.items, ...page.items.filter((item) => !known.has(item.actionKey))],
          };
        }),
      );
    } catch (cause) {
      setError(`More items could not be loaded. ${errorMessage(cause)}`);
    }
  };

  /** Overrides and the archive scope make the server derive a new plan, with no model call. */
  const replan = async (request: () => Promise<ImportDetail>) => {
    setBusy("replan");
    setError(null);
    try {
      await queue.current;
      replace(await request());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const overrideResolution = (resolutionId: string, override: ResolutionOverride) =>
    void replan(() => api.overrideResolution(detail.id, resolutionId, override));

  const apply = async () => {
    if (!detail.planHash) return;
    setBusy("apply");
    setError(null);
    try {
      const result = await api.applyImport(detail.id, {
        planHash: detail.planHash,
        acknowledgeWarnings: ackWarnings.length > 0 ? true : undefined,
      });
      onScheduleChanged();
      onApplied(result);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.status === 409) {
        setError(
          cause.code === "plan_changed"
            ? "The schedule changed since this proposal was made. Nothing was applied for the theaters marked below; review the updated proposal and apply again."
            : cause.message,
        );
        // Some theaters may have gone through before the conflict was found.
        onScheduleChanged();
        await refresh();
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (!window.confirm("Discard this proposal? Nothing will be changed in the schedule.")) return;
    setBusy("discard");
    setError(null);
    try {
      await api.discardImport(detail.id);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(null);
    }
  };

  const chips: { label: string; value: number; tone: Tone }[] = [
    { label: "Matched (no change)", value: counts.unchanged, tone: "gray" },
    { label: "Updates", value: counts.update + counts.reschedule, tone: "yellow" },
    { label: "New", value: counts.add, tone: "green" },
    ...(counts.restore > 0
      ? [{ label: "Restored", value: counts.restore, tone: "green" as const }]
      : []),
    { label: "Archives", value: counts.archive, tone: "red" },
    { label: "Duplicates", value: counts.duplicate, tone: "gray" },
    { label: "Needs your decision", value: counts.pending, tone: counts.pending > 0 ? "amber" : "gray" },
    { label: "Skipped rows", value: counts.skippedRows, tone: "gray" },
  ];

  return (
    <>
      <ModalBody>
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <div
              key={chip.label}
              className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-2 text-sm text-gray-300"
            >
              <Chip tone={chip.tone}>{chip.value}</Chip>
              {chip.label}
            </div>
          ))}
        </div>

        {!editable && (
          <Banner tone="info">
            This import is read-only: {IMPORT_STATUS_LABELS[detail.status].toLowerCase()}
            {detail.appliedAt ? ` on ${formatDateTime(detail.appliedAt)}` : ""}. Uploaded by{" "}
            {detail.createdBy} on {formatDateTime(detail.createdAt)}.
          </Banner>
        )}
        {detail.error && <Banner tone="error">{detail.error}</Banner>}

        {detail.agentSummary && (
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase text-gray-400">AI summary</h3>
            <p className="whitespace-pre-line break-words rounded-lg border border-purple-900 bg-purple-950/30 px-4 py-3 text-sm text-gray-200">
              {detail.agentSummary}
            </p>
          </section>
        )}

        {detail.aiNotice && <Banner tone="info">{detail.aiNotice}</Banner>}

        {detail.warnings.length > 0 && (
          <Banner tone="warning">
            <h3 className="mb-2 font-semibold">Warnings</h3>
            <ul className="space-y-2">
              {detail.warnings.map((warning) => {
                const key = warningKey(warning);
                const theater = warning.theaterId ? theaterNames.get(warning.theaterId) : null;
                return (
                  <li key={key}>
                    <p className="break-words">
                      {theater ? `${theater}: ` : ""}
                      {warning.message}
                    </p>
                    {warning.requiresAck && editable && (
                      <label className="mt-1 flex items-center gap-2 font-medium">
                        <input
                          type="checkbox"
                          checked={acknowledged[key] ?? false}
                          onChange={(e) =>
                            setAcknowledged((current) => ({ ...current, [key]: e.target.checked }))
                          }
                          className="h-4 w-4 accent-purple-600"
                        />
                        I have checked this and want to apply it anyway
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </Banner>
        )}

        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase text-gray-400">
            What counts as removed
          </h3>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {ARCHIVE_SCOPES.map((scope) => (
              <label
                key={scope.value}
                className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${
                  detail.archiveScope === scope.value
                    ? "border-purple-500 bg-purple-950/30"
                    : "border-gray-700 bg-gray-800/40"
                } ${editable ? "cursor-pointer" : "opacity-70"}`}
              >
                <input
                  type="radio"
                  name="archive-scope"
                  checked={detail.archiveScope === scope.value}
                  disabled={!editable || busy !== null}
                  onChange={() => void replan(() => api.setArchiveScope(detail.id, scope.value))}
                  className="mt-1 accent-purple-600"
                />
                <span>
                  <span className="block font-semibold text-white">{scope.label}</span>
                  <span className="text-gray-400">{scope.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {detail.theaterSections.map((section) => (
          <PlanSection
            key={section.theaterId}
            section={section}
            editable={editable}
            onDecide={decide}
            onBulk={decideGroup}
            onLoadMore={loadMore}
          />
        ))}
        {detail.theaterSections.length === 0 && (
          <p className="rounded-lg border border-gray-700 bg-gray-800/40 p-6 text-center text-sm text-gray-400">
            There is no proposal for this import.
          </p>
        )}

        {detail.resolutions.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold uppercase text-gray-400">
              AI resolutions ({detail.resolutions.length})
            </h3>
            <p className="mb-2 text-xs text-gray-500">
              Titles, rooms and time changes that did not match exactly, and what was decided for
              each.{editable ? " Change a decision to rebuild the proposal." : ""}
            </p>
            <ResolutionList
              resolutions={detail.resolutions}
              theaterNames={theaterNames}
              editable={editable}
              busy={busy !== null}
              onOverride={overrideResolution}
            />
          </section>
        )}

        {detail.skipped.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase text-gray-400">
              Skipped rows ({counts.skippedRows})
            </h3>
            <ul className="space-y-2">
              {detail.skipped.map((group) => (
                <li
                  key={`${group.reason}|${group.theaterName}`}
                  className="rounded-lg border border-gray-700 bg-gray-800/40 px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip>{SKIP_REASONS[group.reason]}</Chip>
                    <span className="break-words font-semibold text-white">
                      {group.theaterName || "(no theater name)"}
                    </span>
                    <span className="text-xs text-gray-500">
                      File {group.rowNumbers.length === 1 ? "row" : "rows"}{" "}
                      {group.rowNumbers.join(", ")}
                    </span>
                  </div>
                  {group.note && <p className="mt-1 break-words text-gray-400">{group.note}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <details className="rounded-lg border border-gray-700 bg-gray-800/40">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-white">
            Analysis trace ({plural(events.length, "event")})
          </summary>
          <div className="space-y-3 border-t border-gray-700 p-4">
            <p className="text-sm text-gray-300">{usageLine(detail)}</p>
            <EventFeed events={events} />
          </div>
        </details>
      </ModalBody>

      <ModalFooter>
        <div className="mr-auto min-w-0 flex-1 text-sm" aria-live="polite">
          {error ? (
            <Banner tone="error" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          ) : (
            editable && blockedReason && <span className="text-amber-300">{blockedReason}</span>
          )}
        </div>
        {editable && (
          <>
            <button
              type="button"
              onClick={() => void discard()}
              disabled={busy !== null}
              className={dangerButton}
            >
              {busy === "discard" ? "Discarding..." : "Discard"}
            </button>
            {hasFallbacks && detail.status === "ready" && (
              <button
                type="button"
                onClick={onRetryAnalysis}
                disabled={busy !== null || saving > 0}
                className={secondaryButton}
              >
                Retry AI analysis
              </button>
            )}
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy !== null || blockedReason !== null}
              className={primaryButton}
            >
              {busy === "apply"
                ? "Applying..."
                : busy === "replan"
                  ? "Rebuilding proposal..."
                  : acceptedChanges > 0
                    ? `Apply ${plural(acceptedChanges, "change")}`
                    : "Confirm with no changes"}
            </button>
          </>
        )}
      </ModalFooter>
    </>
  );
}

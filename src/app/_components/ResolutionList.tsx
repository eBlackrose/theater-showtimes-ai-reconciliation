"use client";

import type { PlanResolution } from "~/types/api";
import { CONFIDENCE_TONES } from "./PlanSection";
import { Chip, selectInput, type Tone } from "./ui";

const KIND_LABELS: Record<PlanResolution["kind"], string> = {
  movie: "Movie title",
  auditorium: "Room",
  reschedule: "Time change",
};

const METHODS: Record<PlanResolution["method"], { label: string; tone: Tone }> = {
  agent: { label: "AI", tone: "purple" },
  alias: { label: "Saved alias", tone: "gray" },
  human: { label: "You", tone: "blue" },
  fallback: { label: "Not resolved by AI", tone: "amber" },
};

export type ResolutionOverride = { outcome: PlanResolution["outcome"]; targetId?: string };

function decisionText(resolution: PlanResolution): string {
  const thing = resolution.kind === "movie" ? "movie" : "room";
  switch (resolution.outcome) {
    case "existing":
      return `Same as the existing ${thing} "${resolution.targetName}"`;
    case "new":
      return `A new ${thing}, created as "${resolution.targetName}"`;
    case "moved":
      return "The stored showing moved to the new time";
    case "separate":
      return "Two separate showings";
  }
}

/** The value of the override dropdown: "existing:<id>" for a catalog entry, else the outcome. */
const optionValue = (outcome: PlanResolution["outcome"], targetId: string | null) =>
  outcome === "existing" ? `existing:${targetId ?? ""}` : outcome;

interface ResolutionListProps {
  resolutions: PlanResolution[];
  theaterNames: Map<string, string>;
  editable: boolean;
  busy: boolean;
  onOverride: (resolutionId: string, override: ResolutionOverride) => void;
}

export function ResolutionList({
  resolutions,
  theaterNames,
  editable,
  busy,
  onOverride,
}: ResolutionListProps) {
  const choose = (resolution: PlanResolution, value: string) => {
    if (value === optionValue(resolution.outcome, resolution.targetId)) return;
    onOverride(
      resolution.id,
      value.startsWith("existing:")
        ? { outcome: "existing", targetId: value.slice("existing:".length) }
        : { outcome: value as PlanResolution["outcome"] },
    );
  };

  return (
    <ul className="space-y-2">
      {resolutions.map((resolution) => {
        const method = METHODS[resolution.method];
        const theater = resolution.theaterId ? theaterNames.get(resolution.theaterId) : null;
        // The current target stays selectable even when it was not among the candidates.
        const options =
          resolution.outcome === "existing" &&
          resolution.targetId &&
          !resolution.candidates.some((c) => c.id === resolution.targetId)
            ? [{ id: resolution.targetId, name: resolution.targetName }, ...resolution.candidates]
            : resolution.candidates;
        return (
          <li
            key={resolution.id}
            className={`rounded-lg border p-3 ${
              resolution.method === "fallback"
                ? "border-amber-500 bg-amber-950/30"
                : "border-gray-700 bg-gray-800/40"
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip>{KIND_LABELS[resolution.kind]}</Chip>
                  <span className="break-words font-semibold text-white">
                    {resolution.subjectRaw}
                  </span>
                  {theater && <span className="text-xs text-gray-400">{theater}</span>}
                </div>
                <p className="mt-1 break-words text-sm text-gray-200">{decisionText(resolution)}</p>
                {resolution.explanation && (
                  <p className="mt-1 whitespace-pre-line break-words text-sm text-gray-400">
                    {resolution.explanation}
                  </p>
                )}
                {resolution.candidates.length > 0 && (
                  <p className="mt-1 break-words text-xs text-gray-500">
                    Candidates considered:{" "}
                    {resolution.candidates
                      .map((c) =>
                        c.score === undefined ? c.name : `${c.name} (${c.score.toFixed(2)})`,
                      )
                      .join(", ")}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Chip tone={CONFIDENCE_TONES[resolution.confidence]}>
                    {resolution.confidence} confidence
                  </Chip>
                  <Chip tone={method.tone}>{method.label}</Chip>
                  {resolution.rowNumbers.length > 0 && (
                    <span className="text-xs text-gray-500">
                      File {resolution.rowNumbers.length === 1 ? "row" : "rows"}{" "}
                      {resolution.rowNumbers.join(", ")}
                    </span>
                  )}
                </div>
              </div>

              {editable && (
                <select
                  aria-label={`Change the decision for ${resolution.subjectRaw}`}
                  value={optionValue(resolution.outcome, resolution.targetId)}
                  onChange={(e) => choose(resolution, e.target.value)}
                  disabled={busy}
                  className={`${selectInput} max-w-xs`}
                >
                  {resolution.kind === "reschedule" ? (
                    <>
                      <option value="moved">Same showing, moved to the new time</option>
                      <option value="separate">Two separate showings</option>
                    </>
                  ) : (
                    <>
                      {options.map((candidate) => (
                        <option key={candidate.id} value={`existing:${candidate.id}`}>
                          Use: {candidate.name}
                        </option>
                      ))}
                      <option value="new">
                        Create new {resolution.kind === "movie" ? "movie" : "room"}
                      </option>
                    </>
                  )}
                </select>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

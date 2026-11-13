"use client";

import type { ImportDetail, ImportEvent } from "~/types/api";
import { EventFeed } from "./EventFeed";

const STAGES = [
  { id: "validate", label: "Validating file" },
  { id: "match", label: "Matching exact titles and saved aliases" },
  { id: "agent", label: "AI agent resolving unmatched titles and rooms" },
  { id: "plan", label: "Building the proposal" },
];

type StageState = "waiting" | "running" | "done" | "skipped";

const MARKS: Record<StageState, { mark: string; tone: string; label: string }> = {
  waiting: { mark: "○", tone: "border-gray-600 text-gray-500", label: "Waiting" },
  running: { mark: "…", tone: "animate-pulse border-purple-500 text-purple-300", label: "Running" },
  done: { mark: "✓", tone: "border-green-600 bg-green-900 text-green-300", label: "Done" },
  skipped: { mark: "–", tone: "border-gray-600 text-gray-500", label: "Skipped" },
};

/** Each stage's state and latest message, read from the `stage` events of the feed. */
function stageProgress(events: ImportEvent[], finished: boolean) {
  const latest = new Map<string, ImportEvent>();
  for (const event of events) {
    if (event.type === "stage" && typeof event.data.stage === "string") {
      latest.set(event.data.stage, event);
    }
  }
  const lastSeen = STAGES.reduce((last, stage, i) => (latest.has(stage.id) ? i : last), -1);
  return STAGES.map((stage, index) => {
    const event = latest.get(stage.id);
    let state: StageState;
    if (event) state = event.data.state === "done" ? "done" : "running";
    // A stage with no events that a later stage has passed did not run (no AI work, or no AI).
    else if (finished || index < lastSeen) state = "skipped";
    else state = lastSeen === -1 && index === 0 ? "running" : "waiting";
    return { ...stage, state, message: event?.message ?? null };
  });
}

/** "claude-sonnet-5-5 · 3 turns · 7 tool calls · 12,345 tokens · 8.2 s", or why there is none. */
export function usageLine(detail: ImportDetail): string {
  const usage = detail.usage;
  if (!usage) return "No AI model was called for this import: rule-based matching only.";
  return [
    detail.model ?? "AI model",
    `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`,
    `${usage.toolCalls} tool call${usage.toolCalls === 1 ? "" : "s"}`,
    `${(usage.inputTokens + usage.outputTokens).toLocaleString("en-US")} tokens (${usage.inputTokens.toLocaleString("en-US")} in, ${usage.outputTokens.toLocaleString("en-US")} out)`,
    `${(usage.durationMs / 1000).toFixed(1)} s`,
  ].join(" · ");
}

interface AnalysisViewProps {
  events: ImportEvent[];
  /** The finished import, once the analysis is done. */
  detail: ImportDetail | null;
}

export function AnalysisView({ events, detail }: AnalysisViewProps) {
  const stages = stageProgress(events, detail !== null);

  return (
    <>
      <ol className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        {stages.map((stage) => {
          const mark = MARKS[stage.state];
          return (
            <li key={stage.id} className="rounded-lg border border-gray-700 bg-gray-800/50 p-3">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${mark.tone}`}
                >
                  {mark.mark}
                </span>
                <span className="text-sm font-semibold text-white">{stage.label}</span>
              </div>
              <p className="mt-2 text-xs text-gray-400">
                <span className="font-semibold uppercase text-gray-500">{mark.label}</span>
                {stage.message ? ` · ${stage.message}` : ""}
              </p>
            </li>
          );
        })}
      </ol>

      <section aria-live="polite">
        <h3 className="mb-2 text-sm font-semibold uppercase text-gray-400">Activity</h3>
        <div className="max-h-[46vh] overflow-y-auto rounded-lg border border-gray-700 bg-gray-950/60 p-4">
          <EventFeed events={events} live={detail === null} />
        </div>
      </section>

      {detail && (
        <p className="rounded-lg border border-gray-700 bg-gray-800/50 px-4 py-3 text-sm text-gray-300">
          {usageLine(detail)}
        </p>
      )}
    </>
  );
}

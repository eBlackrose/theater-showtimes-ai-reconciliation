"use client";

import { useEffect, useRef } from "react";
import type { ImportEvent } from "~/types/api";

const KINDS: Record<string, { label: string; tone: string }> = {
  stage: { label: "Step", tone: "text-purple-300" },
  llm_turn: { label: "Model", tone: "text-gray-400" },
  tool_call: { label: "Lookup", tone: "text-gray-200" },
  resolution: { label: "Decision", tone: "text-green-300" },
  note: { label: "Note", tone: "text-gray-200" },
  warning: { label: "Warning", tone: "text-amber-300" },
  error: { label: "Error", tone: "text-red-400" },
};

const clock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const numberField = (data: Record<string, unknown>, key: string) =>
  typeof data[key] === "number" ? data[key] : null;

/** Token and timing figures of a model turn or tool call, when the event carries them. */
function metrics(event: ImportEvent): string {
  const input = numberField(event.data, "inputTokens");
  const output = numberField(event.data, "outputTokens");
  const ms = numberField(event.data, "ms");
  return [
    input !== null && output !== null ? `${input} in / ${output} out tokens` : null,
    ms !== null ? `${ms} ms` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The analysis trace. Messages come from the server, and partly from the model and the CSV,
 * so they are rendered as plain text only.
 */
export function EventFeed({ events, live = false }: { events: ImportEvent[]; live?: boolean }) {
  const end = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (live) end.current?.scrollIntoView({ block: "nearest" });
  }, [live, events.length]);

  if (events.length === 0) {
    return <p className="text-sm text-gray-500">{live ? "Waiting for activity..." : "No activity was recorded."}</p>;
  }

  return (
    <ol className="space-y-1.5 text-sm">
      {events.map((event) => {
        const kind = KINDS[event.type] ?? { label: event.type, tone: "text-gray-300" };
        const rejected = event.type === "resolution" && event.data.status === "rejected";
        const detail = metrics(event);
        return (
          <li key={event.id} className="flex gap-3">
            <span className="w-20 shrink-0 text-xs leading-5 text-gray-500">
              {clock.format(new Date(event.createdAt))}
            </span>
            <span className="w-16 shrink-0 text-xs font-semibold uppercase leading-5 text-gray-500">
              {kind.label}
            </span>
            <span
              className={`min-w-0 flex-1 whitespace-pre-line break-words ${
                rejected ? "text-amber-300" : kind.tone
              } ${event.data.summary === true ? "font-medium" : ""}`}
            >
              {event.message}
              {detail && <span className="ml-2 text-xs text-gray-500">{detail}</span>}
            </span>
          </li>
        );
      })}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

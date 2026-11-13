import { useCallback, useEffect, useRef, useState } from "react";
import { csvRowErrors, errorMessage, type ApiClient } from "~/lib/api-client";
import type {
  ApplyResponse,
  CsvRowError,
  ImportDetail,
  ImportEvent,
  ImportStatus,
} from "~/types/api";

export type ImportPhase =
  | { name: "loading" }
  | { name: "rejected"; message: string; rowErrors: CsvRowError[] }
  | { name: "analyzing"; done: boolean }
  | { name: "failed"; message: string; retryable: boolean }
  | { name: "review" }
  | { name: "result"; result: ApplyResponse };

const POLL_MS = 1000;
/** The server lets an analysis be re-claimed after five minutes; past that it is treated as failed. */
const STALE_MS = 5 * 60 * 1000;
const EVENTS_PAGE = 500;
const ANALYSIS_FAILED = "The analysis failed. You can retry it.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every event after `after`, following the server's paging to the end. */
async function fetchEvents(api: ApiClient, importId: string, after: number) {
  const events: ImportEvent[] = [];
  for (;;) {
    const page = await api.importEvents(importId, events.at(-1)?.id ?? after);
    events.push(...page.events);
    if (page.events.length < EVENTS_PAGE) return { status: page.status, events };
  }
}

/**
 * One import from upload to result: upload, analysis with a polled event feed, review, apply.
 * Everything starts from a user action, never from an effect, so a file is uploaded once.
 */
export function useImportFlow(api: ApiClient) {
  const [phase, setPhase] = useState<ImportPhase | null>(null);
  const [title, setTitle] = useState("");
  const [importId, setImportId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [events, setEvents] = useState<ImportEvent[]>([]);

  // Each upload, open, retry or close takes a new token; async work holding an old one stops.
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  const begin = useCallback((name: string, id: string | null) => {
    run.current += 1;
    setTitle(name);
    setImportId(id);
    setDetail(null);
    setEvents([]);
    setPhase({ name: "loading" });
    return run.current;
  }, []);

  /**
   * Follow an analysis until the import leaves `analyzing`. With `trigger` the analysis is
   * started here; the long request and the polling run side by side, and the polled status
   * decides the outcome, so a dropped connection does not lose a run that finished.
   */
  const watch = useCallback(
    async (
      token: number,
      id: string,
      options: { after: number; startedAt: number; trigger: boolean },
    ) => {
      setPhase({ name: "analyzing", done: false });
      const request = { settled: !options.trigger, failure: null as string | null };
      if (options.trigger) {
        void api
          .analyzeImport(id)
          .catch((cause: unknown) => {
            request.failure = errorMessage(cause);
          })
          .then(() => {
            request.settled = true;
          });
      }

      let after = options.after;
      while (run.current === token) {
        // Read before polling: a status seen after the request settled is final.
        const settled = request.settled;
        let status: ImportStatus | null = null;
        try {
          const page = await fetchEvents(api, id, after);
          if (run.current !== token) return;
          status = page.status;
          after = page.events.at(-1)?.id ?? after;
          if (page.events.length > 0) setEvents((current) => [...current, ...page.events]);
        } catch {
          // A missed poll is simply retried on the next tick.
        }

        if (settled && status && status !== "analyzing") {
          let failure = status === "ready" ? null : (request.failure ?? ANALYSIS_FAILED);
          if (!failure) {
            try {
              const next = await api.getImport(id);
              if (run.current !== token) return;
              setDetail(next);
            } catch (cause) {
              failure = errorMessage(cause);
            }
          }
          if (run.current !== token) return;
          setPhase(
            failure
              ? { name: "failed", message: failure, retryable: true }
              : { name: "analyzing", done: true },
          );
          return;
        }
        if (Date.now() - options.startedAt > STALE_MS) {
          setPhase({
            name: "failed",
            message: "The analysis did not finish within five minutes. You can retry it.",
            retryable: true,
          });
          return;
        }
        await sleep(POLL_MS);
      }
    },
    [api],
  );

  const upload = useCallback(
    async (file: File, scopeTheaterId: string | null) => {
      const token = begin(file.name, null);
      try {
        const created = await api.createImport(file, scopeTheaterId);
        if (run.current !== token) return;
        setImportId(created.importId);
        await watch(token, created.importId, { after: 0, startedAt: Date.now(), trigger: true });
      } catch (cause) {
        if (run.current !== token) return;
        setPhase({
          name: "rejected",
          message: errorMessage(cause),
          rowErrors: csvRowErrors(cause),
        });
      }
    },
    [api, begin, watch],
  );

  /** Open an import from the history: its plan, its decisions and its full trace. */
  const open = useCallback(
    async (id: string, filename: string) => {
      const token = begin(filename, id);
      try {
        const [next, trace] = await Promise.all([api.getImport(id), fetchEvents(api, id, 0)]);
        if (run.current !== token) return;
        setDetail(next);
        setEvents(trace.events);
        if (next.status === "analyzing") {
          await watch(token, id, {
            after: trace.events.at(-1)?.id ?? 0,
            startedAt: Date.parse(next.createdAt),
            trigger: false,
          });
        } else if (next.status === "uploaded" || next.status === "failed") {
          setPhase({
            name: "failed",
            message:
              next.error ??
              (next.status === "uploaded"
                ? "This file was uploaded but its analysis never ran. You can run it now."
                : ANALYSIS_FAILED),
            retryable: true,
          });
        } else {
          setPhase({ name: "review" });
        }
      } catch (cause) {
        if (run.current !== token) return;
        setPhase({ name: "failed", message: errorMessage(cause), retryable: false });
      }
    },
    [api, begin, watch],
  );

  /** Run the analysis again from the stored file. The feed restarts at the new run's events. */
  const retry = useCallback(async () => {
    if (!importId) return;
    run.current += 1;
    const after = events.at(-1)?.id ?? 0;
    setEvents([]);
    await watch(run.current, importId, { after, startedAt: Date.now(), trigger: true });
  }, [events, importId, watch]);

  const close = useCallback(() => {
    run.current += 1;
    setPhase(null);
  }, []);

  return {
    phase,
    title,
    detail,
    events,
    upload,
    open,
    retry,
    close,
    review: useCallback(() => setPhase({ name: "review" }), []),
    showResult: useCallback((result: ApplyResponse) => setPhase({ name: "result", result }), []),
    updateDetail: useCallback(
      (change: (current: ImportDetail) => ImportDetail) =>
        setDetail((current) => current && change(current)),
      [],
    ),
  };
}

export type ImportFlow = ReturnType<typeof useImportFlow>;

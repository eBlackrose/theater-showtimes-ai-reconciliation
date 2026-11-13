"use client";

import type { ApiClient } from "~/lib/api-client";
import { IMPORT_STATUS_LABELS, describeChanges, plural } from "~/lib/format";
import type { ImportFlow } from "~/lib/hooks/useImportFlow";
import type { ApplyResponse, CsvRowError } from "~/types/api";
import { AnalysisView } from "./AnalysisView";
import { EventFeed } from "./EventFeed";
import { ReviewView } from "./ReviewView";
import { Banner, Chip, Modal, ModalBody, ModalFooter, primaryButton } from "./ui";

interface ImportModalProps {
  api: ApiClient;
  flow: ImportFlow;
  /** Opens the file picker, so a rejected file can be replaced without leaving the dialog. */
  onChooseFile: () => void;
  onScheduleChanged: () => void;
}

export function ImportModal({ api, flow, onChooseFile, onScheduleChanged }: ImportModalProps) {
  const { phase, detail, events } = flow;
  if (!phase) return null;

  const subtitle =
    phase.name === "review" && detail
      ? `${IMPORT_STATUS_LABELS[detail.status]} · ${plural(detail.rowCount, "row")}${
          detail.theaters.length > 0 ? ` · ${detail.theaters.join(", ")}` : ""
        }`
      : phase.name === "analyzing"
        ? phase.done
          ? "Analysis finished"
          : "Analyzing the file..."
        : undefined;

  return (
    <Modal title={flow.title || "Import"} subtitle={subtitle} onClose={flow.close}>
      {phase.name === "loading" && (
        <ModalBody>
          <p className="animate-pulse text-sm text-gray-400" role="status">
            Loading...
          </p>
        </ModalBody>
      )}

      {phase.name === "rejected" && (
        <>
          <ModalBody>
            <Banner tone="error">{phase.message}</Banner>
            {phase.rowErrors.length > 0 && <RowErrors errors={phase.rowErrors} />}
          </ModalBody>
          <ModalFooter>
            <span className="mr-auto text-sm text-gray-400">
              Nothing was stored. Fix the file, or choose another one.
            </span>
            <button type="button" onClick={onChooseFile} className={primaryButton}>
              Choose another file
            </button>
          </ModalFooter>
        </>
      )}

      {phase.name === "analyzing" && (
        <>
          <ModalBody>
            <AnalysisView events={events} detail={phase.done ? detail : null} />
          </ModalBody>
          <ModalFooter>
            <span className="mr-auto text-sm text-gray-400">
              {phase.done
                ? "The proposal is ready. Nothing changes until you apply it."
                : "You can close this window: the analysis keeps running and appears in the import history."}
            </span>
            <button
              type="button"
              onClick={flow.review}
              disabled={!phase.done}
              className={primaryButton}
            >
              {phase.done ? "Review proposal" : "Analyzing..."}
            </button>
          </ModalFooter>
        </>
      )}

      {phase.name === "failed" && (
        <>
          <ModalBody>
            <Banner tone="error">{phase.message}</Banner>
            {events.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold uppercase text-gray-400">Activity</h3>
                <div className="rounded-lg border border-gray-700 bg-gray-950/60 p-4">
                  <EventFeed events={events} />
                </div>
              </section>
            )}
          </ModalBody>
          {phase.retryable && (
            <ModalFooter>
              <button type="button" onClick={() => void flow.retry()} className={primaryButton}>
                Retry analysis
              </button>
            </ModalFooter>
          )}
        </>
      )}

      {phase.name === "review" && detail && (
        <ReviewView
          api={api}
          detail={detail}
          events={events}
          onDetail={flow.updateDetail}
          onApplied={flow.showResult}
          onScheduleChanged={onScheduleChanged}
          onRetryAnalysis={() => void flow.retry()}
          onClose={flow.close}
        />
      )}

      {phase.name === "result" && (
        <>
          <ModalBody>
            <ApplyResult result={phase.result} />
          </ModalBody>
          <ModalFooter>
            <button type="button" onClick={flow.close} className={primaryButton}>
              Done
            </button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

function RowErrors({ errors }: { errors: CsvRowError[] }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase text-gray-400">
        {plural(errors.length, "problem")} in the file
      </h3>
      <div className="overflow-x-auto rounded-lg border border-gray-700">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-800 text-xs uppercase text-gray-400">
            <tr>
              <th className="px-4 py-2">Row</th>
              <th className="px-4 py-2">Field</th>
              <th className="px-4 py-2">Problem</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((error, index) => (
              <tr key={index} className="border-t border-gray-700">
                <td className="px-4 py-2 text-gray-300">{error.row}</td>
                <td className="px-4 py-2 text-gray-300">{error.field ?? "(whole row)"}</td>
                <td className="break-words px-4 py-2 text-red-300">{error.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ApplyResult({ result }: { result: ApplyResponse }) {
  return (
    <>
      <Banner tone="success">
        The import is {IMPORT_STATUS_LABELS[result.status].toLowerCase()}. The showtimes table has
        been refreshed.
      </Banner>
      <ul className="space-y-2">
        {result.theaters.map((theater) => (
          <li
            key={theater.theaterId}
            className="rounded-lg border border-gray-700 bg-gray-800/40 px-4 py-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-white">{theater.theaterName}</span>
              <Chip tone={theater.status === "applied" ? "green" : "red"}>{theater.status}</Chip>
            </div>
            <p className="mt-1 text-gray-300">
              {describeChanges(theater.applied)}
              {theater.skipped > 0 ? ` · ${theater.skipped} skipped` : ""}
            </p>
            {theater.message && <p className="mt-1 text-amber-300">{theater.message}</p>}
          </li>
        ))}
      </ul>
      {result.theaters.length === 0 && (
        <p className="text-sm text-gray-400">No theater had anything left to apply.</p>
      )}
    </>
  );
}

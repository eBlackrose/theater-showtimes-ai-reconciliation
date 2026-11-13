"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage, type ApiClient } from "~/lib/api-client";
import { plural } from "~/lib/format";
import { useImportFlow } from "~/lib/hooks/useImportFlow";
import { useShowtimes } from "~/lib/hooks/useShowtimes";
import type { AssessmentUser, Theater } from "~/types/assessment";
import { FilterBar } from "./FilterBar";
import { HistoryModal } from "./HistoryModal";
import { ImportModal } from "./ImportModal";
import { ShowtimesTable } from "./ShowtimesTable";
import { Toolbar } from "./Toolbar";
import { Banner, selectInput } from "./ui";

interface ConsoleProps {
  api: ApiClient;
  user: AssessmentUser;
  /** Whether the server allows restoring the demo seed. */
  demoReset: boolean;
  /** Called after the demo data was restored, so the session reloads its users too. */
  onDemoReset: () => void;
}

/** Everything below the header for one signed-in user. Remounted when the user changes. */
export function Console({ api, user, demoReset, onDemoReset }: ConsoleProps) {
  const isAdmin = user.role === "admin";
  const [theaters, setTheaters] = useState<Theater[] | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<"sample" | "clear" | "reset" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const table = useShowtimes(api);
  const flow = useImportFlow(api);
  const { theaterId } = table.query;
  const scopeTheater = theaters?.find((theater) => theater.id === theaterId) ?? null;

  useEffect(() => {
    let cancelled = false;
    api.me().then(
      (me) => {
        if (!cancelled) setTheaters(me.theaters);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setTheaters([]);
        setNotice({ tone: "error", text: `Your theaters could not be loaded. ${errorMessage(cause)}` });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const upload = (file: File) => {
    setNotice(null);
    void flow.upload(file, scopeTheater?.id ?? null);
  };

  const uploadSample = async (name: string) => {
    setBusy("sample");
    setNotice(null);
    try {
      const response = await fetch(`/samples/${name}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      upload(new File([await response.blob()], name, { type: "text/csv" }));
    } catch {
      setNotice({ tone: "error", text: `The sample file ${name} could not be loaded.` });
    } finally {
      setBusy(null);
    }
  };

  const clearSchedule = async () => {
    if (!scopeTheater) return;
    if (!window.confirm(`Archive every showtime of ${scopeTheater.name}?`)) return;
    setBusy("clear");
    setNotice(null);
    try {
      const { archived } = await api.clearSchedule(scopeTheater.id);
      setNotice({
        tone: "success",
        text: `${plural(archived, "showtime")} of ${scopeTheater.name} archived.`,
      });
      table.reload();
    } catch (cause) {
      setNotice({ tone: "error", text: `The schedule was not cleared. ${errorMessage(cause)}` });
    } finally {
      setBusy(null);
    }
  };

  const resetDemo = async () => {
    if (!window.confirm("Restore the demo data? All showtimes, imports and saved aliases go back to the seed.")) {
      return;
    }
    setBusy("reset");
    setNotice(null);
    try {
      await api.resetDemo();
      setNotice({ tone: "success", text: "The demo data was restored." });
      table.reload();
      onDemoReset();
    } catch (cause) {
      setNotice({ tone: "error", text: `The demo data was not restored. ${errorMessage(cause)}` });
    } finally {
      setBusy(null);
    }
  };

  const noTheaters = theaters?.length === 0;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label htmlFor="theater-scope" className="text-xs font-semibold uppercase text-gray-400">
            Theater Scope
          </label>
          <select
            id="theater-scope"
            value={theaterId}
            onChange={(e) => table.update({ theaterId: e.target.value })}
            disabled={!theaters?.length}
            className={selectInput}
          >
            <option value="all">All accessible theaters</option>
            {theaters?.map((theater) => (
              <option key={theater.id} value={theater.id}>
                {theater.name}
              </option>
            ))}
          </select>
        </div>

        {isAdmin && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Reset the input so the same file can be chosen again.
                event.target.value = "";
                if (file) upload(file);
              }}
            />
            <Toolbar
              uploadBlocked={
                theaters === null
                  ? "Loading your theaters..."
                  : noTheaters
                    ? "You do not manage any theaters."
                    : null
              }
              clearBlocked={
                scopeTheater ? null : "Select a single theater to clear its schedule."
              }
              busy={busy}
              showReset={demoReset}
              onUpload={() => fileInput.current?.click()}
              onSample={(name) => void uploadSample(name)}
              onClear={() => void clearSchedule()}
              onHistory={() => setHistoryOpen(true)}
              onReset={() => void resetDemo()}
            />
          </>
        )}

        <div className="ml-auto text-sm text-gray-400">
          {table.list && table.list.total > 0 && (
            <>
              {plural(table.list.total, "showtime")}
              {theaterId === "all" ? " across theaters" : ""}
            </>
          )}
        </div>
      </div>

      {isAdmin && (
        <p className="-mt-3 mb-6 text-xs text-gray-500">
          {scopeTheater
            ? `Uploads apply to ${scopeTheater.name} only; rows for other theaters are skipped.`
            : "Uploads apply to every theater you manage that appears in the file."}
        </p>
      )}

      {!isAdmin && (
        <div className="mb-6 rounded-lg border border-gray-700 bg-gray-900 p-4 text-sm text-gray-400">
          You are in read-only mode. Admin users can upload CSVs and update movie status.
        </div>
      )}

      {notice && (
        <div className="mb-6">
          <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
            {notice.text}
          </Banner>
        </div>
      )}

      {theaters === null ? (
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-8 text-center text-gray-400">
          Loading...
        </div>
      ) : noTheaters ? (
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-8 text-center text-gray-400">
          This user does not belong to any theaters yet.
        </div>
      ) : (
        <>
          <FilterBar
            filters={table.query.filters}
            options={table.options}
            onChange={(filters) => table.update({ filters })}
          />
          <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
            <ShowtimesTable table={table} theaters={theaters} isAdmin={isAdmin} />
          </div>
        </>
      )}

      {historyOpen && !flow.phase && (
        <HistoryModal
          api={api}
          onOpen={(item) => void flow.open(item.id, item.filename)}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      <ImportModal
        api={api}
        flow={flow}
        onChooseFile={() => fileInput.current?.click()}
        onScheduleChanged={table.reload}
      />
    </>
  );
}

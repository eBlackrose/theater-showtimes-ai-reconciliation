"use client";

import { useEffect, useState } from "react";
import { errorMessage, type ApiClient } from "~/lib/api-client";
import { IMPORT_STATUS_LABELS, describeChanges, formatDateTime } from "~/lib/format";
import type { ImportListItem, ImportStatus } from "~/types/api";
import { Banner, Chip, Modal, ModalBody, secondaryButton, type Tone } from "./ui";

const STATUS_TONES: Record<ImportStatus, Tone> = {
  uploaded: "gray",
  analyzing: "purple",
  ready: "blue",
  applying: "purple",
  applied: "green",
  partially_applied: "yellow",
  discarded: "gray",
  failed: "red",
};

interface HistoryModalProps {
  api: ApiClient;
  onOpen: (item: ImportListItem) => void;
  onClose: () => void;
}

export function HistoryModal({ api, onOpen, onClose }: HistoryModalProps) {
  const [items, setItems] = useState<ImportListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listImports().then(
      (list) => {
        if (!cancelled) setItems(list);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <Modal title="Import history" subtitle="Newest first. Open one to see its proposal, decisions and trace." onClose={onClose}>
      <ModalBody>
        {error && <Banner tone="error">The history could not be loaded. {error}</Banner>}
        {!error && !items && (
          <p className="animate-pulse text-sm text-gray-400" role="status">
            Loading imports...
          </p>
        )}
        {items?.length === 0 && (
          <p className="rounded-lg border border-gray-700 bg-gray-800/40 p-8 text-center text-sm text-gray-400">
            No files have been uploaded yet.
          </p>
        )}
        {items && items.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-800 text-xs uppercase text-gray-400">
                <tr>
                  <th className="px-4 py-3">File</th>
                  <th className="px-4 py-3">Uploaded by</th>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Proposed changes</th>
                  <th className="px-4 py-3">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-t border-gray-700 hover:bg-gray-800">
                    <td className="px-4 py-3">
                      <span className="break-all font-medium text-white">{item.filename}</span>
                      <span className="block text-xs text-gray-500">
                        {item.rowCount} rows
                        {item.theaters.length > 0 ? ` · ${item.theaters.join(", ")}` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">{item.createdBy}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-300">
                      {formatDateTime(item.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Chip tone={STATUS_TONES[item.status]}>
                        {IMPORT_STATUS_LABELS[item.status]}
                      </Chip>
                      <span className="mt-1 block text-xs text-gray-500">
                        {item.mode === "ai"
                          ? `AI: ${item.model ?? "model"}`
                          : item.mode === "rules_only"
                            ? "Rules only"
                            : ""}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      {describeChanges(item.counts)}
                      <span className="block text-xs text-gray-500">
                        {item.counts.unchanged} unchanged · {item.counts.duplicate} duplicate ·{" "}
                        {item.counts.skippedRows} skipped
                        {item.counts.pending > 0 ? ` · ${item.counts.pending} undecided` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={() => onOpen(item)} className={secondaryButton}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ModalBody>
    </Modal>
  );
}

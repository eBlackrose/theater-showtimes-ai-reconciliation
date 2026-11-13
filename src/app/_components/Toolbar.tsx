"use client";

import { useEffect, useRef, useState } from "react";
import { dangerButton, secondaryButton } from "./ui";

/** The files in `public/samples`, uploaded exactly like a file chosen from disk. */
const SAMPLES = [
  { file: "existing.csv", description: "The original Downtown schedule. Restores it after Clear Schedule." },
  { file: "new-drop.csv", description: "A partner update with respelled rooms, one new show and a duplicate." },
  { file: "ai-messy-drop.csv", description: "Typos, sequels and renamed rooms: the main AI demo." },
  { file: "multi-theater-drop.csv", description: "Several theaters in one file, one unknown. Use with all theaters selected." },
  { file: "invalid-drop.csv", description: "Bad dates and an empty title: rejected with row errors." },
  { file: "injection-drop.csv", description: "A title that tries to give the AI instructions. Nothing is obeyed." },
];

interface ToolbarProps {
  /** Why uploading is not possible right now, or null when it is. */
  uploadBlocked: string | null;
  /** Why clearing is not possible right now, or null when it is. */
  clearBlocked: string | null;
  busy: "sample" | "clear" | "reset" | null;
  showReset: boolean;
  onUpload: () => void;
  onSample: (file: string) => void;
  onClear: () => void;
  onHistory: () => void;
  onReset: () => void;
}

export function Toolbar({
  uploadBlocked,
  clearBlocked,
  busy,
  showReset,
  onUpload,
  onSample,
  onClear,
  onHistory,
  onReset,
}: ToolbarProps) {
  const working = busy !== null;

  return (
    <>
      <button
        type="button"
        onClick={onUpload}
        disabled={working || uploadBlocked !== null}
        title={uploadBlocked ?? undefined}
        className="rounded-lg bg-purple-600 px-6 py-3 font-semibold text-white transition hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Upload CSV
      </button>
      <SampleMenu
        disabled={working || uploadBlocked !== null}
        loading={busy === "sample"}
        onSample={onSample}
      />
      <button
        type="button"
        onClick={onClear}
        disabled={working || clearBlocked !== null}
        title={clearBlocked ?? undefined}
        className={`${dangerButton} px-6 py-3 text-base`}
      >
        {busy === "clear" ? "Clearing..." : "Clear Schedule"}
      </button>
      <button type="button" onClick={onHistory} className={`${secondaryButton} py-3`}>
        Import history
      </button>
      {showReset && (
        <button
          type="button"
          onClick={onReset}
          disabled={working}
          className={`${secondaryButton} py-3`}
        >
          {busy === "reset" ? "Resetting..." : "Reset demo data"}
        </button>
      )}
    </>
  );
}

interface SampleMenuProps {
  disabled: boolean;
  loading: boolean;
  onSample: (file: string) => void;
}

function SampleMenu({ disabled, loading, onSample }: SampleMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${secondaryButton} py-3`}
      >
        {loading ? "Loading sample..." : "Try a sample ▾"}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-40 mt-2 w-96 max-w-[90vw] rounded-lg border border-gray-600 bg-gray-900 p-1 shadow-2xl"
        >
          {SAMPLES.map((sample) => (
            <button
              key={sample.file}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSample(sample.file);
              }}
              className="block w-full rounded-md px-3 py-2 text-left hover:bg-gray-800"
            >
              <span className="block text-sm font-semibold text-white">{sample.file}</span>
              <span className="block text-xs text-gray-400">{sample.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

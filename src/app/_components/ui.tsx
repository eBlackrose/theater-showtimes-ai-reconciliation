"use client";

import { useEffect, useRef, type ReactNode } from "react";

export const primaryButton =
  "rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryButton =
  "rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50";
export const dangerButton =
  "rounded-lg border border-red-600 px-4 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-50";
export const selectInput =
  "rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50";

export type Tone = "gray" | "green" | "yellow" | "red" | "purple" | "amber" | "blue";

const CHIP_TONES: Record<Tone, string> = {
  gray: "bg-gray-700 text-gray-200",
  green: "bg-green-900 text-green-300",
  yellow: "bg-yellow-900 text-yellow-200",
  red: "bg-red-900 text-red-300",
  purple: "bg-purple-900 text-purple-200",
  amber: "bg-amber-500 text-gray-950",
  blue: "bg-sky-900 text-sky-200",
};

export function Chip({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

const BANNER_TONES = {
  error: "border-red-800 bg-red-950/60 text-red-200",
  warning: "border-amber-700 bg-amber-950/50 text-amber-100",
  info: "border-gray-700 bg-gray-900 text-gray-300",
  success: "border-green-800 bg-green-950/50 text-green-200",
};

export function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: keyof typeof BANNER_TONES;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${BANNER_TONES[tone]}`}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded px-1 text-base leading-none opacity-70 hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
}

/** A full-height dialog. Children are a scrolling `ModalBody` and an optional `ModalFooter`. */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex h-[92vh] w-full max-w-6xl flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl focus:outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-700 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold text-white">{title}</h2>
            {subtitle && <div className="mt-1 text-sm text-gray-400">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} className={secondaryButton}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ModalBody({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">{children}</div>;
}

export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-gray-700 px-6 py-4">
      {children}
    </div>
  );
}

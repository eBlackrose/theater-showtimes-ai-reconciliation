import { normalizeKey } from "./normalize";
import type { ParsedRow, ScopedRow, TheaterInfo } from "./types";

export interface ScopeActor {
  role: "admin" | "viewer";
  theaterIds: string[];
}

/** Dice similarity over character bigrams: enough for a "did you mean" suggestion. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      out.set(gram, (out.get(gram) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const [gram, count] of ga) shared += Math.min(count, gb.get(gram) ?? 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * Decide, row by row, whether the actor may write it. Skipped rows are reported and never
 * written, and a theater without in-scope rows is never archived from.
 */
export function scopeRows(
  rows: ParsedRow[],
  actor: ScopeActor,
  scopeTheaterId: string | null,
  theaters: TheaterInfo[],
): ScopedRow[] {
  const byKey = new Map(
    theaters.map((theater) => [theater.normalizedName, theater]),
  );
  const managed = new Set(actor.role === "admin" ? actor.theaterIds : []);

  return rows.map((row): ScopedRow => {
    if (!row.theaterName && scopeTheaterId) {
      const allowed = managed.has(scopeTheaterId);
      return {
        ...row,
        disposition: allowed ? "in_scope" : "skipped_no_access",
        theaterId: scopeTheaterId,
        note: allowed ? null : "You do not manage the selected theater.",
      };
    }
    const key = normalizeKey(row.theaterName);
    const theater = byKey.get(key);
    if (!theater) {
      const nearest = theaters
        .map((candidate) => ({
          name: candidate.name,
          score: similarity(key, candidate.normalizedName),
        }))
        .sort((a, b) => b.score - a.score)[0];
      return {
        ...row,
        disposition: "skipped_unknown_theater",
        theaterId: null,
        note:
          nearest && nearest.score >= 0.3
            ? `No theater is named "${row.theaterName}". Did you mean "${nearest.name}"?`
            : `No theater is named "${row.theaterName}".`,
      };
    }
    if (!managed.has(theater.id)) {
      return {
        ...row,
        disposition: "skipped_no_access",
        theaterId: theater.id,
        note: `You do not manage ${theater.name}.`,
      };
    }
    if (scopeTheaterId && theater.id !== scopeTheaterId) {
      return {
        ...row,
        disposition: "skipped_out_of_scope",
        theaterId: theater.id,
        note: `This row is for ${theater.name}, not the selected theater.`,
      };
    }
    return { ...row, disposition: "in_scope", theaterId: theater.id, note: null };
  });
}

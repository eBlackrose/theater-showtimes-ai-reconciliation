import { cleanText, normalizeKey } from "./normalize";
import {
  resolutionKey,
  type CatalogSnapshot,
  type Resolution,
  type ScopedRow,
} from "./types";

export const NEW_PREFIX = "new:";
export const isNewRef = (ref: string) => ref.startsWith(NEW_PREFIX);

export interface RefResult {
  /** An existing id, or `new:<normalized key>`. */
  ref: string;
  /** Canonical display name. Partner spellings never replace it. */
  name: string;
  subjectKey: string;
  via: "exact" | "alias" | "agent" | "human" | "fallback" | "unresolved";
  /** Present when the match came from a saved alias, the agent, a human or a fallback. */
  resolution: Resolution | null;
}

export interface Subject {
  kind: "movie" | "auditorium";
  theaterId: string | null;
  subjectKey: string;
  raws: string[];
  rowNumbers: number[];
}

/**
 * Turns a raw title or room name into a reference. Order: a resolution stored for this
 * import, then an exact normalized match, then a saved alias, else unresolved.
 */
export class Resolver {
  private readonly stored = new Map<string, Resolution>();

  constructor(
    readonly catalog: CatalogSnapshot,
    resolutions: Resolution[],
  ) {
    for (const resolution of resolutions) {
      this.stored.set(
        resolutionKey(resolution.kind, resolution.theaterId, resolution.subjectKey),
        resolution,
      );
    }
  }

  movieName(ref: string): string {
    return this.catalog.movieTitles.get(ref) ?? ref;
  }

  roomName(theaterId: string, ref: string): string {
    return this.catalog.rooms.get(theaterId)?.byId.get(ref) ?? ref;
  }

  reschedule(theaterId: string, subjectKey: string): Resolution | undefined {
    return this.stored.get(resolutionKey("reschedule", theaterId, subjectKey));
  }

  movie(rawTitle: string): RefResult {
    const { movieTitles, movieByKey, movieAliasByKey } = this.catalog;
    return this.resolve({
      kind: "movie",
      theaterId: null,
      raw: rawTitle,
      names: movieTitles,
      byKey: movieByKey,
      aliasByKey: movieAliasByKey,
    });
  }

  auditorium(theaterId: string, rawName: string): RefResult {
    const rooms = this.catalog.rooms.get(theaterId);
    return this.resolve({
      kind: "auditorium",
      theaterId,
      raw: rawName,
      names: rooms?.byId ?? new Map<string, string>(),
      byKey: rooms?.byKey ?? new Map<string, string>(),
      aliasByKey: rooms?.aliasByKey ?? new Map<string, string>(),
    });
  }

  private resolve(input: {
    kind: "movie" | "auditorium";
    theaterId: string | null;
    raw: string;
    names: Map<string, string>;
    byKey: Map<string, string>;
    aliasByKey: Map<string, string>;
  }): RefResult {
    const { kind, theaterId, raw, names, byKey, aliasByKey } = input;
    const subjectKey = normalizeKey(raw);
    const cleaned = cleanText(raw);

    const stored = this.stored.get(resolutionKey(kind, theaterId, subjectKey));
    if (stored && stored.method !== "alias") {
      const via = stored.method;
      if (stored.outcome.type === "existing" && names.has(stored.outcome.id)) {
        const id = stored.outcome.id;
        return { ref: id, name: names.get(id) ?? id, subjectKey, via, resolution: stored };
      }
      if (stored.outcome.type === "new") {
        const name = cleanText(stored.outcome.name) || cleaned;
        const key = normalizeKey(name);
        // A "new" name that already exists is that existing entry, never a second copy.
        const existingId = byKey.get(key);
        return existingId
          ? {
              ref: existingId,
              name: names.get(existingId) ?? name,
              subjectKey,
              via,
              resolution: stored,
            }
          : { ref: NEW_PREFIX + key, name, subjectKey, via, resolution: stored };
      }
    }

    const exactId = byKey.get(subjectKey);
    if (exactId) {
      return {
        ref: exactId,
        name: names.get(exactId) ?? cleaned,
        subjectKey,
        via: "exact",
        resolution: null,
      };
    }

    const aliasId = aliasByKey.get(subjectKey);
    if (aliasId && names.has(aliasId)) {
      const name = names.get(aliasId) ?? cleaned;
      return {
        ref: aliasId,
        name,
        subjectKey,
        via: "alias",
        resolution: {
          kind,
          theaterId,
          subjectKey,
          subjectRaw: cleaned,
          rowNumbers: [],
          outcome: { type: "existing", id: aliasId },
          method: "alias",
          confidence: "high",
          explanation: `"${cleaned}" is a saved alias of "${name}".`,
          candidates: [],
        },
      };
    }

    return {
      ref: NEW_PREFIX + subjectKey,
      name: cleaned,
      subjectKey,
      via: "unresolved",
      resolution: null,
    };
  }
}

/**
 * One pass over the in-scope rows: which subjects still need a decision (one per distinct
 * key, not per row), and which were matched through saved aliases.
 */
export function surveyRows(rows: ScopedRow[], resolver: Resolver) {
  const unresolved = new Map<string, Subject>();
  const aliasHits = new Map<string, Resolution>();

  const note = (
    result: RefResult,
    kind: "movie" | "auditorium",
    theaterId: string | null,
    raw: string,
    rowNumber: number,
  ) => {
    const key = resolutionKey(kind, theaterId, result.subjectKey);
    if (result.via === "unresolved") {
      const subject = unresolved.get(key) ?? {
        kind,
        theaterId,
        subjectKey: result.subjectKey,
        raws: [],
        rowNumbers: [],
      };
      if (!subject.raws.includes(raw)) subject.raws.push(raw);
      subject.rowNumbers.push(rowNumber);
      unresolved.set(key, subject);
    } else if (result.via === "alias" && result.resolution) {
      const hit = aliasHits.get(key) ?? { ...result.resolution, rowNumbers: [] };
      hit.rowNumbers.push(rowNumber);
      aliasHits.set(key, hit);
    }
  };

  for (const row of rows) {
    if (row.disposition !== "in_scope" || !row.theaterId) continue;
    note(resolver.movie(row.title), "movie", null, row.title, row.rowNumber);
    note(
      resolver.auditorium(row.theaterId, row.auditorium),
      "auditorium",
      row.theaterId,
      row.auditorium,
      row.rowNumber,
    );
  }
  return {
    unresolved: [...unresolved.values()],
    aliasHits: [...aliasHits.values()],
  };
}

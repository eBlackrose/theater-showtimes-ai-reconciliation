const NUMBER_WORDS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};
const SEQUEL_MARKERS = "part|chapter|episode|volume|vol";
const SEQUEL_NUMBER = new RegExp(
  `\\b(${SEQUEL_MARKERS})\\s+(${Object.keys(NUMBER_WORDS).join("|")})\\b`,
  "g",
);

/** What we store and show: Unicode-normalized, single-spaced, trimmed. */
export const cleanText = (raw: string | null | undefined) =>
  (raw ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();

/**
 * Matching key for titles, room names and theater names.
 *
 * Conservative on purpose: only equivalences that are always safe live here (case, accents,
 * punctuation, spacing, a number word after a sequel marker). Typos, roman numerals,
 * abbreviations and edition tags are left to the agent, because a wrong rule would merge
 * two different films silently.
 */
export function normalizeKey(raw: string | null | undefined): string {
  let key = cleanText(raw).normalize("NFKD").replace(/\p{M}+/gu, "");
  key = key
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  key = key.replace(
    SEQUEL_NUMBER,
    (_match, marker: string, word: string) =>
      `${marker === "vol" ? "volume" : marker} ${NUMBER_WORDS[word]}`,
  );
  return key.replace(/\s+/g, " ").trim();
}

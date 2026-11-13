# Sample files

Each file is also served from `/samples/` for the console's **Try a sample** menu. Expected results are against a fresh seed (use **Reset demo data**), uploaded as **Avery Admin** with **Downtown Cinema 7** selected unless noted. Every expectation below was verified by a test or an eval run; the last column says which.

| File | What it shows | Expected result | Verified by |
|---|---|---|---|
| `existing.csv` | The current Downtown schedule for March 15 as the partner sends it. | On a fresh seed: 3 unchanged, 1 update (Dune 1:00 PM, format IMAX → 2D), 2 restores (Wonka, Oppenheimer). After **Clear Schedule**: 6 restores. No AI call (every title and room matches exactly). | `tests/unit/plan.test.ts`, `tests/integration/imports.test.ts` |
| `new-drop.csv` | Messy spellings and room names, a new showtime in a new room, an in-file duplicate. | 4 unchanged, 1 add (Kung Fu Panda 4, 11:30 AM, Auditorium 5), 1 duplicate, 0 archives. The agent resolves four room names: "Aud 1", "Auditorium Two", "Auditorium 1 (Laser)" to existing rooms and "Auditorium 5" as new. Upload it again after applying: no AI call, no changes. | `evals/cases/01-new-drop.json`, `npm run smoke` |
| `ai-messy-drop.csv` | Typos, roman numerals, an edition tag, a film that is not in the catalog, a semantic duplicate, a showing that moved 15 minutes. | 3 unchanged, 3 adds (Dune at 8:00 AM, Kung Fu Panda 4, Challengers), 1 reschedule (Inside Out 2, 10:30 AM → 10:45 AM), 1 duplicate ("Kung-Fu Panda 4" and "Kung Fu Panda IV" are the same showtime), 0 archives. "Dune" stays a different film from "Dune: Part Two". | `evals/cases/02-ai-messy-drop.json` |
| `multi-theater-drop.csv` | One file for several theaters. Upload with **All accessible theaters**. | As Avery: 4 adds in two sections (Downtown, Riverside); the Uptown row is skipped (no access), the "Lakeside Drive-In" row is skipped (unknown theater); no archives. As Casey Operator: 5 adds in three sections, 1 skipped. No AI call. | `tests/integration/imports.test.ts` |
| `invalid-drop.csv` | A file that must be rejected. | 422 with three row errors (row 3: start time is not ISO 8601; row 4: end before start; row 5: empty title). Nothing is stored, no AI call. | `tests/unit/normalize-csv-scope-window.test.ts` |
| `injection-drop.csv` | A title cell with instructions and a room cell with SQL. | The odd title is proposed as a new movie and the odd room as a new room, both low confidence and waiting for a decision under the "new movie / new room" warnings; 0 archives; nothing in the file is followed. | `evals/cases/03-injection.json` |

## The base README scenario

**Clear Schedule**, then `existing.csv`, then `new-drop.csv`:

1. `existing.csv` restores the six archived March 15 showtimes (same ids, same movie status). The March 16 showtime stays archived because the file does not cover that date.
2. `new-drop.csv` then gives 1 add, 1 update (Dune 1:00 PM, format 2D → IMAX), 2 archives (Wonka, Oppenheimer), 1 duplicate, 3 unchanged.

The base mock showed three updates for this file because it counted spelling changes ("Spider Man - Homecoming", "Aud 1") as updates. Here a spelling variant is a *matched alias* with no data change: the clean title and room name stay as they are, and the partner's spelling is saved as an alias.

Times above are theater-local (America/Los_Angeles); the files use UTC.

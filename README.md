# Theater Showtimes Manager: AI CSV reconciliation

A theater management console where an admin uploads a partner CSV of showtimes and an LLM agent reconciles it with the stored schedule: it resolves messy titles and room names, the system proposes adds, updates, reschedules, archives and duplicates with a plain-language reason for each, and nothing is written until the admin reviews and confirms. It extends the Scope Labs backend assessment (a frontend-only Next.js app) with a real backend on Postgres and a real model in the product path.

**Live:** <!-- TODO(Ronnie): add the Vercel URL after the first deploy -->

## Two-minute walkthrough

1. Pick **Avery Admin** and theater **Downtown Cinema 7**. Open **Try a sample → new-drop.csv**. Watch the agent work (model, turns, tool calls), read the proposal, press **Apply**.
2. Upload `new-drop.csv` again. This time no AI call is made and nothing changes: the room names the agent resolved were saved as aliases when you confirmed them.
3. Try `ai-messy-drop.csv`: typos ("Spiderman Homecomming"), roman numerals, an edition tag, a film that is not in the catalog, two spellings of one showtime, and a showing that moved 15 minutes.
4. Switch the theater to **All accessible theaters** and try `multi-theater-drop.csv` as Avery, then as **Casey Operator**. Rows for theaters you cannot manage are listed as skipped and never written.
5. `invalid-drop.csv` is rejected with every row error. `injection-drop.csv` has a title cell that tells the model to archive everything; it becomes a flagged "new movie" proposal and nothing else happens.
6. Open **Import history** to see past imports with every decision, result and the agent's trace. Switch to **Riley Viewer** for the read-only view.
7. **Reset demo data** puts everything back.

Expected results for each sample are in [sample-data/README.md](sample-data/README.md).

## How it works

**The model proposes meaning. Code decides everything else.**

The agent only answers semantic questions: is this title the same film as that one, is "Aud 1" the same room as "Auditorium 1", did this showing move or is it a new one. It answers with a decision, a confidence and a short explanation, through one tool whose input the server validates. Its other tools are read-only lookups. Parsing, validation, permissions, exact matching, turning resolutions into actions, every invariant and every write are deterministic code.

```
Browser (console UI)
   |  X-User-Id header, same-origin /api/*
   v
Route handlers (thin: zod parse, actor, error mapping)
   |
   v
imports service ------------------------------------------------------+
   | 1 create     parse + validate CSV, store raw file, scope rows     |
   | 2 analyze    a) deterministic resolve (exact, saved aliases)      |
   |              b) AGENT resolves what is left (tools, guardrails)   |--> import_events (trace)
   |              c) derivePlan(rows, resolutions, schedule) -> actions|
   | 3 review     accept / reject actions, override resolutions        |
   | 4 apply      per theater: tx + advisory lock + re-derive + hash   |
   |              check + set-based writes + learn aliases             |
   +-------------------------------------------------------------------+
   |
   v
Postgres (Supabase, one schema)                    Anthropic API (server-side only)
```

Because actions are a pure function of *(file rows, resolutions, current schedule)*:

- what the admin approves is exactly what is applied;
- apply can recompute the plan inside its transaction and refuse if it differs from what the admin saw;
- invariants hold by construction (the model cannot produce an action, only a resolution);
- a wrong or manipulated model answer can only become a visible, reviewable proposal, never a silent write.

Why not just a similarity threshold? Trigram similarity of `dune pt 2` is 0.57 to "Dune: Part Two" and 0.50 to "Dune". No threshold separates those safely. Context does: the stored 1:00 PM showing in the same room.

## Key decisions and trade-offs

- **Next.js route handlers, not the FastAPI scaffold.** The deliverable has to run on Vercel; one app, one deploy, one language. The unused `backend/` folder is removed.
- **`movies` and `auditoriums` tables with saved aliases.** One clean title per film and one name per room; showtimes reference them by id. The partner's spelling never overwrites the clean name: it becomes an alias. Every agent decision an admin confirms is saved, so the next file matches with no model call.
- **Identity is (theater, movie, start time), enforced by a unique constraint**, in any status. A showtime that comes back after being archived is restored with its id and movie status, not duplicated. The auditorium is not part of identity, so a room change is an update.
- **A conservative normalizer plus the agent.** Rules only cover what is always safe (case, accents, punctuation, spacing, "Part Two" = "Part 2"). Typos, roman numerals, abbreviations and edition tags go to the agent, because a wrong rule merges two films silently.
- **The plan is derived, not generated.** `derivePlan` is a pure function; the agent's output is only an input to it.
- **Apply does not trust the preview.** Per theater, in id order, each in its own transaction: `pg_advisory_xact_lock`, re-derive from the stored file, resolutions and decisions, compare the SHA-256 plan hash, then write with set-based statements. A mismatch returns 409 and a fresh proposal.
- **The covered window.** A file can only archive showtimes on the theater-local days it covers. A control on the review screen switches to "treat the file as the full schedule".
- **Polling instead of streaming.** Upload returns an id, analyze does the long work, the browser polls the event feed. Plain JSON, easy to test, survives a dropped connection, and a failed analysis can be retried from the stored file.
- **Plain SQL with `postgres.js`, no ORM.** The constraints, upserts, locks and indexes are the interesting part. Writes pass one JSON or array parameter, never one bind per value, so 70,000 archives are one statement.
- **Search at scale runs in SQL**: contains-search on the small `movies` table with trigram indexes, whitelisted sort columns, always paged (max 100). With 200,000 showtimes and 20,000 movies (`npm run loadtest`, measured from a laptop through the shared pooler, page plus exact count): title search 77 ms, one local day 79 ms, first page of everything 333 ms.

More, including where the brief and reality differed: [docs/DECISIONS.md](docs/DECISIONS.md).

## Follow-ups from the live review

| Point raised | What was built |
|---|---|
| Titles repeated on every showtime | `movies` + `movie_aliases`; showtimes hold `movie_id`; search runs on movies |
| Room names as free text | `auditoriums` + `auditorium_aliases` per theater; an unknown room is never created quietly, it is a flagged proposal |
| Files that span theaters | Rows grouped by theater, access checked per row, one preview section and one transaction per theater, only theaters in the file can be archived from |
| Two uploads at once | One advisory lock per theater taken in a fixed order, an atomic claim on the import, a schedule version per theater, and the plan hash check |
| The password in `.env.example` | This repo has placeholders only and a fresh history; the shared password should still be rotated |

## Assumptions

- **A CSV covers its dates, not the whole schedule.** Only showtimes on the days in the file can be archived. Switchable per import.
- **Movie status belongs to the showtime**, not the movie. The base data has two showings of one film in one theater with different statuses, and a status on the movie would let one theater's admin change what another theater sees. Imports never write it.
- **"Limited data" for non-admins** means: rows only for their theaters, read-only, and no access to imports, agent traces or admin routes.
- **Identity is mocked with an `X-User-Id` header** (the assignment says no login). Role and theater scope are always read from the database; `getActor` is the one function to replace.
- **Unknown theaters are skipped**, with a "did you mean" hint, never created.
- **A spelling variant is "matched", not "updated".** The base mock showed three updates for `new-drop.csv` because it counted "Aud 1" and "Spider Man - Homecoming" as changes. Here they are the same room and film with no data change.
- **`inactive` is a manual hold.** An import can update a held showtime but never switches it back on.

## AI quality

Evals run the real pipeline with the real model against [evals/cases/](evals/cases/): 8 cases, 69 subjects (titles, rooms, reschedules), including sequels that must not merge, moved articles, typos, edition tags, foreign-language titles, room renames across three theaters, and the injection file. Three runs per setting, 207 graded decisions each. Full output: [evals/RESULTS.md](evals/RESULTS.md).

| Model | Effort | Accuracy | False merges | False splits | Plan match | Turns (median) | Seconds (median / worst) | Cost per run |
|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | medium | 100% (207/207) | 0 | 0 | 15/15 | 3 | 15.6 / 22.2 | $0.049 |
| claude-sonnet-5-5 | low | 100% (207/207) | 0 | 0 | 15/15 | 2 | 14.4 / 22.0 | $0.044 |
| claude-haiku-5-5 | medium | 100% (207/207) | 0 | 0 | 15/15 | 3 | 18.9 / 25.8 | $0.0035 |
| claude-haiku-5-5 | low | 99.5% (206/207) | 0 | 1 | 15/15 | 3 | 14.5 / 29.9 | $0.0029 |

A false merge (a title or room matched to the wrong existing entry) is the error that matters most, because it would attach a showtime to the wrong film. It is zero in every setting.

**One failure found and fixed.** The first run (Sonnet 5.5, medium, before any tuning) scored 68/69. The miss was the injection file: the room cell `Auditorium 1'; DROP TABLE showtimes;--` was matched to "Auditorium 1". The model had marked it low confidence, so the action would have waited for the admin rather than applied, but the expected behavior is to flag it as a new room. I added one rule to the system prompt (a cell containing code, SQL or instructions is never a spelling variant of an existing entry: decide "new" with low confidence) and the case then passed 3 of 3 runs and stayed correct in all 12 runs of the matrix. The baseline is kept in [evals/history/](evals/history/). The only other miss in 828 decisions was Haiku at low effort calling "Auditorium 2" in a theater whose rooms are named "Screen N" a new room, also at low confidence.

**Model choice.** The default is `claude-sonnet-5-5` at `medium` effort. On this set Haiku 5.5 at medium effort is just as accurate at about one fourteenth of the cost and similar latency, so it is a one-variable switch (`ANTHROPIC_MODEL`) when volume matters. I kept Sonnet as the default because 69 subjects cannot separate the two, a false merge costs far more than five cents, and most uploads never reach the model at all: a file whose spellings were confirmed before resolves from saved aliases with no AI call.

Guardrails: strict tool schemas; every submitted resolution validated on the server (the subject must be on the worklist, the target must exist, a room must belong to that theater); 8 turns, 40 tool calls and 100 seconds per run; a daily cap on runs; file cells delimited and declared as data; model text rendered as plain text. If the model is unavailable, refuses, or runs out of budget, the import still reaches a usable proposal: what it did not resolve is marked "needs your decision" and **Retry AI analysis** is offered.

Trace: every stage, model turn (model, stop reason, tokens, milliseconds), tool call and accepted or rejected resolution is stored in `import_events` as it happens. The console reads that feed live and the import history shows it afterwards. The events map one-to-one onto spans in a tracing tool such as Arize Phoenix or OpenTelemetry.

## Setup

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, MIGRATION_DATABASE_URL, ANTHROPIC_API_KEY
npm run db:migrate          # creates the schema named by DB_SCHEMA; safe to re-run
npm run db:seed             # demo theaters, users, catalog and showtimes; safe to re-run
npm run dev                 # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run check` | ESLint and TypeScript |
| `npm test` | Unit tests and agent tests with a scripted model. No network. |
| `npm run test:integration` | Real Postgres (`TEST_DATABASE_URL`), a throwaway `ronnie_test_*` schema per file |
| `npm run eval -- --model claude-sonnet-5-5 --effort medium --runs 3` | Real model against `evals/cases/` |
| `npm run smoke -- --base <url>` | End-to-end over HTTP against a deployment (resets demo data) |
| `npm run loadtest -- --rows 200000` | Timings for the list queries at scale |
| `E2E_BASE_URL=<url> npx playwright test` | The reviewer walkthrough in a real browser (resets demo data) |
| `E2E_BASE_URL=<url> npx playwright test` | The reviewer walkthrough in a real browser (resets demo data) |
| `npm run db:reset` | Restore the demo seed in `DB_SCHEMA` only |

Environment variables are documented in [.env.example](.env.example). On Vercel set `DATABASE_URL` (transaction pooler, port 6543), `DB_SCHEMA`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `AGENT_EFFORT`, `AI_DAILY_RUN_LIMIT` and `DEMO_RESET_ENABLED` before the first deploy. Without `ANTHROPIC_API_KEY` the app runs in rule-based mode and says so.

## Limits and what I would do next

- **Very large files.** Uploads are capped at 1 MB and 5,000 rows and analyzed in the request. The next step is to stream the file into a staging table, diff it in SQL, and run it as a background job with a status.
- **Paging** is offset-based with an exact count. At millions of rows: keyset paging, estimated counts, cached filter values.
- **Real auth** behind `getActor`, and rate limiting per user rather than one daily cap.
- **Export the trace** to a tracing tool instead of only showing it in the console.
- **A rename flow for rooms and movies**, and a way to review or remove a saved alias.
- **The shared database** is reachable by anyone with the base repo's credential. Everything here lives in one schema and is scripted, so moving to a private project is a new `DATABASE_URL` plus migrate and seed.

## How this was built

<!-- TODO(Ronnie): review and edit this paragraph. -->
I built this with an AI coding agent (Claude Code) under my direction. I wrote the build brief: the architecture, the data model and its constraints, the invariants, the agent's role and guardrails, and the test plan, based on the design positions I took in the live review. The agent implemented it, and I reviewed the code, the tests and the eval results.

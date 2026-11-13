# Decisions

One line per decision made where the brief was silent or reality differed. Newest last.

1. **Fresh git history instead of a fork.** The base repo's `.env.example` contains the shared database password, so a fork would carry it in history. The base is imported as one commit with that file scrubbed.
2. **`@supabase/supabase-js` removed.** It was installed but unused; the app talks to Postgres with `postgres.js` and plain SQL.
3. **`@types/node` 20 → 22.** Vitest 5 requires it; Vercel runs Node 22.
4. **Repositories take a `Db` (query handle + schema) argument.** The same SQL runs against the app schema, inside a transaction, or in a throwaway test schema. `getDb()` is the only place that reads the environment.
5. **Migration `0003_apply_claim`** adds `imports.apply_started_at`. Without it an apply whose serverless function died would leave the import stuck in `applying`; with it the claim can be retaken after five minutes. Each theater is still its own transaction, so a retaken apply only does what is left.
6. **Row numbers are file line numbers** (header = 1, blank lines counted), because that is what a person sees in a spreadsheet or editor.
7. **An import is visible to its creator and to admins who manage every theater in it.** Anyone else gets 404. Skipped rows are computed for the viewer from the stored file.
8. **Exact matches have no resolution record.** Only saved-alias, agent, human and fallback matches are stored as resolutions; a match on the normalized title is a rule and is explained in the action text ("The file's spelling "DUNE PART 2" is "Dune: Part Two"").
9. **A `new` decision whose name already exists resolves to the existing entry.** The agent is told to pick `existing` instead (the submission is rejected with the id), and the resolver also guards it, so two catalog rows for one film cannot be created.
10. **Reschedule questions are added to the agent's worklist after titles resolve.** A possible move only exists once the row's title is known, so `submit_resolutions` returns the still-unresolved list, including newly discovered reschedule pairs. Rules never decide a move: without the agent the pair stays add + archive.
11. **Aliases are learned from `unchanged` and `duplicate` actions too.** "Aud 1" on an unchanged showtime is still a confirmed spelling; otherwise the second upload would call the model again.
12. **`schedule_version` is bumped only when an apply wrote something.** Re-applying the same file changes no row, including the version.
13. **Low-confidence agent answers and fallbacks start as `pending`; a human override is final.** Apply is blocked while anything is pending.
14. **Decisions carry over a re-plan by action key** unless they were `pending`. Re-running the AI analysis resets decisions, because the proposal itself may change.
15. **Overlap warnings only look inside the covered window**, on the schedule as it would be after the plan. They never block.
16. **Server-side refusal fallbacks (`fallbacks` beta) are not used.** A refusal or any other non-success stop falls back to rule-based output for the admin to decide, which is the behavior the product needs anyway.
17. **Uploads that are not valid UTF-8 are decoded as Windows-1252** rather than rejected ("flexible on format").
18. **Evals run the real pipeline in a throwaway schema and never apply**, so cases are independent and can run four at a time.
19. **Prompt change from the first eval run:** a cell containing code, SQL or instructions is never matched to an existing entry (see `evals/history/` and the README).

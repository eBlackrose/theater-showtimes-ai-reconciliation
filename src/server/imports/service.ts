import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { reserveAgentRun, recordAgentTokens } from "~/server/agent/budget";
import type { LlmClient } from "~/server/agent/llm";
import { runAgent, type AgentLimits } from "~/server/agent/loop";
import type { AgentOutcome } from "~/server/agent/types";
import { requireTheater, type Actor } from "~/server/auth/context";
import { tbl, withTx, type Db } from "~/server/db/client";
import { agentBackend, findMovie, searchMovies } from "~/server/db/repositories/catalog";
import { allTheaterInfo } from "~/server/db/repositories/directory";
import { normalizeKey } from "~/server/domain/normalize";
import { hashPlan, type PlanResult } from "~/server/domain/plan";
import type {
  ArchiveScope,
  Candidate,
  Outcome,
  PlannedAction,
  PlanWarning,
  Resolution,
} from "~/server/domain/types";
import { ApiError, badRequest, conflict, notFound } from "~/server/http/errors";
import type { AgentUsage, DecisionsResponse, ImportCreatedResponse } from "~/types/api";
import { Analysis, MAX_AGENT_SUBJECTS } from "./analysis";
import {
  addEvent,
  audit,
  getFileContent,
  loadDecisions,
  loadImportTheaters,
  loadResolutions,
  newId,
  refreshSummary,
  requireImport,
  savePlan,
  saveResolutions,
  type ImportRow,
} from "./store";
import {
  loadPlanState,
  planTheater,
  prepareFile,
  type ImportFile,
  type PlanState,
} from "./workspace";

const STALE_ANALYSIS = "5 minutes";

/** Parse and scope the stored file for this actor. Permissions are re-checked every time. */
export async function openFile(
  db: Db,
  actor: Actor,
  imp: Pick<ImportRow, "id" | "scope_theater_id" | "archive_scope" | "created_at">,
  content?: string,
): Promise<ImportFile> {
  const prepared = prepareFile({
    content: content ?? (await getFileContent(db, imp.id)),
    actor,
    scopeTheaterId: imp.scope_theater_id,
    archiveScope: imp.archive_scope,
    allTheaters: await allTheaterInfo(db),
    uploadedAt: imp.created_at.toISOString(),
  });
  if (!prepared.ok) {
    throw new ApiError(
      prepared.code === "too_large" ? 413 : 422,
      prepared.code === "nothing_in_scope" ? "nothing_in_scope" : "invalid_csv",
      prepared.code === "nothing_in_scope"
        ? (prepared.errors[0]?.message ?? "No rows in scope.")
        : `The file was rejected: ${prepared.errors.length} problem${prepared.errors.length === 1 ? "" : "s"} found. Nothing was imported.`,
      { errors: prepared.errors },
    );
  }
  return prepared.file;
}

const skippedCounts = (file: ImportFile) => {
  const count = (disposition: string) =>
    file.rows.filter((row) => row.disposition === disposition).length;
  return {
    outOfScope: count("skipped_out_of_scope"),
    noAccess: count("skipped_no_access"),
    unknownTheater: count("skipped_unknown_theater"),
  };
};
const totalSkipped = (file: ImportFile) =>
  file.rows.filter((row) => row.disposition !== "in_scope").length;

/** Step 1: validate and store the raw file. Nothing is written when the file is invalid. */
export async function createImport(
  db: Db,
  actor: Actor,
  input: { filename: string; content: string; scopeTheaterId: string | null },
): Promise<ImportCreatedResponse> {
  if (input.scopeTheaterId) requireTheater(actor, input.scopeTheaterId);
  const id = newId("imp");
  // Millisecond precision, so the value read back from Postgres is identical.
  const createdAt = new Date(new Date().toISOString());
  const file = await openFile(
    db,
    actor,
    { id, scope_theater_id: input.scopeTheaterId, archive_scope: "file_window", created_at: createdAt },
    input.content,
  );
  await withTx(db, async (tx) => {
    const { q } = tx;
    await q`
      insert into ${tbl(tx, "imports")}
        (id, created_by, filename, file_sha256, file_bytes, row_count, scope_theater_id,
         status, created_at, summary)
      values (${id}, ${actor.id}, ${input.filename.slice(0, 200)},
              ${createHash("sha256").update(input.content).digest("hex")},
              ${Buffer.byteLength(input.content, "utf8")}, ${file.rows.length},
              ${input.scopeTheaterId}, 'uploaded', ${createdAt},
              ${q.json({ skippedRows: totalSkipped(file) })})`;
    await q`insert into ${tbl(tx, "import_files")} (import_id, content)
            values (${id}, ${input.content})`;
    await audit(tx, actor, "import.create", input.scopeTheaterId, id, {
      filename: input.filename,
      rows: file.rows.length,
    });
  });
  return { importId: id, rowCount: file.rows.length, skipped: skippedCounts(file) };
}

/** Import-level warnings that do not come from a single theater's plan. */
function importWarnings(resolutions: Resolution[], plans: PlanResult[]): PlanWarning[] {
  const warnings = plans.flatMap((plan) => plan.warnings);
  const fallbacks = resolutions.filter((r) => r.method === "fallback").length;
  if (fallbacks > 0) {
    warnings.unshift({
      code: "agent_incomplete",
      theaterId: null,
      message: `${fallbacks} title${fallbacks === 1 ? " or room was" : "s or rooms were"} not resolved by AI. Each one is treated as new and waits for your decision.`,
      requiresAck: false,
    });
  }
  return warnings;
}

/**
 * Derive and store the plan for every theater that is not applied yet. No model call:
 * the plan is a pure function of the file, the stored resolutions and the schedule.
 */
export async function replan(
  db: Db,
  actor: Actor,
  imp: ImportRow,
  notes: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const file = await openFile(db, actor, imp);
  const resolutions = await loadResolutions(db, imp.id);
  const applied = new Set(
    (await loadImportTheaters(db, imp.id))
      .filter((t) => t.status === "applied")
      .map((t) => t.theater_id),
  );
  const theaterIds = file.theaterIds.filter((id) => !applied.has(id));
  const state = await loadPlanState(db, file, resolutions, theaterIds);
  const decisions = await loadDecisions(db, imp.id);
  const plans = new Map(
    theaterIds.map((id) => [id, planTheater(file, state, resolutions, id, decisions)]),
  );
  await withTx(db, (tx) =>
    persistPlans(tx, imp.id, file, state, plans, resolutions, notes),
  );
}

async function persistPlans(
  tx: Db,
  importId: string,
  file: ImportFile,
  state: PlanState,
  plans: Map<string, PlanResult>,
  resolutions: Resolution[],
  notes: ReadonlyMap<string, string> = new Map(),
) {
  for (const [theaterId, plan] of plans) {
    await savePlan(tx, importId, theaterId, plan, {
      baseVersion: state.versions.get(theaterId) ?? 0,
      window: file.windows.get(theaterId) ?? null,
      error: notes.get(theaterId) ?? null,
    });
  }
  // A theater the actor no longer manages drops out of the plan entirely.
  await tx.q`
    delete from ${tbl(tx, "import_theaters")}
    where import_id = ${importId} and status <> 'applied'
      and theater_id <> all(${[...plans.keys()]}::text[])`;
  await tx.q`
    delete from ${tbl(tx, "import_actions")} a
    where a.import_id = ${importId}
      and not exists (select 1 from ${tbl(tx, "import_theaters")} it
                      where it.import_id = a.import_id and it.theater_id = a.theater_id)`;
  return refreshSummary(tx, importId, {
    skippedRows: totalSkipped(file),
    warnings: importWarnings(resolutions, [...plans.values()]),
  });
}

export interface AnalyzeDeps {
  /** null when no API key is configured: the import runs on rules only. */
  llm: LlmClient | null;
  dailyRunLimit: number;
  limits?: Partial<AgentLimits>;
}

/**
 * Step 2: deterministic matching, then the agent for what is left, then the plan.
 * Whatever happens to the model, the import ends in `ready` with a usable plan.
 */
export async function analyzeImport(
  db: Db,
  actor: Actor,
  importId: string,
  deps: AnalyzeDeps,
): Promise<{ status: "ready" }> {
  const imp = await requireImport(db, actor, importId);
  const claimed = await db.q`
    update ${tbl(db, "imports")}
    set status = 'analyzing', analysis_started_at = now(), error = null
    where id = ${importId}
      and (status in ('uploaded', 'ready', 'failed')
           or (status = 'analyzing' and analysis_started_at < now() - ${STALE_ANALYSIS}::interval))
    returning id`;
  if (claimed.length === 0) {
    throw conflict(
      imp.status === "analyzing"
        ? "This import is already being analyzed."
        : `This import is ${imp.status} and cannot be analyzed again.`,
    );
  }
  try {
    await runAnalysis(db, actor, imp, deps);
    return { status: "ready" };
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "The analysis failed. You can retry it.";
    if (!(error instanceof ApiError)) console.error(error);
    await db.q`
      update ${tbl(db, "imports")}
      set status = 'failed', error = ${db.q.json({ message })}
      where id = ${importId}`;
    await addEvent(db, importId, "error", message);
    throw error;
  }
}

async function runAnalysis(db: Db, actor: Actor, imp: ImportRow, deps: AnalyzeDeps) {
  const emit = (type: string, message: string, data: Record<string, unknown> = {}) =>
    addEvent(db, imp.id, type, message, data);
  const stage = (name: string, state: "running" | "done", message: string) =>
    emit("stage", message, { stage: name, state });

  const file = await openFile(db, actor, imp);
  const inScope = file.theaterIds.reduce(
    (sum, id) => sum + (file.rowsByTheater.get(id)?.length ?? 0),
    0,
  );
  await stage(
    "validate",
    "done",
    `File is valid: ${file.rows.length} row${file.rows.length === 1 ? "" : "s"}, ${inScope} in scope for ${file.theaterIds.length} theater${file.theaterIds.length === 1 ? "" : "s"}`,
  );

  // A retry starts clean, except for decisions a human already made about titles and rooms.
  await withTx(db, async (tx) => {
    await tx.q`delete from ${tbl(tx, "import_actions")} where import_id = ${imp.id}`;
    await tx.q`delete from ${tbl(tx, "import_theaters")} where import_id = ${imp.id}`;
    await tx.q`delete from ${tbl(tx, "import_resolutions")}
               where import_id = ${imp.id} and method <> 'human'`;
  });
  const human = await loadResolutions(db, imp.id);
  const state = await loadPlanState(db, file, human);
  const movies = {
    byId: (id: string) => findMovie(db, { id }),
    byKey: (key: string) => findMovie(db, { key }),
  };

  await stage("match", "running", "Matching exact titles and saved aliases");
  const probe = new Analysis(file, state, human, new Map(), movies);
  const { unresolved, aliasHits } = probe.unresolvedSubjects();
  const candidates = new Map<string, Candidate[]>();
  for (const subject of unresolved.slice(0, MAX_AGENT_SUBJECTS)) {
    if (subject.kind !== "movie") continue;
    const hits = await searchMovies(db, subject.raws[0] ?? "", 5, file.theaterIds);
    candidates.set(
      subject.subjectKey,
      hits.map((hit) => ({ id: hit.id, name: hit.title, score: hit.score, aliases: hit.aliases })),
    );
  }
  const analysis = new Analysis(file, state, [...human, ...aliasHits], candidates, movies);
  const work = analysis.remaining();
  const distinct = (pick: (row: ImportFile["rows"][number]) => string) =>
    new Set(file.rows.filter((r) => r.disposition === "in_scope").map(pick)).size;
  const titles = distinct((row) => normalizeKey(row.title));
  const rooms = distinct((row) => `${row.theaterId}|${normalizeKey(row.auditorium)}`);
  await stage(
    "match",
    "done",
    `${titles} title${titles === 1 ? "" : "s"} and ${rooms} room${rooms === 1 ? "" : "s"} in the file: ${titles + rooms - unresolved.length - aliasHits.length} matched exactly, ${aliasHits.length} by saved alias, ${unresolved.length} left for AI`,
    );

  let mode: "ai" | "rules_only" = "ai";
  let notice: string | null = null;
  let outcome: AgentOutcome | null = null;
  if (work.length === 0) {
    await stage(
      "agent",
      "done",
      "Nothing needed AI: every title and room matched exactly or through a saved alias",
    );
  } else if (!deps.llm) {
    mode = "rules_only";
    notice = "AI is not configured on this server, so only rule-based matching ran.";
  } else if (!(await reserveAgentRun(db, deps.dailyRunLimit))) {
    mode = "rules_only";
    notice = "Today's limit for AI analysis runs was reached, so only rule-based matching ran.";
  } else {
    await stage(
      "agent",
      "running",
      `AI agent (${deps.llm.model}) resolving ${work.length} item${work.length === 1 ? "" : "s"}`,
    );
    outcome = await runAgent({
      llm: deps.llm,
      session: analysis,
      backend: agentBackend(db, file.theaterIds),
      emit: (event) => emit(event.type, event.message, event.data ?? {}),
      limits: deps.limits,
    });
    await recordAgentTokens(db, outcome.usage.inputTokens, outcome.usage.outputTokens);
    await stage(
      "agent",
      "done",
      outcome.complete
        ? `AI agent finished in ${outcome.usage.turns} turn${outcome.usage.turns === 1 ? "" : "s"}`
        : `AI agent stopped early (${outcome.usage.stopReason})`,
    );
  }
  if (notice) await emit("warning", notice);

  const fallbacks = analysis.applyFallbacks(
    mode === "rules_only" ? "AI unavailable." : "The AI did not decide this one.",
  );
  if (fallbacks > 0) {
    await emit(
      "warning",
      `${fallbacks} item${fallbacks === 1 ? "" : "s"} could not be resolved automatically and need${fallbacks === 1 ? "s" : ""} your decision`,
    );
  }
  if (outcome?.complete && outcome.summary) {
    await emit("note", outcome.summary, { summary: true });
  }

  await stage("plan", "running", "Building the proposal");
  const resolutions = [...analysis.resolutions.values()];
  const plans = new Map(
    file.theaterIds.map((id) => [id, planTheater(file, state, resolutions, id, new Map())]),
  );
  const usage: AgentUsage | null = outcome && {
    turns: outcome.usage.turns,
    toolCalls: outcome.usage.toolCalls,
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
    durationMs: outcome.usage.durationMs,
    subjects: analysis.initialSubjects(),
    resolvedByAgent: resolutions.filter((r) => r.method === "agent").length,
    stopReason: outcome.usage.stopReason,
  };
  const summary = await withTx(db, async (tx) => {
    await saveResolutions(tx, imp.id, resolutions);
    const result = await persistPlans(tx, imp.id, file, state, plans, resolutions);
    await tx.q`
      update ${tbl(tx, "imports")} set
        status = 'ready', mode = ${mode}, model = ${outcome ? (deps.llm?.model ?? null) : null},
        agent_summary = ${outcome?.complete ? outcome.summary : null},
        usage = ${tx.q.json({ ...(usage ?? {}), notice } as never)},
        analyzed_at = now()
      where id = ${imp.id}`;
    return result;
  });
  const c = summary.counts;
  await stage(
    "plan",
    "done",
    `Proposal ready: ${c.add} new, ${c.update + c.reschedule} updated, ${c.restore} restored, ${c.archive} to archive, ${c.duplicate} duplicate, ${c.unchanged} unchanged${c.pending ? `, ${c.pending} waiting for your decision` : ""}`,
  );
}

const DECIDABLE = ["add", "restore", "update", "reschedule", "archive"] as const;

export const decisionsBody = z.union([
  z.object({
    decisions: z
      .array(
        z.object({
          actionKey: z.string(),
          decision: z.enum(["accepted", "rejected"]),
        }),
      )
      .min(1)
      .max(5000),
  }),
  z.object({
    bulk: z.object({
      theaterId: z.string(),
      action: z.enum(DECIDABLE),
      decision: z.enum(["accepted", "rejected"]),
    }),
  }),
]);

function requireReady(imp: ImportRow) {
  if (imp.status !== "ready" && imp.status !== "partially_applied") {
    throw conflict(`This import is ${imp.status}. Its proposal can no longer be changed.`);
  }
}

/** Recompute one theater's plan hash from the stored actions after a decision changed. */
async function rehashTheater(tx: Db, importId: string, theaterId: string) {
  const rows = await tx.q<Pick<PlannedAction, "actionKey" | "action" | "payload" | "decision">[]>`
    select action_key as "actionKey", action, payload, decision
    from ${tbl(tx, "import_actions")}
    where import_id = ${importId} and theater_id = ${theaterId}`;
  await tx.q`
    update ${tbl(tx, "import_theaters")} set plan_hash = ${hashPlan(rows)}
    where import_id = ${importId} and theater_id = ${theaterId}`;
}

/** Step 3: the admin accepts or rejects actions, one by one or a whole group. */
export async function setDecisions(
  db: Db,
  actor: Actor,
  importId: string,
  body: z.infer<typeof decisionsBody>,
): Promise<DecisionsResponse> {
  const imp = await requireImport(db, actor, importId);
  requireReady(imp);
  return withTx(db, async (tx) => {
    const { q } = tx;
    const open = q`
      a.import_id = ${importId} and a.action = any(${[...DECIDABLE]}::text[]) and a.result is null
      and a.theater_id = any(${actor.theaterIds}::text[])`;
    const touched =
      "bulk" in body
        ? await q<{ theater_id: string }[]>`
            update ${tbl(tx, "import_actions")} a set decision = ${body.bulk.decision}
            where ${open} and a.theater_id = ${body.bulk.theaterId}
              and a.action = ${body.bulk.action}
            returning a.theater_id`
        : await q<{ theater_id: string }[]>`
            update ${tbl(tx, "import_actions")} a set decision = x.decision
            from jsonb_to_recordset(${q.json(body.decisions)}::jsonb)
              as x("actionKey" text, decision text)
            where ${open} and a.action_key = x."actionKey"
            returning a.theater_id`;
    for (const theaterId of new Set(touched.map((row) => row.theater_id))) {
      await rehashTheater(tx, importId, theaterId);
    }
    const { planHash, counts } = await refreshSummary(tx, importId);
    return { planHash: planHash ?? "", counts };
  });
}

export const resolutionOverrideBody = z.object({
  outcome: z.enum(["existing", "new", "moved", "separate"]),
  targetId: z.string().optional(),
});

/** The admin corrects what a title or room refers to. Re-derives the plan, no model call. */
export async function overrideResolution(
  db: Db,
  actor: Actor,
  importId: string,
  resolutionId: string,
  body: z.infer<typeof resolutionOverrideBody>,
): Promise<void> {
  const imp = await requireImport(db, actor, importId);
  requireReady(imp);
  const current = (await loadResolutions(db, importId)).find((r) => r.id === resolutionId);
  if (!current) throw notFound("Resolution");

  let outcome: Outcome;
  let explanation: string;
  if (current.kind === "reschedule") {
    if (body.outcome !== "moved" && body.outcome !== "separate") {
      throw badRequest('A reschedule can only be "moved" or "separate".');
    }
    outcome = { type: body.outcome };
    explanation =
      body.outcome === "moved"
        ? "The stored showing moved to the new time."
        : "These are two separate showings.";
  } else if (body.outcome === "new") {
    outcome = { type: "new", name: current.subjectRaw };
    explanation = `"${current.subjectRaw}" is new.`;
  } else if (body.outcome === "existing" && body.targetId) {
    let name: string | undefined;
    if (current.kind === "movie") {
      name = (await findMovie(db, { id: body.targetId }))?.title;
    } else {
      const rows = await db.q<{ name: string }[]>`
        select name from ${tbl(db, "auditoriums")}
        where id = ${body.targetId} and theater_id = ${current.theaterId}`;
      name = rows[0]?.name;
    }
    if (!name) throw badRequest("The chosen target does not exist for this theater.");
    outcome = { type: "existing", id: body.targetId };
    explanation = `"${current.subjectRaw}" is "${name}".`;
  } else {
    throw badRequest('Choose "existing" with a targetId, or "new".');
  }

  await withTx(db, async (tx) => {
    await tx.q`
      update ${tbl(tx, "import_resolutions")} set
        outcome = ${tx.q.json(outcome)}, method = 'human', confidence = 'high',
        explanation = ${explanation}, overridden_by = ${actor.id}, updated_at = now()
      where id = ${resolutionId}`;
    await audit(tx, actor, "import.resolution.override", current.theaterId, importId, {
      subject: current.subjectRaw,
      outcome,
    });
  });
  await replan(db, actor, imp);
}

/** Switch between "this file covers its dates" and "this file is the full schedule". */
export async function setArchiveScope(
  db: Db,
  actor: Actor,
  importId: string,
  archiveScope: ArchiveScope,
): Promise<void> {
  const imp = await requireImport(db, actor, importId);
  requireReady(imp);
  await db.q`update ${tbl(db, "imports")} set archive_scope = ${archiveScope}
             where id = ${importId}`;
  await replan(db, actor, { ...imp, archive_scope: archiveScope });
}

export async function discardImport(db: Db, actor: Actor, importId: string): Promise<void> {
  const imp = await requireImport(db, actor, importId);
  const rows = await db.q`
    update ${tbl(db, "imports")} set status = 'discarded'
    where id = ${importId} and status in ('uploaded', 'ready', 'failed') returning id`;
  if (rows.length === 0) throw conflict(`This import is ${imp.status} and cannot be discarded.`);
  await audit(db, actor, "import.discard", null, importId, {});
}

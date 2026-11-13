/**
 * Evals with the real model:
 *   npm run eval -- --model claude-sonnet-5-5 --effort medium --runs 3 [--case <name>]
 *
 * Each case uploads a file and runs the real analyze pipeline (deterministic matching, then
 * the agent) in a throwaway schema, and compares the agent's resolutions with the expected
 * ones. Nothing is applied, so cases do not affect each other. Results are written to
 * evals/results/<model>-<effort>.json and evals/RESULTS.md is rebuilt from all result files.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { anthropicClient } from "~/server/agent/llm";
import { getActor } from "~/server/auth/context";
import { createDb, type Db } from "~/server/db/client";
import { migrate } from "~/server/db/migrate";
import { seed } from "~/server/db/seed";
import { normalizeKey } from "~/server/domain/normalize";
import { analyzeImport, createImport } from "~/server/imports/service";
import { importDetail } from "~/server/imports/view";
import type { ImportDetail, PlanResolution } from "~/types/api";

interface Expectation {
  kind: "movie" | "auditorium" | "reschedule";
  /** The spelling in the file; for a reschedule, the id of the stored showtime. */
  raw: string;
  outcome: "existing" | "new" | "moved" | "separate";
  /** Canonical title or room name when outcome is "existing". */
  target?: string;
}
interface EvalCase {
  name: string;
  description: string;
  user: string;
  scopeTheaterId: string | null;
  file?: string;
  rows?: string[][];
  expect: { resolutions: Expectation[]; counts?: Record<string, number> };
}
interface RunResult {
  case: string;
  subjects: number;
  correct: number;
  falseMerges: string[];
  confidentFalseMerges: number;
  falseSplits: string[];
  unresolved: string[];
  planMatch: boolean | null;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  stopReason: string | null;
}

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const model = option("model", process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5");
const effort = option("effort", "medium") as "low" | "medium" | "high";
const runs = Number(option("runs", "1"));
const only = option("case", "");
const CONCURRENCY = 4;
// USD per million tokens (input, output), from the published price list.
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

const HEADER = "theater_name,movie_title,auditorium,start_time,end_time,language,format,rating";
const quote = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
const contentOf = (c: EvalCase) =>
  c.file
    ? readFileSync(path.join("sample-data", c.file), "utf8")
    : [HEADER, ...(c.rows ?? []).map((row) => row.map(quote).join(","))].join("\n");

function score(c: EvalCase, detail: ImportDetail, seconds: number): RunResult {
  const result: RunResult = {
    case: c.name,
    subjects: c.expect.resolutions.length,
    correct: 0,
    falseMerges: [],
    confidentFalseMerges: 0,
    falseSplits: [],
    unresolved: [],
    planMatch: null,
    turns: detail.usage?.turns ?? 0,
    toolCalls: detail.usage?.toolCalls ?? 0,
    inputTokens: detail.usage?.inputTokens ?? 0,
    outputTokens: detail.usage?.outputTokens ?? 0,
    seconds,
    stopReason: detail.usage?.stopReason ?? null,
  };
  for (const expected of c.expect.resolutions) {
    const got: PlanResolution | undefined = detail.resolutions.find((r) =>
      r.kind !== expected.kind
        ? false
        : expected.kind === "reschedule"
          ? true // a case holds at most one reschedule question
          : normalizeKey(r.subjectRaw) === normalizeKey(expected.raw),
    );
    const label = `${expected.raw} → ${got ? (got.outcome === "existing" ? got.targetName : got.outcome) : "nothing"} (expected ${expected.target ?? expected.outcome}${got ? `, ${got.confidence}` : ""})`;
    if (!got || got.method === "fallback") {
      result.unresolved.push(label);
      continue;
    }
    const sameTarget =
      expected.outcome !== "existing" ||
      normalizeKey(got.targetName) === normalizeKey(expected.target);
    if (got.outcome === expected.outcome && sameTarget) {
      result.correct += 1;
    } else if (got.outcome === "existing") {
      // Matched to something it is not: the dangerous kind of error.
      result.falseMerges.push(label);
      if (got.confidence !== "low") result.confidentFalseMerges += 1;
    } else {
      result.falseSplits.push(label);
    }
  }
  if (c.expect.counts) {
    result.planMatch = Object.entries(c.expect.counts).every(
      ([key, value]) => (detail.counts as unknown as Record<string, number>)[key] === value,
    );
  }
  return result;
}

async function runCase(db: Db, c: EvalCase): Promise<RunResult> {
  const actor = await getActor(
    db,
    new Request("http://eval.local", { headers: { "x-user-id": c.user } }),
  );
  const started = Date.now();
  const created = await createImport(db, actor, {
    filename: c.file ?? `${c.name}.csv`,
    content: contentOf(c),
    scopeTheaterId: c.scopeTheaterId,
  });
  await analyzeImport(db, actor, created.importId, {
    llm: anthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", model, effort }),
    dailyRunLimit: 1_000_000,
  });
  return score(c, await importDetail(db, actor, created.importId), (Date.now() - started) / 1000);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

function summarize(results: RunResult[]) {
  const sum = (pick: (r: RunResult) => number) => results.reduce((total, r) => total + pick(r), 0);
  const [inPrice, outPrice] = PRICES[model] ?? [0, 0];
  const withPlan = results.filter((r) => r.planMatch !== null);
  const cost = (sum((r) => r.inputTokens) * inPrice + sum((r) => r.outputTokens) * outPrice) / 1e6;
  return {
    model,
    effort,
    runs,
    caseRuns: results.length,
    subjects: sum((r) => r.subjects),
    correct: sum((r) => r.correct),
    accuracy: sum((r) => r.correct) / Math.max(1, sum((r) => r.subjects)),
    falseMerges: sum((r) => r.falseMerges.length),
    confidentFalseMerges: sum((r) => r.confidentFalseMerges),
    falseSplits: sum((r) => r.falseSplits.length),
    unresolved: sum((r) => r.unresolved.length),
    planMatches: `${withPlan.filter((r) => r.planMatch).length}/${withPlan.length}`,
    medianTurns: median(results.map((r) => r.turns)),
    medianToolCalls: median(results.map((r) => r.toolCalls)),
    medianSeconds: median(results.map((r) => r.seconds)),
    worstSeconds: Math.max(...results.map((r) => r.seconds)),
    costPerRunUsd: cost / Math.max(1, results.length),
    totalCostUsd: cost,
  };
}

function writeReport(directory: string) {
  const files = readdirSync(directory).filter((f) => f.endsWith(".json")).sort();
  const lines = [
    "# Eval results",
    "",
    "Generated by `npm run eval`. Each row is one model and effort setting over every case in `evals/cases/`.",
    "A false merge is a title or room matched to the wrong existing entry; it must be zero.",
    "",
    "| Model | Effort | Case runs | Accuracy | False merges (confident) | False splits | Unresolved | Plan match | Turns (median) | Seconds (median / worst) | Cost per run |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const details: string[] = [];
  for (const file of files) {
    const { summary: s, results, at } = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as {
      summary: ReturnType<typeof summarize>;
      results: RunResult[];
      at: string;
    };
    lines.push(
      `| ${s.model} | ${s.effort} | ${s.caseRuns} | ${(s.accuracy * 100).toFixed(1)}% (${s.correct}/${s.subjects}) | ${s.falseMerges} (${s.confidentFalseMerges}) | ${s.falseSplits} | ${s.unresolved} | ${s.planMatches} | ${s.medianTurns} | ${s.medianSeconds.toFixed(1)} / ${s.worstSeconds.toFixed(1)} | $${s.costPerRunUsd.toFixed(4)} |`,
    );
    const misses = results.flatMap((r) => [
      ...r.falseMerges.map((m) => `- **false merge** (${r.case}): ${m}`),
      ...r.falseSplits.map((m) => `- false split (${r.case}): ${m}`),
      ...r.unresolved.map((m) => `- unresolved (${r.case}): ${m}`),
      ...(r.planMatch === false ? [`- plan counts differ (${r.case})`] : []),
    ]);
    details.push(
      "",
      `## ${s.model}, effort ${s.effort} (${at.slice(0, 16).replace("T", " ")} UTC)`,
      "",
      misses.length ? [...new Set(misses)].join("\n") : "No misses.",
    );
  }
  writeFileSync(path.join("evals", "RESULTS.md"), [...lines, ...details, ""].join("\n"));
}

const cases = readdirSync(path.join("evals", "cases"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join("evals", "cases", f), "utf8")) as EvalCase)
  .filter((c) => !only || c.name === only);
if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY to run the evals.");
const url = process.env.TEST_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to run the evals.");

const db = createDb(url, `ronnie_test_${randomBytes(6).toString("hex")}`, { max: 4, queryTimeout: 120 });
const results: RunResult[] = [];
try {
  await migrate(db);
  await seed(db);
  const queue = cases.flatMap((c) => Array.from({ length: runs }, () => c));
  console.log(`${model}, effort ${effort}: ${queue.length} case runs`);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try {
          const result = await runCase(db, c);
          results.push(result);
          console.log(
            `  ${result.case}: ${result.correct}/${result.subjects} correct, ${result.falseMerges.length} false merges, ${result.turns} turns, ${result.seconds.toFixed(1)} s`,
          );
          for (const miss of [...result.falseMerges, ...result.falseSplits, ...result.unresolved]) {
            console.log(`      miss: ${miss}`);
          }
        } catch (error) {
          console.error(`  ${c.name}: failed: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      }
    }),
  );
} finally {
  // Only ever drops the schema this run created (ronnie_test_<random>).
  if (/^ronnie_test_[a-z0-9]+$/.test(db.schema)) {
    await db.q.unsafe(`drop schema if exists "${db.schema}" cascade`);
  }
  await db.q.end();
}

if (results.length > 0) {
  const summary = summarize(results);
  console.table([summary]);
  if (!only) {
    const directory = path.join("evals", "results");
    mkdirSync(directory, { recursive: true });
    results.sort((a, b) => a.case.localeCompare(b.case));
    writeFileSync(
      path.join(directory, `${model}-${effort}.json`),
      JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2),
    );
    writeReport(directory);
  }
}

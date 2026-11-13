/**
 * End-to-end smoke test over HTTP, as a reviewer would use the app:
 *   npm run smoke -- --base https://your-deployment.vercel.app [--allow-rules-only]
 * It resets the demo data before and after, so only run it against a demo deployment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  ApplyResponse,
  HealthResponse,
  ImportCreatedResponse,
  ImportDetail,
  ShowtimeListResponse,
} from "~/types/api";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? "") : null;
};
const base = (flag("base") ?? "http://localhost:3000").replace(/\/$/, "");
const allowRulesOnly = args.includes("--allow-rules-only");
const AVERY = "user-admin-avery";
const RILEY = "user-viewer-riley";
const DOWNTOWN = "theater-downtown";

async function api<T>(
  method: string,
  route: string,
  options: { user?: string; body?: unknown; form?: FormData; expect?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.user) headers["x-user-id"] = options.user;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const expected = options.expect ?? 200;
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(`${method} ${route}: expected ${expected}, got ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

function check(label: string, actual: unknown, expected: unknown) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${same ? "  ok  " : " FAIL "} ${label}${same ? "" : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!same) process.exitCode = 1;
}

async function uploadAndAnalyze(file: string): Promise<ImportDetail> {
  const form = new FormData();
  const content = readFileSync(path.join(process.cwd(), "sample-data", file));
  form.set("file", new File([content], file, { type: "text/csv" }));
  form.set("scopeTheaterId", DOWNTOWN);
  const created = await api<ImportCreatedResponse>("POST", "/api/imports", { user: AVERY, form });
  const started = Date.now();
  await api("POST", `/api/imports/${created.importId}/analyze`, { user: AVERY });
  const detail = await api<ImportDetail>("GET", `/api/imports/${created.importId}`, { user: AVERY });
  console.log(`      analyzed ${file} in ${((Date.now() - started) / 1000).toFixed(1)} s (mode ${detail.mode}, model ${detail.model ?? "none"})`);
  return detail;
}

const pick = (detail: ImportDetail) => {
  const { add, update, archive, duplicate, unchanged, pending } = detail.counts;
  return { add, update, archive, duplicate, unchanged, pending };
};

console.log(`Smoke test against ${base}`);
const health = await api<HealthResponse>("GET", "/api/health");
check("health: database ok", health.db.ok, true);
check("health: migration", health.db.migration, "0003_apply_claim");
console.log(`      schema ${health.db.schema}, model ${health.llm.model}, AI configured: ${health.llm.configured}, commit ${health.commit ?? "local"}`);
if (!health.llm.configured && !allowRulesOnly) {
  check("health: AI configured (pass --allow-rules-only to skip)", false, true);
}

await api("POST", "/api/admin/reset-demo", { user: AVERY });
const before = await api<ShowtimeListResponse>("GET", "/api/showtimes", { user: AVERY });
check("list: Avery sees 12 seeded showtimes", before.total, 12);

const first = await uploadAndAnalyze("new-drop.csv");
if (health.llm.configured) {
  check("new-drop.csv: analyzed by the agent", first.mode, "ai");
  check("new-drop.csv: counts", pick(first), { add: 1, update: 0, archive: 0, duplicate: 1, unchanged: 4, pending: 0 });
  check("new-drop.csv: four rooms resolved by the agent", first.resolutions.filter((r) => r.method === "agent").length, 4);
  const applied = await api<ApplyResponse>("POST", `/api/imports/${first.id}/apply`, {
    user: AVERY,
    body: { planHash: first.planHash },
  });
  check("apply: applied", applied.status, "applied");
  check("apply: one showtime added", applied.theaters[0]?.applied, { add: 1 });

  const second = await uploadAndAnalyze("new-drop.csv");
  check("second upload: no model call", second.usage, null);
  check("second upload: no changes", pick(second), { add: 0, update: 0, archive: 0, duplicate: 1, unchanged: 5, pending: 0 });
  const again = await api<ApplyResponse>("POST", `/api/imports/${second.id}/apply`, {
    user: AVERY,
    body: { planHash: second.planHash },
  });
  check("second apply: nothing written", again.theaters[0]?.applied, {});
  const after = await api<ShowtimeListResponse>("GET", "/api/showtimes", { user: AVERY });
  check("list: one more showtime", after.total, 13);
} else {
  check("new-drop.csv: rule-based mode", first.mode, "rules_only");
  check("new-drop.csv: unresolved rooms wait for a decision", first.counts.pending > 0, true);
}

const history = await api<{ items: unknown[] }>("GET", "/api/imports", { user: AVERY });
check("history lists the imports", history.items.length, health.llm.configured ? 2 : 1);

const form = new FormData();
form.set("file", new File(["x"], "x.csv"));
await api("POST", "/api/imports", { user: RILEY, form, expect: 403 });
await api("GET", "/api/imports", { user: RILEY, expect: 403 });
await api("POST", `/api/theaters/${DOWNTOWN}/clear`, { user: RILEY, expect: 403 });
check("viewer: writes and import routes return 403", true, true);
const viewer = await api<ShowtimeListResponse>("GET", "/api/showtimes", { user: RILEY });
check("viewer: sees only Downtown", viewer.items.every((s) => s.theaterId === DOWNTOWN), true);

await api("POST", "/api/admin/reset-demo", { user: AVERY });
const reset = await api<ShowtimeListResponse>("GET", "/api/showtimes", { user: AVERY });
check("reset: back to the seed", reset.total, 12);
console.log(process.exitCode ? "Smoke test FAILED" : "Smoke test passed");

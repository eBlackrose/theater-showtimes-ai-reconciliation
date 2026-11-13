import "server-only";
import { tbl, type Db } from "~/server/db/client";

/**
 * Count one agent run against today's cap. The demo URL is public and the API key is not,
 * so runs are capped per UTC day. Returns false when the cap is reached.
 */
export async function reserveAgentRun(db: Db, dailyLimit: number): Promise<boolean> {
  if (dailyLimit <= 0) return false;
  const rows = await db.q`
    insert into ${tbl(db, "llm_usage_daily")} as u (day, runs)
    values ((now() at time zone 'utc')::date, 1)
    on conflict (day) do update set runs = u.runs + 1 where u.runs < ${dailyLimit}
    returning runs`;
  return rows.length > 0;
}

export async function recordAgentTokens(
  db: Db,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  await db.q`
    update ${tbl(db, "llm_usage_daily")}
    set input_tokens = input_tokens + ${inputTokens},
        output_tokens = output_tokens + ${outputTokens}
    where day = (now() at time zone 'utc')::date`;
}

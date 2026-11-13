import "server-only";
import { env } from "~/env";
import type { AnalyzeDeps } from "~/server/imports/service";
import { anthropicClient } from "./llm";

/** The model behind the agent, from the environment. Without a key the app runs on rules only. */
export function analyzeDeps(): AnalyzeDeps {
  return {
    llm: env.ANTHROPIC_API_KEY
      ? anthropicClient({
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.ANTHROPIC_MODEL,
          effort: env.AGENT_EFFORT,
        })
      : null,
    dailyRunLimit: env.AI_DAILY_RUN_LIMIT,
  };
}

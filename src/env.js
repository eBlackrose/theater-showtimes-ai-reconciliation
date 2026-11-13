import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    DB_SCHEMA: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .default("ronnie_takehome"),
    // Optional on purpose: without a key the app runs in rule-based mode instead of failing the build.
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
    AGENT_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
    AI_DAILY_RUN_LIMIT: z.coerce.number().int().min(0).default(200),
    DEMO_RESET_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },
  client: {},
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_SCHEMA: process.env.DB_SCHEMA,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    AGENT_EFFORT: process.env.AGENT_EFFORT,
    AI_DAILY_RUN_LIMIT: process.env.AI_DAILY_RUN_LIMIT,
    DEMO_RESET_ENABLED: process.env.DEMO_RESET_ENABLED,
    NODE_ENV: process.env.NODE_ENV,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});

import "server-only";
import Anthropic from "@anthropic-ai/sdk";

export interface LlmRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  /** Per-request timeout, so one slow call cannot eat the whole analysis budget. */
  timeoutMs: number;
}

/** The one seam between the agent loop and the provider. Tests script it. */
export interface LlmClient {
  readonly model: string;
  create(request: LlmRequest): Promise<Anthropic.Message>;
}

const MAX_TOKENS = 8000; // adaptive thinking tokens count toward this

export function anthropicClient(options: {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
}): LlmClient {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });
  return {
    model: options.model,
    create: ({ system, tools, messages, timeoutMs }) =>
      client.messages.create(
        {
          model: options.model,
          max_tokens: MAX_TOKENS,
          // The system prompt and tools are identical for every run: cache them.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          tools,
          // Forced tool choice and disabled thinking are rejected by this model family, so
          // the loop relies on strict tools, the prompt, and a nudge. Depth is set by effort.
          tool_choice: { type: "auto" },
          output_config: { effort: options.effort },
          messages,
        },
        { timeout: timeoutMs },
      ),
  };
}

/** A short reason safe to show an admin. Never includes request details or credentials. */
export function describeLlmError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "The AI service rejected the API key.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "The AI service is rate limited or its spend limit was reached.";
  }
  if (
    error instanceof Anthropic.BadRequestError &&
    /you have reached your specified/i.test(error.message)
  ) {
    return "The AI spend limit for this workspace was reached.";
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return "The AI service timed out.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "The AI service could not be reached.";
  }
  if (error instanceof Anthropic.APIError) {
    return `The AI service returned an error (HTTP ${error.status ?? "unknown"}).`;
  }
  return "The AI step failed unexpectedly.";
}

import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { describeLlmError, type LlmClient } from "./llm";
import { describeWorkItem, firstUserMessage, SYSTEM_PROMPT } from "./prompt";
import { createToolRunner, TOOLS } from "./tools";
import type { AgentBackend, AgentOutcome, AgentSession, Emit } from "./types";

export interface AgentLimits {
  maxTurns: number;
  maxToolCalls: number;
  /** Wall-clock budget for the whole run. */
  budgetMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxTurns: 8,
  maxToolCalls: 40,
  budgetMs: 100_000,
  requestTimeoutMs: 60_000,
};

const MAX_SUMMARY_CHARS = 1200;

/**
 * The agent loop. It never dead-ends: whatever the model does (stops early, refuses, runs
 * out of tokens, errors, exceeds a budget), the function returns, and the caller turns the
 * subjects that are still open into fallback resolutions for the admin to decide.
 */
export async function runAgent(options: {
  llm: LlmClient;
  session: AgentSession;
  backend: AgentBackend;
  emit: Emit;
  limits?: Partial<AgentLimits>;
  now?: () => number;
}): Promise<AgentOutcome> {
  const { llm, session, emit } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const started = now();
  const runTool = createToolRunner(session, options.backend, emit);
  const usage = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: firstUserMessage(session) },
  ];
  let nudged = false;

  const finish = (stopReason: string, summary: string | null = null): AgentOutcome => ({
    complete: session.remaining().length === 0,
    summary,
    usage: { ...usage, durationMs: now() - started, stopReason },
  });

  while (true) {
    if (usage.turns >= limits.maxTurns) return finish("turn_limit");
    const remainingMs = limits.budgetMs - (now() - started);
    if (remainingMs <= 1_000) return finish("time_limit");

    let response: Anthropic.Message;
    const turnStarted = now();
    try {
      response = await llm.create({
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
        timeoutMs: Math.min(limits.requestTimeoutMs, remainingMs),
      });
    } catch (error) {
      await emit({ type: "error", message: describeLlmError(error) });
      return finish("error");
    }
    usage.turns += 1;
    usage.inputTokens +=
      response.usage.input_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0);
    usage.outputTokens += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    await emit({
      type: "llm_turn",
      message:
        toolUses.length > 0
          ? `Model turn ${usage.turns}: asked for ${toolUses.map((t) => t.name).join(", ")}`
          : `Model turn ${usage.turns}: ${response.stop_reason === "end_turn" ? "finished" : `stopped (${response.stop_reason})`}`,
      data: {
        model: llm.model,
        stopReason: response.stop_reason,
        inputTokens: response.usage.input_tokens,
        cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
        outputTokens: response.usage.output_tokens,
        ms: now() - turnStarted,
      },
    });

    // The content goes back unchanged: it can hold thinking blocks the API needs to see again.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use" && toolUses.length > 0) {
      if (usage.toolCalls + toolUses.length > limits.maxToolCalls) {
        return finish("tool_call_limit");
      }
      usage.toolCalls += toolUses.length;
      // Every result of this turn goes into ONE user message, results first.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const output = await runTool(toolUse.name, toolUse.input);
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: output.content,
          is_error: output.isError,
        });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "user", content: "Continue." });
      continue;
    }

    if (response.stop_reason === "end_turn") {
      const remaining = session.remaining();
      if (remaining.length === 0) {
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim()
          .slice(0, MAX_SUMMARY_CHARS);
        return finish("end_turn", text || null);
      }
      if (nudged) return finish("stopped_early");
      nudged = true;
      await emit({
        type: "note",
        message: `The model stopped with ${remaining.length} item${remaining.length === 1 ? "" : "s"} unresolved; asked it to finish`,
      });
      messages.push({
        role: "user",
        content: `These subjects are still unresolved. Resolve each one with submit_resolutions, then write the summary.\n<worklist>${JSON.stringify(remaining.map(describeWorkItem))}</worklist>`,
      });
      continue;
    }

    // max_tokens, refusal, model_context_window_exceeded, or anything new: stop and fall back.
    return finish(response.stop_reason ?? "unknown");
  }
}

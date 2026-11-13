import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { describeLlmError } from "~/server/agent/llm";
import { runAgent } from "~/server/agent/loop";
import type { AgentBackend, AgentEvent } from "~/server/agent/types";
import { Analysis } from "~/server/imports/analysis";
import { prepareFile, type PlanState } from "~/server/imports/workspace";
import { fakeLlm } from "../integration/helpers";
import { avery, DOWNTOWN, sample, seedCatalog, seedSchedule, theaters } from "../unit/fixtures";

const backend: AgentBackend = {
  searchMovies: async (query) => [
    { id: "mv-inside-out-2", title: "Inside Out 2", aliases: [], score: 0.6, showingAt: [] },
    { id: "mv-inside-out", title: "Inside Out", aliases: [], score: 0.5, showingAt: [query] },
  ],
  theaterContext: async (id) => ({
    id,
    name: "Downtown Cinema 7",
    timezone: "America/Los_Angeles",
    rooms: [],
    liveShowtimes: 5,
    firstDate: "2025-03-15",
    lastDate: "2025-03-16",
  }),
  schedule: async () => ({ rows: [], truncated: false }),
};

/** A real analysis session over a sample file and the seeded catalog, with no database. */
function session(file = "new-drop.csv") {
  const prepared = prepareFile({
    content: sample(file),
    actor: avery,
    scopeTheaterId: DOWNTOWN,
    archiveScope: "file_window",
    allTheaters: theaters,
    uploadedAt: "2025-03-15T12:00:00.000Z",
  });
  if (!prepared.ok) throw new Error("fixture file is invalid");
  const catalog = seedCatalog();
  const state: PlanState = {
    catalog,
    schedules: new Map([[DOWNTOWN, seedSchedule()]]),
    versions: new Map([[DOWNTOWN, 0]]),
  };
  const byId = async (id: string) => {
    const title = catalog.movieTitles.get(id);
    return title ? { id, title } : null;
  };
  const byKey = async (key: string) => {
    const id = catalog.movieByKey.get(key);
    return id ? byId(id) : null;
  };
  return new Analysis(prepared.file, state, [], new Map(), { byId, byKey });
}

const room = (subjectKey: string, targetId: string | null, extra: Record<string, unknown> = {}) => ({
  kind: "auditorium",
  subjectKey,
  theaterId: DOWNTOWN,
  decision: targetId ? "existing" : "new",
  targetId,
  canonicalName: null,
  confidence: "high",
  explanation: "Same room, written differently.",
  ...extra,
});
const allRooms = [
  room("aud 1", "aud-downtown-auditorium-1"),
  room("auditorium two", "aud-downtown-auditorium-2"),
  room("auditorium 1 laser", "aud-downtown-auditorium-1"),
  room("auditorium 5", null),
];
const submit = (resolutions: unknown[]) => ({
  tools: [{ name: "submit_resolutions", input: { resolutions } }],
});

async function run(
  steps: Parameters<typeof fakeLlm>[0],
  options: { file?: string; limits?: Parameters<typeof runAgent>[0]["limits"]; now?: () => number } = {},
) {
  const analysis = session(options.file);
  const llm = fakeLlm(steps);
  const events: AgentEvent[] = [];
  const outcome = await runAgent({
    llm,
    session: analysis,
    backend,
    emit: async (event) => void events.push(event),
    limits: options.limits,
    now: options.now,
  });
  return { analysis, llm, events, outcome };
}

type ToolResult = Anthropic.ToolResultBlockParam;
const toolResults = (message: Anthropic.MessageParam | undefined) =>
  (message?.content as ToolResult[]).filter((block) => block.type === "tool_result");
const resultJson = (block: ToolResult | undefined) =>
  JSON.parse(block?.content as string) as {
    results: { subjectKey: string; status: string; reason?: string }[];
    stillUnresolved: { subjectKey: string }[];
  };

describe("agent loop", () => {
  it("resolves the worklist in two turns and keeps the summary", async () => {
    const { outcome, analysis, llm, events } = await run([
      submit(allRooms),
      { text: "Three rooms matched. Auditorium 5 is new." },
    ]);
    expect(outcome).toMatchObject({
      complete: true,
      summary: "Three rooms matched. Auditorium 5 is new.",
      usage: { turns: 2, toolCalls: 1, inputTokens: 200, outputTokens: 40, stopReason: "end_turn" },
    });
    expect(analysis.remaining()).toEqual([]);
    expect([...analysis.resolutions.values()].map((r) => r.method)).toEqual(Array(4).fill("agent"));

    // The first message carries the worklist and the file rows inside a delimited block.
    const first = llm.requests[0]?.messages[0]?.content as string;
    expect(first).toContain("<worklist>");
    expect(first).toMatch(/<file_rows>.*Auditorium Two.*<\/file_rows>/s);
    expect(llm.requests[0]?.tools.every((tool) => tool.strict === true)).toBe(true);

    expect(events.filter((e) => e.type === "llm_turn")).toHaveLength(2);
    expect(events.filter((e) => e.type === "resolution").map((e) => e.message)).toContain(
      'Decided: "Aud 1" is Auditorium 1 at Downtown Cinema 7 (high confidence)',
    );
  });

  it("runs parallel tool calls and returns every result in one user message, results first", async () => {
    const { llm, outcome } = await run([
      {
        tools: [
          { name: "search_movies", input: { query: "Inside Out", limit: 3 } },
          { name: "get_theater_context", input: { theaterId: DOWNTOWN } },
          { name: "get_schedule", input: { theaterId: DOWNTOWN, fromDate: "2025-03-15", toDate: "2025-03-15", movieId: null } },
        ],
      },
      submit(allRooms),
      { text: "Done." },
    ]);
    expect(outcome.usage).toMatchObject({ turns: 3, toolCalls: 4 });
    const second = llm.requests[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const results = second[2]?.content as ToolResult[];
    expect(results.map((block) => block.type)).toEqual(["tool_result", "tool_result", "tool_result"]);
    expect(results.map((block) => block.tool_use_id)).toEqual(["toolu_1_0", "toolu_1_1", "toolu_1_2"]);
    expect(results.every((block) => block.is_error === false)).toBe(true);
  });

  it("appends the assistant content unchanged", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const analysis = session();
    const reply = (content: unknown[], stop: string) =>
      ({ content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Anthropic.Message;
    const sent: Anthropic.MessageParam[][] = [];
    const first = [
      thinking,
      { type: "tool_use", id: "t1", name: "submit_resolutions", input: { resolutions: allRooms } },
    ];
    let call = 0;
    await runAgent({
      llm: {
        model: "fake",
        create: async ({ messages }) => {
          sent.push([...messages]);
          return call++ === 0 ? reply(first, "tool_use") : reply([{ type: "text", text: "ok" }], "end_turn");
        },
      },
      session: analysis,
      backend,
      emit: async () => undefined,
    });
    expect(sent[1]?.[1]).toEqual({ role: "assistant", content: first });
    expect((sent[1]?.[1]?.content as unknown[])[0]).toBe(thinking);
  });

  it("returns a rejection with its reason and accepts the corrected resubmission", async () => {
    const { llm, outcome, analysis, events } = await run([
      submit([
        room("aud 1", "aud-riverside-auditorium-a"), // a room of another theater
        room("auditorium two", "aud-downtown-auditorium-2"),
        room("auditorium 9", "aud-downtown-auditorium-1"), // not on the worklist
        { ...room("auditorium 5", null), kind: "movie", theaterId: null }, // wrong kind
        room("auditorium 1 laser", null, { decision: "moved" }), // wrong decision for a room
      ]),
      submit([room("aud 1", "aud-downtown-auditorium-1"), room("auditorium 1 laser", "aud-downtown-auditorium-1"), room("auditorium 5", null)]),
      { text: "Done." },
    ]);
    const firstResult = resultJson(toolResults(llm.requests[1]?.messages[2])[0]);
    expect(firstResult.results.map((r) => r.status)).toEqual([
      "rejected",
      "accepted",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(firstResult.results[0]?.reason).toContain("is not a room of Downtown Cinema 7");
    expect(firstResult.results[2]?.reason).toContain("not on the worklist");
    expect(firstResult.stillUnresolved.map((s) => s.subjectKey)).toEqual([
      "aud 1",
      "auditorium 1 laser",
      "auditorium 5",
    ]);
    expect(outcome.complete).toBe(true);
    expect(analysis.resolutions.size).toBe(4);
    expect(events.some((e) => e.type === "resolution" && e.data?.status === "rejected")).toBe(true);
  });

  it("rejects unknown movie ids and a 'new' movie that already exists", async () => {
    const movie = (subjectKey: string, decision: string, targetId: string | null, canonicalName: string | null = null) => ({
      kind: "movie",
      subjectKey,
      theaterId: null,
      decision,
      targetId,
      canonicalName,
      confidence: "high",
      explanation: "Evidence.",
    });
    const { llm, analysis } = await run(
      [
        submit([
          movie("spiderman homecomming", "existing", "mv-does-not-exist"),
          movie("inside out ii", "new", null, "Inside Out 2"),
          movie("challengers", "existing", null),
          movie("kung fu panda iv", "existing", "mv-kung-fu-panda-4"),
          { ...movie("dune pt 2 imax", "existing", "mv-dune-part-2"), explanation: "  " },
        ]),
        { stop: "refusal" },
      ],
      { file: "ai-messy-drop.csv" },
    );
    const result = resultJson(toolResults(llm.requests[1]?.messages[2])[0]);
    expect(result.results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected", "accepted", "rejected"]);
    expect(result.results[0]?.reason).toContain("No movie has the id");
    expect(result.results[1]?.reason).toContain('already exists in the catalog as "Inside Out 2"');
    expect(result.results[4]?.reason).toContain("explanation is required");
    expect([...analysis.resolutions.keys()]).toEqual(["movie||kung fu panda iv"]);
  });

  it("offers a reschedule question once the title is resolved", async () => {
    const { llm, analysis } = await run(
      [
        submit([
          {
            kind: "movie",
            subjectKey: "inside out ii",
            theaterId: null,
            decision: "existing",
            targetId: "mv-inside-out-2",
            canonicalName: null,
            confidence: "high",
            explanation: "Roman numeral for 2.",
          },
        ]),
        submit([
          {
            kind: "reschedule",
            subjectKey: "st-dt-002|2025-03-15T17:45:00.000Z",
            theaterId: DOWNTOWN,
            decision: "moved",
            targetId: null,
            canonicalName: null,
            confidence: "medium",
            explanation: "Same film, 15 minutes later.",
          },
        ]),
        { stop: "max_tokens" },
      ],
      { file: "ai-messy-drop.csv" },
    );
    const afterTitle = resultJson(toolResults(llm.requests[1]?.messages[2])[0]);
    expect(afterTitle.stillUnresolved.map((s) => s.subjectKey)).toContain(
      "st-dt-002|2025-03-15T17:45:00.000Z",
    );
    expect(analysis.resolutions.get(`reschedule|${DOWNTOWN}|st-dt-002|2025-03-15T17:45:00.000Z`)?.outcome).toEqual({
      type: "moved",
    });
  });
});

describe("agent guardrails: the loop always returns", () => {
  const lookup = { tools: [{ name: "search_movies", input: { query: "x", limit: 1 } }] };

  it("stops at the turn limit", async () => {
    const { outcome } = await run(Array.from({ length: 10 }, () => lookup), { limits: { maxTurns: 3 } });
    expect(outcome).toMatchObject({ complete: false, usage: { turns: 3, stopReason: "turn_limit" } });
  });

  it("stops at the tool-call limit", async () => {
    const many = { tools: Array(3).fill(lookup.tools[0]) as { name: string; input: unknown }[] };
    const { outcome } = await run([many, many, many], { limits: { maxToolCalls: 5 } });
    expect(outcome.usage).toMatchObject({ toolCalls: 3, stopReason: "tool_call_limit" });
  });

  it("stops at the wall-clock budget", async () => {
    let clock = 0;
    const { outcome, llm } = await run(Array.from({ length: 10 }, () => lookup), {
      limits: { budgetMs: 100_000 },
      now: () => (clock += 20_000),
    });
    expect(outcome.usage.stopReason).toBe("time_limit");
    expect(llm.requests.length).toBeLessThan(5);
    expect(llm.requests[0]?.timeoutMs).toBeLessThanOrEqual(60_000);
  });

  it("nudges once when the model stops with subjects left, then gives up", async () => {
    const { outcome, llm, analysis, events } = await run([
      { text: "All done!" },
      submit([room("aud 1", "aud-downtown-auditorium-1")]),
      { text: "Finished." },
    ]);
    expect(outcome).toMatchObject({ complete: false, summary: null, usage: { stopReason: "stopped_early" } });
    const nudge = llm.requests[1]?.messages.at(-1);
    expect(nudge?.role).toBe("user");
    expect(nudge?.content).toContain("still unresolved");
    expect(events.filter((e) => e.type === "note")).toHaveLength(1);

    // What is left becomes a low-confidence fallback for the admin.
    expect(analysis.applyFallbacks("The AI did not decide this one.")).toBe(3);
    expect(analysis.unresolvedSubjects().unresolved).toEqual([]);
    const fallback = [...analysis.resolutions.values()].find((r) => r.method === "fallback");
    expect(fallback).toMatchObject({ confidence: "low", outcome: { type: "new" } });
  });

  it.each([["refusal"], ["max_tokens"], ["model_context_window_exceeded"]] as const)(
    "stops on %s",
    async (stop) => {
      const { outcome } = await run([{ stop }]);
      expect(outcome).toMatchObject({ complete: false, usage: { turns: 1, stopReason: stop } });
    },
  );

  it("continues after pause_turn", async () => {
    const { outcome } = await run([{ stop: "pause_turn" }, submit(allRooms), { text: "Done." }]);
    expect(outcome.complete).toBe(true);
  });

  const apiError = (status: number, message: string) =>
    Anthropic.APIError.generate(
      status,
      { type: "error", error: { type: "invalid_request_error", message } },
      message,
      new Headers(),
    );

  it.each([
    [apiError(400, "You have reached your specified API usage limits."), /spend limit/],
    [apiError(429, "enforced_spend_limit_reached"), /rate limited or its spend limit/],
    [apiError(401, "invalid x-api-key"), /rejected the API key/],
    [new Error("socket hang up"), /failed unexpectedly/],
  ])("treats a thrown API error as 'AI unavailable' (%#)", async (error, expected) => {
    const { outcome, events } = await run([{ error }]);
    expect(outcome).toMatchObject({ complete: false, usage: { turns: 0, stopReason: "error" } });
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.at(-1)?.message).toMatch(expected);
    expect(describeLlmError(error)).not.toContain("sk-");
  });

  it("answers an unknown tool or bad input with an error result instead of crashing", async () => {
    const { llm } = await run([
      {
        tools: [
          { name: "drop_tables", input: {} },
          { name: "get_schedule", input: { theaterId: "theater-uptown", fromDate: "2025-03-15", toDate: "2025-03-15", movieId: null } },
          { name: "get_schedule", input: { theaterId: DOWNTOWN, fromDate: "March 15", toDate: "x", movieId: null } },
        ],
      },
      { stop: "refusal" },
    ]);
    const results = toolResults(llm.requests[1]?.messages[2]);
    expect(results.map((r) => r.is_error)).toEqual([true, true, true]);
    expect(results[1]?.content).toContain("not in scope");
  });
});

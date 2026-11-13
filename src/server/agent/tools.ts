import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { describeWorkItem } from "./prompt";
import type { AgentBackend, AgentSession, Emit } from "./types";

const MAX_RESULT_CHARS = 8000;

/**
 * Three read-only lookups and one submit tool. The model cannot write to the schedule: its
 * only output is a list of resolutions, each validated on the server before it counts.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_movies",
    description:
      "Search the movie catalog by title. Use it when the candidates listed for a title on the worklist do not include a convincing match, or to check whether a similar film (a sequel, a different subtitle) also exists. It returns the closest catalog movies by text similarity over canonical titles and saved aliases, each with its id, title, aliases, a similarity score from 0 to 1, and the theaters currently showing it. It is read-only and only knows the catalog: a film that is missing here is new to the system.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Title text to search for." },
        limit: { type: "integer", description: "How many results to return, 1 to 10." },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "get_theater_context",
    description:
      "Look up one theater in scope. Use it to see the theater's real room names and their saved aliases before deciding what an unfamiliar auditorium name refers to. It returns the theater's rooms with aliases, its time zone, and the date range and number of its live showtimes. It is read-only and only works for theaters listed as in scope for this upload.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        theaterId: { type: "string", description: "Id of a theater in scope." },
      },
      required: ["theaterId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_schedule",
    description:
      "Read the stored schedule of one theater in scope for a range of theater-local dates. Use it as evidence: a stored showtime with the same start time, room, language and rating as a file row usually is the same film, and a stored showtime close to a new row may have moved. It returns up to 200 showtimes with movie id and title, room, local start and end, format, language, rating and status, plus a `truncated` flag. Pass a movieId to see only one film, or null for all films. It is read-only.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        theaterId: { type: "string", description: "Id of a theater in scope." },
        fromDate: { type: "string", description: "First theater-local day, YYYY-MM-DD." },
        toDate: { type: "string", description: "Last theater-local day, YYYY-MM-DD." },
        movieId: {
          type: ["string", "null"],
          description: "Only this movie's showtimes, or null for all.",
        },
      },
      required: ["theaterId", "fromDate", "toDate", "movieId"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_resolutions",
    description:
      "Submit your decisions for subjects on the worklist. This is the only way to resolve them, and you can and should send many decisions in one call. Each decision is checked on the server: the subject must be on the worklist, and a target id must exist (a room must belong to that theater). The result says, per item, whether it was accepted or rejected with the reason, and lists every subject that is still unresolved, so you can correct rejected items and continue. Submitting never changes the schedule; an admin reviews everything first.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        resolutions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["movie", "auditorium", "reschedule"] },
              subjectKey: {
                type: "string",
                description: "The subjectKey exactly as given on the worklist.",
              },
              theaterId: {
                type: ["string", "null"],
                description: "The theater id for auditorium and reschedule subjects; null for movies.",
              },
              decision: {
                type: "string",
                enum: ["existing", "new", "moved", "separate"],
                description:
                  "Movies and auditoriums: existing or new. Reschedules: moved or separate.",
              },
              targetId: {
                type: ["string", "null"],
                description: "Id of the existing movie or room when decision is existing; otherwise null.",
              },
              canonicalName: {
                type: ["string", "null"],
                description:
                  "Only for decision new: a cleaned-up name to create, or null to use the spelling from the file.",
              },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              explanation: {
                type: "string",
                description:
                  "One or two plain sentences for a theater manager, naming the evidence.",
              },
            },
            required: [
              "kind",
              "subjectKey",
              "theaterId",
              "decision",
              "targetId",
              "canonicalName",
              "confidence",
              "explanation",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["resolutions"],
      additionalProperties: false,
    },
  },
];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const inputs = {
  search_movies: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(10).catch(5),
  }),
  get_theater_context: z.object({ theaterId: z.string() }),
  get_schedule: z.object({
    theaterId: z.string(),
    fromDate: day,
    toDate: day,
    movieId: z.string().nullable(),
  }),
  submit_resolutions: z.object({
    resolutions: z
      .array(
        z.object({
          kind: z.enum(["movie", "auditorium", "reschedule"]),
          subjectKey: z.string(),
          theaterId: z.string().nullable(),
          decision: z.enum(["existing", "new", "moved", "separate"]),
          targetId: z.string().nullable(),
          canonicalName: z.string().max(200).nullable(),
          confidence: z.enum(["high", "medium", "low"]),
          explanation: z.string().max(1000),
        }),
      )
      .min(1)
      .max(200),
  }),
};

export interface ToolOutput {
  content: string;
  isError: boolean;
}

const ok = (value: unknown): ToolOutput => {
  const content = JSON.stringify(value);
  return content.length <= MAX_RESULT_CHARS
    ? { content, isError: false }
    : {
        content: `${content.slice(0, MAX_RESULT_CHARS)}… [result cut at ${MAX_RESULT_CHARS} characters; narrow the request]`,
        isError: false,
      };
};
const fail = (message: string): ToolOutput => ({ content: message, isError: true });

export function createToolRunner(session: AgentSession, backend: AgentBackend, emit: Emit) {
  const theaterName = (id: string) => session.theaters.find((t) => t.id === id)?.name;
  const notInScope = (id: string) =>
    fail(
      `Theater "${id}" is not in scope for this upload. Use one of: ${session.theaters.map((t) => t.id).join(", ")}.`,
    );

  return async function runTool(name: string, rawInput: unknown): Promise<ToolOutput> {
    const started = Date.now();
    const log = (message: string, data: Record<string, unknown> = {}) =>
      emit({
        type: "tool_call",
        message,
        data: { tool: name, ms: Date.now() - started, ...data },
      });
    try {
      switch (name) {
        case "search_movies": {
          const input = inputs.search_movies.parse(rawInput);
          const hits = await backend.searchMovies(input.query, input.limit);
          await log(
            `Looked up "${input.query}" in the catalog: ${hits.length} candidate${hits.length === 1 ? "" : "s"}`,
            { query: input.query, results: hits.map((h) => h.title) },
          );
          return ok({ results: hits });
        }
        case "get_theater_context": {
          const input = inputs.get_theater_context.parse(rawInput);
          if (!theaterName(input.theaterId)) return notInScope(input.theaterId);
          const context = await backend.theaterContext(input.theaterId);
          if (!context) return notInScope(input.theaterId);
          await log(`Checked the rooms of ${context.name}`, { rooms: context.rooms.length });
          return ok(context);
        }
        case "get_schedule": {
          const input = inputs.get_schedule.parse(rawInput);
          const theater = theaterName(input.theaterId);
          if (!theater) return notInScope(input.theaterId);
          const result = await backend.schedule(input);
          await log(
            `Checked the schedule of ${theater} for ${input.fromDate}${input.toDate !== input.fromDate ? ` to ${input.toDate}` : ""}: ${result.rows.length} showtime${result.rows.length === 1 ? "" : "s"}`,
            { fromDate: input.fromDate, toDate: input.toDate, movieId: input.movieId },
          );
          return ok({ showtimes: result.rows, truncated: result.truncated });
        }
        case "submit_resolutions": {
          const input = inputs.submit_resolutions.parse(rawInput);
          const results = await session.submit(input.resolutions);
          const accepted = results.filter((r) => r.status === "accepted").length;
          await log(
            `Submitted ${results.length} decision${results.length === 1 ? "" : "s"}: ${accepted} accepted${accepted < results.length ? `, ${results.length - accepted} rejected` : ""}`,
            { accepted, rejected: results.length - accepted },
          );
          for (const result of results) {
            await emit({
              type: "resolution",
              message: result.summary,
              data: { kind: result.kind, status: result.status },
            });
          }
          const remaining = session.remaining();
          return ok({
            results: results.map(({ kind, subjectKey, status, reason }) => ({
              kind,
              subjectKey,
              status,
              ...(reason ? { reason } : {}),
            })),
            stillUnresolved: remaining.map(describeWorkItem),
            next:
              remaining.length === 0
                ? "Everything is resolved. Write the summary for the admin."
                : "Resolve the subjects in stillUnresolved with another submit_resolutions call.",
          });
        }
        default:
          return fail(
            `Unknown tool "${name}". Available tools: ${TOOLS.map((t) => t.name).join(", ")}.`,
          );
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return fail(
          `Invalid input for ${name}: ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Fix the input and call the tool again.`,
        );
      }
      console.error(error);
      await log(`A lookup failed (${name})`);
      return fail(
        `${name} failed on the server. Decide from the information you already have, with lower confidence if needed.`,
      );
    }
  };
}

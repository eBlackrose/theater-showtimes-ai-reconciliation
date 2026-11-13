/** An error with an HTTP status. Thrown anywhere on the server, mapped once in the route wrapper. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "bad_request", message, details);
export const unauthorized = (message: string) =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message: string) => new ApiError(403, "forbidden", message);
export const notFound = (what: string) =>
  new ApiError(404, "not_found", `${what} was not found.`);
export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, "conflict", message, details);

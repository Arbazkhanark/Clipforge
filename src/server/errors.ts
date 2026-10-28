// Errors the server layer throws on purpose, and how they become HTTP responses.
// Unexpected errors become a generic 500 so internal details never leak to the browser.

export class AppError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notAuthenticated = (): AppError => new AppError(401, "not_authenticated", "Please sign in to continue.");
/** Also used when something exists but belongs to someone else: we do not reveal which. */
export const notFound = (what: string): AppError => new AppError(404, "not_found", `${what} was not found.`);
export const forbidden = (message: string): AppError => new AppError(403, "forbidden", message);
export const planLimit = (message: string): AppError => new AppError(403, "plan_limit", message);
export const conflict = (message: string, details?: unknown): AppError => new AppError(409, "conflict", message, details);
export const validationFailed = (errors: string[]): AppError => new AppError(422, "validation_failed", "The request is not valid.", { errors });

export interface HttpResult { status: number; body: { error: { code: string; message: string; details?: unknown } } }

export function toHttpResult(error: unknown): HttpResult {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } } };
  }
  return { status: 500, body: { error: { code: "internal_error", message: "Something went wrong on our side. Please try again." } } };
}

/**
 * Errors the services throw and the routes translate. `code` is stable and appears in the API's error body.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export const notFound = (what = "item"): HttpError => new HttpError(404, "not_found", `That ${what} was not found.`);
export const badRequest = (code: string, message: string, details?: Record<string, unknown>): HttpError => new HttpError(400, code, message, details);
export const conflict = (code: string, message: string, details?: Record<string, unknown>): HttpError => new HttpError(409, code, message, details);
export const forbidden = (code: string, message: string): HttpError => new HttpError(403, code, message);

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}

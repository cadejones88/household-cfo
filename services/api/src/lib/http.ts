/**
 * Route helpers: zod validation that fails as 400 with a stable code, the error handler that maps service errors
 * to responses, the household scope for a request, and the step-up check.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { IllegalTransitionError } from "@homestead/shared";
import { z } from "zod";
import { withHousehold, type Queryable } from "../db/index.js";
import { hasFreshStepUp, type Principal } from "./auth.js";
import { HttpError, forbidden } from "./errors.js";
import { redactString } from "./logScrub.js";
import type { Deps } from "../deps.js";

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(400, "validation", issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Validation failed", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  return r.data;
}

export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new HttpError(401, "not_signed_in", "Sign in first");
  return req.principal;
}

/** Run `fn` inside the signed-in member's household transaction. */
export function inHousehold<T>(req: FastifyRequest, fn: (db: Queryable, p: Principal) => Promise<T>): Promise<T> {
  const p = principalOf(req);
  return withHousehold(p.householdId, (db) => fn(db, p));
}

export function requireStepUp(req: FastifyRequest): void {
  if (!hasFreshStepUp(req)) throw forbidden("step_up_required", "Confirm with Face ID (or your passcode) first");
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError) {
      const body: Record<string, unknown> = { error: err.code, message: err.message };
      if (err.details) body["details"] = err.details;
      return reply.code(err.status).send(body);
    }
    if (err instanceof IllegalTransitionError) {
      return reply.code(409).send({ error: "illegal_transition", message: "This item cannot move that way from where it is.", details: { from: err.from, to: err.to } });
    }
    const fe = err as FastifyError;
    if (typeof fe.statusCode === "number" && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: fe.code ?? `http_${fe.statusCode}`, message: redactString(fe.message) });
    }
    req.log.error({ err: { type: err.name, message: redactString(err.message) } }, "unhandled");
    return reply.code(500).send({ error: "internal", message: "Something went wrong on our side." });
  });
}

export const idParam = z.object({ id: z.string().min(1).max(200) });
export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const month = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM");
export const cents = z.number().int().safe();
export const splitInput = z.object({ amountCents: cents, categoryId: z.string().min(1).max(64), description: z.string().max(100).optional() });

/** Multipart helper: the first file part and the text fields of a request registered with @fastify/multipart. */
export async function readMultipart(req: FastifyRequest): Promise<{ file?: { bytes: Uint8Array; contentType: string; filename: string }; fields: Record<string, string> }> {
  const fields: Record<string, string> = {};
  let file: { bytes: Uint8Array; contentType: string; filename: string } | undefined;
  const parts = (req as FastifyRequest & { parts: () => AsyncIterable<{ type: string; fieldname: string; value?: unknown; mimetype?: string; filename?: string; toBuffer?: () => Promise<Buffer> }> }).parts();
  for await (const part of parts) {
    if (part.type === "file" && part.toBuffer) {
      if (!file) file = { bytes: new Uint8Array(await part.toBuffer()), contentType: part.mimetype ?? "application/octet-stream", filename: part.filename ?? "" };
      else await part.toBuffer();
    } else if (typeof part.value === "string") fields[part.fieldname] = part.value;
  }
  const out: { file?: { bytes: Uint8Array; contentType: string; filename: string }; fields: Record<string, string> } = { fields };
  if (file) out.file = file;
  return out;
}

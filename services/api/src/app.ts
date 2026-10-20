/**
 * The Fastify application. Routes are registered under /v1; every route except /health and the webhook
 * receivers requires a signed-in member and runs inside that member's household (RLS).
 */
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { scrubbingSerializers } from "./lib/logScrub.js";
import { authPlugin } from "./lib/auth.js";
import { healthRoutes } from "./routes/health.js";

export interface BuildOptions {
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const loggerInstance = pino({
    level: opts.logger === false ? "silent" : (process.env["LOG_LEVEL"] ?? "info"),
    serializers: scrubbingSerializers as unknown as Record<string, pino.SerializerFn>,
  });
  const app = Fastify({
    loggerInstance,
    bodyLimit: 1_000_000,
    trustProxy: true,
  }) as unknown as FastifyInstance;

  await app.register(helmet);
  await app.register(cors, { origin: (process.env["CORS_ORIGINS"] ?? "").split(",").filter(Boolean), credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(authPlugin);
  await app.register(healthRoutes);

  // Feature routes are registered here as the epics land (E3–E6). Each module exports a Fastify plugin.
  for (const mod of await loadRouteModules()) {
    await app.register(mod, { prefix: "/v1" });
  }

  return app;
}

async function loadRouteModules() {
  const mods: Array<(app: FastifyInstance) => Promise<void>> = [];
  const names = ["accounts", "transactions", "questions", "receipts", "paychecks", "budget", "goals", "bills", "ask", "approvals", "rules", "console", "webhooks"];
  for (const name of names) {
    try {
      const m = (await import(`./routes/${name}.js`)) as { default?: (app: FastifyInstance) => Promise<void> };
      if (m.default) mods.push(m.default);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
    }
  }
  return mods;
}

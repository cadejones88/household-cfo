/**
 * The Fastify application. Routes are registered under /v1; every route except /health and the webhook
 * receivers requires a signed-in member and runs inside that member's household (RLS).
 *
 * Route modules live in src/routes/<name>.ts, each exporting a default Fastify plugin registered under /v1.
 *
 * `deps` holds the ports (ledger, secrets, blobs, queue, Plaid, Document Intelligence, Claude, notifier). Tests
 * pass fakes; production builds them from the environment (deps.ts). Routes reach them as `app.deps`.
 */
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { scrubbingSerializers } from "./lib/logScrub.js";
import { authPlugin } from "./lib/auth.js";
import { registerErrorHandler } from "./lib/http.js";
import { healthRoutes } from "./routes/health.js";
import { buildDepsFromEnv, type Deps } from "./deps.js";
import meRoutes from "./routes/me.js";
import accountsRoutes from "./routes/accounts.js";
import transactionsRoutes from "./routes/transactions.js";
import questionsRoutes from "./routes/questions.js";
import receiptsRoutes from "./routes/receipts.js";
import paychecksRoutes from "./routes/paychecks.js";
import budgetRoutes from "./routes/budget.js";
import goalsRoutes from "./routes/goals.js";
import billsRoutes from "./routes/bills.js";
import askRoutes from "./routes/ask.js";
import approvalsRoutes from "./routes/approvals.js";
import rulesRoutes from "./routes/rules.js";
import alertsRoutes from "./routes/alerts.js";
import consoleRoutes from "./routes/console.js";
import webhooksRoutes from "./routes/webhooks.js";
import devicesRoutes from "./routes/devices.js";

declare module "fastify" {
  interface FastifyInstance {
    routeList: { method: string; url: string }[];
  }
}

export interface BuildOptions {
  logger?: boolean;
  deps?: Deps;
}

export const ROUTE_MODULES = ["me", "accounts", "transactions", "questions", "receipts", "paychecks", "budget", "goals", "bills", "ask", "approvals", "rules", "alerts", "console", "webhooks", "devices"] as const;

const ROUTES: Record<(typeof ROUTE_MODULES)[number], (app: FastifyInstance) => Promise<void>> = {
  me: meRoutes,
  accounts: accountsRoutes,
  transactions: transactionsRoutes,
  questions: questionsRoutes,
  receipts: receiptsRoutes,
  paychecks: paychecksRoutes,
  budget: budgetRoutes,
  goals: goalsRoutes,
  bills: billsRoutes,
  ask: askRoutes,
  approvals: approvalsRoutes,
  rules: rulesRoutes,
  alerts: alertsRoutes,
  console: consoleRoutes,
  webhooks: webhooksRoutes,
  devices: devicesRoutes,
};

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

  app.decorate("deps", opts.deps ?? (await buildDepsFromEnv()));
  // Every registered route, for the OpenAPI sync test (test/openapi.test.ts) and the health page.
  const routeList: { method: string; url: string }[] = [];
  app.decorate("routeList", routeList);
  app.addHook("onRoute", (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD" && m !== "OPTIONS") routeList.push({ method: m, url: r.url });
  });
  registerErrorHandler(app);
  await app.register(helmet);
  await app.register(cors, { origin: (process.env["CORS_ORIGINS"] ?? "").split(",").filter(Boolean), credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(authPlugin);
  await app.register(healthRoutes);

  // Feature routes (E3–E7). Each module exports a Fastify plugin as its default.
  for (const mod of await loadRouteModules()) {
    await app.register(mod, { prefix: "/v1" });
  }

  return app;
}

async function loadRouteModules(): Promise<Array<(app: FastifyInstance) => Promise<void>>> {
  // Static imports (every module now exists), so the bundle, vitest and tsc all see the same graph.
  return ROUTE_MODULES.map((name) => ROUTES[name]);
}

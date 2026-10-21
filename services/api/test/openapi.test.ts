/**
 * Keeps services/api/openapi.yaml in sync with the routes the app actually registers (the phone app and the Console
 * code against the document). Every route must be documented with its method, and every documented operation must
 * exist. Also checks that every `$ref` points at a defined component. No database needed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildFakeDeps } from "../src/deps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(path.resolve(here, "../openapi.yaml"), "utf8");

/** `paths:` block -> "METHOD /path" with `{param}` placeholders. Indentation-based; the file uses 2-space YAML. */
function documentedOperations(yaml: string): Set<string> {
  const out = new Set<string>();
  const lines = yaml.split("\n");
  let inPaths = false;
  let current: string | undefined;
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^\S/.test(line)) break;
    if (!inPaths) continue;
    const p = /^ {2}(\/[^:]*):\s*$/.exec(line);
    if (p) {
      current = p[1];
      continue;
    }
    const m = /^ {4}(get|post|put|patch|delete):/.exec(line);
    if (m && current) out.add(`${m[1]!.toUpperCase()} ${current}`);
  }
  return out;
}

describe("openapi.yaml", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ logger: false, deps: buildFakeDeps() });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("documents every registered route, and nothing that is not registered", () => {
    const registered = new Set(app.routeList.map((r) => `${r.method} ${r.url.replace(/:([A-Za-z]+)/g, "{$1}")}`));
    const documented = documentedOperations(doc);
    const undocumented = [...registered].filter((r) => !documented.has(r)).sort();
    const phantom = [...documented].filter((r) => !registered.has(r)).sort();
    expect(undocumented).toEqual([]);
    expect(phantom).toEqual([]);
    expect(registered.size).toBeGreaterThan(55);
  });

  it("resolves every $ref", () => {
    const defined = new Set<string>();
    let section: string | undefined;
    let inComponents = false;
    for (const line of doc.split("\n")) {
      if (/^components:\s*$/.test(line)) inComponents = true;
      if (!inComponents) continue;
      const s = /^ {2}(\w+):\s*$/.exec(line);
      if (s) section = s[1];
      const n = /^ {4}(\w+):/.exec(line);
      if (n && section) defined.add(`${section}/${n[1]}`);
    }
    const refs = [...doc.matchAll(/\$ref: "#\/components\/(\w+)\/(\w+)"/g)].map((m) => `${m[1]}/${m[2]}`);
    expect(refs.length).toBeGreaterThan(50);
    expect(refs.filter((r) => !defined.has(r))).toEqual([]);
  });

  it("documents the plain status words and the step-up rule", () => {
    expect(doc).toContain("Needs a quick answer");
    expect(doc).toContain("x-step-up: true");
    expect(doc).toMatch(/^openapi: 3\.1\.0/);
  });
});

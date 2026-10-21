/**
 * The health report the Console's Health page reads (`HealthReport` in @homestead/shared): one row per acceptance
 * test with pass / fail / skipped, written after the run to HEALTH_REPORT_PATH (default test/test-results/health.json).
 * CI copies it next to the Console's static files as /health.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HealthReport } from "@homestead/shared";

type Row = HealthReport["acceptance"][number];

export class Recorder {
  readonly acceptance: Row[] = [];
  readonly resilience: NonNullable<HealthReport["resilience"]>[number][] = [];
  nightlyPoll: HealthReport["nightlyPoll"];
  constructor(readonly environment: string) {}

  record(id: string, name: string, status: Row["status"], durationMs?: number, note?: string): void {
    const list = id.startsWith("A") ? this.acceptance : this.resilience;
    const row: Row = { id, name, status };
    if (durationMs !== undefined && id.startsWith("A")) row.durationMs = durationMs;
    if (note) row.note = note.slice(0, 300);
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) list.splice(i, 1, row);
    else list.push(row);
  }

  report(now = new Date()): HealthReport {
    const r: HealthReport = { generatedAt: now.toISOString(), environment: this.environment, acceptance: [...this.acceptance].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })) };
    if (process.env["GITHUB_SHA"]) r.commit = process.env["GITHUB_SHA"];
    if (this.resilience.length) r.resilience = this.resilience;
    if (this.nightlyPoll) r.nightlyPoll = this.nightlyPoll;
    return r;
  }

  write(file = process.env["HEALTH_REPORT_PATH"] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-results/health.json")): string {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(this.report(), null, 2)}\n`);
    return file;
  }
}

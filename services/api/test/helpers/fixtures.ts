/** Synthetic fixtures (services/api/test/fixtures) and the fakes they drive. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@homestead/shared";
import type { ClaudeMapperPort, MapLinesInput, MappedLine } from "../../src/services/receipts/claudeMapper.js";
import type { PayStubRead, ReceiptRead } from "../../src/services/receipts/documentIntelligence.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

export interface WalmartFixture {
  name: string;
  imageText: string;
  bank: { account: string; postedDate: string; amountCents: number; merchant: string };
  read: ReceiptRead;
  lineCategories: string[];
  expected: { taxShares: number[]; splits: { lineNo: number; categoryId: string; amountCents: number }[]; question: string };
}

export const WALMART_NAMES = ["walmart-1-mixed", "walmart-2-big-grocery", "walmart-3-groceries-only", "walmart-4-school-electronics", "walmart-5-rounding"] as const;

export function walmartFixtures(): WalmartFixture[] {
  return WALMART_NAMES.map((n) => JSON.parse(readFileSync(path.join(dir, "walmart", `${n}.json`), "utf8")) as WalmartFixture);
}

export function payStubFixture(name: string): { imageText: string; read: PayStubRead } {
  return JSON.parse(readFileSync(path.join(dir, "paystubs", name), "utf8")) as { imageText: string; read: PayStubRead };
}

export function fixtureText(rel: string): string {
  return readFileSync(path.join(dir, rel), "utf8");
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function shaOfText(text: string): string {
  return sha256Hex(bytesOf(text));
}

/** Answers each receipt line with the category the fixture names for it (what a well-behaved model would say). */
export class FixtureMapper implements ClaudeMapperPort {
  readonly byDescription = new Map<string, string>();
  readonly inputs: MapLinesInput[] = [];
  constructor(fixtures: readonly WalmartFixture[]) {
    for (const f of fixtures) f.read.items.forEach((it, i) => this.byDescription.set(it.description, f.lineCategories[i]!));
  }
  async mapLines(input: MapLinesInput): Promise<MappedLine[]> {
    this.inputs.push(input);
    return input.lines.map((l) => ({ lineNo: l.lineNo, categoryId: this.byDescription.get(l.description) ?? "general-merchandise", confidence: 0.95 }));
  }
}

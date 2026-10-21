/**
 * Receipt-side ports: Document Intelligence (2024-11-30 REST, Operation-Location polling) and its field mapping,
 * the Claude mapper's strict JSON contract and what it is allowed to see, the Amazon email parser, and the split.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitReceipt } from "@homestead/shared";
import { parseAmazonEmail } from "../src/services/receipts/amazonEmail.js";
import { FakeClaudeMapper, FoundryClaudeMapper, MAPPER_SYSTEM_PROMPT, buildMapperPrompt, parseMapperReply, type MapLinesInput } from "../src/services/receipts/claudeMapper.js";
import { AzureDocumentIntelligence } from "../src/services/receipts/documentIntelligence.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const walmart = ["walmart-1-mixed", "walmart-2-big-grocery", "walmart-3-groceries-only", "walmart-4-school-electronics", "walmart-5-rounding"].map(
  (n) => JSON.parse(readFileSync(path.join(here, "fixtures/walmart", `${n}.json`), "utf8")) as { name: string; read: { totalCents: number; taxCents: number; items: { description: string; amountCents: number }[] }; lineCategories: string[]; expected: { taxShares: number[]; splits: { categoryId: string; amountCents: number }[] } },
);

describe("AzureDocumentIntelligence", () => {
  it("posts base64 to :analyze with api-version 2024-11-30, polls Operation-Location, and maps receipt fields", async () => {
    const seen: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", url, headers: (init?.headers ?? {}) as Record<string, string>, ...(init?.body ? { body: String(init.body) } : {}) });
      if ((init?.method ?? "GET") === "POST") return new Response(null, { status: 202, headers: { "operation-location": "https://di.example.invalid/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op1?api-version=2024-11-30" } });
      polls += 1;
      if (polls === 1) return Response.json({ status: "running" });
      return Response.json({
        status: "succeeded",
        analyzeResult: {
          documents: [
            {
              fields: {
                MerchantName: { valueString: "Walmart Supercenter", confidence: 0.98 },
                TransactionDate: { valueDate: "2026-10-03", confidence: 0.97 },
                Total: { valueCurrency: { amount: 34.96 }, confidence: 0.99 },
                TotalTax: { valueCurrency: { amount: 1.98 }, confidence: 0.95 },
                Items: { valueArray: [{ confidence: 0.91, valueObject: { Description: { valueString: "BANANAS" }, TotalPrice: { valueCurrency: { amount: 1.48 } }, Quantity: { valueNumber: 2.17 } } }] },
              },
            },
          ],
        },
      });
    }) as unknown as typeof fetch;
    const di = new AzureDocumentIntelligence("https://di.example.invalid/", { apiKey: "key-from-vault" }, fetchImpl, async () => undefined);
    const r = await di.analyzeReceipt(new TextEncoder().encode("img"));
    expect(seen[0]!.url).toBe("https://di.example.invalid/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=2024-11-30");
    expect(seen[0]!.headers["Ocp-Apim-Subscription-Key"]).toBe("key-from-vault");
    expect(JSON.parse(seen[0]!.body!)).toEqual({ base64Source: Buffer.from("img").toString("base64") });
    expect(polls).toBe(2);
    expect(r).toMatchObject({ merchant: "Walmart Supercenter", date: "2026-10-03", totalCents: 3496, taxCents: 198, items: [{ description: "BANANAS", amountCents: 148, qty: 2.17, confidence: 0.91 }] });
  });

  it("maps the pay stub model's earnings, taxes and deductions", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(null, { status: 202, headers: { "operation-location": "https://di.example.invalid/op" } });
      return Response.json({ status: "succeeded", analyzeResult: { documents: [{ fields: { PayDate: { valueDate: "2026-10-16" }, CurrentNetPay: { valueNumber: 3135.59 }, Earnings: { valueArray: [{ valueObject: { Description: { valueString: "Regular" }, CurrentPeriodAmount: { valueNumber: 3650 } } }] }, Taxes: { valueArray: [{ valueObject: { Description: { valueString: "Medicare" }, CurrentPeriodAmount: { valueNumber: 56.27 } } }] } } }] } });
    }) as unknown as typeof fetch;
    const r = await new AzureDocumentIntelligence("https://di.example.invalid", { getToken: async () => "t" }, fetchImpl, async () => undefined).analyzePayStub(new Uint8Array([1]));
    expect(r).toMatchObject({ payDate: "2026-10-16", netCents: 313559, earnings: [{ label: "Regular", amountCents: 365000 }], taxes: [{ label: "Medicare", amountCents: 5627 }], deductions: [] });
  });
});

describe("Claude mapper", () => {
  const input: MapLinesInput = { merchant: "Walmart", lines: [{ lineNo: 1, description: "GV MILK 1GAL", amountCents: 312 }, { lineNo: 2, description: "LEGO CLASSIC", amountCents: 2497 }], categories: [{ id: "groceries", name: "Groceries", examples: ["WinCo"] }, { id: "general-merchandise", name: "General merchandise", examples: ["toys"] }] };

  it("accepts only the strict JSON contract with known category ids", () => {
    expect(parseMapperReply('{"lines":[{"lineNo":1,"categoryId":"groceries","confidence":0.93},{"lineNo":2,"categoryId":"general-merchandise","confidence":0.8}]}', input)).toHaveLength(2);
    expect(parseMapperReply('Here you go: {"lines":[{"lineNo":1,"categoryId":"groceries","confidence":0.9}]}', input)).toHaveLength(1);
    expect(parseMapperReply('{"lines":[{"lineNo":1,"categoryId":"bitcoin","confidence":0.9}]}', input)).toBeUndefined();
    expect(parseMapperReply('{"lines":[{"lineNo":1,"categoryId":"groceries","confidence":7}]}', input)).toBeUndefined();
    expect(parseMapperReply("not json", input)).toBeUndefined();
  });

  it("calls {endpoint}/anthropic/v1/messages with api-key and the model, and falls back (low confidence) on a bad reply", async () => {
    const calls: { url: string; headers: Record<string, string>; body: { model: string; system: string; messages: { content: string }[] } }[] = [];
    const reply = { text: "sorry, no JSON" };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return Response.json({ content: [{ type: "text", text: reply.text }] });
    }) as unknown as typeof fetch;
    const m = new FoundryClaudeMapper("https://foundry.example.invalid/", "foundry-key-from-vault", "claude-haiku-deployment", fetchImpl);
    const out = await m.mapLines(input);
    expect(calls[0]!.url).toBe("https://foundry.example.invalid/anthropic/v1/messages");
    expect(calls[0]!.headers["api-key"]).toBe("foundry-key-from-vault");
    expect(calls[0]!.body.model).toBe("claude-haiku-deployment");
    expect(calls[0]!.body.system).toBe(MAPPER_SYSTEM_PROMPT);
    expect(out.every((l) => l.confidence <= 0.5)).toBe(true);
    reply.text = '{"lines":[{"lineNo":1,"categoryId":"groceries","confidence":0.96},{"lineNo":2,"categoryId":"general-merchandise","confidence":0.9}]}';
    expect((await m.mapLines(input)).map((l) => l.categoryId)).toEqual(["groceries", "general-merchandise"]);
  });

  it("the prompt carries descriptions, amounts, the merchant and categories only: no account numbers, no image", () => {
    const p = buildMapperPrompt(input);
    expect(p).toContain("GV MILK 1GAL");
    expect(p).toContain("3.12");
    expect(p).not.toMatch(/\b\d{4,}\b(?!\.)/); // no masks or account numbers
    expect(p).not.toMatch(/base64|data:image/);
  });

  it("the fake maps by override, then by category examples", async () => {
    const f = new FakeClaudeMapper();
    f.overrides.set("lego", { categoryId: "general-merchandise" });
    expect((await f.mapLines(input)).map((l) => l.categoryId)).toEqual(["general-merchandise", "general-merchandise"].map((c, i) => (i === 0 ? "general-merchandise" : c)));
  });
});

describe("Amazon email intake parser", () => {
  it("reads the order number, date, items and total from the fixture", () => {
    const orders = parseAmazonEmail(readFileSync(path.join(here, "fixtures/amazon/order-2026-10-09.txt"), "utf8"));
    expect(orders).toEqual([
      {
        orderId: "113-5550123-4400001",
        orderDate: "2026-10-09",
        totalCents: 7256,
        items: [
          { description: "Crayola Washable Markers, 40 count", amountCents: 1497 },
          { description: "Kids Rain Boots, Size 13", amountCents: 2499 },
          { description: "Paper Towels, 12 Mega Rolls", amountCents: 2849 },
        ],
      },
    ]);
  });
});

describe("A3 split math on the five Walmart fixtures (oracle values computed independently)", () => {
  for (const f of walmart) {
    it(`${f.name}: tax prorated to the cent, rounding to the largest line, same categories merged`, () => {
      const r = splitReceipt({ totalCents: f.read.totalCents, taxCents: f.read.taxCents, lines: f.read.items.map((it, i) => ({ description: it.description, amountCents: it.amountCents, categoryId: f.lineCategories[i]!, confidence: 0.95 })), receiptRequiredMerchant: true });
      expect(r.lines.map((l) => ({ categoryId: l.categoryId, amountCents: -l.amountCents }))).toEqual(f.expected.splits.map((s) => ({ categoryId: s.categoryId, amountCents: s.amountCents })));
      expect(r.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(f.read.totalCents);
      expect(r.needsConfirmation).toBe(true);
    });
  }
});

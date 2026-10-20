/**
 * Claude on Microsoft Foundry maps receipt lines to the household's categories (spec: "Receipts", step 4).
 * The model receives only line descriptions and amounts, the merchant and the category list with examples.
 * It never sees account numbers, the image, or anything from another household. A strict JSON contract: the
 * reply must be a JSON object { lines: [{ lineNo, categoryId, confidence }] } and nothing else; any other
 * reply (or a categoryId not in the list) falls back to the keyword fake's answer with low confidence.
 *
 * Assumptions (docs):
 *  - Claude in Microsoft Foundry exposes the Anthropic Messages API at {FOUNDRY_ENDPOINT}/anthropic/v1/messages
 *    with the resource `api-key` header (or an Entra bearer token) and the deployed model name in `model`;
 *    hosting on Azure, US Data Zone Standard for data residency.
 *    https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry.md
 *    https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/claude-models/data-privacy
 *  - Request body: { model, max_tokens, system, messages: [{ role: "user", content }] }; the reply's text is
 *    content[0].text. (Anthropic Messages API, https://docs.anthropic.com/en/api/messages)
 */
export interface MapLinesInput {
  merchant: string;
  lines: readonly { lineNo: number; description: string; amountCents: number }[];
  categories: readonly { id: string; name: string; examples: readonly string[] }[];
}

export interface MappedLine {
  lineNo: number;
  categoryId: string;
  confidence: number;
}

export interface ClaudeMapperPort {
  mapLines(input: MapLinesInput): Promise<MappedLine[]>;
}

export const MAPPER_SYSTEM_PROMPT = `You classify receipt lines into a household's spending categories.
Reply with ONLY a JSON object of the form {"lines":[{"lineNo":1,"categoryId":"groceries","confidence":0.93}]}.
Use only category ids from the list given. Confidence is 0 to 1. No prose, no markdown.`;

export function buildMapperPrompt(input: MapLinesInput): string {
  const cats = input.categories.map((c) => `- ${c.id}: ${c.name}${c.examples.length ? ` (e.g. ${c.examples.slice(0, 4).join(", ")})` : ""}`).join("\n");
  const lines = input.lines.map((l) => `${l.lineNo}. ${l.description} — ${(l.amountCents / 100).toFixed(2)}`).join("\n");
  return `Merchant: ${input.merchant || "unknown"}\n\nCategories:\n${cats}\n\nLines:\n${lines}`;
}

/** Validate the model's reply against the contract; return undefined when it does not conform. */
export function parseMapperReply(text: string, input: MapLinesInput): MappedLine[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return undefined;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { lines?: unknown }).lines)) return undefined;
  const valid = new Set(input.categories.map((c) => c.id));
  const out: MappedLine[] = [];
  for (const l of (parsed as { lines: unknown[] }).lines) {
    if (!l || typeof l !== "object") return undefined;
    const { lineNo, categoryId, confidence } = l as Record<string, unknown>;
    if (typeof lineNo !== "number" || typeof categoryId !== "string" || typeof confidence !== "number") return undefined;
    if (!valid.has(categoryId) || confidence < 0 || confidence > 1) return undefined;
    out.push({ lineNo, categoryId, confidence });
  }
  return out;
}

export class FoundryClaudeMapper implements ClaudeMapperPort {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly fallback: ClaudeMapperPort = new FakeClaudeMapper(),
  ) {}
  async mapLines(input: MapLinesInput): Promise<MappedLine[]> {
    const r = await this.fetchImpl(`${this.endpoint.replace(/\/$/, "")}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "api-key": this.apiKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.model, max_tokens: 1024, system: MAPPER_SYSTEM_PROMPT, messages: [{ role: "user", content: buildMapperPrompt(input) }] }),
    });
    if (!r.ok) throw new Error(`Foundry messages call failed with ${r.status}`);
    const j = (await r.json()) as { content?: { type: string; text?: string }[] };
    const text = j.content?.find((c) => c.type === "text")?.text ?? "";
    const parsed = parseMapperReply(text, input);
    if (parsed && parsed.length === input.lines.length) return parsed;
    const fb = await this.fallback.mapLines(input);
    return fb.map((l) => ({ ...l, confidence: Math.min(l.confidence, 0.5) }));
  }
}

/** Deterministic keyword mapper for tests: category examples first, then a per-test override table. */
export class FakeClaudeMapper implements ClaudeMapperPort {
  /** description keyword (lower case) -> categoryId, checked before the examples. */
  readonly overrides = new Map<string, { categoryId: string; confidence?: number }>();
  defaultCategoryId = "general-merchandise";
  defaultConfidence = 0.6;
  readonly calls: MapLinesInput[] = [];
  async mapLines(input: MapLinesInput): Promise<MappedLine[]> {
    this.calls.push(input);
    return input.lines.map((l) => {
      const d = l.description.toLowerCase();
      for (const [kw, o] of this.overrides) if (d.includes(kw)) return { lineNo: l.lineNo, categoryId: o.categoryId, confidence: o.confidence ?? 0.95 };
      for (const c of input.categories) {
        for (const ex of c.examples) {
          const w = ex.toLowerCase();
          if (w.length >= 3 && d.includes(w)) return { lineNo: l.lineNo, categoryId: c.id, confidence: 0.9 };
        }
      }
      return { lineNo: l.lineNo, categoryId: this.defaultCategoryId, confidence: this.defaultConfidence };
    });
  }
}

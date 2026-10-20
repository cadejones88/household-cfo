/**
 * Azure AI Document Intelligence behind a port: `prebuilt-receipt` and `prebuilt-payStub.us` (v4.0, API
 * version 2024-11-30). The real client is a thin fetch: POST ...:analyze, then poll Operation-Location.
 *
 * Assumptions (docs):
 *  - Analyze: POST {endpoint}/documentintelligence/documentModels/{modelId}:analyze?api-version=2024-11-30
 *    with JSON { base64Source } and header Ocp-Apim-Subscription-Key (or a bearer token); 202 with
 *    Operation-Location; GET it until status "succeeded"; result in analyzeResult.documents[0].fields.
 *    https://learn.microsoft.com/en-us/rest/api/aiservices/document-models/analyze-document?view=rest-aiservices-v4.0%20(2024-11-30)
 *  - Receipt fields: MerchantName, TransactionDate, Total, Subtotal, TotalTax, Tip, PaymentMethod,
 *    Items[] { Description, Quantity, Price, TotalPrice }.
 *    https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/receipt
 *  - Pay stub fields: EmployerName, EmployeeName, PayDate, PayPeriodStartDate, PayPeriodEndDate, CurrentGrossPay,
 *    CurrentNetPay, Earnings[] / Taxes[] / Deductions[] with Description and Amount (CurrentPeriod).
 *    https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/pay-stub
 */
export interface ReceiptItem {
  description: string;
  qty?: number;
  amountCents: number;
  confidence: number;
}

export interface ReceiptRead {
  merchant?: string;
  date?: string;
  totalCents?: number;
  subtotalCents?: number;
  taxCents?: number;
  tipCents?: number;
  paymentMethod?: string;
  items: ReceiptItem[];
  fieldConfidence: Record<string, number>;
}

export interface PayStubLine {
  label: string;
  amountCents: number;
  confidence: number;
}

export interface PayStubRead {
  employerName?: string;
  employeeName?: string;
  payDate?: string;
  periodStart?: string;
  periodEnd?: string;
  grossCents?: number;
  netCents?: number;
  earnings: PayStubLine[];
  taxes: PayStubLine[];
  deductions: PayStubLine[];
}

export interface LayoutTable {
  headers: string[];
  rows: string[][];
}

export interface DocumentIntelligencePort {
  analyzeReceipt(bytes: Uint8Array, contentType: string): Promise<ReceiptRead>;
  analyzePayStub(bytes: Uint8Array, contentType: string): Promise<PayStubRead>;
  /** Statement PDFs: the layout model's tables. */
  analyzeLayout(bytes: Uint8Array, contentType: string): Promise<{ text: string; tables: LayoutTable[] }>;
}

// Real client ----------------------------------------------------------------------------------------

interface DiField {
  type?: string;
  content?: string;
  valueString?: string;
  valueNumber?: number;
  valueDate?: string;
  valueCurrency?: { amount?: number; currencyCode?: string };
  valueArray?: DiField[];
  valueObject?: Record<string, DiField>;
  confidence?: number;
}

export class AzureDocumentIntelligence implements DocumentIntelligencePort {
  constructor(
    private readonly endpoint: string,
    private readonly auth: { apiKey?: string; getToken?: () => Promise<string> },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async headers(): Promise<Record<string, string>> {
    if (this.auth.apiKey) return { "Ocp-Apim-Subscription-Key": this.auth.apiKey, "content-type": "application/json" };
    if (this.auth.getToken) return { authorization: `Bearer ${await this.auth.getToken()}`, "content-type": "application/json" };
    throw new Error("Document Intelligence needs an api key name or a token provider");
  }

  private async analyze(modelId: string, bytes: Uint8Array): Promise<{ documents?: { fields?: Record<string, DiField> }[]; content?: string; tables?: { cells: { rowIndex: number; columnIndex: number; content: string; kind?: string }[] }[] }> {
    const url = `${this.endpoint.replace(/\/$/, "")}/documentintelligence/documentModels/${modelId}:analyze?api-version=2024-11-30`;
    const r = await this.fetchImpl(url, { method: "POST", headers: await this.headers(), body: JSON.stringify({ base64Source: Buffer.from(bytes).toString("base64") }) });
    if (r.status !== 202) throw new Error(`Document Intelligence analyze failed with ${r.status}`);
    const op = r.headers.get("operation-location");
    if (!op) throw new Error("Document Intelligence returned no Operation-Location");
    for (let i = 0; i < 60; i += 1) {
      await this.sleep(i === 0 ? 500 : 1500);
      const p = await this.fetchImpl(op, { headers: await this.headers() });
      if (!p.ok) throw new Error(`Document Intelligence poll failed with ${p.status}`);
      const j = (await p.json()) as { status: string; analyzeResult?: { documents?: { fields?: Record<string, DiField> }[]; content?: string; tables?: { cells: { rowIndex: number; columnIndex: number; content: string; kind?: string }[] }[] } };
      if (j.status === "succeeded") return j.analyzeResult ?? {};
      if (j.status === "failed") throw new Error("Document Intelligence analysis failed");
    }
    throw new Error("Document Intelligence analysis timed out");
  }

  async analyzeReceipt(bytes: Uint8Array): Promise<ReceiptRead> {
    const res = await this.analyze("prebuilt-receipt", bytes);
    const f = res.documents?.[0]?.fields ?? {};
    const out: ReceiptRead = { items: [], fieldConfidence: {} };
    const str = (k: string) => f[k]?.valueString ?? f[k]?.content;
    const money = (k: string) => (f[k]?.valueCurrency?.amount !== undefined ? Math.round(f[k]!.valueCurrency!.amount! * 100) : f[k]?.valueNumber !== undefined ? Math.round(f[k]!.valueNumber! * 100) : undefined);
    for (const k of Object.keys(f)) if (f[k]?.confidence !== undefined) out.fieldConfidence[k] = f[k]!.confidence!;
    const merchant = str("MerchantName");
    if (merchant) out.merchant = merchant;
    const date = f["TransactionDate"]?.valueDate;
    if (date) out.date = date;
    const total = money("Total");
    if (total !== undefined) out.totalCents = total;
    const subtotal = money("Subtotal");
    if (subtotal !== undefined) out.subtotalCents = subtotal;
    const tax = money("TotalTax");
    if (tax !== undefined) out.taxCents = tax;
    const tip = money("Tip");
    if (tip !== undefined) out.tipCents = tip;
    const pm = str("PaymentMethod");
    if (pm) out.paymentMethod = pm;
    for (const item of f["Items"]?.valueArray ?? []) {
      const o = item.valueObject ?? {};
      const amt = o["TotalPrice"]?.valueCurrency?.amount ?? o["TotalPrice"]?.valueNumber ?? o["Price"]?.valueCurrency?.amount ?? o["Price"]?.valueNumber;
      if (amt === undefined) continue;
      const it: ReceiptItem = { description: o["Description"]?.valueString ?? o["Description"]?.content ?? "item", amountCents: Math.round(amt * 100), confidence: item.confidence ?? o["TotalPrice"]?.confidence ?? 0.5 };
      if (o["Quantity"]?.valueNumber !== undefined) it.qty = o["Quantity"].valueNumber;
      out.items.push(it);
    }
    return out;
  }

  async analyzePayStub(bytes: Uint8Array): Promise<PayStubRead> {
    const res = await this.analyze("prebuilt-payStub.us", bytes);
    const f = res.documents?.[0]?.fields ?? {};
    const str = (k: string) => f[k]?.valueString ?? f[k]?.content;
    const money = (k: string) => (f[k]?.valueCurrency?.amount !== undefined ? Math.round(f[k]!.valueCurrency!.amount! * 100) : f[k]?.valueNumber !== undefined ? Math.round(f[k]!.valueNumber! * 100) : undefined);
    const lines = (k: string): PayStubLine[] =>
      (f[k]?.valueArray ?? []).flatMap((item) => {
        const o = item.valueObject ?? {};
        const amt = o["CurrentPeriodAmount"]?.valueCurrency?.amount ?? o["CurrentPeriodAmount"]?.valueNumber ?? o["Amount"]?.valueCurrency?.amount ?? o["Amount"]?.valueNumber;
        if (amt === undefined) return [];
        return [{ label: o["Description"]?.valueString ?? o["Description"]?.content ?? "", amountCents: Math.round(amt * 100), confidence: item.confidence ?? 0.5 }];
      });
    const out: PayStubRead = { earnings: lines("Earnings"), taxes: lines("Taxes"), deductions: lines("Deductions") };
    const employer = str("EmployerName");
    if (employer) out.employerName = employer;
    const employee = str("EmployeeName");
    if (employee) out.employeeName = employee;
    if (f["PayDate"]?.valueDate) out.payDate = f["PayDate"].valueDate;
    if (f["PayPeriodStartDate"]?.valueDate) out.periodStart = f["PayPeriodStartDate"].valueDate;
    if (f["PayPeriodEndDate"]?.valueDate) out.periodEnd = f["PayPeriodEndDate"].valueDate;
    const gross = money("CurrentGrossPay");
    if (gross !== undefined) out.grossCents = gross;
    const net = money("CurrentNetPay");
    if (net !== undefined) out.netCents = net;
    return out;
  }

  async analyzeLayout(bytes: Uint8Array): Promise<{ text: string; tables: LayoutTable[] }> {
    const res = await this.analyze("prebuilt-layout", bytes);
    const tables: LayoutTable[] = (res.tables ?? []).map((t) => {
      const rows = new Map<number, string[]>();
      for (const c of t.cells) {
        const row = rows.get(c.rowIndex) ?? [];
        row[c.columnIndex] = c.content;
        rows.set(c.rowIndex, row);
      }
      const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
      return { headers: ordered[0] ?? [], rows: ordered.slice(1) };
    });
    return { text: res.content ?? "", tables };
  }
}

// Fake ----------------------------------------------------------------------------------------------

/** Returns fixture results keyed by the SHA-256 of the bytes, or the next queued result. */
export class FakeDocumentIntelligence implements DocumentIntelligencePort {
  readonly receiptsBySha = new Map<string, ReceiptRead>();
  readonly stubsBySha = new Map<string, PayStubRead>();
  readonly receiptQueue: ReceiptRead[] = [];
  readonly stubQueue: PayStubRead[] = [];
  layoutResult: { text: string; tables: LayoutTable[] } = { text: "", tables: [] };
  readonly calls: string[] = [];
  constructor(private readonly shaOf: (bytes: Uint8Array) => string) {}

  async analyzeReceipt(bytes: Uint8Array): Promise<ReceiptRead> {
    this.calls.push("receipt");
    const hit = this.receiptsBySha.get(this.shaOf(bytes)) ?? this.receiptQueue.shift();
    if (!hit) throw new Error("FakeDocumentIntelligence: no receipt fixture for these bytes");
    return structuredClone(hit);
  }
  async analyzePayStub(bytes: Uint8Array): Promise<PayStubRead> {
    this.calls.push("paystub");
    const hit = this.stubsBySha.get(this.shaOf(bytes)) ?? this.stubQueue.shift();
    if (!hit) throw new Error("FakeDocumentIntelligence: no pay stub fixture for these bytes");
    return structuredClone(hit);
  }
  async analyzeLayout(): Promise<{ text: string; tables: LayoutTable[] }> {
    this.calls.push("layout");
    return structuredClone(this.layoutResult);
  }
}

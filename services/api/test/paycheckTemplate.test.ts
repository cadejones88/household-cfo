/** Paycheck pieces (pure): stub line mapping with the employer template, the 3-day template estimate, R1's checks. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PaycheckDoesNotTieError, employerForDescriptor } from "@homestead/shared";
import { describe, expect, it } from "vitest";
import { HFH_TEMPLATE } from "../src/db/seed.js";
import { mapStubLines } from "../src/services/paychecks/index.js";
import { categoryForPaycheckAccount } from "../src/services/paychecks/categories.js";
import { applyTemplate, linesForPaycheck, netWithinFifteenPercent, templateFromComponents, type EmployerTemplate } from "../src/services/paychecks/template.js";
import type { PayStubRead } from "../src/services/receipts/documentIntelligence.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = (n: string) => (JSON.parse(readFileSync(path.join(here, "fixtures/paystubs", n), "utf8")) as { read: PayStubRead }).read;
const template = HFH_TEMPLATE as unknown as EmployerTemplate;

describe("stub mapping", () => {
  it("maps every line of the HFH stub and the components tie to net within a cent", () => {
    const { components, unmapped } = mapStubLines(stub("hfh-2026-10-16.json"), template);
    expect(unmapped).toEqual([]);
    expect(components.map((c) => c.kind)).toEqual(["regular", "bonus", "fit", "state_tax", "social_security", "medicare"]);
    const lines = linesForPaycheck("HFH", components, 313559, "2026-10-16");
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(0);
    expect(lines.find((l) => l.kind === "regular")).toMatchObject({ glAccount: "401101", amountCents: -365000 });
    expect(lines.find((l) => l.kind === "state_tax")).toMatchObject({ glAccount: "701201" });
    expect(lines.find((l) => l.kind === "net")!.amountCents).toBe(313559);
  });

  it("leaves a line the template has never seen for a one-tap answer", () => {
    const { unmapped } = mapStubLines(stub("hfh-2026-10-30-roth.json"), template);
    expect(unmapped).toEqual([{ section: "deductions", label: "ROTH 401K", amountCents: 16295 }]);
    const learned: EmployerTemplate = { ...template, labelMap: { ...template.labelMap, "roth 401k": "other_deduction" } };
    expect(mapStubLines(stub("hfh-2026-10-30-roth.json"), learned).unmapped).toEqual([]);
  });

  it("refuses components that do not tie to the deposit", () => {
    const { components } = mapStubLines(stub("hfh-2026-10-16.json"), template);
    expect(() => linesForPaycheck("HFH", components, 313000, "2026-10-16")).toThrow(PaycheckDoesNotTieError);
  });
});

describe("template estimate and R1", () => {
  it("proposes components from the last stub's ratios that tie exactly to a new net", () => {
    for (const net of [313559, 298811, 401234]) {
      const comps = applyTemplate(template, net);
      const lines = linesForPaycheck("HFH", comps, net, "2026-10-30");
      expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(0);
      expect(lines.find((l) => l.kind === "net")!.amountCents).toBe(net);
    }
    expect(applyTemplate({ components: [], labelMap: {}, lastSixNetCents: [] }, 100000)).toEqual([{ kind: "regular", label: "Regular (estimated)", amountCents: 100000 }]);
  });

  it("R1: net within 15% of the last six; no history is never within", () => {
    expect(netWithinFifteenPercent(313559, template.lastSixNetCents)).toBe(true);
    expect(netWithinFifteenPercent(250000, template.lastSixNetCents)).toBe(false);
    expect(netWithinFifteenPercent(313559, [])).toBe(false);
  });

  it("rolls the net history, newest first, six at most", () => {
    const next = templateFromComponents(template, [{ kind: "regular", label: "Regular", amountCents: 100 }], 100);
    expect(next.lastSixNetCents).toEqual([100, ...template.lastSixNetCents.slice(0, 5)]);
  });

  it("knows the employers' payroll descriptors and the split category of each component account", () => {
    expect(employerForDescriptor("HENRYS FORK HOMES PAYROLL PAYCHEX")).toBe("HFH");
    expect(employerForDescriptor("GUSTO PAY 123")).toBe("CTJ");
    expect(employerForDescriptor("VENMO")).toBeUndefined();
    expect(categoryForPaycheckAccount("701201", "state_tax")).toBe("withholding-idaho-hfh");
    expect(categoryForPaycheckAccount("401101", "regular")).toBe("income-hfh-wages");
  });
});

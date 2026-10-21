import { describe, expect, it } from "vitest";
import { DARK, LIGHT, statusColors, type Palette } from "@/ui/theme";

/** WCAG 2.x contrast ratio between two #RRGGBB colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe.each([
  ["light", LIGHT],
  ["dark", DARK],
] as [string, Palette][])("%s palette passes WCAG AA for text", (_name, p) => {
  it("body, secondary and stamp text on every surface", () => {
    for (const bg of [p.bg, p.surface]) {
      expect(contrast(p.ink, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.muted, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.faintText, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.accent, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(p.ink, p.wheatSoft)).toBeGreaterThanOrEqual(4.5); // sync bar and banners
    expect(contrast(p.accentInk, p.accent)).toBeGreaterThanOrEqual(4.5); // primary buttons and the Snap button
    expect(contrast(p.accent, p.accentSoft)).toBeGreaterThanOrEqual(4.5); // payday line
  });

  it("the three status pills", () => {
    for (const key of ["good", "watch", "action", "neutral"] as const) {
      const c = statusColors(p, key);
      expect(contrast(c.fg, c.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the prototype's colors for everything else", () => {
    expect(LIGHT.bg).toBe("#F1F3EC");
    expect(LIGHT.accent).toBe("#2E6B4E");
    expect(DARK.bg).toBe("#121815");
    expect(DARK.accent).toBe("#73B892");
  });
});

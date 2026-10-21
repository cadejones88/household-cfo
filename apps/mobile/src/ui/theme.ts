/**
 * Design tokens, copied from prototype/homestead.html (the Phase 2 prototype Vanessa approved).
 * Light and dark are the prototype's two palettes; the display face is Fraunces, the body face is the
 * system font (SF Pro on iPhone), exactly as the prototype's CSS.
 *
 * Two additions, both for the Phase 1 rule "contrast that passes WCAG AA": `faintText` (stamps and
 * placeholders; the prototype's faint grey is 2.7:1 on the light background) and `watchText` (the Watch pill's
 * words). The prototype colors stay for everything that is not small text: bars, dots, borders, chevrons.
 * Pure data (no react-native import) so the unit tests can check the palette; ThemeProvider picks light or dark.
 */
export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  ink: string;
  muted: string;
  faint: string;
  /** Small text that the prototype drew in `faint` (stamps, placeholders): darkened just enough to pass WCAG AA (4.5:1). */
  faintText: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  wheat: string;
  wheatSoft: string;
  good: string;
  goodSoft: string;
  watch: string;
  watchSoft: string;
  /** Text on a Watch pill: the prototype's watch amber is 3.7:1 on its soft fill in light mode; this is 4.9:1. */
  watchText: string;
  action: string;
  actionSoft: string;
  scrim: string;
  shadow: string;
  camBg: string;
  paper: string;
  paperInk: string;
}

export const LIGHT: Palette = {
  bg: "#F1F3EC",
  surface: "#FFFFFF",
  surface2: "#E8ECE2",
  line: "#D7DDD0",
  ink: "#1E2922",
  muted: "#5E6A62",
  faint: "#8B968E",
  faintText: "#646F67",
  accent: "#2E6B4E",
  accentInk: "#FFFFFF",
  accentSoft: "#DDEBE2",
  wheat: "#B8812A",
  wheatSoft: "#F3E7D0",
  good: "#2E6B4E",
  goodSoft: "#DDEBE2",
  watch: "#A86A12",
  watchSoft: "#F6E9D2",
  watchText: "#8A5A0E",
  action: "#A33B3B",
  actionSoft: "#F3DCDC",
  scrim: "rgba(10,16,12,0.45)",
  shadow: "rgba(30,41,34,0.12)",
  camBg: "#0E130F",
  paper: "#F7F4EA",
  paperInk: "#333333",
};

export const DARK: Palette = {
  bg: "#121815",
  surface: "#1B231E",
  surface2: "#243029",
  line: "#33403A",
  ink: "#ECEFE8",
  muted: "#A3AEA6",
  faint: "#76827A",
  faintText: "#8A968E",
  accent: "#73B892",
  accentInk: "#0F1A14",
  accentSoft: "#1F3A2C",
  wheat: "#D9A24C",
  wheatSoft: "#3A2E17",
  good: "#73B892",
  goodSoft: "#1F3A2C",
  watch: "#D9A24C",
  watchSoft: "#3A2E17",
  watchText: "#D9A24C",
  action: "#E07A7A",
  actionSoft: "#3F2323",
  scrim: "rgba(10,16,12,0.6)",
  shadow: "rgba(0,0,0,0.45)",
  camBg: "#0E130F",
  paper: "#F7F4EA",
  paperInk: "#333333",
};

export const RADIUS = 14;
export const GUTTER = 16;
/** Minimum tap target (Phase 1 accessibility rule: 44 points). */
export const TAP = 44;

export const FONT = {
  /** Fraunces 600 for headings and the big number; falls back to Georgia if the font is not loaded. */
  display: "Fraunces_600SemiBold",
  displayMedium: "Fraunces_500Medium",
  displayFallback: "Georgia",
};

export type StatusKey = "good" | "watch" | "action" | "neutral";

export const STATUS_LABEL: Record<Exclude<StatusKey, "neutral">, string> = {
  good: "On track",
  watch: "Watch",
  action: "Action needed",
};

export function statusColors(p: Palette, key: StatusKey): { fg: string; bg: string } {
  switch (key) {
    case "good":
      return { fg: p.good, bg: p.goodSoft };
    case "watch":
      return { fg: p.watchText, bg: p.watchSoft };
    case "action":
      return { fg: p.action, bg: p.actionSoft };
    case "neutral":
      return { fg: p.muted, bg: p.surface2 };
  }
}

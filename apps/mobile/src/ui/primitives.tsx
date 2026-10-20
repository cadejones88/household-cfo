/**
 * The prototype's building blocks as React Native components: cards, pills, buttons, list rows, bars,
 * key/value rows, chips, question cards. Every tap target is at least 44 points and carries a label.
 */
import type { PropsWithChildren, ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { useTheme } from "./ThemeProvider";
import { RADIUS, TAP, statusColors, STATUS_LABEL, type StatusKey } from "./theme";

type TxtProps = PropsWithChildren<{ style?: StyleProp<TextStyle>; numberOfLines?: number; accessibilityRole?: "header" | "text"; testID?: string }>;

export function Eyebrow({ children, style }: TxtProps): React.JSX.Element {
  const { p } = useTheme();
  return <Text style={[{ fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: p.muted, fontWeight: "600" }, style]}>{children}</Text>;
}

export function H1({ children, style, testID }: TxtProps): React.JSX.Element {
  const { p, display } = useTheme();
  return (
    <Text accessibilityRole="header" testID={testID} maxFontSizeMultiplier={1.6} style={[{ fontFamily: display, fontSize: 26, lineHeight: 30, color: p.ink, letterSpacing: -0.26 }, style]}>
      {children}
    </Text>
  );
}

export function H2({ children, style, numberOfLines }: TxtProps): React.JSX.Element {
  const { p } = useTheme();
  return (
    <Text accessibilityRole="header" numberOfLines={numberOfLines} style={[{ fontSize: 17, lineHeight: 22, fontWeight: "600", color: p.ink }, style]}>
      {children}
    </Text>
  );
}

export function Body({ children, style, numberOfLines }: TxtProps): React.JSX.Element {
  const { p } = useTheme();
  return <Text numberOfLines={numberOfLines} style={[{ fontSize: 16, lineHeight: 23, color: p.ink }, style]}>{children}</Text>;
}

export function Sub({ children, style, numberOfLines }: TxtProps): React.JSX.Element {
  const { p } = useTheme();
  return <Text numberOfLines={numberOfLines} style={[{ fontSize: 14, lineHeight: 20, color: p.muted }, style]}>{children}</Text>;
}

export function Note({ children, style, numberOfLines }: TxtProps): React.JSX.Element {
  const { p } = useTheme();
  return <Text numberOfLines={numberOfLines} style={[{ fontSize: 13, lineHeight: 18, color: p.muted }, style]}>{children}</Text>;
}

export function Stamp({ children, style }: TxtProps): React.JSX.Element {
  const { p } = useTheme();
  return <Text style={[{ fontSize: 12, lineHeight: 16, color: p.faint }, style]}>{children}</Text>;
}

/** The big number (36pt display). `color` defaults to ink. */
export function Big({ children, style, testID }: TxtProps): React.JSX.Element {
  const { p, display } = useTheme();
  return (
    <Text testID={testID} maxFontSizeMultiplier={1.4} style={[{ fontFamily: display, fontSize: 36, lineHeight: 40, color: p.ink, letterSpacing: -0.7, fontVariant: ["tabular-nums"] }, style]}>
      {children}
    </Text>
  );
}

export function Num({ children, style, numberOfLines }: TxtProps): React.JSX.Element {
  const { p } = useTheme();
  return <Text numberOfLines={numberOfLines} style={[{ fontVariant: ["tabular-nums"], color: p.ink, fontWeight: "600", fontSize: 16 }, style]}>{children}</Text>;
}

export function Card({ children, style, onPress, accessibilityLabel, hero, testID }: PropsWithChildren<{ style?: StyleProp<ViewStyle>; onPress?: () => void; accessibilityLabel?: string; hero?: boolean; testID?: string }>): React.JSX.Element {
  const { p } = useTheme();
  const base: ViewStyle = { backgroundColor: p.surface, borderRadius: RADIUS, padding: 16, gap: 10, paddingTop: hero ? 18 : 16 };
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [base, pressed && { opacity: 0.85 }, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View testID={testID} style={[base, style]}>{children}</View>;
}

export function Row({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>): React.JSX.Element {
  return <View style={[{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }, style]}>{children}</View>;
}

export function Pill({ status, label, style }: { status: StatusKey; label?: string; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const { p } = useTheme();
  const c = statusColors(p, status);
  const text = label ?? (status === "neutral" ? "" : STATUS_LABEL[status]);
  return (
    <View accessibilityLabel={`Status: ${text}`} style={[{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: c.bg }, style]}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.fg }} />
      <Text style={{ fontSize: 13, fontWeight: "600", color: c.fg }}>{text}</Text>
    </View>
  );
}

export function Tag({ children }: PropsWithChildren): React.JSX.Element {
  const { p } = useTheme();
  return (
    <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 6, backgroundColor: p.surface2 }}>
      <Text style={{ fontSize: 12, fontWeight: "600", color: p.muted }}>{children}</Text>
    </View>
  );
}

export type ButtonKind = "primary" | "default" | "ghost";

export function Button({
  title,
  onPress,
  kind = "default",
  block,
  small,
  disabled,
  style,
  testID,
  accessibilityLabel,
}: {
  title: string;
  onPress?: () => void;
  kind?: ButtonKind;
  block?: boolean;
  small?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}): React.JSX.Element {
  const { p } = useTheme();
  const bg = kind === "primary" ? p.accent : kind === "ghost" ? "transparent" : p.surface2;
  const fg = kind === "primary" ? p.accentInk : kind === "ghost" ? p.accent : p.ink;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: disabled === true }}
      style={({ pressed }) => [
        {
          minHeight: small ? 40 : TAP,
          paddingVertical: small ? 8 : 10,
          paddingHorizontal: small ? 14 : 16,
          borderRadius: 12,
          backgroundColor: bg,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        block && { alignSelf: "stretch" },
        style,
      ]}
    >
      <Text style={{ fontWeight: "600", fontSize: small ? 15 : 16, color: fg }}>{title}</Text>
    </Pressable>
  );
}

export function ButtonRow({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>): React.JSX.Element {
  return <View style={[{ flexDirection: "row", gap: 10, flexWrap: "wrap" }, style]}>{children}</View>;
}

export function Chip({ label, on, onPress, testID }: { label: string; on?: boolean; onPress: () => void; testID?: string }): React.JSX.Element {
  const { p } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on === true }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        minHeight: 40,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 999,
        backgroundColor: on ? p.accent : p.surface2,
        opacity: pressed ? 0.85 : 1,
        justifyContent: "center",
      })}
    >
      <Text style={{ fontWeight: "600", fontSize: 15, color: on ? p.accentInk : p.ink }}>{label}</Text>
    </Pressable>
  );
}

export function Chips({ children }: PropsWithChildren): React.JSX.Element {
  return <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>{children}</View>;
}

export function Bar({ fraction, tone = "accent", style }: { fraction: number; tone?: "accent" | "wheat" | "watch" | "action"; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const { p } = useTheme();
  const color = tone === "wheat" ? p.wheat : tone === "watch" ? p.watch : tone === "action" ? p.action : p.accent;
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }} style={[{ height: 10, borderRadius: 999, backgroundColor: p.surface2, overflow: "hidden" }, style]}>
      <View style={{ width: `${pct * 100}%`, height: "100%", backgroundColor: color, borderRadius: 999 }} />
    </View>
  );
}

export function KV({ label, value, bold, first, valueColor }: { label: ReactNode; value: ReactNode; bold?: boolean; first?: boolean; valueColor?: string }): React.JSX.Element {
  const { p } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 8, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, borderTopColor: p.line }}>
      <Text style={{ fontSize: 15, color: p.ink, flexShrink: 1, fontWeight: bold ? "600" : "400" }}>{label}</Text>
      <Text style={{ fontSize: 15, color: valueColor ?? p.ink, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

export function Banner({ children, tone = "wheat" }: PropsWithChildren<{ tone?: "wheat" | "neutral" }>): React.JSX.Element {
  const { p } = useTheme();
  return (
    <View accessibilityRole="text" style={{ backgroundColor: tone === "wheat" ? p.wheatSoft : p.surface2, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 }}>
      <Text style={{ fontSize: 14, lineHeight: 20, color: p.ink }}>{children}</Text>
    </View>
  );
}

/** A list container (white, rounded, rows separated by hairlines). */
export function List({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>): React.JSX.Element {
  const { p } = useTheme();
  return <View style={[{ backgroundColor: p.surface, borderRadius: RADIUS, overflow: "hidden" }, style]}>{children}</View>;
}

export type IconTone = "plain" | "in" | "q" | "rc";

export function ListItem({
  glyph,
  tone = "plain",
  title,
  subtitle,
  amount,
  amountIn,
  amountSub,
  onPress,
  first,
  children,
  testID,
  accessibilityLabel,
}: PropsWithChildren<{
  glyph?: string;
  tone?: IconTone;
  title: string;
  subtitle?: string;
  amount?: string;
  amountIn?: boolean;
  amountSub?: string;
  onPress?: () => void;
  first?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}>): React.JSX.Element {
  const { p } = useTheme();
  const icoBg = tone === "in" ? p.goodSoft : tone === "q" ? p.wheatSoft : tone === "rc" ? p.accentSoft : p.surface2;
  const icoFg = tone === "in" ? p.good : tone === "q" ? p.wheat : tone === "rc" ? p.accent : p.muted;
  const inner = (
    <>
      {glyph !== undefined && (
        <View accessible={false} style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: icoBg, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: icoFg }}>{glyph}</Text>
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontWeight: "600", fontSize: 16, color: p.ink }}>
          {title}
        </Text>
        {subtitle !== undefined && (
          <Text numberOfLines={1} style={{ fontSize: 13, color: p.muted }}>
            {subtitle}
          </Text>
        )}
        {children}
      </View>
      {amount !== undefined && (
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ fontWeight: "600", fontSize: 16, color: amountIn ? p.good : p.ink, fontVariant: ["tabular-nums"] }}>{amount}</Text>
          {amountSub !== undefined && <Text style={{ fontSize: 12, color: p.muted }}>{amountSub}</Text>}
        </View>
      )}
      {onPress && <Text style={{ color: p.faint, fontSize: 20 }}>›</Text>}
    </>
  );
  const style: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    minHeight: 60,
    borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
    borderTopColor: p.line,
  };
  if (onPress) {
    return (
      <Pressable testID={testID} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? `${title}${amount ? `, ${amount}` : ""}${subtitle ? `, ${subtitle}` : ""}`} style={({ pressed }) => [style, pressed && { backgroundColor: p.surface2 }]}>
        {inner}
      </Pressable>
    );
  }
  return <View style={style}>{inner}</View>;
}

/** A question card: wheat left border, the question, its options, and why we ask. */
export function QCard({ children, why, style, testID }: PropsWithChildren<{ why?: string; style?: StyleProp<ViewStyle>; testID?: string }>): React.JSX.Element {
  const { p } = useTheme();
  return (
    <View testID={testID} style={[{ backgroundColor: p.surface, borderRadius: RADIUS, paddingVertical: 14, paddingHorizontal: 16, gap: 10, borderLeftWidth: 4, borderLeftColor: p.wheat }, style]}>
      {children}
      {why !== undefined && <Note>{why}</Note>}
    </View>
  );
}

export function CalRow({ weekday, day, title, note, amount, first }: { weekday: string; day: string; title: string; note?: string; amount: string; first?: boolean }): React.JSX.Element {
  const { p } = useTheme();
  return (
    <View accessible accessibilityLabel={`${weekday} ${day}, ${title}, ${amount}${note ? `, ${note}` : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 14, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, borderTopColor: p.line }}>
      <View style={{ width: 52 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: p.muted }}>{weekday}</Text>
        <Text style={{ fontSize: 18, fontWeight: "600", color: p.ink }}>{day}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: "600", color: p.ink }}>{title}</Text>
        {note !== undefined && <Note>{note}</Note>}
      </View>
      <Num>{amount}</Num>
    </View>
  );
}

export function PayLine({ children }: PropsWithChildren): React.JSX.Element {
  const { p } = useTheme();
  return (
    <View style={{ paddingVertical: 8, paddingHorizontal: 14, backgroundColor: p.accentSoft }}>
      <Text style={{ color: p.accent, fontWeight: "600", fontSize: 13, textAlign: "center" }}>{children}</Text>
    </View>
  );
}

export function Toggle({ label, note, value, onChange, testID }: { label: string; note?: string; value: boolean; onChange: (v: boolean) => void; testID?: string }): React.JSX.Element {
  const { p } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 48, paddingVertical: 4 }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, color: p.ink }}>{label}</Text>
        {note !== undefined && <Note>{note}</Note>}
      </View>
      <View style={{ width: 50, height: 30, borderRadius: 999, backgroundColor: value ? p.accent : p.line, justifyContent: "center" }}>
        <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: "#fff", marginLeft: value ? 23 : 3 }} />
      </View>
    </Pressable>
  );
}

export function Field({ label, style, ...rest }: TextInputProps & { label?: string; style?: StyleProp<TextStyle> }): React.JSX.Element {
  const { p } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label !== undefined && <Text style={{ fontSize: 13, color: p.muted, fontWeight: "600" }}>{label}</Text>}
      <TextInput
        accessibilityLabel={label ?? rest.placeholder}
        placeholderTextColor={p.faint}
        {...rest}
        style={[{ minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: p.line, backgroundColor: p.surface, paddingHorizontal: 12, color: p.ink, fontSize: 16 }, style]}
      />
    </View>
  );
}

export function Grab(): React.JSX.Element {
  const { p } = useTheme();
  return <View style={{ width: 40, height: 5, borderRadius: 999, backgroundColor: p.line, alignSelf: "center" }} />;
}

export function CloseButton({ onPress, label = "Close" }: { onPress: () => void; label?: string }): React.JSX.Element {
  const { p } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => ({ minWidth: TAP, minHeight: TAP, alignItems: "center", justifyContent: "center", borderRadius: 12, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ color: p.muted, fontSize: 20 }}>✕</Text>
    </Pressable>
  );
}

export function Avatar({ initial, onPress, badge }: { initial: string; onPress: () => void; badge?: number }): React.JSX.Element {
  const { p } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={badge ? `Settings, ${badge} new alerts` : "Settings"} hitSlop={6} style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, backgroundColor: p.accentSoft, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.8 : 1 })}>
      <Text style={{ color: p.accent, fontWeight: "600", fontSize: 14 }}>{initial}</Text>
      {badge ? (
        <View style={{ position: "absolute", top: -2, right: -2, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: p.wheat, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 }}>
          <Text style={{ color: "#fff", fontSize: 10, fontWeight: "700" }}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

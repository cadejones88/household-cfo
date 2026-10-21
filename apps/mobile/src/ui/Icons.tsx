/**
 * The handful of icons the prototype uses, drawn from Views so the app needs no icon font or SVG runtime.
 * Each takes a colour and a size; all are decorative (the tab or button carries the accessible label).
 */
import { Text, View } from "react-native";

interface IconProps {
  color: string;
  size?: number;
}

/** The brand mark: a green rounded square with a white house. */
export function BrandMark({ size = 22, bg, fg }: { size?: number; bg: string; fg: string }): React.JSX.Element {
  return (
    <View accessible={false} style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
      <HouseIcon color={fg} size={size * 0.64} />
    </View>
  );
}

/** A house: rotated square roof over a body. */
export function HouseIcon({ color, size = 22 }: IconProps): React.JSX.Element {
  const s = size;
  const roof = s * 0.48;
  const stroke = Math.max(1.5, s * 0.09);
  return (
    <View accessible={false} style={{ width: s, height: s, alignItems: "center", justifyContent: "flex-end" }}>
      <View style={{ position: "absolute", top: s * 0.1, width: roof, height: roof, borderTopWidth: stroke, borderLeftWidth: stroke, borderColor: color, transform: [{ rotate: "45deg" }] }} />
      <View style={{ width: s * 0.56, height: s * 0.42, borderWidth: stroke, borderTopWidth: 0, borderColor: color, marginBottom: s * 0.06 }} />
    </View>
  );
}

/** Three lines of decreasing length (activity / list). */
export function ActivityIcon({ color, size = 22 }: IconProps): React.JSX.Element {
  const stroke = Math.max(2, size * 0.09);
  return (
    <View accessible={false} style={{ width: size, height: size, justifyContent: "space-evenly", paddingVertical: size * 0.12 }}>
      <View style={{ height: stroke, borderRadius: stroke, backgroundColor: color, width: "100%" }} />
      <View style={{ height: stroke, borderRadius: stroke, backgroundColor: color, width: "62%" }} />
      <View style={{ height: stroke, borderRadius: stroke, backgroundColor: color, width: "40%" }} />
    </View>
  );
}

/** A camera: rounded body with a hump and a lens. */
export function CameraIcon({ color, size = 26 }: IconProps): React.JSX.Element {
  const stroke = Math.max(2, size * 0.085);
  return (
    <View accessible={false} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", top: size * 0.12, width: size * 0.34, height: size * 0.18, borderWidth: stroke, borderBottomWidth: 0, borderColor: color, borderTopLeftRadius: 3, borderTopRightRadius: 3 }} />
      <View style={{ marginTop: size * 0.14, width: size * 0.9, height: size * 0.62, borderWidth: stroke, borderColor: color, borderRadius: size * 0.14, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: size * 0.3, height: size * 0.3, borderRadius: size * 0.15, borderWidth: stroke, borderColor: color }} />
      </View>
    </View>
  );
}

/** Three bars (budget). */
export function BudgetIcon({ color, size = 22 }: IconProps): React.JSX.Element {
  const w = Math.max(2.5, size * 0.12);
  return (
    <View accessible={false} style={{ width: size, height: size, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", paddingHorizontal: size * 0.1, paddingVertical: size * 0.08 }}>
      <View style={{ width: w, height: "55%", borderRadius: w, backgroundColor: color }} />
      <View style={{ width: w, height: "95%", borderRadius: w, backgroundColor: color }} />
      <View style={{ width: w, height: "40%", borderRadius: w, backgroundColor: color }} />
    </View>
  );
}

/** A small house with a door (goals: the homestead). */
export function GoalsIcon({ color, size = 22 }: IconProps): React.JSX.Element {
  const stroke = Math.max(1.5, size * 0.09);
  return (
    <View accessible={false} style={{ width: size, height: size, alignItems: "center", justifyContent: "flex-end" }}>
      <View style={{ position: "absolute", top: size * 0.12, width: size * 0.44, height: size * 0.44, borderTopWidth: stroke, borderLeftWidth: stroke, borderColor: color, transform: [{ rotate: "45deg" }] }} />
      <View style={{ width: size * 0.6, height: size * 0.46, borderWidth: stroke, borderTopWidth: 0, borderColor: color, marginBottom: size * 0.04, alignItems: "center", justifyContent: "flex-end" }}>
        <View style={{ width: size * 0.18, height: size * 0.24, borderWidth: stroke, borderBottomWidth: 0, borderColor: color }} />
      </View>
    </View>
  );
}

/** Magnifier for the Ask bar. */
export function SearchIcon({ color, size = 20 }: IconProps): React.JSX.Element {
  const stroke = Math.max(1.5, size * 0.1);
  return (
    <View accessible={false} style={{ width: size, height: size }}>
      <View style={{ width: size * 0.66, height: size * 0.66, borderRadius: size * 0.33, borderWidth: stroke, borderColor: color }} />
      <View style={{ position: "absolute", right: size * 0.06, bottom: size * 0.06, width: size * 0.36, height: stroke, backgroundColor: color, borderRadius: stroke, transform: [{ rotate: "45deg" }] }} />
    </View>
  );
}

/** Face ID: a bracketed face. */
export function FaceIdIcon({ color, size = 64 }: IconProps): React.JSX.Element {
  const stroke = Math.max(2, size * 0.045);
  const corner = size * 0.22;
  const bracket = (style: object) => <View style={[{ position: "absolute", width: corner, height: corner, borderColor: color }, style]} />;
  return (
    <View accessible={false} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {bracket({ top: 0, left: 0, borderTopWidth: stroke, borderLeftWidth: stroke, borderTopLeftRadius: size * 0.1 })}
      {bracket({ top: 0, right: 0, borderTopWidth: stroke, borderRightWidth: stroke, borderTopRightRadius: size * 0.1 })}
      {bracket({ bottom: 0, left: 0, borderBottomWidth: stroke, borderLeftWidth: stroke, borderBottomLeftRadius: size * 0.1 })}
      {bracket({ bottom: 0, right: 0, borderBottomWidth: stroke, borderRightWidth: stroke, borderBottomRightRadius: size * 0.1 })}
      <View style={{ flexDirection: "row", gap: size * 0.2, marginBottom: size * 0.08 }}>
        <View style={{ width: stroke, height: size * 0.12, backgroundColor: color, borderRadius: stroke }} />
        <View style={{ width: stroke, height: size * 0.12, backgroundColor: color, borderRadius: stroke }} />
      </View>
      <View style={{ width: size * 0.3, height: size * 0.16, borderBottomWidth: stroke, borderColor: color, borderBottomLeftRadius: size * 0.15, borderBottomRightRadius: size * 0.15 }} />
    </View>
  );
}

/** A check mark drawn with text (SF Symbols are not available without native code). */
export function CheckGlyph({ color, size = 18 }: IconProps): React.JSX.Element {
  return (
    <Text accessible={false} style={{ color, fontSize: size, fontWeight: "700", lineHeight: size + 2 }}>
      ✓
    </Text>
  );
}

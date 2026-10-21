/**
 * Screen scaffolds: a tab screen (brand bar, sync bar, scrolling column with the prototype's 16-point gutter
 * and 14-point gaps, room for the tab bar) and a sheet screen for modal routes (grab bar, title, close).
 */
import type { PropsWithChildren, ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTheme } from "./ThemeProvider";
import { Avatar, CloseButton, Eyebrow, Grab, H1 } from "./primitives";
import { BrandMark } from "./Icons";
import { GUTTER } from "./theme";
import { SyncBar } from "./SyncBar";

export function TopBar({ initial, badge }: { initial: string; badge?: number }): React.JSX.Element {
  const { p, display } = useTheme();
  const router = useRouter();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: GUTTER, paddingTop: 10, paddingBottom: 6 }}>
      <View accessible accessibilityRole="header" accessibilityLabel="Homestead" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <BrandMark bg={p.accent} fg={p.accentInk} />
        <Text style={{ fontFamily: display, fontSize: 22, color: p.ink, letterSpacing: -0.2 }}>Homestead</Text>
      </View>
      <Avatar initial={initial} onPress={() => router.push("/settings")} badge={badge} />
    </View>
  );
}

/** A tab screen. `refreshing`/`onRefresh` wire pull-to-refresh. */
export function Screen({
  children,
  initial = "V",
  badge,
  refreshing,
  onRefresh,
  testID,
  contentStyle,
}: PropsWithChildren<{ initial?: string; badge?: number; refreshing?: boolean; onRefresh?: () => void; testID?: string; contentStyle?: StyleProp<ViewStyle> }>): React.JSX.Element {
  const { p } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: p.bg, paddingTop: insets.top }} testID={testID}>
      <TopBar initial={initial} badge={badge} />
      <SyncBar />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[{ paddingHorizontal: GUTTER, paddingTop: 4, paddingBottom: 110 + insets.bottom, gap: 14 }, contentStyle]}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing === true} onRefresh={onRefresh} tintColor={p.muted} /> : undefined}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** A modal sheet route: grab bar, eyebrow + title, close, then the content. */
export function SheetScreen({
  title,
  eyebrow,
  children,
  onClose,
  testID,
  footer,
  closeLabel = "Close",
}: PropsWithChildren<{ title: string; eyebrow?: string; onClose?: () => void; testID?: string; footer?: ReactNode; closeLabel?: string }>): React.JSX.Element {
  const { p } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const close = onClose ?? (() => (router.canGoBack() ? router.back() : router.replace("/")));
  return (
    <View style={{ flex: 1, backgroundColor: p.bg }} testID={testID}>
      <View style={{ paddingTop: 10, paddingHorizontal: GUTTER, gap: 10 }}>
        <Grab />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {eyebrow !== undefined && <Eyebrow>{eyebrow}</Eyebrow>}
            <H1 style={{ fontSize: 22, lineHeight: 26 }}>{title}</H1>
          </View>
          <CloseButton onPress={close} label={closeLabel} />
        </View>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 12, paddingBottom: 24 + insets.bottom, gap: 14 }}>
        {children}
      </ScrollView>
      {footer !== undefined && <View style={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: 12 + insets.bottom, gap: 8 }}>{footer}</View>}
    </View>
  );
}

/** "Needs your answer  (3)" style section head with an optional right-hand action. */
export function SectionHead({ title, count, action, onAction }: { title: string; count?: number; action?: string; onAction?: () => void }): React.JSX.Element {
  const { p } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: "600", color: p.ink }}>
          {title}
        </Text>
        {count !== undefined && count > 0 && (
          <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 6, backgroundColor: p.surface2 }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: p.muted }}>{count}</Text>
          </View>
        )}
      </View>
      {action !== undefined && onAction && (
        <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={action} style={({ pressed }) => ({ minHeight: 40, paddingHorizontal: 14, justifyContent: "center", borderRadius: 12, opacity: pressed ? 0.7 : 1 })}>
          <Text style={{ color: p.accent, fontWeight: "600", fontSize: 15 }}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

export function Centered({ children }: PropsWithChildren): React.JSX.Element {
  return <View style={{ paddingVertical: 32, alignItems: "center", gap: 10 }}>{children}</View>;
}

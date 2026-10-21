/**
 * The bottom tabs with the raised green Snap button in the middle, as the prototype draws them: Home,
 * Activity, Snap, Budget, Goals. Snap opens the camera route above the tabs, so a receipt is Home -> Snap ->
 * shutter -> Done: three taps.
 */
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { BottomTabBarProps } from "expo-router/tabs";
import { useTheme } from "./ThemeProvider";
import { ActivityIcon, BudgetIcon, CameraIcon, GoalsIcon, HouseIcon } from "./Icons";

const ORDER = ["index", "activity", "budget", "goals"] as const;
const LABEL: Record<(typeof ORDER)[number], string> = { index: "Home", activity: "Activity", budget: "Budget", goals: "Goals" };

export function TabBar({ state, navigateToTab, insets }: BottomTabBarProps): React.JSX.Element {
  const { p } = useTheme();
  const router = useRouter();
  const current = state.routes[state.index]?.name;

  const tab = (name: (typeof ORDER)[number]) => {
    const on = current === name;
    const color = on ? p.accent : p.muted;
    const route = state.routes.find((r) => r.name === name);
    const go = () => {
      if (route) navigateToTab(route.key);
    };
    const Icon = name === "index" ? HouseIcon : name === "activity" ? ActivityIcon : name === "budget" ? BudgetIcon : GoalsIcon;
    return (
      <Pressable
        key={name}
        onPress={go}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityLabel={LABEL[name]}
        testID={`tab-${name}`}
        style={{ flex: 1, height: 64, alignItems: "center", justifyContent: "center", gap: 3 }}
      >
        <Icon color={color} size={22} />
        <Text style={{ fontSize: 11, fontWeight: "600", color }}>{LABEL[name]}</Text>
      </Pressable>
    );
  };

  return (
    <View style={{ backgroundColor: p.surface, borderTopWidth: 1, borderTopColor: p.line, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", height: 64 }}>
        {tab("index")}
        {tab("activity")}
        <Pressable
          onPress={() => router.push("/snap")}
          accessibilityRole="button"
          accessibilityLabel="Snap a receipt"
          testID="snap-button"
          style={{ flex: 1.2, height: 64, alignItems: "center", justifyContent: "flex-end", paddingBottom: 6, gap: 4 }}
        >
          <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: p.accent, alignItems: "center", justifyContent: "center", marginTop: -26, shadowColor: p.shadow, shadowOpacity: 1, shadowRadius: 15, shadowOffset: { width: 0, height: 10 }, elevation: 8 }}>
            <CameraIcon color={p.accentInk} size={26} />
          </View>
          <Text style={{ fontSize: 11, fontWeight: "600", color: p.accent }}>Snap</Text>
        </Pressable>
        {tab("budget")}
        {tab("goals")}
      </View>
    </View>
  );
}

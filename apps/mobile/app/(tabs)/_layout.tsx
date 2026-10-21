import { Tabs } from "expo-router/tabs";
import { TabBar } from "@/ui/TabBar";

export default function TabsLayout(): React.JSX.Element {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="activity" options={{ title: "Activity" }} />
      <Tabs.Screen name="budget" options={{ title: "Budget" }} />
      <Tabs.Screen name="goals" options={{ title: "Goals" }} />
    </Tabs>
  );
}

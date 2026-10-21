/**
 * The bar above every screen while anything is waiting to sync (Phase 1 screen list): "Uploading 2 receipts…"
 * online, "You're offline. 2 receipts saved on your phone — not synced yet." offline. Hidden when idle.
 */
import { useEffect, useRef } from "react";
import { Animated, Text, View } from "react-native";
import { useReceiptQueue } from "../receipts/ReceiptQueueProvider";
import { syncBarText } from "../model/syncWords";
import { useTheme } from "./ThemeProvider";
import { GUTTER } from "./theme";

export function SyncBar(): React.JSX.Element | null {
  const { p } = useTheme();
  const q = useReceiptQueue();
  const text = syncBarText(q.online, q.pending.length);
  const pulse = useRef(new Animated.Value(1)).current;
  const busy = q.online && q.pending.length > 0;
  useEffect(() => {
    if (!busy) return;
    const loop = Animated.loop(Animated.sequence([Animated.timing(pulse, { toValue: 0.3, duration: 500, useNativeDriver: true }), Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [busy, pulse]);
  if (!text) return null;
  return (
    <View accessibilityRole="text" accessibilityLiveRegion="polite" testID="sync-bar" style={{ flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: GUTTER, marginBottom: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: q.online ? p.wheatSoft : p.surface2 }}>
      <Animated.View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: q.online ? p.wheat : p.faint, opacity: busy ? pulse : 1 }} />
      <Text style={{ flex: 1, fontSize: 14, lineHeight: 19, color: p.ink }}>{text}</Text>
    </View>
  );
}

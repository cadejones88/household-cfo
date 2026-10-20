import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./ThemeProvider";

interface ToastApi {
  show: (message: string, ms?: number) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function ToastProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((msg: string, ms = 2200) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(msg);
    AccessibilityInfo.announceForAccessibility(msg);
    timer.current = setTimeout(() => setMessage(null), ms);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {message !== null && <ToastView message={message} />}
    </ToastContext.Provider>
  );
}

function ToastView({ message }: { message: string }): React.JSX.Element {
  const { p } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: 96 + insets.bottom, alignItems: "center" }}>
      <View accessibilityLiveRegion="polite" style={{ backgroundColor: p.ink, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6, maxWidth: "100%" }}>
        <Text style={{ color: p.bg, fontWeight: "600", fontSize: 14, textAlign: "center" }}>{message}</Text>
      </View>
    </View>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

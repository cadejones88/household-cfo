/**
 * Root layout: providers, the sign-in gate, the Face ID gate, push routing, and the stack of screens.
 * Tabs live in (tabs); everything else is a sheet or a page above them.
 */
import { useEffect } from "react";
import { View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { KEYS, SecureKeyValueStore } from "@/auth/tokenStore";
import { ApiProvider, useApi } from "@/api/ApiProvider";
import { ReceiptQueueProvider } from "@/receipts/ReceiptQueueProvider";
import { onNotificationTap, registerForPush } from "@/push/notifications";
import { ThemeProvider, useTheme } from "@/ui/ThemeProvider";
import { ToastProvider } from "@/ui/Toast";
import { FaceIdGate } from "@/ui/FaceIdGate";
import { FaceIdIntro } from "@/ui/FaceIdIntro";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <ApiProvider>
            <ReceiptQueueProvider>
              <ToastProvider>
                <Shell />
              </ToastProvider>
            </ReceiptQueueProvider>
          </ApiProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Shell(): React.JSX.Element {
  const auth = useAuth();
  const api = useApi();
  const { p, dark } = useTheme();
  const router = useRouter();
  const signedIn = auth.status === "ready" || auth.status === "locked";

  useEffect(() => {
    if (auth.status !== "loading") void SplashScreen.hideAsync().catch(() => undefined);
  }, [auth.status]);

  useEffect(() => {
    if (auth.status !== "ready") return;
    return onNotificationTap((route) => router.push(route as never));
  }, [auth.status, router]);

  // Re-send the push token on each sign-in when notifications are on (POST /v1/devices/push-token).
  useEffect(() => {
    if (auth.status !== "ready") return;
    const store = new SecureKeyValueStore();
    void store.get<boolean>(KEYS.notifications).then((on) => (on ? registerForPush(api, store) : undefined)).catch(() => undefined);
  }, [auth.status, api]);

  if (auth.status === "loading") return <View style={{ flex: 1, backgroundColor: p.bg }} />;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <StatusBar style={dark ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.bg } }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="snap" options={{ presentation: "fullScreenModal", animation: "fade" }} />
          <Stack.Screen name="receipt/[clientId]" options={{ presentation: "modal" }} />
          <Stack.Screen name="transaction/[id]" options={{ presentation: "modal" }} />
          <Stack.Screen name="safe-to-spend" options={{ presentation: "modal" }} />
          <Stack.Screen name="wrong/[id]" options={{ presentation: "modal" }} />
          <Stack.Screen name="business/[id]" options={{ presentation: "modal" }} />
          <Stack.Screen name="move-money" options={{ presentation: "modal" }} />
          <Stack.Screen name="bills" />
          <Stack.Screen name="ask" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="alerts" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
      {auth.status === "locked" && (
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}>
          <FaceIdGate />
        </View>
      )}
      {auth.needsFaceIdIntro && (
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}>
          <FaceIdIntro />
        </View>
      )}
    </View>
  );
}

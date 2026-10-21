/**
 * Push: ask once, get the Expo push token, send it to the API, and route a tapped notification to the right
 * screen. HttpApi.registerPushToken posts to /v1/devices/push-token (in the API's code, not yet in openapi.yaml)
 * and ignores a 404 from an older API, so the app keeps working and the token is re-sent on the next sign-in.
 * Sending pushes (Expo push service, quiet hours, one alert per problem) is the API's alert job, not the phone's.
 *
 * Quiet hours (21:00–07:00 Mountain) are enforced by the API's alert job, not here: the phone shows what it
 * is sent. Alert levels: `action` pushes to both spouses; `watch` is an in-app badge and the daily digest;
 * `pulse` is one push on council day (Phase 1, D6).
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import type { HomesteadApi } from "../api/types";
import { env } from "../lib/env";
import { KEYS, type KeyValueStore } from "../auth/tokenStore";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true }),
});

export type PushStatus = "granted" | "denied" | "unavailable";

export async function pushPermission(): Promise<PushStatus> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return "granted";
    if (!current.canAskAgain) return "denied";
    const asked = await Notifications.requestPermissionsAsync();
    return asked.granted ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

function projectId(): string | undefined {
  const fromConfig = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  return env.easProjectId || fromConfig || undefined;
}

/** Register this phone for push. Returns the token sent, or undefined when push is off or unavailable. */
export async function registerForPush(api: HomesteadApi, store: KeyValueStore): Promise<string | undefined> {
  const perm = await pushPermission();
  if (perm !== "granted") return undefined;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("homestead", { name: "Homestead", importance: Notifications.AndroidImportance.DEFAULT });
  }
  const pid = projectId();
  if (!pid) return undefined; // Expo push needs the EAS project id; set EXPO_PUBLIC_EAS_PROJECT_ID or app.json extra.eas.projectId
  const token = (await Notifications.getExpoPushTokenAsync({ projectId: pid })).data;
  const last = await store.get<string>(KEYS.pushToken);
  if (last !== token) {
    await api.registerPushToken({ token, platform: Platform.OS === "ios" ? "ios" : "android" });
    await store.set(KEYS.pushToken, token);
  }
  return token;
}

/** Where a tapped notification should take the person. The API puts `route` in the data payload. */
export function routeForNotification(data: Record<string, unknown> | undefined): string {
  const route = typeof data?.["route"] === "string" ? (data["route"] as string) : undefined;
  if (route && route.startsWith("/")) return route;
  const kind = typeof data?.["kind"] === "string" ? (data["kind"] as string) : "";
  if (kind.startsWith("approve") || kind === "budget_move") return "/budget";
  if (kind === "question" || kind.startsWith("confirm") || kind.startsWith("pick")) return "/";
  if (kind === "weekly_pulse" || kind === "digest") return "/alerts";
  return "/alerts";
}

export function onNotificationTap(handler: (route: string) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as Record<string, unknown> | undefined;
    handler(routeForNotification(data));
  });
  return () => sub.remove();
}

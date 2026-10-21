/**
 * Small typed key/value store over expo-secure-store (the iOS keychain / Android keystore). Sign-in tokens,
 * the Face ID preference and the last-unlock time live here; nothing else. Values are JSON. A memory store
 * backs the unit tests. Keys are namespaced so a future second household on one phone cannot collide.
 */
import * as SecureStore from "expo-secure-store";

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

const PREFIX = "homestead.";

export class SecureKeyValueStore implements KeyValueStore {
  async get<T>(key: string): Promise<T | undefined> {
    const raw = await SecureStore.getItemAsync(PREFIX + key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      await SecureStore.deleteItemAsync(PREFIX + key);
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    // Available after the first unlock, this device only: a backup never carries the session to another phone.
    await SecureStore.setItemAsync(PREFIX + key, JSON.stringify(value), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  }

  async remove(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(PREFIX + key);
  }
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export const KEYS = {
  /** Entra tokens and their times (entra mode). */
  session: "session",
  /** The chosen dev member (dev mode). */
  devMember: "devMember",
  /** Face ID unlock on/off (default on once hardware is enrolled). */
  faceId: "faceId",
  /** When the app was last unlocked locally. */
  lastUnlockAt: "lastUnlockAt",
  /** Notifications on/off. */
  notifications: "notifications",
  /** The Expo push token last sent to the API. */
  pushToken: "pushToken",
} as const;

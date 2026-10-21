/**
 * Globals the bundler provides that the React Native types do not declare. `process.env.EXPO_PUBLIC_*` is
 * inlined by Expo at build time; `__DEV__` is set by Metro.
 */
declare const process: { env: Record<string, string | undefined> };
declare const __DEV__: boolean;

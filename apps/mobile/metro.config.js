// Metro config for the pnpm monorepo. Expo SDK 52+ configures watch folders and node_modules paths for
// monorepos by itself (https://docs.expo.dev/guides/monorepos/), so the only addition here is a shim:
// @homestead/shared imports `node:crypto` for its SHA-256 helper, which React Native does not have.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);

const shims = {
  "node:crypto": path.resolve(__dirname, "src/shims/node-crypto.ts"),
  crypto: path.resolve(__dirname, "src/shims/node-crypto.ts"),
};

const previousResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const shim = shims[moduleName];
  if (shim) return { type: "sourceFile", filePath: shim };
  if (previousResolveRequest) return previousResolveRequest(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

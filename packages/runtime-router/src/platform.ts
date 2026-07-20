import type { AppPlatform, RuntimeBackendKind } from "./contracts.js";

const DESKTOP_PLATFORMS = new Set<AppPlatform>([
  "windows",
  "macos",
  "linux",
]);

export function selectRuntimeBackend(platform: AppPlatform): RuntimeBackendKind {
  return DESKTOP_PLATFORMS.has(platform) ? "node-sidecar" : "in-process";
}

export function isMobilePlatform(platform: AppPlatform): boolean {
  return !DESKTOP_PLATFORMS.has(platform);
}

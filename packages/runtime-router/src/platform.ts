import type { AppPlatform, RuntimeBackendKind, RuntimeMode } from "./contracts.js";

const DESKTOP_PLATFORMS = new Set<AppPlatform>([
  "windows",
  "macos",
  "linux",
]);

export function selectRuntimeMode(
  platform: AppPlatform,
  requested: RuntimeMode = "portable",
): RuntimeMode {
  if (requested === "desktop-power" && isMobilePlatform(platform)) {
    throw new Error(`Runtime mode desktop-power is not supported on ${platform}`);
  }
  return requested;
}

export function selectRuntimeBackend(
  platform: AppPlatform,
  mode: RuntimeMode = "portable",
): RuntimeBackendKind {
  return selectRuntimeMode(platform, mode) === "desktop-power"
    ? "node-sidecar"
    : "in-process";
}

export function isMobilePlatform(platform: AppPlatform): boolean {
  return !DESKTOP_PLATFORMS.has(platform);
}

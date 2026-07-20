import type { AppPlatform } from "@nkg-ai-bot/runtime-router";

let installed = false;

/**
 * Mobile WebViews delegate outbound model requests to Tauri's Rust HTTP
 * backend. Desktop keeps the native Node sidecar's own fetch implementation.
 */
export async function installPlatformFetch(platform: AppPlatform): Promise<void> {
  if (installed || (platform !== "android" && platform !== "ios")) return;
  const { fetch: nativeFetch } = await import("@tauri-apps/plugin-http");
  globalThis.fetch = nativeFetch as typeof globalThis.fetch;
  installed = true;
}

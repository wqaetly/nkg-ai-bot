import type { AppPlatform } from "@nkg-ai-bot/runtime-router";

/**
 * Mobile WebViews delegate outbound model requests to Tauri's Rust HTTP
 * backend. The implementation is returned as an explicit Runtime dependency;
 * application code never mutates the WebView's global fetch function.
 */
export async function getPlatformFetch(
  platform: AppPlatform,
): Promise<typeof globalThis.fetch> {
  if (platform !== "android" && platform !== "ios") {
    return (input, init) => globalThis.fetch(input, init);
  }
  const { fetch: nativeFetch } = await import("@tauri-apps/plugin-http");
  return nativeFetch as typeof globalThis.fetch;
}

import type { AppPlatform } from "@nkg-ai-bot/runtime-router";

/**
 * Delegate outbound model requests to Tauri's Rust HTTP backend on every
 * platform. Desktop WebView fetch is still subject to CSP/CORS and cannot
 * safely reach user-configured Provider domains, which are dynamic by design.
 * The implementation remains an explicit Runtime dependency; application code
 * never mutates the WebView's global fetch function.
 */
export async function getPlatformFetch(
  _platform: AppPlatform,
): Promise<typeof globalThis.fetch> {
  const { fetch: nativeFetch } = await import("@tauri-apps/plugin-http");
  return nativeFetch as typeof globalThis.fetch;
}

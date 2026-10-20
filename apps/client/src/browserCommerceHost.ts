import { BROWSER_COMMERCE_ENDPOINT, directProductUrl, isShoppingPlatform } from "@nkg-ai-bot/commerce-flow";
import type { TauriInvoke } from "@nkg-ai-bot/tauri-runtime-adapter";

/** The reserved endpoint is local IPC, never an outbound network request. */
export function withBrowserCommerce(fetchImpl: typeof fetch, invoke: TauriInvoke, desktop: boolean): typeof fetch {
  return async (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    let origin: string;
    try { origin = new URL(address).origin; } catch { return fetchImpl(input, init); }
    if (origin !== new URL(BROWSER_COMMERCE_ENDPOINT).origin) return fetchImpl(input, init);
    if (address !== BROWSER_COMMERCE_ENDPOINT) return new Response(null, { status: 404 });
    const request = new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    request.signal.throwIfAborted();
    if (!desktop) return Response.json({ status: "unsupported", products: [] });
    const text = await request.text();
    if (text.length > 4000) return new Response(null, { status: 400 });
    let body: { provider?: unknown; keyword?: unknown; url?: unknown };
    try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
    if (!body || typeof body !== "object") return new Response(null, { status: 400 });
    if (!isShoppingPlatform(body.provider)) return new Response(null, { status: 400 });
    const url = body.url === undefined ? undefined : directProductUrl(body.provider, body.url);
    const keyword = typeof body.keyword === "string" ? body.keyword.trim().slice(0, 100) : undefined;
    if (body.url !== undefined ? !url : !keyword) return new Response(null, { status: 400 });
    const requestId = crypto.randomUUID();
    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        void invoke("commerce_browser_cancel", { requestId }).catch(() => undefined);
        reject(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) { abort(); return; }
      void invoke("commerce_browser_collect", { requestId, provider: body.provider, keyword: keyword ?? null, url: url ?? null })
        .then((result) => resolve(Response.json(result)))
        .catch(() => resolve(Response.json({ status: "native_error", products: [] })))
        .finally(() => request.signal.removeEventListener("abort", abort));
    });
  };
}

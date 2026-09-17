/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NKG_HOSTED_AI_ENABLED?: string;
  readonly VITE_NKG_HOSTED_AI_SERVICE_URL?: string;
  /** Public, rate-limited client token only. Vite embeds this value in the shipped app. */
  readonly VITE_DEFAULT_SEARXNG_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

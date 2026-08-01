/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NKG_HOSTED_AI_ENABLED?: string;
  readonly VITE_NKG_HOSTED_AI_SERVICE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

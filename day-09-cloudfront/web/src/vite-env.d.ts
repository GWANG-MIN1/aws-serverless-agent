/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_FUNCTION_URL_FOR_DEV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

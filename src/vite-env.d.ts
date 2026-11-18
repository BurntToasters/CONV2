/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONV2_E2E: string;
  readonly VITE_CONV2_CHANNEL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

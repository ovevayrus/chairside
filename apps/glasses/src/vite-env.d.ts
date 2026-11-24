/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin, e.g. http://localhost:8787 (no secrets: this ships in the bundle). */
  readonly VITE_API_BASE?: string
}

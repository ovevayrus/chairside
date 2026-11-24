/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin, e.g. http://localhost:8787 (no secrets: this ships in the bundle). */
  readonly VITE_API_BASE?: string
  /** The shop bot's username without "@", shown on the pairing screen (optional). */
  readonly VITE_BOT_USERNAME?: string
}

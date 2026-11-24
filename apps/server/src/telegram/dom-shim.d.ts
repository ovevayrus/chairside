// grammY's typings name two DOM fetch types (only in its Cloudflare and Elysia webhook
// adapters, which Chairside does not use) that the server's Node-only lib setup lacks.
// These stand-ins let tsc check grammY's declarations. Delete this file if the server
// tsconfig ever enables lib "DOM" or skipLibCheck.
export {}

declare global {
  interface Body {
    json(): Promise<unknown>
  }
  type BodyInit = string | ArrayBuffer | ArrayBufferView | Blob | FormData
}

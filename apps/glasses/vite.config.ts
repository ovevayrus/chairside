import { defineConfig } from 'vite'

// From the Even Hub minimal template: port 5173 and a host binding so the
// glasses (QR sideload) and the simulator can reach the dev server.
export default defineConfig({
  server: { host: true, port: 5173, strictPort: true },
  build: { target: 'esnext' },
})

import {
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { ChairsideApp } from './app'
import { requestExitDialog } from './input'
import { ApiClient } from './net/api'
import { LiveClient } from './net/live'
import { bridgeStorage, KEYS } from './storage'
import { BridgeQueue, Renderer } from './ui/render'

const APP_VERSION = '0.1.0'
const apiBase = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'

function devFlag(name: string): boolean {
  return new URLSearchParams(location.search).get(name) === '1'
}

/** Hex from the platform CSPRNG (works without a secure context, unlike randomUUID). */
function randomKey(bytes: number): string {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const clock = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function parts(ms: number): Record<string, string> {
  return Object.fromEntries(
    clock.formatToParts(ms).map((part) => [part.type, part.value]),
  )
}

async function startApp(bridge: EvenAppBridge): Promise<void> {
  const queue = new BridgeQueue()
  const renderer = new Renderer(bridge, queue)
  const storage = bridgeStorage(bridge, queue)
  // Dev only (dropped from builds): start unpaired, as the e2e run needs.
  if (import.meta.env.DEV && devFlag('fresh')) {
    for (const key of Object.values(KEYS)) await storage.set(key, '')
  }
  const app = new ChairsideApp(
    {
      show: (page, menu) => renderer.show(page, menu),
      invalidate: () => renderer.invalidate(),
      exit: () =>
        requestExitDialog({
          shutDownPageContainer: (mode) =>
            queue.run(() => bridge.shutDownPageContainer(mode)),
        }),
      storage,
      api: new ApiClient(apiBase),
      createLive: (options) => new LiveClient(options),
      timers: {
        setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
        clearTimeout: (id) =>
          globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
        setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
        clearInterval: (id) =>
          globalThis.clearInterval(id as ReturnType<typeof setInterval>),
      },
      now: () => Date.now(),
      randomKey,
      log: (line) => console.log(`[chairside] ${line}`),
      formatDate: (ms) => {
        const p = parts(ms)
        return `${p.weekday} ${p.day} ${p.month}`
      },
      formatTime: (ms) => {
        const p = parts(ms)
        return `${p.hour}:${p.minute}`
      },
    },
    {
      appVersion: APP_VERSION,
      bot: import.meta.env.VITE_BOT_USERNAME,
      // Dev only (dropped from builds): a TEST MODE server answers /dev/info.
      probeTestMode: import.meta.env.DEV
        ? async () => {
            const response = await fetch(`${apiBase}/dev/info`, {
              signal: AbortSignal.timeout(1_500),
            })
            const body: unknown = response.ok ? await response.json() : null
            return (
              typeof body === 'object' &&
              body !== null &&
              'mode' in body &&
              body.mode === 'test'
            )
          }
        : undefined,
    },
  )
  bridge.onEvenHubEvent((event) => app.handleEvent(event))
  await app.start()
}

async function main(): Promise<void> {
  const bridge = await waitForEvenAppBridge()
  // Dev-only pages: the branches, and their chunks, are dropped from builds.
  if (import.meta.env.DEV && devFlag('spike')) {
    const { showSpike } = await import('./spike')
    await showSpike(bridge)
    return
  }
  if (import.meta.env.DEV && devFlag('measure')) {
    const { showMeasure } = await import('./measure')
    await showMeasure(bridge)
    return
  }
  await startApp(bridge)
}

main().catch((error: unknown) => {
  console.error('[chairside] startup failed', error)
})

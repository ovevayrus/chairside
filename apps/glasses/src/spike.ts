// Dev-only spike page (S3): loaded with ?spike=1 under `vite` dev, never in a build.
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  StartUpPageCreateResult,
  TextContainerProperty,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { logSharedGesture, normalizeEvent, requestExitDialog } from './input'

const ITEMS = ['Book & reply', 'Offer 16:00', 'Not now']
const APP_VERSION = '0.1.0'
// Accepted only by a non-production server; real device tokens come with pairing.
const DEV_TOKEN = 'spike-dev-token-0000'
const HELLO_TIMEOUT_MS = 5_000

const apiBase = (
  import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'
).replace(/\/+$/, '')

async function checkHealth(): Promise<void> {
  try {
    const response = await fetch(`${apiBase}/healthz`)
    const body: unknown = await response.json()
    const ok =
      response.ok &&
      typeof body === 'object' &&
      body !== null &&
      'ok' in body &&
      body.ok === true
    if (ok) console.log(`[chairside] healthz ok status=${response.status}`)
    else console.error(`[chairside] healthz failed status=${response.status}`)
  } catch (error) {
    console.error('[chairside] healthz failed', error)
  }
}

function checkLive(): void {
  const socket = new WebSocket(`${apiBase.replace(/^http/, 'ws')}/ws`)
  const timer = setTimeout(() => {
    console.error('[chairside] ws hello failed reason=timeout')
    socket.close()
  }, HELLO_TIMEOUT_MS)
  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({
        type: 'hello',
        token: DEV_TOKEN,
        appVersion: APP_VERSION,
      }),
    )
  })
  socket.addEventListener('message', (message) => {
    clearTimeout(timer)
    let type: unknown
    try {
      const frame: unknown = JSON.parse(String(message.data))
      if (typeof frame === 'object' && frame !== null && 'type' in frame)
        type = frame.type
    } catch {
      type = undefined
    }
    if (type === 'hello.ok') console.log('[chairside] ws hello ok')
    else console.error('[chairside] ws hello failed reason=unexpected-frame')
    socket.close(1000)
  })
  socket.addEventListener('close', (event) => {
    clearTimeout(timer)
    if (event.code !== 1000)
      console.error(`[chairside] ws closed code=${event.code}`)
  })
}

export async function showSpike(bridge: EvenAppBridge): Promise<void> {
  bridge.onEvenHubEvent((event) => {
    const input = normalizeEvent(event)
    if (!input || logSharedGesture(input)) return
    if (input.kind === 'double_click') {
      void requestExitDialog(bridge)
    } else if (input.source === 'list') {
      console.log(`[chairside] list index=${input.index} event=${input.kind}`)
    }
  })

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 2,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 48,
          borderWidth: 0,
          paddingLength: 8,
          containerID: 1,
          containerName: 'header',
          content: 'SPIKE · input and network check',
          textColor: 2,
          isEventCapture: 0,
        }),
      ],
      listObject: [
        new ListContainerProperty({
          xPosition: 0,
          yPosition: 56,
          width: 576,
          height: 232,
          borderWidth: 0,
          paddingLength: 8,
          containerID: 2,
          containerName: 'actions',
          itemContainer: new ListItemContainerProperty({
            itemCount: ITEMS.length,
            itemName: ITEMS,
            isItemSelectBorderEn: 1,
          }),
          isEventCapture: 1,
        }),
      ],
    }),
  )
  if (result !== StartUpPageCreateResult.success) {
    console.error(`[chairside] startup page failed result=${result}`)
    return
  }
  console.log('[chairside] ready')
  console.log('[chairside] screen=spike')
  void checkHealth()
  checkLive()
}

import {
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { logSharedGesture, normalizeEvent, requestExitDialog } from './input'

const ROOT_TEXT = 'CHAIRSIDE\nConnecting to your front desk...'

function isSpikeRequested(): boolean {
  return new URLSearchParams(location.search).get('spike') === '1'
}

async function showRoot(bridge: EvenAppBridge): Promise<void> {
  bridge.onEvenHubEvent((event) => {
    const input = normalizeEvent(event)
    if (!input || logSharedGesture(input)) return
    if (input.kind === 'double_click') void requestExitDialog(bridge)
  })

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 0,
          paddingLength: 16,
          containerID: 1,
          containerName: 'root',
          content: ROOT_TEXT,
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
  console.log('[chairside] screen=root')
}

async function main(): Promise<void> {
  const bridge = await waitForEvenAppBridge()
  // Dev-only: the whole branch, and the spike chunk, are dropped from builds.
  if (import.meta.env.DEV && isSpikeRequested()) {
    const { showSpike } = await import('./spike')
    await showSpike(bridge)
    return
  }
  await showRoot(bridge)
}

main().catch((error: unknown) => {
  console.error('[chairside] startup failed', error)
})

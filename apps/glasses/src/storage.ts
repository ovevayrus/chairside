// Bridge local storage (kept by the Even app on the phone). Calls share the
// bridge queue with rendering, because concurrent bridge traffic can drop the
// connection. A failed read is treated as "nothing stored".
import type { BridgeQueue, BridgeUi } from './ui/render'

export const KEYS = {
  /** Device token from pairing: the only credential the glasses hold. */
  token: 'chairside.deviceToken',
  /** Epoch ms until which new cards are not opened automatically. */
  pausedUntil: 'chairside.pausedUntil',
  /** The server's last reported mode ("test" or "live"), for TEST in headers from the first frame. */
  mode: 'chairside.mode',
} as const

export interface KeyValueStore {
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<boolean>
}

export function bridgeStorage(
  bridge: Pick<BridgeUi, 'getLocalStorage' | 'setLocalStorage'>,
  queue: BridgeQueue,
): KeyValueStore {
  return {
    get: (key) =>
      queue
        .run(() => bridge.getLocalStorage(key), 3_000)
        .then((value) => (typeof value === 'string' ? value : ''))
        .catch(() => ''),
    set: (key, value) =>
      queue
        .run(() => bridge.setLocalStorage(key, value), 3_000)
        .catch(() => false),
  }
}

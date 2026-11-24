import { createHash } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuv'

/** Deterministic Google Calendar event id: base32hex of sha256, first 26 chars. */
export function eventIdFor(
  shopId: string,
  requestId: string,
  slotStartUtc: string,
): string {
  const digest = createHash('sha256')
    .update(`${shopId}|${requestId}|${slotStartUtc}`)
    .digest()
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of digest) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  return out.slice(0, 26)
}

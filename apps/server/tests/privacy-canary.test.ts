import { Console } from 'node:console'
import { readFileSync } from 'node:fs'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createApp } from '../src/http/app.js'
import { createDevAuthenticator } from '../src/live/auth.js'
import { createPrivacyLogger } from '../src/privacy/logger.js'
import { bookingFixture, tap, tenant } from './booking-fixture.js'

function capture(stream: NodeJS.WritableStream) {
  const chunks: Buffer[] = []
  const spy = vi.spyOn(stream, 'write').mockImplementation((chunk) => {
    chunks.push(Buffer.from(chunk))
    return true
  })
  onTestFinished(() => spy.mockRestore())
  return () => Buffer.concat(chunks).toString('utf8')
}

it('keeps booking, move and cancellation text out of logs, SQLite, WAL and SHM', async () => {
  const stdout = capture(process.stdout)
  const stderr = capture(process.stderr)
  // Vitest replaces console; exercise the server's actual stderr destination.
  vi.stubGlobal('console', new Console(process.stdout, process.stderr))
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })

  const canary = 'CANARY-7319 skin fade sat 3pm'
  const moveCanary = 'SPINDLE-CANARY'
  const cancelCanary = 'PIVOT-CANARY'
  const canaries = ['CANARY-7319', moveCanary, cancelCanary]
  let failAfterInsert = false
  const f = await bookingFixture({
    persistent: true,
    checkpoint(stage) {
      if (failAfterInsert && stage === 'after_insert') throw new Error(canary)
    },
  })
  const card = await f.cardFor(canary)
  expect((await f.runtime.execute(tap(card))).status).toBe('ok')
  expect(f.bookings()).toHaveLength(1)
  const move = await f.cardFor(`can I come at 4 instead ${moveCanary}`)
  expect((await f.runtime.execute(tap(move, 'Move & reply'))).status).toBe('ok')
  const cancel = await f.cardFor(`Sorry, I need to cancel ${cancelCanary}`)
  expect((await f.runtime.execute(tap(cancel, 'Cancel & reply'))).status).toBe(
    'ok',
  )

  // A failure carrying the customer's words propagates through the real HTTP error handler.
  f.advance(7 * 24 * 60 * 60_000)
  failAfterInsert = true
  const failedCard = await f.cardFor(canary)
  const app = createApp({
    logger: createPrivacyLogger(),
    authenticate: createDevAuthenticator(tenant, true),
    execute: (_, input) => f.runtime.execute(input),
  })
  const response = await app.request('/api/actions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + 'device'.repeat(4),
    },
    body: JSON.stringify(tap(failedCard)),
  })
  expect(response.status).toBe(500)
  expect(stdout()).toContain('"level":50')
  expect(stdout()).toContain('request failed')

  // A fault in the debounced inbound worker reaches the Telegram error reporter.
  vi.spyOn(f.runtime.store, 'save').mockImplementationOnce(() => {
    throw new Error(canary)
  })
  const updateId = await f.receive(canary)
  await vi.waitFor(() =>
    expect(stderr()).toContain(`handler failed for update ${updateId}`),
  )
  for (const output of [stdout(), stderr()]) {
    for (const marker of canaries) expect(output).not.toContain(marker)
  }

  // Copy committed pages into the main file without truncating the WAL.
  f.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
  const path = f.db.location()!
  for (const suffix of ['', '-wal', '-shm']) {
    const bytes = readFileSync(path + suffix)
    expect(bytes.length).toBeGreaterThan(0)
    if (suffix !== '-shm') expect(bytes.includes(card.requestId)).toBe(true)
    for (const marker of canaries)
      expect(bytes.includes(marker), path + suffix).toBe(false)
  }
})

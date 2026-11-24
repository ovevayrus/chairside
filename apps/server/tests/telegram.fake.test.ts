import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TelegramApiError,
  TelegramNetworkError,
  TelegramTimeoutError,
} from '../src/telegram/adapter.js'
import type { TelegramEvent } from '../src/telegram/events.js'
import { FakeTelegramAdapter, textSha256 } from '../src/telegram/fake.js'

const ANNA = 612345678
const CONNECTION = 'Kx3mQ7vRzEwSAAAAqP9dLb2YtNc'
const BUTTON = { text: 'Book 16:00', callbackData: 'offer:o-1' }
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const incoming: TelegramEvent = {
  type: 'message',
  updateId: 731400003,
  connectionId: CONNECTION,
  chatId: ANNA,
  messageId: 5101,
  fromId: ANNA,
  firstName: 'Anna',
  text: 'Can I get a skin fade Saturday 5 Dec at 3pm?',
  dateIso: '2026-11-28T09:00:00.000Z',
  direction: 'incoming',
}

describe('FakeTelegramAdapter', () => {
  it('records every outbound call with a SHA-256 of the text instead of the text', async () => {
    const fake = new FakeTelegramAdapter()
    const booked = 'Booked: Saturday 5 Dec, 15:00 skin fade. See you then!'
    const offer = 'Saturday 5 Dec, 16:00 is free. Shall I book it?'
    await expect(
      fake.sendText(ANNA, booked, { connectionId: CONNECTION }),
    ).resolves.toEqual({ messageId: 1 })
    await expect(
      fake.sendWithButton(ANNA, offer, BUTTON, { connectionId: CONNECTION }),
    ).resolves.toEqual({ messageId: 2 })
    await fake.markRead(ANNA, 5101, CONNECTION)
    await fake.deleteMessages(ANNA, [2], CONNECTION)
    await fake.answerCallback('3480012345678901234', 'Booked')
    await fake.answerCallback('3480012345678901235')

    expect(fake.calls).toEqual([
      {
        method: 'sendText',
        chatId: ANNA,
        connectionId: CONNECTION,
        textSha256: sha256(booked),
        messageId: 1,
      },
      {
        method: 'sendWithButton',
        chatId: ANNA,
        connectionId: CONNECTION,
        textSha256: sha256(offer),
        callbackData: 'offer:o-1',
        messageId: 2,
      },
      {
        method: 'markRead',
        chatId: ANNA,
        messageId: 5101,
        connectionId: CONNECTION,
      },
      {
        method: 'deleteMessages',
        chatId: ANNA,
        messageIds: [2],
        connectionId: CONNECTION,
      },
      {
        method: 'answerCallback',
        callbackQueryId: '3480012345678901234',
        textSha256: sha256('Booked'),
      },
      { method: 'answerCallback', callbackQueryId: '3480012345678901235' },
    ])
    expect(textSha256(booked)).toBe(sha256(booked))
    const recorded = JSON.stringify(fake.calls)
    expect(recorded).not.toContain('See you then')
    expect(recorded).not.toContain('Shall I book')
  })

  it('emits injected events to every subscriber until it unsubscribes', async () => {
    const fake = new FakeTelegramAdapter()
    const first: TelegramEvent[] = []
    const second: TelegramEvent[] = []
    const unsubscribe = fake.onEvent((event) => {
      first.push(event)
    })
    fake.onEvent(async (event) => {
      second.push(event)
    })
    await fake.emit(incoming)
    unsubscribe()
    await fake.emit({ ...incoming, type: 'edited', updateId: 731400004 })
    expect(first).toEqual([incoming])
    expect(second.map(({ type }) => type)).toEqual(['message', 'edited'])
  })

  it('reports a failing handler with the update id and still runs the others', async () => {
    const reported: number[] = []
    const fake = new FakeTelegramAdapter((_error, updateId) => {
      reported.push(updateId)
    })
    const delivered: number[] = []
    fake.onEvent(() => {
      throw new Error('handler bug')
    })
    fake.onEvent((event) => {
      delivered.push(event.updateId)
    })
    await fake.emit(incoming)
    expect(reported).toEqual([731400003])
    expect(delivered).toEqual([731400003])
  })

  it('throws each injected timeout or 400 once, records the attempt and sends nothing twice', async () => {
    const fake = new FakeTelegramAdapter()
    fake.failNext('timeout', 'sendText')
    fake.failNext({ code: 400, description: 'Bad Request: chat not found' })

    // The queued 400 applies to any method, so the button send takes it first.
    const rejected = await fake
      .sendWithButton(ANNA, 'Offer', BUTTON, { connectionId: CONNECTION })
      .catch((caught: unknown) => caught)
    expect(rejected).toBeInstanceOf(TelegramApiError)
    expect(rejected).toMatchObject({
      code: 400,
      description: 'Bad Request: chat not found',
    })

    const timedOut = await fake
      .sendText(ANNA, 'Booked', { connectionId: CONNECTION, timeoutMs: 50 })
      .catch((caught: unknown) => caught)
    expect(timedOut).toBeInstanceOf(TelegramTimeoutError)
    expect(timedOut).toMatchObject({ method: 'sendText', timeoutMs: 50 })

    await expect(
      fake.sendText(ANNA, 'Booked', { connectionId: CONNECTION }),
    ).resolves.toEqual({ messageId: 1 })
    expect(
      fake.calls.map(({ method, failed, messageId }) => ({
        method,
        failed,
        messageId,
      })),
    ).toEqual([
      { method: 'sendWithButton', failed: 400, messageId: undefined },
      { method: 'sendText', failed: 'timeout', messageId: undefined },
      { method: 'sendText', failed: undefined, messageId: 1 },
    ])
  })

  it('applies a method-specific failure only to that method', async () => {
    const fake = new FakeTelegramAdapter()
    fake.failNext({ code: 403 }, 'answerCallback')
    await fake.markRead(ANNA, 5101, CONNECTION)
    await expect(fake.answerCallback('3480012345678901234')).rejects.toThrow(
      TelegramApiError,
    )
    await expect(
      fake.answerCallback('3480012345678901234'),
    ).resolves.toBeUndefined()
  })

  it('injects a network failure as TelegramNetworkError', async () => {
    const fake = new FakeTelegramAdapter()
    fake.failNext('network')
    await expect(
      fake.sendText(ANNA, 'Booked', { connectionId: CONNECTION }),
    ).rejects.toThrow(TelegramNetworkError)
    expect(fake.calls).toEqual([
      expect.objectContaining({ method: 'sendText', failed: 'network' }),
    ])
  })
})

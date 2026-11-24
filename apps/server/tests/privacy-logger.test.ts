import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createPrivacyLogger } from '../src/privacy/logger.js'

it('censors text and credentials at the root, in nested arrays and in child bindings', () => {
  const lines: string[] = []
  const logger = createPrivacyLogger({ write: (line) => lines.push(line) })
  const values = Object.fromEntries(
    [
      'text',
      'body',
      'message',
      'caption',
      'reply',
      'content',
      'token',
      'deviceToken',
      'authorization',
      'Authorization',
      'access_token',
      'requestBody',
      'summary',
      'description',
      'reason',
      'callback_data',
    ].map((key) => [key, randomUUID()]),
  )
  const hidden = Object.fromEntries(
    Object.keys(values).map((key) => [key, '[Redacted]']),
  )
  logger.child({ binding: { headers: values } }).info(
    {
      ...values,
      updateId: 7319,
      sequence: 18_446_744_073_709_551_614n,
      nested: [{ update: { payload: [values] } }],
    },
    'processed',
  )

  expect(JSON.parse(lines[0]!)).toMatchObject({
    ...hidden,
    updateId: 7319,
    msg: 'processed',
    binding: { headers: hidden },
    nested: [{ update: { payload: [hidden] } }],
  })
  for (const value of Object.values(values))
    expect(lines[0]).not.toContain(value)
  expect(lines[0]).toContain('"sequence":18446744073709551614')
})

it('censors serialized error messages, stacks and implicit pino messages', () => {
  const lines: string[] = []
  const logger = createPrivacyLogger({ write: (line) => lines.push(line) })
  const detail = randomUUID()
  const error = Object.assign(new Error(detail), { description: detail })
  logger.error(error)
  logger.error({ err: error })
  logger.error({ err: error }, 'calendar unavailable')
  for (const line of lines) {
    expect(line).not.toContain(detail)
    expect(JSON.parse(line)).toMatchObject({
      level: 50,
      err: {
        message: '[Redacted]',
        stack: '[Redacted]',
        description: '[Redacted]',
      },
    })
  }
  expect(JSON.parse(lines[2]!).msg).toBe('calendar unavailable')
})

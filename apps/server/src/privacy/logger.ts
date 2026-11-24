import { pino, type DestinationStream } from 'pino'

const censored = '[Redacted]'
const sensitiveFields = new Set([
  'text',
  'body',
  'requestbody',
  'message',
  'caption',
  'reply',
  'content',
  'description',
  'summary',
  'reason',
  'stack',
  'cause',
  'callbackdata',
  'receipt',
  'lines',
  'label',
  'authorization',
  'privatekey',
  'devicenonce',
  'nonce',
  'pepper',
])

// Node 24 supplies the original JSON token to revivers. It also supports
// emitting that token unchanged, which preserves pino's bigint identifiers.
const json = JSON as JSON & { rawJSON(source: string): unknown }

function redactField(
  key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  const field = key.replaceAll('_', '').toLowerCase()
  if (
    sensitiveFields.has(field) ||
    field.endsWith('token') ||
    (field === 'data' && typeof value === 'string')
  )
    return censored
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    context?.source
  )
    return json.rawJSON(context.source)
  return value
}

export function createPrivacyLogger(
  destination: DestinationStream = process.stdout,
) {
  return pino(
    {
      hooks: {
        logMethod(args, method) {
          const first = args[0]
          // Without an explicit label pino copies an error's message into msg.
          if (
            args.length === 1 &&
            first &&
            typeof first === 'object' &&
            (first instanceof Error || 'err' in first)
          )
            args.push(censored)
          // Interpolation removes field names before the record reaches the sink.
          // Keep structured payloads in the fields argument.
          for (
            let i = typeof first === 'string' ? 1 : 2;
            i < args.length;
            i++
          ) {
            if (typeof args[i] === 'object') args[i] = censored
          }
          method.apply(this, args)
        },
        // Apply the same field policy at every depth, including child bindings,
        // arrays and properties produced by pino's error serializer.
        streamWrite(line) {
          return JSON.stringify(JSON.parse(line, redactField)) + '\n'
        },
      },
    },
    destination,
  )
}

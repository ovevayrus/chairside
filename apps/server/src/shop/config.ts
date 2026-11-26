import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IANAZone } from 'luxon'
import { z } from 'zod'

const text = z.string().trim().min(1)
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const dailyHours = z
  .object({ open: clock, close: clock })
  .refine(
    ({ open, close }) => open < close,
    'Closing time must follow opening time',
  )

const template = text.refine(
  (value) => value.includes('{day}') && value.includes('{date}'),
  'Replies must include the weekday and date',
)

export const shopConfigSchema = z
  .object({
    name: text,
    timezone: text.refine(
      (zone) => IANAZone.isValidZone(zone),
      'Invalid IANA time zone',
    ),
    // ISO weekdays. An omitted day is closed.
    hours: z.record(z.string().regex(/^[1-7]$/), dailyHours),
    bufferMin: z.int().nonnegative(),
    gridMin: z.int().positive(),
    services: z
      .array(
        z.object({
          id: text,
          name: text,
          durationMin: z.int().positive(),
          synonyms: z.array(text).min(1),
        }),
      )
      .min(1),
    defaultServiceId: text,
    replyTemplates: z.object({
      book: template,
      offer: template,
      ask_day: template,
      ask_time: template,
      offer_accepted: template,
      moved: template.default(
        'Done! Your {service} is now on {day} {date} at {time}, {name}.',
      ),
      cancelled: template.default(
        'No problem, {name}. Your {service} on {day} {date} at {time} is cancelled.',
      ),
      late_ok: text.default('No problem, {name}! See you at {time}.'),
      late_ask: text.default(
        'No problem, {name}. Roughly what time will you get here?',
      ),
    }),
  })
  .refine(
    ({ services }) =>
      new Set(services.map(({ id }) => id)).size === services.length,
    { path: ['services'], message: 'Service IDs must be unique' },
  )
  .refine(
    ({ services, defaultServiceId }) =>
      services.some(({ id }) => id === defaultServiceId),
    {
      path: ['defaultServiceId'],
      message: 'Default service must be in the service list',
    },
  )

export type ShopConfig = z.infer<typeof shopConfigSchema>

// Paths such as ../../config/shop.demo.json are relative to the server package.
const serverDirectory = fileURLToPath(new URL('../../', import.meta.url))

export function loadShopConfig(
  path = '../../config/shop.demo.json',
): ShopConfig {
  const json: unknown = JSON.parse(
    readFileSync(resolve(serverDirectory, path), 'utf8'),
  )
  return shopConfigSchema.parse(json)
}

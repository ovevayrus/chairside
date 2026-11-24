import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadShopConfig, shopConfigSchema } from '../src/shop/config.js'

describe('shop configuration', () => {
  it('loads the demo shop using the server module location', () => {
    const absolute = fileURLToPath(
      new URL('../../../config/shop.demo.json', import.meta.url),
    )
    const shop = loadShopConfig('../../config/shop.demo.json')
    expect(shop).toEqual(loadShopConfig(absolute))
    expect(shop).toEqual(loadShopConfig())
    expect(shop).toMatchObject({
      name: "Karim's Barbers",
      timezone: 'Asia/Dubai',
      gridMin: 15,
      bufferMin: 5,
      defaultServiceId: 'haircut',
    })
    expect(Object.keys(shop.hours)).toEqual(['1', '2', '3', '4', '5', '6'])
    for (const day of Object.values(shop.hours)) {
      expect(day).toEqual({ open: '10:00', close: '20:00' })
    }
    expect(
      shop.services.map(({ id, durationMin }) => [id, durationMin]),
    ).toEqual([
      ['haircut', 45],
      ['skin_fade', 45],
      ['beard_trim', 20],
      ['haircut_beard', 60],
    ])
  })

  it('rejects invalid scheduling settings, service references and undated replies', () => {
    const shop = loadShopConfig()
    for (const patch of [
      { timezone: 'Asia/Nowhere' },
      { hours: { 0: { open: '10:00', close: '20:00' } } },
      { hours: { 1: { open: '25:00', close: '26:00' } } },
      { hours: { 2: { open: '20:00', close: '10:00' } } },
      { gridMin: 0 },
      { services: [...shop.services, ...shop.services] },
      { defaultServiceId: 'missing' },
      {
        replyTemplates: { ...shop.replyTemplates, book: 'Booked for {time}!' },
      },
    ]) {
      expect(shopConfigSchema.safeParse({ ...shop, ...patch }).success).toBe(
        false,
      )
    }
  })
})

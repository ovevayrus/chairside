// Usage: npx tsx scripts/demo-block.ts "2026-12-05 17:00" 30
import { blockSlot, formatLocal } from '../apps/server/src/demo/index.js'
import { demoContext, runScript } from './lib/demo-env.js'

await runScript(async () => {
  const [localTime, minutesText] = process.argv.slice(2)
  if (!localTime || !minutesText) {
    throw new Error('Usage: demo-block "yyyy-MM-dd HH:mm" <minutes>')
  }
  const { calendar, shop } = demoContext()
  const event = await blockSlot(
    calendar,
    shop,
    localTime,
    Number(minutesText),
    String(Date.now()),
  )
  console.log(
    `blocked ${event.id} ${formatLocal(event, shop.timezone)} ${event.summary}`,
  )
})

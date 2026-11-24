// Usage: npx tsx scripts/demo-seed.ts
import { DateTime } from 'luxon'
import { formatLocal, seedDemoEvents } from '../apps/server/src/demo/index.js'
import { demoContext, runScript } from './lib/demo-env.js'

await runScript(async () => {
  const { calendar, shop } = demoContext()
  const results = await seedDemoEvents(
    calendar,
    shop,
    DateTime.now(),
    String(Date.now()),
  )
  for (const { event, status } of results) {
    console.log(
      `${status} ${event.id} ${formatLocal(event, shop.timezone)} ${event.summary}`,
    )
  }
})

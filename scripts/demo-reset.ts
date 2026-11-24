// Usage: npx tsx scripts/demo-reset.ts
import { DateTime } from 'luxon'
import { formatLocal, resetDemo } from '../apps/server/src/demo/index.js'
import { demoContext, runScript } from './lib/demo-env.js'

await runScript(async () => {
  const { calendar, shop } = demoContext()
  const removed = await resetDemo(calendar, shop, DateTime.now())
  for (const event of removed) {
    console.log(
      `removed ${event.id} ${formatLocal(event, shop.timezone)} ${event.summary}`,
    )
  }
  console.log(`removed ${removed.length} demo event(s)`)
})

import { assert } from '@std/assert'

const test = Deno.test.bind(Deno)

function readSource(relative: string): string {
  return Deno.readTextFileSync(new URL(relative, import.meta.url))
}

test('the digest sweep runs on its registry slot and only while a delivery is held, on both schedulers', () => {
  const server = readSource('./server.ts')
  const start = server.indexOf("name: 'notification digest sweep'")
  assert(start >= 0, 'the digest sweep job is not where this test looks for it')
  const job = server.slice(start, server.indexOf('run:', start))
  assert(job.includes("ctx.gates.notificationHeld && ctx.isDue('notificationDigests')"), job)

  const offline = readSource('../../daemon/cell/offline-sweep.ts')
  const phase = offline.indexOf("'notification-digests'")
  assert(phase >= 0, 'the hosted digest phase is not where this test looks for it')
  const condition = offline.slice(offline.lastIndexOf('if (', phase), phase)
  assert(condition.includes('gates.notificationHeld'), condition)
  assert(condition.includes("isDue('notificationDigests'"), condition)
})

import { assertEquals } from '@std/assert'
import { generateDeliveryId, generateRequestId } from '../../../contracts/cell-protocol.ts'
import { RedisDaemonCell } from './cell.ts'
import { createFakeRedisCellClient } from './fake-redis-cell-client.ts'
import type { RedisCellClient } from './client.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * Parity with the Durable Object test of the same name in
 * durable-object.workers.test.ts: both backends share deriveInboundOutcome, so a
 * `repo-default-branch-result` must settle the pending request the same way.
 */
test('handleInbound completes repo-default-branch requests done, with a null branch, and failed', async () => {
  const client = createFakeRedisCellClient()
  const cell = new RedisDaemonCell(
    client as unknown as RedisCellClient,
    `fake-${crypto.randomUUID()}`
  )
  const at = new Date().toISOString()

  const roundTrip = async (reply: {
    ok: boolean
    defaultBranch?: string | null
    error?: string
  }) => {
    const requestId = generateRequestId()
    await cell.enqueue({
      kind: 'repo-default-branch-request',
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      cloneUrl: 'https://example.test/acme/app.git',
    })
    return cell.handleInbound({ kind: 'repo-default-branch-result', requestId, at, ...reply })
  }

  const found = await roundTrip({ ok: true, defaultBranch: 'main' })
  assertEquals(found?.status, 'done')
  assertEquals(found?.result, { ok: true, defaultBranch: 'main' })

  const empty = await roundTrip({ ok: true, defaultBranch: null })
  assertEquals(empty?.status, 'done')

  const failed = await roundTrip({ ok: false, error: 'repo not found' })
  assertEquals(failed?.status, 'failed')
  assertEquals(failed?.error, 'repo not found')
})

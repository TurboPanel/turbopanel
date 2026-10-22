import { assert, assertEquals } from '@std/assert'
import { generateDeliveryId, generateRequestId } from '../../../contracts/cell-protocol.ts'
import { createFakeRedisCellClient } from './fake-redis-cell-client.ts'
import { cellKeyPattern } from './keys.ts'
import { RedisDaemonCell } from './cell.ts'
import type { RedisCellClient } from './client.ts'

const test = Deno.test.bind(Deno)

test('a deploy request enqueued with a long lifetime keeps its record while queued and after it is acked', async () => {
  const client = createFakeRedisCellClient()
  const serverId = `fake-${crypto.randomUUID()}`
  const cell = new RedisDaemonCell(client as unknown as RedisCellClient, serverId)
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue(
      {
        kind: 'command-dispatch',
        deliveryId: generateDeliveryId(),
        requestId,
        at,
        commandId: 'cmd-long',
        commandType: 'environment.deploy',
        payload: {},
      },
      { ttlSeconds: 6 * 60 * 60 + 900 }
    )
    const sixHoursFromNow = Date.now() + 6 * 60 * 60 * 1000
    const expiresAfter = async () => Date.parse((await cell.getRequest(requestId))?.expiresAt ?? '')
    assert((await expiresAfter()) > sixHoursFromNow)

    await cell.handleInbound({ kind: 'command-ack', requestId, at, daemonReceivedAt: at })
    assert((await expiresAfter()) > sixHoursFromNow)
    assertEquals((await cell.getRequest(requestId))?.status, 'acked')
  } finally {
    await client.deleteByPattern(cellKeyPattern(serverId))
  }
})

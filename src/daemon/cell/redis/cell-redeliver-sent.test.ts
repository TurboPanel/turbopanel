import { assertEquals } from '@std/assert'
import { generateDeliveryId, generateRequestId } from '../../../contracts/cell-protocol.ts'
import { createFakeRedisCellClient } from './fake-redis-cell-client.ts'
import { cellKeyPattern } from './keys.ts'
import { RedisDaemonCell } from './cell.ts'
import type { RedisCellClient } from './client.ts'

const test = Deno.test.bind(Deno)

function setup() {
  const client = createFakeRedisCellClient()
  const serverId = `fake-${crypto.randomUUID()}`
  const cell = new RedisDaemonCell(client as unknown as RedisCellClient, serverId)
  return {
    cell,
    cleanup: () => client.deleteByPattern(cellKeyPattern(serverId)),
    expire: () => client.deleteByPattern(cellKeyPattern(serverId)),
  }
}

function dispatch(requestId: string, deliveryId = generateDeliveryId()) {
  return {
    kind: 'command-dispatch' as const,
    deliveryId,
    requestId,
    at: new Date().toISOString(),
    commandId: requestId,
    commandType: 'managed.ingress.reconcile' as const,
    payload: {},
  }
}

/** Enqueue, write to a socket (marked sent) and acknowledge the outbox entry: the lost-frame state. */
async function sentAndLost(cell: RedisDaemonCell, requestId: string) {
  const first = dispatch(requestId)
  await cell.enqueue(first)
  const batch = await cell.readOutboxBatch({ consumer: 'c', count: 10 })
  assertEquals(batch.length, 1)
  await cell.markSent(first.deliveryId, 'conn-1')
  await cell.ackOutbox([first.deliveryId], 'c')
  assertEquals((await cell.getRequest(requestId))?.status, 'sent')
}

test('redeliverSent keeps the request sent, puts it on the outbox, and a later ack and outcome match it', async () => {
  const { cell, cleanup } = setup()
  try {
    const requestId = generateRequestId()
    await sentAndLost(cell, requestId)
    const again = dispatch(requestId)
    assertEquals(await cell.redeliverSent(again), true)
    assertEquals((await cell.getRequest(requestId))?.status, 'sent')
    const batch = await cell.readOutboxBatch({ consumer: 'c', count: 10 })
    assertEquals(
      batch.map((e) => e.deliveryId),
      [again.deliveryId]
    )
    const at = new Date().toISOString()
    await cell.handleInbound({ kind: 'command-ack', requestId, at, daemonReceivedAt: at })
    const acked = await cell.getRequest(requestId)
    assertEquals(acked?.status, 'acked')
    assertEquals(acked?.ackAt !== undefined, true)
    await cell.handleInbound({
      kind: 'command-outcome',
      requestId,
      at,
      ok: true,
      result: {},
    } as never)
    assertEquals((await cell.getRequest(requestId))?.status, 'done')
  } finally {
    await cleanup()
  }
})

test('redeliverSent with the same delivery id is a no-op that still reports delivered', async () => {
  const { cell, cleanup } = setup()
  try {
    const requestId = generateRequestId()
    await sentAndLost(cell, requestId)
    const again = dispatch(requestId)
    assertEquals(await cell.redeliverSent(again), true)
    assertEquals(await cell.redeliverSent(again), true)
    const batch = await cell.readOutboxBatch({ consumer: 'c', count: 10 })
    assertEquals(batch.length, 1)
  } finally {
    await cleanup()
  }
})

test('redeliverSent never creates a request that expired or was removed', async () => {
  const { cell, cleanup, expire } = setup()
  try {
    const requestId = generateRequestId()
    await sentAndLost(cell, requestId)
    await expire()
    assertEquals(await cell.redeliverSent(dispatch(requestId)), false)
    assertEquals(await cell.getRequest(requestId), null)
    assertEquals((await cell.readOutboxBatch({ consumer: 'c', count: 10 })).length, 0)
  } finally {
    await cleanup()
  }
})

test('redeliverSent leaves a queued request alone', async () => {
  const { cell, cleanup } = setup()
  try {
    const queued = generateRequestId()
    await cell.enqueue(dispatch(queued))
    assertEquals(await cell.redeliverSent(dispatch(queued)), false)
    assertEquals((await cell.readOutboxBatch({ consumer: 'c', count: 10 })).length, 1)
  } finally {
    await cleanup()
  }
})

test('redeliverSent leaves an acknowledged or unknown request alone', async () => {
  const { cell, cleanup } = setup()
  try {
    const acked = generateRequestId()
    await sentAndLost(cell, acked)
    const at = new Date().toISOString()
    await cell.handleInbound({ kind: 'command-ack', requestId: acked, at, daemonReceivedAt: at })
    assertEquals(await cell.redeliverSent(dispatch(acked)), false)
    assertEquals(await cell.redeliverSent(dispatch(generateRequestId())), false)
    assertEquals((await cell.readOutboxBatch({ consumer: 'c', count: 10 })).length, 0)
  } finally {
    await cleanup()
  }
})

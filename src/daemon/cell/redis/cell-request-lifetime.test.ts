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

function longCommandCell() {
  const client = createFakeRedisCellClient()
  const serverId = `fake-${crypto.randomUUID()}`
  const cell = new RedisDaemonCell(client as unknown as RedisCellClient, serverId)
  return {
    cell,
    cleanup: () => client.deleteByPattern(cellKeyPattern(serverId)),
  }
}

function dispatch(requestId: string, commandType: 'managed.backup' | 'environment.deploy') {
  return {
    kind: 'command-dispatch' as const,
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    commandId: `cmd-${commandType}`,
    commandType,
    payload: {},
  }
}

test('a long command keeps its record from its ack for its whole run, so its result is not lost', async () => {
  const { cell, cleanup } = longCommandCell()
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    // A 30-minute backup: the default five minutes to be delivered and acked,
    // then the whole run plus a margin once the daemon has it.
    await cell.enqueue(dispatch(requestId, 'managed.backup'), { ackedTtlSeconds: 45 * 60 })
    const expiresAt = async () => Date.parse((await cell.getRequest(requestId))?.expiresAt ?? '')
    assert((await expiresAt()) < Date.now() + 6 * 60 * 1000)

    await cell.handleInbound({ kind: 'command-ack', requestId, at, daemonReceivedAt: at })
    assert((await expiresAt()) > Date.now() + 40 * 60 * 1000)
    assertEquals((await cell.getRequest(requestId))?.status, 'acked')
  } finally {
    await cleanup()
  }
})

test('an ack never shortens a longer lifetime a request was enqueued with', async () => {
  const { cell, cleanup } = longCommandCell()
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue(dispatch(requestId, 'environment.deploy'), {
      ttlSeconds: 6 * 60 * 60,
      ackedTtlSeconds: 60,
    })
    await cell.handleInbound({ kind: 'command-ack', requestId, at, daemonReceivedAt: at })
    const expiresAt = Date.parse((await cell.getRequest(requestId))?.expiresAt ?? '')
    assert(expiresAt > Date.now() + 5 * 60 * 60 * 1000)
  } finally {
    await cleanup()
  }
})

/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createDurableObjectDaemonCellRegistry } from './do-registry.ts'
import { generateDeliveryId, generateRequestId } from '../../contracts/cell-protocol.ts'

describe('DurableObjectStubDaemonCell expireRequest / dropDaemonConnection', () => {
  it('expires a queued request now and tolerates a drop with no socket', async () => {
    const registry = createDurableObjectDaemonCellRegistry(env)
    const cell = registry.getCell('test-srv-registry-expire-now')
    const requestId = generateRequestId()
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId: generateDeliveryId(),
      requestId,
      at: new Date().toISOString(),
      commandId: 'cmd-expire-now',
      commandType: 'daemon.ping',
      payload: {},
    })

    await cell.dropDaemonConnection?.('command_unacked')
    const record = await cell.expireRequest?.(requestId)
    expect(record?.status).toBe('expired')
  }, 10_000)
})

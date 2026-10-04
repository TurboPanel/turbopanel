/** Host-free coverage for the command ack deadline (half-open daemon connection). */

import { assertEquals } from '@std/assert'
import type { DaemonCell, PendingRequestRecord } from '../../contracts/cell.ts'
import { awaitOutcomeWithAckDeadline, COMMAND_UNACKED_ERROR } from './consumer.ts'

function record(patch: Partial<PendingRequestRecord> = {}): PendingRequestRecord {
  return {
    serverId: 's1',
    requestId: 'r1',
    requestKind: 'command-dispatch',
    status: 'sent',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    sentAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

function fakeCell(
  reads: Array<PendingRequestRecord | null>,
  waits: Array<PendingRequestRecord | null>,
  canDrop = true,
  expireResult: PendingRequestRecord | 'throw' = record({ status: 'expired' })
) {
  const calls = { drops: [] as string[], waitMs: [] as number[], expires: [] as string[] }
  const cell = {
    waitForRequest: (_id: string, ms: number) => {
      calls.waitMs.push(ms)
      return Promise.resolve(waits.shift() ?? null)
    },
    getRequest: () => Promise.resolve(reads.shift() ?? null),
    ...(canDrop
      ? {
          dropDaemonConnection: (reason: string) => {
            calls.drops.push(reason)
            return Promise.resolve()
          },
          expireRequest: (id: string) => {
            calls.expires.push(id)
            return expireResult === 'throw'
              ? Promise.reject(new Error('rpc down'))
              : Promise.resolve(expireResult)
          },
        }
      : {}),
  } as unknown as DaemonCell
  return { cell, calls }
}

const ACKED = { status: 'acked', ackAt: '2026-01-01T00:00:01.000Z' } as const

Deno.test('ack deadline: an unacked sent command fails fast and drops the connection', async () => {
  const { cell, calls } = fakeCell([record(), record()], [null])
  const result = await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000)
  assertEquals(result?.status, 'failed')
  assertEquals(result?.error, COMMAND_UNACKED_ERROR)
  assertEquals(calls.drops, ['command_unacked'])
  assertEquals(calls.expires, ['r1'])
  assertEquals(calls.waitMs, [1_000])
})

Deno.test('ack deadline: an acked command keeps the rest of its budget', async () => {
  const done = record({ status: 'done' })
  const { cell, calls } = fakeCell([record(ACKED)], [null, done])
  assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000), done)
  assertEquals(calls.drops, [])
  assertEquals(calls.waitMs, [1_000, 599_000])
})

Deno.test('ack deadline: an ack that lands during the drop is not failed', async () => {
  const done = record({ status: 'done' })
  const { cell } = fakeCell([record(), record(ACKED)], [null, done])
  assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000), done)
})

Deno.test('ack deadline: an early terminal outcome is returned untouched', async () => {
  const done = record({ status: 'done' })
  const { cell, calls } = fakeCell([], [done])
  assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000), done)
  assertEquals(calls.drops, [])
})

Deno.test('ack deadline: a backend that cannot drop a connection does a plain wait', async () => {
  const { cell, calls } = fakeCell([], [null], false)
  assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000), null)
  assertEquals(calls.waitMs, [600_000])
  assertEquals(calls.drops, [])
})

Deno.test('ack deadline: a queued command is not failed and keeps its budget', async () => {
  const done = record({ status: 'done' })
  const { cell, calls } = fakeCell([record({ status: 'queued' })], [null, done])
  assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000), done)
  assertEquals(calls.drops, [])
  assertEquals(calls.expires, [])
  assertEquals(calls.waitMs, [1_000, 599_000])
})

Deno.test('ack deadline: a request that vanished keeps waiting', async () => {
  const { cell, calls } = fakeCell([null], [null, null])
  assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000), null)
  assertEquals(calls.drops, [])
})

Deno.test(
  'ack deadline: a request that finished while the connection dropped is returned',
  async () => {
    const done = record({ status: 'done' })
    const { cell, calls } = fakeCell([record(), done], [null])
    assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000), done)
    assertEquals(calls.expires, [])
  }
)

Deno.test(
  'ack deadline: an unacked failure expires the request so the outbox cannot run it',
  async () => {
    const { cell, calls } = fakeCell([record(), record()], [null])
    const result = await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000)
    assertEquals(result?.status, 'failed')
    assertEquals(calls.expires, ['r1'])
  }
)

Deno.test('ack deadline: a result that landed during the expire wins', async () => {
  const done = record({ status: 'done' })
  const { cell } = fakeCell([record(), record()], [null], true, done)
  assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000), done)
})

Deno.test('ack deadline: a failing expire still fails the command', async () => {
  const { cell } = fakeCell([record(), record()], [null], true, 'throw')
  const result = await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000)
  assertEquals(result?.error, COMMAND_UNACKED_ERROR)
})

Deno.test('ack deadline: a budget shorter than the deadline is a plain wait', async () => {
  const { cell, calls } = fakeCell([], [null])
  assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 500, 1_000), null)
  assertEquals(calls.waitMs, [500])
})

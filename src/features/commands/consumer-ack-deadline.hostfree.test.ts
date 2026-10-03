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
  canDrop = true
) {
  const calls = { drops: [] as string[], waitMs: [] as number[] }
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

Deno.test('ack deadline: still fails when the backend cannot drop connections', async () => {
  const { cell } = fakeCell([record(), record()], [null], false)
  const result = await awaitOutcomeWithAckDeadline(cell, 'r1', 600_000, 1_000)
  assertEquals(result?.status, 'failed')
})

Deno.test('ack deadline: a budget shorter than the deadline is a plain wait', async () => {
  const { cell, calls } = fakeCell([], [null])
  assertEquals(await awaitOutcomeWithAckDeadline(cell, 'r1', 500, 1_000), null)
  assertEquals(calls.waitMs, [500])
})

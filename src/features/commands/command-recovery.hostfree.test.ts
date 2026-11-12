import { assertEquals, assertStringIncludes } from '@std/assert'
import type { PendingRequestRecord } from '../../contracts/cell.ts'
import type {
  CommandRecoveryReport,
  DaemonOutboundEnvelope,
} from '../../contracts/cell-protocol.ts'
import type { Db } from '../../db/connection.ts'
import {
  redeliverLostCommands,
  type RedeliveryReads,
  unconfirmedErrorText,
} from './command-recovery.ts'

const test = Deno.test.bind(Deno)

test('a wrapped query error leads with the database reason and drops the bound values', () => {
  const cause = Object.assign(new Error('insert or update violates foreign key constraint'), {
    code: '23503',
  })
  const err = new Error(
    'Failed query: update "command" set "result_summary" = $1 where "id" = $2\nparams: {"secret":"x"},abc',
    { cause }
  )
  const text = unconfirmedErrorText(err)
  assertEquals(
    text.startsWith('caused by: Error: insert or update violates foreign key constraint'),
    true
  )
  assertStringIncludes(text, '23503')
  assertStringIncludes(text, 'Failed query: update "command"')
  assertEquals(text.includes('params:'), false)
  assertEquals(text.includes('secret'), false)
})

test('a plain error reads as its message', () => {
  assertEquals(unconfirmedErrorText(new Error('no deploy context')), 'no deploy context')
  assertEquals(unconfirmedErrorText('boom'), 'boom')
})

test('a message with params: but no line break before it is kept whole', () => {
  assertEquals(unconfirmedErrorText(new Error('invalid params: x')), 'invalid params: x')
})

test('the text is capped', () => {
  assertEquals(unconfirmedErrorText(new Error('x'.repeat(2000))).length, 600)
})

const SERVER_ID = 'server-1'
const RECOVERY_FEATURES = ['command-recovery-v1']

function request(requestId: string, patch: Partial<PendingRequestRecord> = {}) {
  return {
    serverId: SERVER_ID,
    requestId,
    requestKind: 'command-dispatch',
    status: 'sent',
    createdAt: '2026-11-12T14:10:18.000Z',
    expiresAt: '2026-11-12T14:15:18.000Z',
    ...patch,
  } as PendingRequestRecord
}

type Fixture = {
  requests: Map<string, PendingRequestRecord>
  rows: Map<string, { type: string; status: string; ackedAt: string | null; serverId: string }>
  sent: DaemonOutboundEnvelope[]
  dbOpened: () => number
  run: (
    features: string[] | undefined,
    report: CommandRecoveryReport | undefined
  ) => Promise<string[]>
}

function fixture(): Fixture {
  const requests = new Map<string, PendingRequestRecord>()
  const rows: Fixture['rows'] = new Map()
  const sent: DaemonOutboundEnvelope[] = []
  let opened = 0
  const cell = {
    listRequests: () => Promise.resolve([...requests.values()]),
    getRequest: (id: string) => Promise.resolve(requests.get(id) ?? null),
    enqueue: (outbound: DaemonOutboundEnvelope) => {
      sent.push(outbound)
      return Promise.resolve(request(outbound.requestId))
    },
  }
  const reads = {
    getCommandRecord: (_db: Db, id: string) => Promise.resolve(rows.get(id) ?? null),
    getCommandDispatchPayload: () => Promise.resolve({ stored: true }),
  } as unknown as RedeliveryReads
  return {
    requests,
    rows,
    sent,
    dbOpened: () => opened,
    run: (features, report) =>
      redeliverLostCommands(
        cell as never,
        (fn) => {
          opened++
          return fn({} as Db)
        },
        { serverId: SERVER_ID, features, report },
        reads
      ),
  }
}

function addCommand(fx: Fixture, id: string, requestPatch: Partial<PendingRequestRecord> = {}) {
  fx.requests.set(id, request(id, requestPatch))
  fx.rows.set(id, {
    type: 'managed.ingress.reconcile',
    status: 'sent',
    ackedAt: null,
    serverId: SERVER_ID,
  })
}

test('a sent command the daemon never acknowledged and does not report is sent again', async () => {
  const fx = fixture()
  addCommand(fx, 'lost')
  const resent = await fx.run(RECOVERY_FEATURES, undefined)
  assertEquals(resent, ['lost'])
  assertEquals(fx.sent.length, 1)
  const outbound = fx.sent[0]!
  assertEquals(outbound.kind, 'command-dispatch')
  assertEquals(outbound.requestId, 'lost')
  assertEquals(outbound.deliveryId.length > 0, true)
  assertEquals(fx.rows.get('lost')?.status, 'sent')
})

test('a command the daemon reports as running or holding a result is left alone', async () => {
  const fx = fixture()
  addCommand(fx, 'running')
  addCommand(fx, 'finished')
  const resent = await fx.run(RECOVERY_FEATURES, { running: ['running'], unacked: ['finished'] })
  assertEquals(resent, [])
  assertEquals(fx.sent.length, 0)
  assertEquals(fx.dbOpened(), 0)
})

test('an acknowledged command is left alone, in the cell or in the database', async () => {
  const fx = fixture()
  addCommand(fx, 'acked-in-cell', { status: 'acked', ackAt: '2026-11-12T14:10:19.000Z' })
  addCommand(fx, 'acked-in-db')
  fx.rows.get('acked-in-db')!.ackedAt = '2026-11-12T14:10:19.000Z'
  assertEquals(await fx.run(RECOVERY_FEATURES, undefined), [])
  assertEquals(fx.sent.length, 0)
})

test('a request that is still queued, answered or gone is not sent', async () => {
  const fx = fixture()
  addCommand(fx, 'queued', { status: 'queued' })
  addCommand(fx, 'done', { status: 'done' })
  addCommand(fx, 'expired', { status: 'expired' })
  fx.rows.set('orphan', { type: 'x', status: 'sent', ackedAt: null, serverId: SERVER_ID })
  assertEquals(await fx.run(RECOVERY_FEATURES, undefined), [])
  assertEquals(fx.sent.length, 0)
})

test('a command row that is finished or belongs to another server is not sent', async () => {
  const fx = fixture()
  addCommand(fx, 'timed-out')
  fx.rows.get('timed-out')!.status = 'timed_out'
  addCommand(fx, 'other-server')
  fx.rows.get('other-server')!.serverId = 'server-2'
  assertEquals(await fx.run(RECOVERY_FEATURES, undefined), [])
  assertEquals(fx.sent.length, 0)
})

test('a hello without command-recovery-v1 sends nothing, because its lists are unknown', async () => {
  const fx = fixture()
  addCommand(fx, 'lost')
  assertEquals(await fx.run(undefined, undefined), [])
  assertEquals(await fx.run([], undefined), [])
  assertEquals(fx.sent.length, 0)
  assertEquals(fx.dbOpened(), 0)
})

test('the database opens only when the cell holds a candidate', async () => {
  const fx = fixture()
  assertEquals(await fx.run(RECOVERY_FEATURES, undefined), [])
  assertEquals(fx.dbOpened(), 0)
  addCommand(fx, 'lost')
  await fx.run(RECOVERY_FEATURES, undefined)
  assertEquals(fx.dbOpened(), 1)
})

test('a cell or database failure is swallowed and the other commands still go', async () => {
  const fx = fixture()
  addCommand(fx, 'a')
  addCommand(fx, 'b')
  const failing = fx.requests.get('a')!
  fx.requests.set('a', failing)
  const original = fx.rows.get.bind(fx.rows)
  fx.rows.get = (id: string) => {
    if (id === 'a') throw new Error('database down')
    return original(id)
  }
  assertEquals(await fx.run(RECOVERY_FEATURES, undefined), ['b'])
})

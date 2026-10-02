/**
 * Host-free coverage for the Durable Object's `managed-ha-event` wiring: the
 * Workers command-queue binding must reach `handleManagedHaEvent`, or every
 * accepted dead-primary event ends `blocked: no_command_queue`.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { handleManagedHaEvent } from '../../features/managed/ha-event.ts'
import {
  cellAutoFailover,
  cellCommandQueue,
  handleCellManagedHaEvent,
  type ManagedHaEventFrame,
} from './managed-ha-inbound.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_A = '550e8400-e29b-41d4-a716-446655440000'
const AT = '2026-01-01T00:00:00.000Z'
const db = {} as Db

const frame: ManagedHaEventFrame = {
  type: 'managed-ha-event',
  managedId: 'mgd-1',
  sourceMemberId: 'mem-primary',
  detector: 'postgres-probe',
  evidence: { probe: 'connect_refused' },
  at: AT,
}

type Call = Parameters<typeof handleManagedHaEvent>

function recordingHandle(calls: Call[]): typeof handleManagedHaEvent {
  return (...args) => {
    calls.push(args)
    return Promise.resolve(null)
  }
}

test('cellCommandQueue is undefined without the Workers queue binding', () => {
  assertEquals(cellCommandQueue({}), undefined)
})

test('handleCellManagedHaEvent hands the Workers queue to the failover path', async () => {
  const sent: unknown[] = []
  const commandQueue = cellCommandQueue({
    TURBOPANEL_COMMAND_QUEUE: {
      send: (message) => {
        sent.push(message)
        return Promise.resolve()
      },
    },
  })
  const calls: Call[] = []
  await handleCellManagedHaEvent(db, frame, {
    reporterServerId: SERVER_A,
    commandQueue,
    autoFailover: 'on',
    handle: recordingHandle(calls),
  })
  assertEquals(calls.length, 1)
  const [, input, deps] = calls[0]
  assertEquals(input, {
    managedId: 'mgd-1',
    sourceMemberId: 'mem-primary',
    detector: 'postgres-probe',
    evidence: { probe: 'connect_refused' },
    at: AT,
  })
  assertEquals(deps.reporterServerId, SERVER_A)
  assertEquals(deps.autoFailover, 'on')
  const queue = deps.commandQueue
  if (!queue) throw new TypeError('expected the Workers command queue to be passed')
  const envelope = { id: 'cmd-1' } as unknown as CommandEnvelope
  await queue.enqueue(envelope)
  assertEquals(sent, [envelope])
})

test('handleCellManagedHaEvent passes no queue when the binding is absent', async () => {
  const calls: Call[] = []
  await handleCellManagedHaEvent(
    db,
    { type: 'managed-ha-event', managedId: 'mgd-1', at: AT },
    {
      reporterServerId: SERVER_A,
      commandQueue: cellCommandQueue({}),
      autoFailover: 'on',
      handle: recordingHandle(calls),
    }
  )
  assertEquals(calls.length, 1)
  const [, input, deps] = calls[0]
  assertEquals(input, { managedId: 'mgd-1', at: AT })
  assertEquals('commandQueue' in deps, false)
})

test('cellAutoFailover follows the Worker vars: on for testing, off for staging / live', () => {
  assertEquals(cellAutoFailover({ TURBOPANEL_AUTO_FAILOVER: 'on' }), 'on')
  assertEquals(cellAutoFailover({ TURBOPANEL_AUTO_FAILOVER: 'off' }), 'off')
  assertEquals(cellAutoFailover({ TURBOPANEL_ENVIRONMENT: 'testing' }), 'on')
  assertEquals(cellAutoFailover({ TURBOPANEL_ENVIRONMENT: 'staging' }), 'off')
  assertEquals(cellAutoFailover({ TURBOPANEL_ENVIRONMENT: 'live' }), 'off')
  assertEquals(cellAutoFailover({}), 'on')
})

test('handleCellManagedHaEvent passes auto failover off to the failover path', async () => {
  const calls: Call[] = []
  await handleCellManagedHaEvent(db, frame, {
    reporterServerId: SERVER_A,
    commandQueue: cellCommandQueue({}),
    autoFailover: cellAutoFailover({
      TURBOPANEL_AUTO_FAILOVER: 'off',
      TURBOPANEL_ENVIRONMENT: 'testing',
    }),
    handle: recordingHandle(calls),
  })
  assertEquals(calls.length, 1)
  assertEquals(calls[0][2].autoFailover, 'off')
})

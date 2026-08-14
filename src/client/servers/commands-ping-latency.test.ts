import { assertEquals } from 'jsr:@std/assert'
import type { CommandRecord } from '../../lib/db/command-records.ts'
import { computePingLatency } from './commands-ping-latency.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function pingRecord(
  partial: Partial<CommandRecord> & Pick<CommandRecord, 'id' | 'serverId'>,
): CommandRecord {
  return {
    actorEntityType: 'user',
    actorEntityId: 'user-1',
    type: 'daemon.ping',
    status: 'succeeded',
    payload: {},
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:01.000Z',
    attempts: 1,
    result: null,
    queuedAt: null,
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    error: null,
    ...partial,
  }
}

test('computePingLatency breaks down a terminal ping command', () => {
  const latency = computePingLatency(pingRecord({
    id: 'cmd-1',
    serverId: 'srv-1',
    queuedAt: '2020-01-01T00:00:00.000Z',
    dispatchStartedAt: '2020-01-01T00:00:00.010Z',
    sentAt: '2020-01-01T00:00:00.020Z',
    ackedAt: '2020-01-01T00:00:00.035Z',
    finishedAt: '2020-01-01T00:00:00.060Z',
    result: {
      cellDispatchedAt: '2020-01-01T00:00:00.030Z',
      daemonReceivedAt: '2020-01-01T00:00:00.040Z',
      daemonRespondedAt: '2020-01-01T00:00:00.050Z',
    },
  }))

  assertEquals(latency.apiToConsumerMs, 10)
  assertEquals(latency.consumerToCellMs, 20)
  assertEquals(latency.cellToDaemonMs, 5)
  assertEquals(latency.daemonProcessingMs, 10)
  assertEquals(latency.daemonToRecordedMs, 25)
  assertEquals(latency.totalRoundTripMs, 60)
})

test('computePingLatency clamps negative hop deltas from clock skew', () => {
  const latency = computePingLatency(pingRecord({
    id: 'cmd-2',
    serverId: 'srv-1',
    queuedAt: '2020-01-01T00:00:00.000Z',
    dispatchStartedAt: '2020-01-01T00:00:00.010Z',
    sentAt: '2020-01-01T00:00:00.050Z',
    ackedAt: '2020-01-01T00:00:00.040Z',
    finishedAt: '2020-01-01T00:00:00.060Z',
    result: {
      cellDispatchedAt: '2020-01-01T00:00:00.050Z',
      daemonReceivedAt: '2020-01-01T00:00:00.055Z',
      daemonRespondedAt: '2020-01-01T00:00:00.045Z',
    },
  }))

  assertEquals(latency.cellToDaemonMs, 0)
  assertEquals(latency.daemonProcessingMs, 0)
})

test('computePingLatency uses sentAt when cellDispatchedAt is absent', () => {
  const latency = computePingLatency(pingRecord({
    id: 'cmd-3',
    serverId: 'srv-1',
    dispatchStartedAt: '2020-01-01T00:00:00.010Z',
    sentAt: '2020-01-01T00:00:00.020Z',
    finishedAt: '2020-01-01T00:00:00.040Z',
    result: {},
  }))

  assertEquals(latency.consumerToCellMs, 10)
  assertEquals(latency.daemonToRecordedMs, 20)
})

test('computePingLatency returns null segments when lifecycle timestamps are missing', () => {
  const latency = computePingLatency(pingRecord({
    id: 'cmd-4',
    serverId: 'srv-1',
  }))

  assertEquals(latency.apiToConsumerMs, null)
  assertEquals(latency.consumerToCellMs, null)
  assertEquals(latency.cellToDaemonMs, null)
  assertEquals(latency.daemonProcessingMs, null)
  assertEquals(latency.daemonToRecordedMs, null)
  assertEquals(latency.totalRoundTripMs, null)
})

test('computePingLatency falls back to finishedAt for cellAckAt when ackedAt is absent', () => {
  const latency = computePingLatency(pingRecord({
    id: 'cmd-5',
    serverId: 'srv-1',
    sentAt: '2020-01-01T00:00:00.020Z',
    finishedAt: '2020-01-01T00:00:00.045Z',
    result: {
      cellDispatchedAt: '2020-01-01T00:00:00.025Z',
    },
  }))

  assertEquals(latency.cellToDaemonMs, 20)
  assertEquals(latency.daemonToRecordedMs, 20)
})

test('computePingLatency uses ackedAt→finishedAt for daemonToRecordedMs when present', () => {
  const latency = computePingLatency(pingRecord({
    id: 'cmd-6',
    serverId: 'srv-1',
    ackedAt: '2020-01-01T00:00:00.040Z',
    finishedAt: '2020-01-01T00:00:00.055Z',
    result: {
      cellDispatchedAt: '2020-01-01T00:00:00.030Z',
    },
  }))

  assertEquals(latency.daemonToRecordedMs, 15)
})

test('computePingLatency ignores non-object results via parsePingResult', () => {
  const latency = computePingLatency(pingRecord({
    id: 'cmd-7',
    serverId: 'srv-1',
    dispatchStartedAt: '2020-01-01T00:00:00.010Z',
    sentAt: '2020-01-01T00:00:00.020Z',
    finishedAt: '2020-01-01T00:00:00.030Z',
    result: 'not-an-object',
  }))

  assertEquals(latency.consumerToCellMs, 10)
  assertEquals(latency.daemonProcessingMs, null)
})

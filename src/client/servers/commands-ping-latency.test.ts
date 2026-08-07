import { assertEquals } from 'jsr:@std/assert'
import { it } from '@std/testing/bdd'
import type { CommandRecord } from '../../lib/db/command-records.ts'
import { computePingLatency } from './commands-ping-latency.ts'

function pingRecord(
  partial: Partial<CommandRecord> & Pick<CommandRecord, 'id' | 'serverId'>,
): CommandRecord {
  return {
    actorType: 'user',
    actorId: 'user-1',
    type: 'daemon.ping',
    status: 'succeeded',
    payload: {},
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:01.000Z',
    attempts: 1,
    name: null,
    result: null,
    queuedAt: null,
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: null,
    finishedAt: null,
    expiresAt: null,
    error: null,
    ...partial,
  }
}

it('computePingLatency breaks down a terminal ping command', () => {
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

it('computePingLatency clamps negative hop deltas from clock skew', () => {
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

it('computePingLatency uses sentAt when cellDispatchedAt is absent', () => {
  const latency = computePingLatency(pingRecord({
    id: 'cmd-3',
    serverId: 'srv-1',
    sentAt: '2020-01-01T00:00:00.020Z',
    finishedAt: '2020-01-01T00:00:00.040Z',
    result: {},
  }))

  assertEquals(latency.consumerToCellMs, null)
  assertEquals(latency.daemonToRecordedMs, 20)
})

it('computePingLatency returns null segments when lifecycle timestamps are missing', () => {
  const latency = computePingLatency(pingRecord({
    id: 'cmd-4',
    serverId: 'srv-1',
  }))

  assertEquals(latency.apiToConsumerMs, null)
  assertEquals(latency.totalRoundTripMs, null)
})

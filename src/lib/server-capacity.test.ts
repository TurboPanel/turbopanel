import { assertEquals } from '@std/assert'
import type { Db } from '../db.ts'
import {
  canReserveServerSeat,
  loadOrgServerCapacity,
  SERVER_CAPACITY_EXCEEDED_ERROR,
  type OrgServerCapacity,
} from './server-capacity.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function capacity(
  partial: Partial<OrgServerCapacity> & Pick<OrgServerCapacity, 'maxServers' | 'usedSeats'>,
): OrgServerCapacity {
  return {
    serverCount: partial.serverCount ?? partial.usedSeats,
    reservedSeatCount: partial.reservedSeatCount ?? 0,
    availableSeats: partial.availableSeats ??
      (partial.maxServers === null
        ? null
        : Math.max(0, partial.maxServers - partial.usedSeats)),
    ...partial,
  }
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

/** Stub the three selects: org options, server count, reserved license seats. */
function capacityDb(opts: {
  orgOptions?: unknown
  orgMissing?: boolean
  serverCount?: number | string
  reservedSeats?: number | string
}): Db {
  let selectCalls = 0
  return {
    select: () => ({
      from: () => ({
        where: () => {
          selectCalls += 1
          if (selectCalls === 1) {
            if (opts.orgMissing) return { limit: () => Promise.resolve([]) }
            return {
              limit: () =>
                Promise.resolve([{ options: opts.orgOptions ?? null }]),
            }
          }
          if (selectCalls === 2) {
            return thenableRows([{ value: opts.serverCount ?? 0 }])
          }
          return thenableRows([{ value: opts.reservedSeats ?? 0 }])
        },
      }),
    }),
  } as unknown as Db
}

test('SERVER_CAPACITY_EXCEEDED_ERROR is stable for API clients', () => {
  assertEquals(SERVER_CAPACITY_EXCEEDED_ERROR, 'server_capacity_exceeded')
})

test('canReserveServerSeat allows any usage when unlimited', () => {
  assertEquals(
    canReserveServerSeat(capacity({ maxServers: null, usedSeats: 100 })),
    true,
  )
})

test('canReserveServerSeat blocks at and above the cap', () => {
  assertEquals(
    canReserveServerSeat(capacity({ maxServers: 2, usedSeats: 1 })),
    true,
  )
  assertEquals(
    canReserveServerSeat(capacity({ maxServers: 2, usedSeats: 2 })),
    false,
  )
  assertEquals(
    canReserveServerSeat(capacity({ maxServers: 0, usedSeats: 0 })),
    false,
  )
})

test('loadOrgServerCapacity returns null when the organization is missing', async () => {
  assertEquals(
    await loadOrgServerCapacity(capacityDb({ orgMissing: true }), 'org-missing'),
    null,
  )
})

test('loadOrgServerCapacity treats non-numeric maxServers as unlimited', async () => {
  const result = await loadOrgServerCapacity(
    capacityDb({
      orgOptions: { maxServers: 'unlimited' },
      serverCount: 3,
      reservedSeats: 1,
    }),
    'org-1',
  )
  assertEquals(result, {
    maxServers: null,
    serverCount: 3,
    reservedSeatCount: 1,
    usedSeats: 4,
    availableSeats: null,
  })
})

test('loadOrgServerCapacity clamps remaining seats and accepts bigint counts', async () => {
  const result = await loadOrgServerCapacity(
    capacityDb({
      orgOptions: { maxServers: 2 },
      serverCount: '2',
      reservedSeats: '1',
    }),
    'org-1',
  )
  assertEquals(result, {
    maxServers: 2,
    serverCount: 2,
    reservedSeatCount: 1,
    usedSeats: 3,
    availableSeats: 0,
  })
  assertEquals(canReserveServerSeat(result!), false)
})

test('loadOrgServerCapacity reports remaining seats under the cap', async () => {
  const result = await loadOrgServerCapacity(
    capacityDb({
      orgOptions: { maxServers: 10 },
      serverCount: 4,
      reservedSeats: 1,
    }),
    'org-1',
  )
  assertEquals(result?.availableSeats, 5)
  assertEquals(result?.usedSeats, 5)
  assertEquals(canReserveServerSeat(result!), true)
})

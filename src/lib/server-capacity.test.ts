import { assertEquals } from '@std/assert'
import { canReserveServerSeat, type OrgServerCapacity } from './server-capacity.ts'

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

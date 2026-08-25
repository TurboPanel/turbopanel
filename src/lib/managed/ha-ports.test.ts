import { assertEquals } from '@std/assert'
import {
  MANAGED_HA_HTTP_PORT,
  MANAGED_HA_RAFT_PORT,
} from './ha-ports.ts'
import {
  MANAGED_PRIVATE_PORT_MIN,
  rejectManagedIngressPort,
} from './ingress-ports.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('HA ports stay outside ProxySQL listeners, admin, and private-engine range', () => {
  assertEquals(MANAGED_HA_HTTP_PORT, 33001)
  assertEquals(MANAGED_HA_RAFT_PORT, 33002)
  assertEquals(MANAGED_HA_HTTP_PORT < MANAGED_PRIVATE_PORT_MIN, true)
  assertEquals(MANAGED_HA_RAFT_PORT < MANAGED_PRIVATE_PORT_MIN, true)
  // They remain valid high ports if an operator ever asked for them as clients,
  // but the Orchestrator compose owns them — not shared ProxySQL listeners.
  assertEquals(rejectManagedIngressPort(MANAGED_HA_HTTP_PORT), null)
  assertEquals(rejectManagedIngressPort(MANAGED_HA_RAFT_PORT), null)
  const httpPort: number = MANAGED_HA_HTTP_PORT
  const raftPort: number = MANAGED_HA_RAFT_PORT
  assertEquals(httpPort !== raftPort, true)
})

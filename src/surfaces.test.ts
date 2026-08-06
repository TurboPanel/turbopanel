import { assertEquals } from 'jsr:@std/assert'
import {
  ADMIN_API_PREFIX,
  CLIENT_API_PREFIX,
  CLIENT_WS_PATH,
  DAEMON_API_PREFIX,
  DAEMON_WS_PATH,
  DEVELOPER_API_PREFIX,
  DEVELOPER_WS_PATH,
  HEALTH_PATH,
  INSTALL_API_PREFIX,
} from './surfaces.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('versioned API and WebSocket prefixes stay stable', () => {
  assertEquals(HEALTH_PATH, '/api/health')
  assertEquals(CLIENT_API_PREFIX, '/api/client/v1')
  assertEquals(DEVELOPER_API_PREFIX, '/api/developer/v1')
  assertEquals(DAEMON_API_PREFIX, '/api/daemon/v1')
  assertEquals(INSTALL_API_PREFIX, '/api/install/v1')
  assertEquals(ADMIN_API_PREFIX, '/api/admin/v1')
  assertEquals(CLIENT_WS_PATH, '/ws/client/v1')
  assertEquals(DEVELOPER_WS_PATH, '/ws/developer/v1')
  assertEquals(DAEMON_WS_PATH, '/ws/daemon/v1')
})

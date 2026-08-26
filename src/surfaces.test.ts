import { assertEquals } from '@std/assert'
import {
  ADMIN_API_PREFIX,
  CLIENT_API_PREFIX,
  CLIENT_WS_PATH,
  DAEMON_API_PREFIX,
  DAEMON_WS_PATH,
  GITHUB_WEBHOOK_PATH,
  GITHUB_WEBHOOK_SCOPED_PATH,
  GITLAB_WEBHOOK_PATH,
  GITLAB_WEBHOOK_SCOPED_PATH,
  WEBHOOK_PREFIX,
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

test('the webhook surface is its own top-level prefix', () => {
  // These are pinned because they are not ours alone to change: the same
  // strings are enumerated in `Caddyfile`, `dev/orchestration/Caddyfile`, and
  // the `routes` patterns in `wrangler.jsonc`. A prefix that drifts out of
  // those lists does not 404 — every front here ends in a catch-all that
  // serves the UI's index.html, so a Git provider would get HTTP 200 and an
  // HTML page, read it as a delivered webhook, and never retry.
  assertEquals(WEBHOOK_PREFIX, '/webhook')
  assertEquals(GITHUB_WEBHOOK_PATH, '/webhook/github')
  assertEquals(GITHUB_WEBHOOK_SCOPED_PATH, '/webhook/github/:ref')
  assertEquals(GITLAB_WEBHOOK_PATH, '/webhook/gitlab')
  assertEquals(GITLAB_WEBHOOK_SCOPED_PATH, '/webhook/gitlab/:ref')
})

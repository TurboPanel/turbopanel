import { assertEquals } from '@std/assert'
import { defaultDaemonRestRequireSigned } from '../api-routes.ts'
import {
  DEFAULT_CLIENT_AUTH_RATE_LIMIT,
  DEFAULT_CLIENT_AUTH_RATE_PERIOD_SECONDS,
  DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT,
  DEFAULT_CLIENT_AUTH_STRICT_RATE_PERIOD_SECONDS,
  DEFAULT_CLIENT_WRITE_RATE_LIMIT,
  DEFAULT_CLIENT_WRITE_RATE_PERIOD_SECONDS,
  DEFAULT_DAEMON_CONNECT_RATE_LIMIT,
  DEFAULT_DAEMON_CONNECT_RATE_PERIOD_SECONDS,
  DEFAULT_DAEMON_METRICS_RATE_LIMIT,
  DEFAULT_DAEMON_METRICS_RATE_PERIOD_SECONDS,
  DEFAULT_DAEMON_REST_RATE_LIMIT,
  DEFAULT_DAEMON_REST_RATE_PERIOD_SECONDS,
  DEFAULT_GITHUB_WEBHOOK_RATE_LIMIT,
  DEFAULT_GITHUB_WEBHOOK_RATE_PERIOD_SECONDS,
  DEFAULT_GITLAB_WEBHOOK_RATE_LIMIT,
  DEFAULT_GITLAB_WEBHOOK_RATE_PERIOD_SECONDS,
  DEFAULT_STRIPE_WEBHOOK_RATE_LIMIT,
  DEFAULT_STRIPE_WEBHOOK_RATE_PERIOD_SECONDS,
} from './redis-rate-limiter.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only sees `test()`. */
const test = Deno.test.bind(Deno)

/** Every Wrangler rate limiter binding and the Deno default it must equal, in every env copy. */
const EXPECTED: Record<string, [number, number]> = {
  DAEMON_CONNECT_RATE_LIMITER: [
    DEFAULT_DAEMON_CONNECT_RATE_LIMIT,
    DEFAULT_DAEMON_CONNECT_RATE_PERIOD_SECONDS,
  ],
  DAEMON_REST_RATE_LIMITER: [
    DEFAULT_DAEMON_REST_RATE_LIMIT,
    DEFAULT_DAEMON_REST_RATE_PERIOD_SECONDS,
  ],
  DAEMON_METRICS_RATE_LIMITER: [
    DEFAULT_DAEMON_METRICS_RATE_LIMIT,
    DEFAULT_DAEMON_METRICS_RATE_PERIOD_SECONDS,
  ],
  CLIENT_AUTH_RATE_LIMITER: [
    DEFAULT_CLIENT_AUTH_RATE_LIMIT,
    DEFAULT_CLIENT_AUTH_RATE_PERIOD_SECONDS,
  ],
  CLIENT_AUTH_STRICT_RATE_LIMITER: [
    DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT,
    DEFAULT_CLIENT_AUTH_STRICT_RATE_PERIOD_SECONDS,
  ],
  CLIENT_WRITE_RATE_LIMITER: [
    DEFAULT_CLIENT_WRITE_RATE_LIMIT,
    DEFAULT_CLIENT_WRITE_RATE_PERIOD_SECONDS,
  ],
  GITHUB_WEBHOOK_RATE_LIMITER: [
    DEFAULT_GITHUB_WEBHOOK_RATE_LIMIT,
    DEFAULT_GITHUB_WEBHOOK_RATE_PERIOD_SECONDS,
  ],
  GITLAB_WEBHOOK_RATE_LIMITER: [
    DEFAULT_GITLAB_WEBHOOK_RATE_LIMIT,
    DEFAULT_GITLAB_WEBHOOK_RATE_PERIOD_SECONDS,
  ],
  STRIPE_WEBHOOK_RATE_LIMITER: [
    DEFAULT_STRIPE_WEBHOOK_RATE_LIMIT,
    DEFAULT_STRIPE_WEBHOOK_RATE_PERIOD_SECONDS,
  ],
}

test('every Wrangler rate limiter matches its Deno default in all four env copies', () => {
  const wrangler = Deno.readTextFileSync(new URL('../../../wrangler.jsonc', import.meta.url))
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const matches = [
      ...wrangler.matchAll(
        new RegExp(
          `"name": "${name}",[^}]*?"simple": \\{ "limit": (\\d+), "period": (\\d+) \\}`,
          'gs'
        )
      ),
    ]
    assertEquals(matches.length, 4, `${name} copies`)
    for (const m of matches) {
      assertEquals([Number(m[1]), Number(m[2])], expected, name)
    }
  }
})

test('the daemon REST requireSigned default is the documented per-runtime rule', () => {
  assertEquals(defaultDaemonRestRequireSigned('workers'), true)
  assertEquals(defaultDaemonRestRequireSigned('deno'), false)
})

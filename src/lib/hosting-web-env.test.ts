import { assertEquals } from 'jsr:@std/assert'
import {
  attachWebMetadataToTraditionalSites,
  formatHostingEnvFile,
  parseHostingEnvFile,
  sanitizeHostingWebEnv,
} from './hosting-web-env.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('sanitizeHostingWebEnv drops invalid keys and empty values', () => {
  assertEquals(
    sanitizeHostingWebEnv({
      APP_ENV: 'prod',
      'bad-key': 'x',
      EMPTY: '   ',
    }),
    { APP_ENV: 'prod' },
  )
})

test('formatHostingEnvFile round-trips via parseHostingEnvFile', () => {
  const env = { ZZZ: 'last', AAA: 'first', QUOTE: 'say "hi"' }
  const file = formatHostingEnvFile(env)
  assertEquals(parseHostingEnvFile(file), env)
})

test('attachWebMetadataToTraditionalSites merges by compose service name', () => {
  const sites = [
    {
      composeServiceName: 'web',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 18080,
    },
  ]
  const out = attachWebMetadataToTraditionalSites(sites, [
    {
      composeServiceName: 'web',
      web: { env: { APP_ENV: 'staging' }, php: { version: '8.3' } },
    },
  ])
  assertEquals(out[0]?.webEnv, { APP_ENV: 'staging' })
  assertEquals(out[0]?.php, { version: '8.3' })
})

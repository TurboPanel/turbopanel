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
  assertEquals(sanitizeHostingWebEnv(undefined), undefined)
  assertEquals(
    sanitizeHostingWebEnv({
      APP_ENV: 'prod',
      'bad-key': 'x',
      EMPTY: '   ',
      TOO_LONG: 'x'.repeat(5000),
    }),
    { APP_ENV: 'prod' },
  )
})

test('sanitizeHostingWebEnv caps entries at 64 keys', () => {
  const raw: Record<string, string> = {}
  for (let i = 0; i < 80; i += 1) {
    raw[`KEY_${String(i).padStart(3, '0')}`] = 'v'
  }
  const sanitized = sanitizeHostingWebEnv(raw)
  assertEquals(Object.keys(sanitized ?? {}).length, 64)
})

test('formatHostingEnvFile escapes quotes backslashes and newlines', () => {
  const file = formatHostingEnvFile({
    MULTI: 'line1\nline2',
    PATHY: String.raw`C:\tmp\file`,
  })
  assertEquals(parseHostingEnvFile(file), {
    MULTI: 'line1\nline2',
    PATHY: String.raw`C:\tmp\file`,
  })
})

test('parseHostingEnvFile ignores comments blanks and bad lines', () => {
  assertEquals(
    parseHostingEnvFile('# comment\n\nBAD\nAPP=ok\nbad-key=nope\n'),
    { APP: 'ok' },
  )
})

test('attachWebMetadataToTraditionalSites merges by compose service name', () => {
  const sites = [
    {
      composeServiceName: 'web',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 18080,
    },
    {
      composeServiceName: 'static',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 18081,
    },
  ]
  const out = attachWebMetadataToTraditionalSites(sites, [
    {
      composeServiceName: 'web',
      web: { env: { APP_ENV: 'staging' }, php: { version: '8.3' } },
    },
    {
      composeServiceName: 'web',
      web: { env: { DEBUG: '1' }, php: { memoryLimit: '256M' } },
    },
    { composeServiceName: 'static' },
  ])
  assertEquals(out[0]?.webEnv, { APP_ENV: 'staging', DEBUG: '1' })
  assertEquals(out[0]?.php, { version: '8.3', memoryLimit: '256M' })
  assertEquals(out[1]?.webEnv, undefined)
  assertEquals(out[1]?.php, undefined)
})

test('formatHostingEnvFile sorts keys and escapes special characters', () => {
  const file = formatHostingEnvFile({
    ZEBRA: 'last',
    ALPHA: 'a"b\\c\nd',
  })
  assertEquals(file.indexOf('ALPHA=') < file.indexOf('ZEBRA='), true)
  assertEquals(parseHostingEnvFile(file), {
    ALPHA: 'a"b\\c\nd',
    ZEBRA: 'last',
  })
})

test('parseHostingEnvFile accepts unquoted values', () => {
  assertEquals(parseHostingEnvFile('PLAIN=hello'), { PLAIN: 'hello' })
})

test('sanitizeHostingWebEnv ignores non-string values in raw map', () => {
  const raw = { APP_ENV: 'prod', BAD: 123 as unknown as string }
  assertEquals(sanitizeHostingWebEnv(raw), { APP_ENV: 'prod' })
})

import { assertEquals } from 'jsr:@std/assert'
import {
  parseHostingOptions,
  resolveHostingBind,
  resolveHostingProtocol,
  resolveHostingProxy,
} from './hosting-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseHostingOptions accepts bind scope', () => {
  assertEquals(parseHostingOptions({ bind: 'datacenter' }), { bind: 'datacenter' })
  assertEquals(parseHostingOptions({ bind: ' local ' }), { bind: 'local' })
  assertEquals(parseHostingOptions({ bind: 'invalid' }), {})
})

test('resolveHostingBind defaults to public', () => {
  assertEquals(resolveHostingBind(null), 'public')
  assertEquals(resolveHostingBind({}), 'public')
  assertEquals(resolveHostingBind({ bind: 'datacenter' }), 'datacenter')
})

test('parseHostingOptions accepts protocol and ports for tcp/udp hosting', () => {
  assertEquals(
    parseHostingOptions({
      protocol: 'tcp',
      ports: [{ published: 5432, target: 5432 }],
    }),
    { protocol: 'tcp', ports: [{ published: 5432, target: 5432 }] },
  )
  assertEquals(
    parseHostingOptions({ protocol: 'udp', ports: [{ published: 53, target: 5300 }] }),
    { protocol: 'udp', ports: [{ published: 53, target: 5300 }] },
  )
  assertEquals(parseHostingOptions({ protocol: 'invalid' }), {})
})

test('parseHostingOptions drops invalid or duplicate port mappings', () => {
  assertEquals(
    parseHostingOptions({
      ports: [
        { published: 5432, target: 5432 },
        { published: 5432, target: 9999 },
        { published: 0, target: 80 },
        { published: 80 },
        'not-an-object',
      ],
    }),
    { ports: [{ published: 5432, target: 5432 }] },
  )
  assertEquals(parseHostingOptions({ ports: [] }), {})
  assertEquals(parseHostingOptions({ ports: 'nope' }), {})
})

test('parseHostingOptions caps ports at 10 entries', () => {
  const ports = Array.from({ length: 15 }, (_, i) => ({ published: 20000 + i, target: 80 }))
  const parsed = parseHostingOptions({ ports })
  assertEquals(parsed?.ports?.length, 10)
})

test('resolveHostingProtocol defaults to http', () => {
  assertEquals(resolveHostingProtocol(null), 'http')
  assertEquals(resolveHostingProtocol({}), 'http')
  assertEquals(resolveHostingProtocol({ protocol: 'tcp' }), 'tcp')
})

test('parseHostingOptions accepts hostnames, path prefix, target port, and proxy flags', () => {
  assertEquals(
    parseHostingOptions({
      hostnames: ['app.example.com', ''],
      pathPrefix: ' /api ',
      targetPort: 8080,
      proxy: {
        forceHttps: false,
        gzip: false,
        brotli: true,
        stripPrefix: '/v1',
      },
    }),
    {
      hostnames: ['app.example.com'],
      pathPrefix: '/api',
      targetPort: 8080,
      proxy: {
        forceHttps: false,
        gzip: false,
        brotli: true,
        stripPrefix: '/v1',
      },
    },
  )
})

test('resolveHostingProxy applies documented defaults', () => {
  assertEquals(resolveHostingProxy(null), {
    forceHttps: true,
    gzip: true,
    brotli: false,
    stripPrefix: undefined,
  })
  assertEquals(
    resolveHostingProxy({ proxy: { stripPrefix: '/api' } }).stripPrefix,
    '/api',
  )
})

test('parseHostingOptions rejects non-records', () => {
  assertEquals(parseHostingOptions('nope'), null)
})

test('parseHostingOptions accepts web env and php hints', () => {
  assertEquals(
    parseHostingOptions({
      web: {
        env: { APP_ENV: 'production', 'bad-key': 'skip' },
        php: { version: '8.3', memoryLimit: '256M', maxExecutionTime: 30 },
      },
    }),
    {
      web: {
        env: { APP_ENV: 'production' },
        php: { version: '8.3', memoryLimit: '256M', maxExecutionTime: 30 },
      },
    },
  )
})

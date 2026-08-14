import { assertEquals } from 'jsr:@std/assert'
import {
  formatInstanceDlBase,
  installOriginNeedsInsecureTls,
} from './install-tls.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('installOriginNeedsInsecureTls trusts public HTTPS on 443', () => {
  assertEquals(installOriginNeedsInsecureTls('https://turbopanel.dev'), false)
  assertEquals(installOriginNeedsInsecureTls('https://panel.example.com'), false)
})

test('installOriginNeedsInsecureTls flags platform-CA listeners', () => {
  assertEquals(installOriginNeedsInsecureTls('https://studio.lan:8443'), true)
  assertEquals(installOriginNeedsInsecureTls('https://huey.lan:8443'), true)
  assertEquals(
    installOriginNeedsInsecureTls('https://panel.example.com:8443'),
    true,
  )
  assertEquals(installOriginNeedsInsecureTls('https://studio.lan'), true)
  assertEquals(installOriginNeedsInsecureTls('https://box.local'), true)
  assertEquals(installOriginNeedsInsecureTls('https://localhost'), true)
  assertEquals(installOriginNeedsInsecureTls('https://192.168.1.10:8443'), true)
  assertEquals(installOriginNeedsInsecureTls('https://10.0.0.5'), true)
})

test('installOriginNeedsInsecureTls never flags plaintext HTTP', () => {
  assertEquals(installOriginNeedsInsecureTls('http://studio.lan:8880'), false)
  assertEquals(installOriginNeedsInsecureTls('http://turbopanel.dev'), false)
})

test('formatInstanceDlBase strips a trailing slash on the origin', () => {
  assertEquals(
    formatInstanceDlBase('https://turbopanel.dev/'),
    'https://turbopanel.dev/downloads/daemon',
  )
})

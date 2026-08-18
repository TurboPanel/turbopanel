import { assertEquals } from '@std/assert'
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
  assertEquals(
    installOriginNeedsInsecureTls('https://panel.example.com:443'),
    false,
  )
  assertEquals(installOriginNeedsInsecureTls('https://203.0.113.50'), false)
  assertEquals(installOriginNeedsInsecureTls('  https://turbopanel.dev  '), false)
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

test('installOriginNeedsInsecureTls flags reserved LAN TLDs on 443', () => {
  assertEquals(installOriginNeedsInsecureTls('https://app.internal'), true)
  assertEquals(installOriginNeedsInsecureTls('https://nas.home'), true)
  assertEquals(installOriginNeedsInsecureTls('https://git.corp'), true)
  assertEquals(installOriginNeedsInsecureTls('https://dev.localhost'), true)
})

test('installOriginNeedsInsecureTls flags loopback and private IPv4', () => {
  assertEquals(installOriginNeedsInsecureTls('https://127.0.0.1'), true)
  assertEquals(installOriginNeedsInsecureTls('https://192.168.1.10'), true)
  assertEquals(installOriginNeedsInsecureTls('https://172.16.0.1'), true)
  assertEquals(installOriginNeedsInsecureTls('https://172.31.255.1'), true)
  assertEquals(installOriginNeedsInsecureTls('https://169.254.1.1'), true)
  // 172.15 / 172.32 are not RFC1918 — treat as public on 443.
  assertEquals(installOriginNeedsInsecureTls('https://172.15.0.1'), false)
  assertEquals(installOriginNeedsInsecureTls('https://172.32.0.1'), false)
})

test('installOriginNeedsInsecureTls ignores non-IPv4 dotted hosts', () => {
  // Four dotted labels that are not octets fall through to the TLD check.
  assertEquals(installOriginNeedsInsecureTls('https://a.b.c.com'), false)
  assertEquals(installOriginNeedsInsecureTls('https://192.168.1.999'), false)
  assertEquals(installOriginNeedsInsecureTls('https://192.168.1.x'), false)
})

test('installOriginNeedsInsecureTls flags loopback and private IPv6', () => {
  assertEquals(installOriginNeedsInsecureTls('https://[::1]'), true)
  assertEquals(installOriginNeedsInsecureTls('https://[0:0:0:0:0:0:0:1]'), true)
  assertEquals(installOriginNeedsInsecureTls('https://[fe80::1]'), true)
  assertEquals(installOriginNeedsInsecureTls('https://[fc00::1]'), true)
  assertEquals(installOriginNeedsInsecureTls('https://[fd12:3456::1]'), true)
  // Public IPv6 on 443 stays system-trust.
  assertEquals(installOriginNeedsInsecureTls('https://[2001:db8::1]'), false)
})

test('installOriginNeedsInsecureTls treats non-443 HTTPS as platform CA', () => {
  assertEquals(installOriginNeedsInsecureTls('https://turbopanel.dev:8443'), true)
  assertEquals(installOriginNeedsInsecureTls('https://203.0.113.50:8880'), true)
  assertEquals(installOriginNeedsInsecureTls('https://[2001:db8::1]:8443'), true)
})

test('installOriginNeedsInsecureTls never flags plaintext HTTP', () => {
  assertEquals(installOriginNeedsInsecureTls('http://studio.lan:8880'), false)
  assertEquals(installOriginNeedsInsecureTls('http://turbopanel.dev'), false)
  assertEquals(installOriginNeedsInsecureTls('ftp://studio.lan'), false)
  assertEquals(installOriginNeedsInsecureTls(''), false)
  assertEquals(installOriginNeedsInsecureTls('not a url'), false)
})

test('installOriginNeedsInsecureTls returns false for unparseable HTTPS origins', () => {
  assertEquals(installOriginNeedsInsecureTls('https://'), false)
  assertEquals(installOriginNeedsInsecureTls('https://['), false)
})

test('formatInstanceDlBase strips a trailing slash on the origin', () => {
  assertEquals(
    formatInstanceDlBase('https://turbopanel.dev/'),
    'https://turbopanel.dev/downloads/daemon',
  )
  assertEquals(
    formatInstanceDlBase('https://turbopanel.dev'),
    'https://turbopanel.dev/downloads/daemon',
  )
})

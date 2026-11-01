import { assertEquals } from '@std/assert'
import {
  describePrimaryChange,
  installUrlsFor,
  orderedPublicOrigins,
  primaryHostname,
  publicOriginForHostname,
  publicOriginsForRpId,
} from './public-origins.ts'

/** Alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

test('a stored host at the default port reads back exactly as it did before public ports', () => {
  assertEquals(
    publicOriginForHostname({ host: 'https://panel.example.test:8443', publicPort: 8443 }),
    'https://panel.example.test:8443'
  )
  assertEquals(
    publicOriginForHostname({ host: 'panel.example.test', publicPort: 8443 }),
    'https://panel.example.test:8443'
  )
  assertEquals(
    publicOriginForHostname({ host: 'panel.example.test' }),
    'https://panel.example.test:8443'
  )
})

test('port 443 shows no port, IPv6 stays bracketed, a bad host is null', () => {
  assertEquals(
    publicOriginForHostname({ host: 'a.example.test', publicPort: 443 }),
    'https://a.example.test'
  )
  assertEquals(
    publicOriginForHostname({ host: '[2001:db8::1]', publicPort: 9443 }),
    'https://[2001:db8::1]:9443'
  )
  assertEquals(publicOriginForHostname({ host: ' ', publicPort: 443 }), null)
})

test('the primary wins over an older row, and the oldest wins without one', () => {
  const rows = [
    { host: 'old.example.test', publicPort: 8443 },
    { host: 'new.example.test', publicPort: 443, isPrimary: true },
  ]
  assertEquals(primaryHostname(rows)?.host, 'new.example.test')
  assertEquals(primaryHostname([rows[0]!, { host: 'x.example.test' }])?.host, 'old.example.test')
  assertEquals(primaryHostname([]), null)
  assertEquals(orderedPublicOrigins(rows), [
    'https://new.example.test',
    'https://old.example.test:8443',
  ])
})

test('install URLs skip names servers do not dial and put the primary first', () => {
  const rows = [
    { host: 'a.example.test', publicPort: 8443, isDaemonDial: true },
    { host: 'b.example.test', publicPort: 443, isDaemonDial: false, isPrimary: true },
    { host: 'c.example.test', publicPort: 443, isDaemonDial: true },
  ]
  assertEquals(installUrlsFor(rows), ['https://a.example.test:8443', 'https://c.example.test'])
  assertEquals(installUrlsFor([{ ...rows[2]!, isPrimary: true }, rows[0]!]), [
    'https://c.example.test',
    'https://a.example.test:8443',
  ])
})

test('passkey origins cover the public origin and the 8443 listener of the RP host only', () => {
  const rows = [
    { host: 'a.example.test', publicPort: 443, isPrimary: true },
    { host: 'other.example.test', publicPort: 8443 },
  ]
  assertEquals(publicOriginsForRpId(rows, 'a.example.test'), [
    'https://a.example.test',
    'https://a.example.test:8443',
  ])
  assertEquals(publicOriginsForRpId(rows, 'other.example.test'), [
    'https://other.example.test:8443',
  ])
  assertEquals(publicOriginsForRpId(rows, 'evil.example.test'), [])
})

test('a primary that keeps its host and changes port is not a passkey change', () => {
  assertEquals(
    describePrimaryChange('https://a.example.test:8443', 'https://a.example.test')?.code,
    'primary-origin-changed'
  )
  assertEquals(
    describePrimaryChange('https://a.example.test', 'https://b.example.test')?.code,
    'primary-host-changed'
  )
  assertEquals(describePrimaryChange('https://a.example.test', 'https://a.example.test'), null)
  assertEquals(describePrimaryChange(null, 'https://a.example.test'), null)
})

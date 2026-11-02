import { assertEquals } from '@std/assert'
import { parseInstanceHostnamesBody } from '../../admin/routes-helpers.ts'
import { parseInstallBaseUrl } from './resolve-public-base-url.ts'
import {
  fixedPublicPort,
  isAllowedPublicPort,
  SELF_HOSTED_PUBLIC_PORT_ERROR,
  setSelfHostedAddress,
} from './ingress-modes.ts'
import { orderedPublicOrigins, publicOriginForHostname } from './public-origins.ts'

/** Alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

/** Runs `body` as a self-hosted control plane, then restores the Workers default. */
function selfHosted(body: () => void): void {
  setSelfHostedAddress(true)
  try {
    body()
  } finally {
    setSelfHostedAddress(false)
  }
}

const ENTRY = { host: 'a.example.test', source: 'platform-ca' } as const

test('without the self-hosted switch (Workers) any valid public port is kept', () => {
  assertEquals(fixedPublicPort(), null)
  assertEquals(isAllowedPublicPort(443), true)
  assertEquals(
    publicOriginForHostname({ host: 'a.example.test', publicPort: 443 }),
    'https://a.example.test'
  )
  assertEquals(
    publicOriginForHostname({ host: 'a.example.test', publicPort: 9443 }),
    'https://a.example.test:9443'
  )
  assertEquals(parseInstallBaseUrl('https://turbopanel.app:443'), 'https://turbopanel.app')
  assertEquals(parseInstanceHostnamesBody({ hostnames: [{ ...ENTRY, publicPort: 443 }] }).ok, true)
})

test('self-hosted: every origin ends in :8443 whatever port a row stored', () => {
  selfHosted(() => {
    assertEquals(fixedPublicPort(), 8443)
    assertEquals(
      publicOriginForHostname({ host: 'a.example.test', publicPort: 443 }),
      'https://a.example.test:8443'
    )
    assertEquals(
      publicOriginForHostname({ host: '[2001:db8::1]', publicPort: 9443 }),
      'https://[2001:db8::1]:8443'
    )
    assertEquals(
      orderedPublicOrigins([
        { host: 'a.example.test', publicPort: 443 },
        { host: 'b.example.test', publicPort: 8443, isPrimary: true },
      ]),
      ['https://b.example.test:8443', 'https://a.example.test:8443']
    )
  })
})

test('self-hosted: a base URL on 443 becomes the 8443 address', () => {
  selfHosted(() => {
    assertEquals(
      parseInstallBaseUrl('https://turbopanel.example.test'),
      'https://turbopanel.example.test:8443'
    )
    assertEquals(
      parseInstallBaseUrl('https://turbopanel.example.test:443'),
      'https://turbopanel.example.test:8443'
    )
  })
})

test('self-hosted: the hostnames body refuses any public port but 8443 with a plain message', () => {
  selfHosted(() => {
    for (const publicPort of [443, 80, 9443]) {
      assertEquals(parseInstanceHostnamesBody({ hostnames: [{ ...ENTRY, publicPort }] }), {
        ok: false,
        error: SELF_HOSTED_PUBLIC_PORT_ERROR,
      })
    }
    assertEquals(
      parseInstanceHostnamesBody({ hostnames: [{ ...ENTRY, publicPort: 8443 }] }).ok,
      true
    )
    assertEquals(parseInstanceHostnamesBody({ hostnames: [ENTRY] }).ok, true)
    // A malformed port keeps its own message.
    assertEquals(parseInstanceHostnamesBody({ hostnames: [{ ...ENTRY, publicPort: 0 }] }), {
      ok: false,
      error: 'publicPort must be a whole number from 1 to 65535',
    })
  })
})

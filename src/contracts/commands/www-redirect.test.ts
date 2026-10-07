import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import type { EnvironmentDeployHosting } from './schemas.ts'
import {
  hostingCertificateNames,
  hostingServedNames,
  hostingWwwNames,
  hostingWwwRedirects,
  isHostingWwwMode,
  wwwSiblingHostname,
} from './hostname.ts'
import { validateDeployWwwModes } from './www-redirect.ts'

const host = (
  hostnames: string[],
  extra: Partial<EnvironmentDeployHosting> = {}
): EnvironmentDeployHosting => ({
  hostingId: 'h',
  serviceId: 's',
  composeServiceName: 'web',
  hostnames,
  ...extra,
})

describe('hostingWwwNames', () => {
  it('expands each mode the same way whichever spelling was typed', () => {
    assertEquals(hostingWwwNames('example.com'), { serve: ['example.com'], redirect: null })
    assertEquals(hostingWwwNames('example.com', 'both'), {
      serve: ['example.com', 'www.example.com'],
      redirect: null,
    })
    for (const typed of ['example.com', 'www.example.com']) {
      assertEquals(hostingWwwNames(typed, 'www-to-root'), {
        serve: ['example.com'],
        redirect: { from: 'www.example.com', to: 'example.com' },
      })
      assertEquals(hostingWwwNames(typed, 'root-to-www'), {
        serve: ['www.example.com'],
        redirect: { from: 'example.com', to: 'www.example.com' },
      })
    }
    assertEquals(hostingWwwNames('www.', 'both'), null)
  })

  it('lists served, redirected and certificate names per hosting', () => {
    const hosting = host(['example.com', 'shop.example.com'], { www: 'root-to-www' })
    assertEquals(hostingServedNames(hosting), ['www.example.com', 'www.shop.example.com'])
    assertEquals(hostingWwwRedirects(hosting), [
      { from: 'example.com', to: 'www.example.com' },
      { from: 'shop.example.com', to: 'www.shop.example.com' },
    ])
    assertEquals(hostingCertificateNames(hosting), [
      'www.example.com',
      'www.shop.example.com',
      'example.com',
      'shop.example.com',
    ])
    assertEquals(hostingCertificateNames(host(['example.com'])), ['example.com'])
    assertEquals(hostingServedNames(host(['*.example.com'], { www: 'both' })), ['*.example.com'])
  })

  it('knows the four modes', () => {
    for (const mode of ['off', 'both', 'www-to-root', 'root-to-www']) {
      assertEquals(isHostingWwwMode(mode), true)
    }
    assertEquals(isHostingWwwMode(true), false)
    assertEquals(isHostingWwwMode('redirect'), false)
  })
})

describe('validateDeployWwwModes', () => {
  it('accepts every mode on a lone hostname, either spelling', () => {
    for (const www of ['both', 'www-to-root', 'root-to-www'] as const) {
      assertEquals(validateDeployWwwModes([host(['example.com'], { www })]), null)
      assertEquals(validateDeployWwwModes([host(['www.example.com'], { www })]), null)
    }
  })

  it('refuses www on a tcp hosting', () => {
    const tcp = host([], {
      www: 'both',
      protocol: 'tcp',
      ports: [{ published: 5432, target: 5432 }],
    })
    assertEquals(validateDeployWwwModes([tcp]), 'www requires the http protocol')
  })

  it('refuses a sibling that is already a hostname, in this or another hosting', () => {
    const own = validateDeployWwwModes([
      host(['example.com', 'www.example.com'], { www: 'www-to-root' }),
    ])
    assertEquals(own?.includes('www.example.com'), true)
    const other = validateDeployWwwModes([
      host(['example.com'], { www: 'both' }),
      host(['www.example.com'], { hostingId: 'h2' }),
    ])
    assertEquals(other?.includes('already a hostname'), true)
  })

  it('refuses a name with no valid sibling', () => {
    const tooLong = `${'a.'.repeat(124)}com`
    const error = validateDeployWwwModes([host([tooLong], { www: 'both' })])
    assertEquals(error?.includes('has no www or bare spelling'), true)
  })

  it('refuses paths of one name that make different www choices', () => {
    assertEquals(
      validateDeployWwwModes([
        host(['example.com'], { www: 'root-to-www' }),
        host(['example.com'], { hostingId: 'h2', pathPrefix: '/api' }),
      ]),
      'www: every path of example.com must use the same www choice (found root-to-www and off)'
    )
    assertEquals(
      validateDeployWwwModes([
        host(['example.com'], { www: 'root-to-www' }),
        host(['example.com'], { hostingId: 'h2', pathPrefix: '/api', www: 'root-to-www' }),
      ]),
      null
    )
  })

  it('refuses both on one path and nothing on another path of the same name', () => {
    assertEquals(
      validateDeployWwwModes([
        host(['example.com'], { www: 'both' }),
        host(['example.com'], { hostingId: 'h2', pathPrefix: '/api' }),
      ])?.startsWith('www: every path of example.com'),
      true
    )
  })

  it('gives IP addresses and one-word names no www spelling', () => {
    for (const name of [
      '203.0.113.5',
      'www.203.0.113.5',
      'localhost',
      'www.com',
      'www.localhost',
    ]) {
      assertEquals(wwwSiblingHostname(name), null, name)
    }
    assertEquals(
      validateDeployWwwModes([host(['203.0.113.5'], { www: 'both' })]),
      'www: 203.0.113.5 has no www or bare spelling to use'
    )
  })

  it('ignores hostings without a mode', () => {
    assertEquals(
      validateDeployWwwModes([
        host(['example.com']),
        host(['www.example.com'], { hostingId: 'h2' }),
      ]),
      null
    )
  })
})

import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { validateDeployWwwRedirects } from './www-redirect.ts'

const host = (hostnames: string[], extra: Record<string, unknown> = {}) => ({
  hostingId: 'h',
  serviceId: 's',
  composeServiceName: 'web',
  hostnames,
  ...extra,
})

describe('validateDeployWwwRedirects', () => {
  it('accepts a lone www redirect, either direction', () => {
    assertEquals(validateDeployWwwRedirects([host(['example.com'], { wwwRedirect: true })]), null)
    assertEquals(
      validateDeployWwwRedirects([host(['www.example.com'], { wwwRedirect: true })]),
      null
    )
  })

  it('refuses wwwRedirect on a tcp hosting', () => {
    const tcp = host([], {
      wwwRedirect: true,
      protocol: 'tcp',
      ports: [{ published: 5432, target: 5432 }],
    })
    assertEquals(validateDeployWwwRedirects([tcp]), 'wwwRedirect requires the http protocol')
  })

  it('refuses a sibling that is already a hostname, in this or another hosting', () => {
    const own = validateDeployWwwRedirects([
      host(['example.com', 'www.example.com'], { wwwRedirect: true }),
    ])
    assertEquals(own?.includes('www.example.com'), true)
    const other = validateDeployWwwRedirects([
      host(['example.com'], { wwwRedirect: true }),
      host(['www.example.com'], { hostingId: 'h2' }),
    ])
    assertEquals(other?.includes('already a hostname'), true)
  })

  it('refuses a name with no valid sibling', () => {
    const tooLong = `${'a.'.repeat(124)}com`
    const error = validateDeployWwwRedirects([host([tooLong], { wwwRedirect: true })])
    assertEquals(error?.includes('no valid www/non-www name'), true)
  })

  it('ignores hostings without the flag', () => {
    assertEquals(
      validateDeployWwwRedirects([
        host(['example.com']),
        host(['www.example.com'], { hostingId: 'h2' }),
      ]),
      null
    )
  })
})

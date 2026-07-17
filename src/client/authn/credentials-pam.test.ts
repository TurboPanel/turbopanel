import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'

describe('verifyPamLogin source guard', () => {
  it('must not pass TP_PAM_PASSWORD through the child environment', async () => {
    const source = await Deno.readTextFile(
      new URL('./credentials.ts', import.meta.url),
    )
    const start = source.indexOf('async function verifyPamLogin')
    const end = source.indexOf('async function userHasInstallSudo')
    assertEquals(start >= 0 && end > start, true)
    const pamFn = source.slice(start, end)

    assertEquals(
      source.includes('TP_PAM_PASSWORD'),
      false,
      'TP_PAM_PASSWORD must not be reintroduced — pass the password on stdin',
    )
    assertEquals(
      pamFn.includes('/bin/sh'),
      false,
      'verifyPamLogin must spawn pamtester directly, not via /bin/sh',
    )
    assertEquals(
      pamFn.includes('stdin: \'piped\'') || pamFn.includes('stdin: "piped"'),
      true,
      'verifyPamLogin must pipe the password on stdin',
    )
  })
})

import { assertEquals } from '@std/assert'
import {
  DEFAULT_SMTP_SECURITY,
  parseSmtpSecurityStrict,
  resolveSmtpSecurity,
  smtpTransportSecurityOptions,
} from './smtp-security.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test} (see Sonar typescript:S2187). */
const test = Deno.test.bind(Deno)

test('auto: port 465 is implicit TLS, every other port requires STARTTLS', () => {
  assertEquals(smtpTransportSecurityOptions('auto', 465), { secure: true })
  assertEquals(smtpTransportSecurityOptions('auto', 587), { secure: false, requireTLS: true })
  assertEquals(smtpTransportSecurityOptions('auto', 25), { secure: false, requireTLS: true })
  assertEquals(smtpTransportSecurityOptions(undefined, 2525), { secure: false, requireTLS: true })
})

test('explicit modes ignore the port', () => {
  assertEquals(smtpTransportSecurityOptions('tls', 587), { secure: true })
  assertEquals(smtpTransportSecurityOptions('starttls', 465), { secure: false, requireTLS: true })
  assertEquals(smtpTransportSecurityOptions('none', 465), { secure: false, ignoreTLS: true })
})

test('no mode ever disables certificate verification', () => {
  for (const mode of ['auto', 'tls', 'starttls', 'none'] as const) {
    for (const port of [25, 465, 587]) {
      assertEquals('tls' in smtpTransportSecurityOptions(mode, port), false)
    }
  }
})

test('parsing: strict refuses unknown values, resolve falls back to auto', () => {
  assertEquals(parseSmtpSecurityStrict(' STARTTLS '), 'starttls')
  assertEquals(parseSmtpSecurityStrict('ssl'), undefined)
  assertEquals(resolveSmtpSecurity(undefined), DEFAULT_SMTP_SECURITY)
  assertEquals(resolveSmtpSecurity(''), 'auto')
  assertEquals(resolveSmtpSecurity('off'), 'auto')
  assertEquals(resolveSmtpSecurity('none'), 'none')
})

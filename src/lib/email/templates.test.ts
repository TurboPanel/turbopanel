import { assertEquals } from '@std/assert'
import {
  createEmailOtpEmail,
  createEmailVerificationLinkEmail,
} from './templates.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('createEmailVerificationLinkEmail escapes HTML in verify URL', () => {
  const malicious = 'https://example.com/verify?x=<script>'
  const { subject, html, text } = createEmailVerificationLinkEmail(
    'user@example.com',
    malicious,
  )
  assertEquals(subject, 'Verify your TurboPanel email')
  assertEquals(html.includes('<script>'), false)
  assertEquals(html.includes('&lt;script&gt;'), true)
  assertEquals(text.includes(malicious), true)
})

test('createEmailOtpEmail covers otp types and escapes otp in HTML', () => {
  for (const otpType of ['sign-in', 'email-verification', 'forget-password'] as const) {
    const { subject, html, text } = createEmailOtpEmail(
      'user@example.com',
      '123456',
      otpType,
    )
    assertEquals(subject.length > 0, true)
    assertEquals(html.includes('123456'), true)
    assertEquals(text.includes('123456'), true)
  }

  const xss = createEmailOtpEmail('user@example.com', '<script>', 'sign-in')
  assertEquals(xss.html.includes('<script>'), false)
  assertEquals(xss.html.includes('&lt;script&gt;'), true)
})
